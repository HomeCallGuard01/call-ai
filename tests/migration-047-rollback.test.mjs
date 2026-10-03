// Rollback credibility test for migration 047 (2026-09-27 launch-hardening
// follow-up) — proves supabase/migrations/_rollbacks/
// 047_rollback_number_release_entitlement_guard.sql is a real, working
// rollback path, not just a file that exists. Applies the full migration
// chain (through 047), confirms the 047-specific objects exist, applies
// the rollback script, and confirms:
//   - it applies with no error;
//   - every 047-specific function and the trigger are gone;
//   - the three original (pre-047) release functions are restored and
//     still callable;
//   - most importantly, the restored functions genuinely exhibit the
//     PRE-047 (vulnerable) behaviour — a release now succeeds even for a
//     currently-entitled household. This is the concrete proof the
//     rollback isn't a no-op or a partial revert: rolling back really
//     does bring back the #8 failure mode, exactly as the rollback
//     file's own header warns. That's the correct, honest behaviour for
//     a rollback (it undoes the fix), and this test exists so nobody
//     mistakes "the rollback runs without error" for "the rollback is
//     safe to leave applied" — it is a genuine, deliberate un-fix.
//
// Run with: node tests/migration-047-rollback.test.mjs

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

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);

  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  assert(files.includes('047_number_release_entitlement_guard.sql'), 'migration 047 file is present');

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await db.exec(sql);
  }
  console.log('Full migration chain (through 047) applied cleanly.\n');

  const before = await db.query(`select proname from pg_proc where proname = 'household_blocks_number_release'`);
  assert(before.rows.length === 1, 'household_blocks_number_release exists before rollback');

  const rollbackSql = await readFile(
    path.join(migrationsDir, '_rollbacks', '047_rollback_number_release_entitlement_guard.sql'),
    'utf8'
  );

  let rollbackThrew = false;
  try {
    await db.exec(rollbackSql);
  } catch (err) {
    rollbackThrew = true;
    console.error('Rollback SQL error:', err.message);
  }
  assert(rollbackThrew === false, 'the rollback script applies with no error');

  const after047Fns = await db.query(`
    select proname from pg_proc
    where proname in (
      'household_blocks_number_release',
      'household_is_currently_entitled',
      'household_has_upcoming_entitlement',
      'entitlements_cancel_pending_number_release'
    )
  `);
  assert(after047Fns.rows.length === 0, 'all four 047-specific functions are gone after rollback');

  const trigger = await db.query(
    `select tgname from pg_trigger where tgname = 'entitlements_cancel_pending_number_release'`
  );
  assert(trigger.rows.length === 0, 'the 047 trigger is gone after rollback');

  const restored = await db.query(`
    select proname from pg_proc
    where proname in (
      'mark_household_twilio_number_pending_release',
      'release_household_twilio_number',
      'release_household_twilio_number_immediately'
    )
  `);
  assert(restored.rows.length === 3, 'all three original release functions are present and restored after rollback');

  // Functional proof, not just object-existence: the restored function
  // must genuinely exhibit pre-047 behaviour (release succeeds even for a
  // currently-entitled household) — confirming this is a real, complete
  // revert, not a partial one that leaves protection silently in place.
  const h = await db.query(
    `insert into public.households (auth_user_id, email, twilio_number, twilio_provisioning_status)
     values (null, 'rollback-credibility-test@example.com', '+441000000900', 'active') returning id`
  );
  const hid = h.rows[0].id;
  await db.query(
    `insert into public.entitlements (household_id, entitlement_type, status, starts_at, ends_at, source)
     values ($1, 'complimentary', 'active', now(), null, 'admin_manual')`,
    [hid]
  );
  await db.query(
    `update public.households set twilio_number_pending_release_at = now() - interval '1 hour' where id = $1`,
    [hid]
  );
  const releaseResult = await db.query(
    `select public.release_household_twilio_number($1, '+441000000900') as released`,
    [hid]
  );
  assert(
    releaseResult.rows[0].released === true,
    'CONFIRMS a real, complete rollback: post-rollback, a release succeeds even though the household is currently entitled — this is the exact #8 failure mode the rollback file\'s own header warns it reintroduces. If this assertion ever fails (release refused), the rollback would be dangerously incomplete — silently leaving protection partially in place while claiming to have reverted'
  );

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} migration-047-rollback checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
