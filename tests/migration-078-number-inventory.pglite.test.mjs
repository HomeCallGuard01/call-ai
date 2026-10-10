// Migration 078 (WS6 Magrathea → Twilio BYOC number inventory, 2026-10-11,
// DRAFT — NOT APPLIED): applies after 000→077 and re-applies idempotently;
// UK 01/02/03 only; claim is idempotent per household and skips held /
// quarantined / cooling-off numbers; return/release refuse while a household
// holds the number; service_role only; rollback refuses while assigned.
//
// Run with: node tests/migration-078-number-inventory.pglite.test.mjs

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
  if (!condition) { failures += 1; console.error(`✗ ${message}`); } else { console.log(`✓ ${message}`); }
}
async function rejects(fn, re, message) {
  try { await fn(); assert(false, `${message} (did not reject)`); } catch (e) { assert(re.test(e.message), `${message}${re.test(e.message) ? '' : ` (got: ${e.message})`}`); }
}

const DDI_A = '+443300884327';
const DDI_B = '+441615550078';
const DDI_C = '+442079460078';

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert(files.includes('078_number_inventory.sql'), 'migration 078 file is present');
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try { await db.exec(sql); } catch (err) { console.error(`✗ ${file} failed to apply: ${err.message}`); process.exitCode = 1; return; }
  }
  assert(true, `all ${files.length} migrations applied in order (000 → 078)`);
  const sql078 = await readFile(path.join(migrationsDir, '078_number_inventory.sql'), 'utf8');
  assert(/STATUS: DRAFT — NOT APPLIED/.test(sql078), '078 header says DRAFT — NOT APPLIED');
  assert((sql078.match(/set search_path = ''/g) || []).length === 3, 'every 078 security-definer function pins an empty search_path');
  let again = true; try { await db.exec(sql078); } catch (e) { again = false; console.error(e.message); }
  assert(again, '078 can be re-applied safely (idempotent)');

  assert((await db.query(`select count(*)::int as n from public.telephony_providers where code = 'magrathea'`)).rows[0].n === 0, "078 does not register 'magrathea' in 062's provider registry");

  const mkHousehold = async (email, twilio = null) => (await db.query(
    `insert into public.households (auth_user_id, email, phone_number, twilio_number, status) values (null, $1, '+447700900456', $2, 'active') returning id`,
    [email, twilio])).rows[0].id;
  const h1 = await mkHousehold('a@example.test');
  const h2 = await mkHousehold('b@example.test');
  const h3 = await mkHousehold('c@example.test');
  const hHolder = await mkHousehold('holder@example.test', DDI_B); // already holds DDI_B (e.g. manual assignment)

  // constraints
  for (const bad of ['+447700900123', '+449090000000', '+448001234567', '03300884327', '+13300884327', '+4433008843']) {
    await rejects(() => db.query(`insert into public.number_inventory (e164_number) values ($1)`, [bad]), /check constraint/, `inventory refuses ${bad}`);
  }
  await rejects(() => db.query(`insert into public.number_inventory (e164_number, status, household_id) values ($1, 'available', $2)`, [DDI_C, h1]), /check constraint/, 'an AVAILABLE row cannot name a household');
  await db.query(`insert into public.number_inventory (e164_number, channel_limit, notes, created_at) values ($1, 2, 'trial DDI', now() - interval '3 days'), ($2, 10, null, now() - interval '2 days'), ($3, 10, null, now() - interval '1 day')`, [DDI_A, DDI_B, DDI_C]);

  const claim = async (h) => (await db.query(`select public.claim_inventory_number($1, 'magrathea') as n`, [h])).rows[0].n;
  // quarantine DDI_C (unreleased) — must be skipped
  await db.query(`insert into public.twilio_number_quarantine (twilio_number, release_reason) values ($1, 'account_deletion')`, [DDI_C]);

  const n1 = await claim(h1);
  assert(n1 === DDI_A, 'oldest available DDI is claimed first');
  assert((await claim(h1)) === DDI_A, 'claim is idempotent per household (same DDI back)');
  const n2 = await claim(h2);
  assert(n2 === null, 'held (households.twilio_number) and quarantined DDIs are never handed out → null');
  const row = (await db.query(`select status, household_id, assigned_at from public.number_inventory where e164_number = $1`, [DDI_A])).rows[0];
  assert(row.status === 'assigned' && row.household_id === h1 && row.assigned_at, 'claimed row is ASSIGNED to the household');
  await rejects(() => db.query(`update public.number_inventory set status = 'assigned', household_id = $1 where e164_number = $2`, [h1, DDI_B]), /duplicate key|unique/, 'one assigned inventory number per household (unique index)');
  await rejects(() => db.query(`select public.claim_inventory_number($1)`, ['00000000-0000-0000-0000-000000000000']), /unknown household/, 'claim for an unknown household is refused');

  // return of an unassigned claim
  assert((await db.query(`select public.return_unassigned_inventory_number($1, $2) as ok`, [DDI_A, h2])).rows[0].ok === false, 'return by the wrong household is refused');
  await db.query(`update public.households set twilio_number = $1 where id = $2`, [DDI_A, h1]);
  assert((await db.query(`select public.return_unassigned_inventory_number($1, $2) as ok`, [DDI_A, h1])).rows[0].ok === false, 'return refused while the household holds the DDI');
  assert((await db.query(`select public.release_inventory_number_after_quarantine($1, 30) as ok`, [DDI_A])).rows[0].ok === false, 'quarantine release refused while a household holds the DDI');

  // household gives it up → quarantine release → cooling-off
  await db.query(`update public.households set twilio_number = null where id = $1`, [h1]);
  assert((await db.query(`select public.release_inventory_number_after_quarantine($1, 30) as ok`, [DDI_A])).rows[0].ok === true, 'quarantine release returns the DDI');
  const cooled = (await db.query(`select status, household_id, cooling_off_until > now() + interval '29 days' as cooling from public.number_inventory where e164_number = $1`, [DDI_A])).rows[0];
  assert(cooled.status === 'available' && cooled.household_id === null && cooled.cooling, 'returned DDI is available but cooling off for 30 days');
  assert((await claim(h3)) === null, 'a cooling-off DDI is not issued to another household');
  await db.query(`update public.number_inventory set cooling_off_until = now() - interval '1 minute' where e164_number = $1`, [DDI_A]);
  assert((await claim(h3)) === DDI_A, 'after cooling-off the DDI can be issued again');
  await rejects(() => db.query(`select public.release_inventory_number_after_quarantine($1, 400)`, [DDI_A]), /cooling-off days/, 'cooling-off bounded 0..365');

  // return of an unassigned claim (h3 never got households.twilio_number)
  assert((await db.query(`select public.return_unassigned_inventory_number($1, $2) as ok`, [DDI_A, h3])).rows[0].ok === true, 'a claim the household never received is returned');
  assert((await db.query(`select status from public.number_inventory where e164_number = $1`, [DDI_A])).rows[0].status === 'available', 'returned claim is available again (no cooling-off: never live)');

  // household hard-delete keeps the number held
  assert((await claim(h2)) === DDI_A, 'h2 claims the DDI');
  await db.query(`delete from public.households where id = $1`, [h2]).catch((e) => console.error('delete household:', e.message));
  const orphan = (await db.query(`select status, household_id from public.number_inventory where e164_number = $1`, [DDI_A])).rows[0];
  assert(orphan && orphan.status === 'assigned' && orphan.household_id === null, 'hard-deleted household: DDI stays ASSIGNED (held) until the quarantine release');

  // privileges
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await rejects(() => db.query(`select * from public.number_inventory`), /permission denied/, `${role} cannot read the inventory`);
    await rejects(() => db.query(`select public.claim_inventory_number($1)`, [h1]), /permission denied/, `${role} cannot claim`);
    await rejects(() => db.query(`select public.release_inventory_number_after_quarantine($1, 0)`, [DDI_A]), /permission denied/, `${role} cannot release`);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  assert((await db.query(`select count(*)::int as n from public.number_inventory`)).rows[0].n === 3, 'service_role can read the inventory');
  await db.exec('reset role');

  // rollback
  const rollback = await readFile(path.join(migrationsDir, '_rollbacks', '078_rollback_number_inventory.sql'), 'utf8');
  await rejects(() => db.exec(rollback), /rollback refused/, 'rollback refuses while any number is assigned');
  await db.query(`update public.number_inventory set status = 'available', household_id = null`);
  let rolled = true; try { await db.exec(rollback); } catch (e) { rolled = false; console.error(e.message); }
  assert(rolled, 'rollback succeeds once nothing is assigned');
  assert((await db.query(`select to_regclass('public.number_inventory') as t`)).rows[0].t === null, 'rollback dropped the table');
  assert((await db.query(`select count(*)::int as n from pg_proc where proname in ('claim_inventory_number','return_unassigned_inventory_number','release_inventory_number_after_quarantine')`)).rows[0].n === 0, 'rollback dropped the functions');
  let reapply = true; try { await db.exec(sql078); } catch (e) { reapply = false; console.error(e.message); }
  assert(reapply, '078 re-applies after rollback');
}

main().then(() => {
  console.log(failures === 0 ? '\nMigration 078 checks passed.' : `\n${failures} check(s) FAILED`);
  if (failures) process.exitCode = 1;
}).catch((e) => { console.error('✗ unexpected error:', e); process.exitCode = 1; });
