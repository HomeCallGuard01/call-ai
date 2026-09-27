// Dedicated PGlite test for supabase/migrations/050_number_lifecycle_sweep_evidence.sql
// — the 3 new RPCs the daily sweep runner depends on. Applies the FULL
// migration chain (through 050, on top of 047), then exercises each RPC
// directly against real Postgres, including the database-level
// idempotency guarantee (ON CONFLICT DO NOTHING) for the expiry-warning
// tracking table.
//
// Run with: node tests/migration-050-sweep-evidence.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

const BOOTSTRAP_SQL = `
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb; $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to service_role;
grant select, insert, update, delete on auth.users to service_role;
`;

function asServiceRole(db) {
  return db.exec(`reset role; set role service_role;`);
}

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  assert(files.includes('050_number_lifecycle_sweep_evidence.sql'), 'migration 050 file is present');

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`✗ ${file} failed to apply: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('All migrations (including 050, on top of 047) applied cleanly.\n');

  await db.exec('reset role');
  const { rows: [household] } = await db.query(
    `insert into public.households (auth_user_id, email, phone_number) values (null, 'sweep-evidence-poc@example.com', '+441234569999') returning id`
  );
  const householdId = household.id;

  await asServiceRole(db);

  // --- expire_lapsed_entitlement ---
  {
    const { rows: [ent] } = await db.query(
      `insert into public.entitlements (household_id, entitlement_type, status, starts_at, ends_at, source)
       values ($1, 'complimentary', 'active', now() - interval '40 days', now() - interval '10 days', 'admin_manual')
       returning id`,
      [householdId]
    );

    const result = await db.query(`select public.expire_lapsed_entitlement($1) as expired`, [ent.id]);
    assert(result.rows[0].expired === true, 'expire_lapsed_entitlement returns true for a genuinely lapsed active entitlement');

    const check = await db.query(`select status from public.entitlements where id = $1`, [ent.id]);
    assert(check.rows[0].status === 'expired', 'the entitlement status is genuinely transitioned to expired');

    // Idempotent: calling it again on the now-expired row is a safe no-op.
    const secondCall = await db.query(`select public.expire_lapsed_entitlement($1) as expired`, [ent.id]);
    assert(secondCall.rows[0].expired === false, 'a second call on an already-expired row returns false (no-op), not an error');
  }

  // --- expire_lapsed_entitlement refuses a NOT-yet-lapsed row ---
  {
    const { rows: [ent] } = await db.query(
      `insert into public.entitlements (household_id, entitlement_type, status, starts_at, ends_at, source)
       values ($1, 'paid_subscription', 'active', now(), now() + interval '10 days', 'stripe')
       returning id`,
      [householdId]
    );
    const result = await db.query(`select public.expire_lapsed_entitlement($1) as expired`, [ent.id]);
    assert(result.rows[0].expired === false, 'expire_lapsed_entitlement re-checks the end date itself and refuses a row that has not actually lapsed yet, regardless of what the caller believes');

    const check = await db.query(`select status from public.entitlements where id = $1`, [ent.id]);
    assert(check.rows[0].status === 'active', 'the not-yet-lapsed entitlement remains untouched');
  }

  // --- record_entitlement_expiry_warning_sent: idempotent at the DB level ---
  // Second disposable household — the first already has an active
  // entitlement from the block above, and entitlements_one_active_per_household
  // (a real, deliberate constraint) means only one active row per household.
  {
    await db.exec('reset role');
    const { rows: [household2] } = await db.query(
      `insert into public.households (auth_user_id, email, phone_number) values (null, 'sweep-evidence-poc-2@example.com', '+441234569998') returning id`
    );
    const householdId2 = household2.id;
    await asServiceRole(db);

    const { rows: [ent] } = await db.query(
      `insert into public.entitlements (household_id, entitlement_type, status, starts_at, ends_at, source)
       values ($1, 'complimentary', 'active', now(), now() + interval '5 days', 'admin_manual')
       returning id`,
      [householdId2]
    );

    const first = await db.query(`select public.record_entitlement_expiry_warning_sent($1, $2) as inserted`, [ent.id, householdId2]);
    assert(first.rows[0].inserted === true, 'the first warning-sent record genuinely inserts');

    const second = await db.query(`select public.record_entitlement_expiry_warning_sent($1, $2) as inserted`, [ent.id, householdId2]);
    assert(second.rows[0].inserted === false, 'DATABASE-LEVEL IDEMPOTENCY: a second call for the same entitlement returns false (ON CONFLICT DO NOTHING) — this is enforced by the database itself, not just application logic, so even a race between two overlapping sweep runs cannot double-send');

    const rowCount = await db.query(`select count(*) as n from public.entitlement_expiry_warnings_sent where entitlement_id = $1`, [ent.id]);
    assert(Number(rowCount.rows[0].n) === 1, 'exactly one row exists after two calls — the constraint genuinely prevented a duplicate, not just returned false while still inserting');
  }

  // --- record_twilio_release_attempt ---
  {
    await db.query(`select public.record_twilio_release_attempt($1, $2)`, [householdId, 'simulated provider timeout']);
    const check = await db.query(
      `select twilio_release_last_error, twilio_release_attempt_count, twilio_release_last_attempt_at is not null as has_timestamp
       from public.households where id = $1`,
      [householdId]
    );
    assert(check.rows[0].twilio_release_last_error === 'simulated provider timeout', 'the error text is recorded verbatim');
    assert(Number(check.rows[0].twilio_release_attempt_count) === 1, 'attempt count starts at 1 after the first recorded attempt');
    assert(check.rows[0].has_timestamp === true, 'the attempt timestamp is recorded');

    // A second attempt increments the count and overwrites the error (or clears it on success).
    await db.query(`select public.record_twilio_release_attempt($1, $2)`, [householdId, null]);
    const check2 = await db.query(`select twilio_release_last_error, twilio_release_attempt_count from public.households where id = $1`, [householdId]);
    assert(check2.rows[0].twilio_release_last_error === null, 'a successful attempt (null error) clears the last-error field, not leaves the stale previous error visible');
    assert(Number(check2.rows[0].twilio_release_attempt_count) === 2, 'attempt count increments correctly on each call, a durable running total');
  }

  // --- privilege checks: only service_role may call any of the 3 new RPCs directly ---
  {
    await db.exec('reset role; set role authenticated;');
    let threw = false;
    try {
      await db.query(`select public.record_twilio_release_attempt($1, $2)`, [householdId, 'x']);
    } catch {
      threw = true;
    }
    assert(threw, 'authenticated role cannot call record_twilio_release_attempt directly');
    await asServiceRole(db);
  }

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} migration-050-sweep-evidence checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
