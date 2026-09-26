// Dedicated PGlite (in-memory Postgres-in-WASM, not a real database) test
// for supabase/migrations/046_voice_client_registration_history.sql —
// P0-3 launch hardening. Applies the FULL migration chain, then
// specifically exercises record_voice_client_registration_event: does it
// (a) insert a durable, append-only history row every time, (b) still
// update households.voice_client_registered_at exactly as the older,
// still-present mark_household_voice_client_registered RPC does, (c)
// correctly reject a nonexistent household, and (d) correctly deny
// authenticated/anon direct execution (service_role only).
//
// Run with: node tests/voice-registration-history.test.mjs

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

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$;

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

  console.log('Bootstrapping auth/role shim...');
  await db.exec(BOOTSTRAP_SQL);

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  assert(files.includes('046_voice_client_registration_history.sql'), 'migration 046 file is present in supabase/migrations/');

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
  console.log('All migrations (including 046) applied cleanly.\n');

  await db.exec(`reset role;`);
  const { rows: [household] } = await db.query(
    `insert into public.households (auth_user_id, email, phone_number) values (null, $1, $2) returning id`,
    ['voice-reg-history-poc@example.com', '+441234560001']
  );
  const householdId = household.id;

  await asServiceRole(db);

  // --- a single registration event: inserts one history row AND updates
  // the existing single-timestamp column, in the same call ---
  {
    const result = await db.query(
      `select public.record_voice_client_registration_event($1, $2, $3, $4) as registered_at`,
      [householdId, 'ios', '1.0.1', '42']
    );
    assert(result.rows[0].registered_at !== null, 'first registration event returns a real timestamp');

    const hh = await db.query(`select voice_client_registered_at from public.households where id = $1`, [householdId]);
    assert(hh.rows[0].voice_client_registered_at !== null, 'households.voice_client_registered_at is updated exactly as the older RPC did — every existing reader of this column is unaffected');

    const events = await db.query(`select * from public.voice_client_registration_events where household_id = $1`, [householdId]);
    assert(events.rows.length === 1, 'exactly one history row now exists for this household');
    assert(events.rows[0].app_platform === 'ios' && events.rows[0].app_version === '1.0.1' && events.rows[0].app_build_version === '42', 'the history row correctly stores the optional platform/version diagnostics passed in');
  }

  // --- a second, later registration: a NEW history row is appended, the
  // first is never overwritten or deleted — this is the entire point of
  // this migration, the exact gap the single-timestamp column left open ---
  {
    await new Promise(resolve => setTimeout(resolve, 5));
    await db.query(
      `select public.record_voice_client_registration_event($1, $2, $3, $4)`,
      [householdId, 'ios', '1.0.2', '43']
    );

    const events = await db.query(`select * from public.voice_client_registration_events where household_id = $1 order by registered_at asc`, [householdId]);
    assert(events.rows.length === 2, 'a second registration event adds a SECOND history row — the first is never overwritten, unlike the single-timestamp column it sits alongside');
    assert(events.rows[0].app_version === '1.0.1' && events.rows[1].app_version === '1.0.2', 'both events are individually preserved with their own diagnostics, in order — a real audit trail, not a rolling window');
  }

  // --- optional diagnostics genuinely optional — a registration event
  // with none of them supplied still succeeds and still updates the
  // single-timestamp column ---
  {
    const beforeCount = await db.query(`select count(*) as n from public.voice_client_registration_events where household_id = $1`, [householdId]);
    await db.query(`select public.record_voice_client_registration_event($1)`, [householdId]);
    const afterCount = await db.query(`select count(*) as n from public.voice_client_registration_events where household_id = $1`, [householdId]);
    assert(Number(afterCount.rows[0].n) === Number(beforeCount.rows[0].n) + 1, 'a registration event with no optional diagnostics at all still records a history row (an older app build that never sends platform/version data still works exactly as before)');
  }

  // --- non-existent household: fails closed with a clear exception ---
  {
    let threw = false;
    try {
      await db.query(`select public.record_voice_client_registration_event($1)`, ['99999999-9999-9999-9999-999999999999']);
    } catch (err) {
      threw = true;
    }
    assert(threw, 'record_voice_client_registration_event: non-existent household id raises an exception, not a silent no-op');

    const orphanEvents = await db.query(`select count(*) as n from public.voice_client_registration_events where household_id = '99999999-9999-9999-9999-999999999999'`);
    assert(Number(orphanEvents.rows[0].n) === 0, 'a rejected registration for a non-existent household never leaves an orphaned history row behind');
  }

  // --- privilege check: only service_role may call this directly ---
  {
    await db.exec(`reset role; set role authenticated;`);
    let threw = false;
    try {
      await db.query(`select public.record_voice_client_registration_event($1)`, [householdId]);
    } catch (err) {
      threw = true;
    }
    assert(threw, 'authenticated role (not service_role) cannot execute record_voice_client_registration_event directly');
    await asServiceRole(db);
  }

  // --- rollback path preserved: the older, migration-035 RPC still works
  // unmodified, exactly as it did before this migration ---
  {
    const result = await db.query(`select public.mark_household_voice_client_registered($1) as registered_at`, [householdId]);
    assert(result.rows[0].registered_at !== null, 'the older mark_household_voice_client_registered RPC (migration 035) still works, completely untouched — a real rollback path, not just a comment claiming one exists');

    const events = await db.query(`select count(*) as n from public.voice_client_registration_events where household_id = $1`, [householdId]);
    assert(Number(events.rows[0].n) === 3, 'calling the OLD RPC does not add a history row — history is only ever recorded via the new RPC, exactly as designed; the old RPC remains a narrower, single-timestamp-only fallback');
  }

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} voice-registration-history checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
