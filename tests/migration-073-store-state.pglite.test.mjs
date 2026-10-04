// Migration 073 (Apple store lifecycle state on entitlements): applies after
// 000→072, idempotent, CHECK on cancel reason, no effect on access, and the
// rollback refuses while billing history exists. Launch sprint 2026-10-05.
//
// Run with: node tests/migration-073-store-state.pglite.test.mjs

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
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert(files.includes('073_entitlements_store_subscription_state.sql'), 'migration 073 file is present');
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try { await db.exec(sql); } catch (err) { console.error(`✗ ${file} failed to apply: ${err.message}`); process.exitCode = 1; return; }
  }
  assert(true, `all ${files.length} migrations applied in order (000 → 073)`);

  const cols = await db.query(`select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='entitlements' and column_name like 'store_%' order by column_name`);
  const names = cols.rows.map((r) => r.column_name).join(',');
  assert(names === 'store_billing_issue_at,store_cancel_reason,store_grace_period_expires_at,store_refunded_at,store_state_event_at,store_will_renew', `073 adds exactly the six store columns (${names})`);
  assert(cols.rows.every((r) => r.is_nullable === 'YES'), 'all 073 columns are nullable (NULL = not reported, never a guess)');

  // Re-applying is a no-op (idempotent).
  const sql073 = await readFile(path.join(migrationsDir, '073_entitlements_store_subscription_state.sql'), 'utf8');
  let reapplied = true;
  try { await db.exec(sql073); } catch { reapplied = false; }
  assert(reapplied, '073 can be re-applied safely (idempotent)');

  const hh = (await db.query(`insert into public.households (auth_user_id, email, phone_number) values (null, 'store-state@example.com', '+441234560073') returning id`)).rows[0].id;
  const ent = (await db.query(
    `insert into public.entitlements (household_id, entitlement_type, status, starts_at, ends_at, source, external_reference, revenuecat_environment)
     values ($1, 'paid_subscription', 'active', now() - interval '3 days', now() + interval '27 days', 'apple_revenuecat', 'tx_073', 'production') returning id`, [hh])).rows[0].id;
  const pre = (await db.query(`select store_will_renew, store_state_event_at from public.entitlements where id = $1`, [ent])).rows[0];
  assert(pre.store_will_renew === null && pre.store_state_event_at === null, 'existing/new rows default to NULL store state (no behaviour change)');

  let badRejected = false;
  try { await db.query(`update public.entitlements set store_cancel_reason = 'drop table; --' where id = $1`, [ent]); } catch { badRejected = true; }
  assert(badRejected, 'store_cancel_reason CHECK rejects anything but an UPPER_SNAKE reason');
  await db.query(`update public.entitlements set store_will_renew = false, store_cancel_reason = 'UNSUBSCRIBE', store_state_event_at = now() where id = $1`, [ent]);
  const after = (await db.query(`select status, ends_at > now() as still_paid, store_will_renew from public.entitlements where id = $1`, [ent])).rows[0];
  assert(after.status === 'active' && after.still_paid === true && after.store_will_renew === false, 'recording a cancellation leaves status and ends_at untouched');

  const rollback = await readFile(path.join(migrationsDir, '_rollbacks', '073_rollback_entitlements_store_subscription_state.sql'), 'utf8');
  let refused = false;
  try { await db.exec(rollback); } catch (err) { refused = /rollback 073/.test(err.message); }
  await db.exec('rollback;').catch(() => {}); // close the aborted transaction left by the refused script
  assert(refused, 'rollback refuses while store lifecycle state is recorded (billing history)');
  const stillThere = (await db.query(`select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='entitlements' and column_name like 'store_%'`)).rows[0].n;
  assert(stillThere === 6, 'refused rollback left the columns intact (transaction rolled back)');

  await db.query(`update public.entitlements set store_will_renew = null, store_cancel_reason = null, store_state_event_at = null where id = $1`, [ent]);
  await db.exec(rollback);
  const gone = (await db.query(`select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='entitlements' and column_name like 'store_%'`)).rows[0].n;
  const entStill = (await db.query(`select status from public.entitlements where id = $1`, [ent])).rows[0];
  assert(gone === 0 && entStill.status === 'active', 'with no recorded state the rollback removes the columns and keeps every entitlement');

  console.log(failures === 0 ? '\nMigration 073: all checks hold.' : `\n${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
