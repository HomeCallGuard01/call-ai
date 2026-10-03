// Migration 063 (customer allowance credits + warning delivery) against a
// real Postgres engine (PGlite), after every earlier migration including
// Financial Fortress's 056. Proves top-up / adjustment credits are
// idempotent, auditable, refuse non-production purchases, and are seen by
// Fortress's own enforcement (begin_monitoring_session) — there is no
// second allowance counter.
// PGlite is a single connection: "concurrent" requests are issued together
// and serialised by the engine (the RPC also takes 056's per-household
// advisory lock for real multi-connection contention).
// Run with: node tests/customer-allowance-migration.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

// Same Supabase platform shim as tests/migrations.pglite.test.mjs.
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
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const MON = { staleAfterSeconds: 90, globalHourlyCostLimitGbp: 50, globalDailyCostLimitGbp: 300, periodCostLimitGbp: 50, dailyCostLimitGbp: 15, maxHouseholdStreams: 2, globalMaxStreams: 20 };
const P1 = ['2026-09-15T10:00:00Z', '2026-10-15T10:00:00Z'];
const P2 = ['2026-10-15T10:00:00Z', '2026-11-15T10:00:00Z'];
const T0 = Date.parse('2026-09-30T09:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try { await db.exec(await readFile(path.join(migrationsDir, f), 'utf8')); } catch (err) { console.error(`✗ ${f}: ${err.message}`); process.exitCode = 1; return; }
  }
  check(files.includes('063_customer_allowance_credits_and_notices.sql'), 'migration 063 applies cleanly after every earlier migration (incl. 056)');

  const mk = async (email) => (await db.query('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email])).rows[0].id;
  const hh = {};
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) hh[k] = await mk(`${k}@example.com`);

  await db.exec('set role service_role;');
  const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  const credit = async (h, { kind = 'topup', seconds = 1800, source = 'stripe', env = 'production', txn, event = null, product = 'topup_small', actor = null, reason = null, allowNonProd = false, period = P1 } = {}) =>
    (await db.query('select public.credit_allowance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) as r',
      [h, period[0], period[1], kind, seconds, source, env, txn, event, product, 299, 'gbp', actor, reason, allowNonProd])).rows[0].r;
  const bonus = async (h, period = P1) => (await q1('select coalesce(max(bonus_monitored_seconds),0)::int b from public.household_usage_periods where household_id=$1 and period_start=$2', [h, period[0]])).b;

  // 1. First paid top-up credits; the audit row records it.
  const c1 = await credit(hh.a, { txn: 'pi_1', event: 'evt_1' });
  check(c1.credited && c1.appliedSeconds === 1800 && (await bonus(hh.a)) === 1800, 'paid top-up credits 30 min to the current period bonus');
  const row = await q1('select kind, requested_seconds, applied_seconds, source, environment, provider_event_id, amount_minor from public.allowance_credits where provider_transaction_id = $1', ['pi_1']);
  check(row.kind === 'topup' && row.applied_seconds === 1800 && row.environment === 'production' && row.provider_event_id === 'evt_1' && row.amount_minor === 299, 'audit row records kind, seconds, environment, provider event and amount');

  // 2. Webhook replay / duplicate delivery (same transaction, different event id).
  const c1b = await credit(hh.a, { txn: 'pi_1', event: 'evt_1_retry' });
  check(!c1b.credited && c1b.duplicate && (await bonus(hh.a)) === 1800, 'a replayed webhook for the same payment credits nothing');

  // 3. Concurrent duplicate deliveries → exactly one credit.
  const burst = await Promise.all(Array.from({ length: 5 }, (_, i) => credit(hh.b, { txn: 'pi_burst', event: `evt_b${i}` })));
  check(burst.filter((r) => r.credited).length === 1 && (await bonus(hh.b)) === 1800, '5 simultaneous deliveries of one payment → exactly one credit');
  const two = await Promise.all([credit(hh.b, { txn: 'pi_x' }), credit(hh.b, { txn: 'pi_y' })]);
  check(two.every((r) => r.credited) && (await bonus(hh.b)) === 5400, 'two different payments at once both credit (no lost update)');

  // 4. Sandbox / test-mode purchases never credit unless explicitly non-production.
  const sb = await credit(hh.c, { txn: 'apple_sb_1', source: 'apple', env: 'sandbox' });
  check(!sb.credited && sb.reason === 'non_production_purchase' && (await bonus(hh.c)) === 0, 'a sandbox purchase is refused by the database itself (production)');
  const sbOk = await credit(hh.c, { txn: 'apple_sb_1', source: 'apple', env: 'sandbox', allowNonProd: true });
  check(sbOk.credited, 'staging (explicit allow) can credit a sandbox purchase for testing');
  const sameTxnOtherSource = await credit(hh.c, { txn: 'apple_sb_1', source: 'google', allowNonProd: false });
  check(sameTxnOtherSource.credited, 'idempotency is per (source, transaction): the same id from another store is a different payment');

  // 5. Refund reversal: applied to the original period, idempotent, unknown originals ignored.
  const rev = await credit(hh.a, { kind: 'topup_reversal', seconds: -1, txn: 'pi_1', event: 'evt_refund' });
  check(rev.credited && rev.appliedSeconds === -1800 && (await bonus(hh.a)) === 0, 'a full refund reverses the top-up');
  const rev2 = await credit(hh.a, { kind: 'topup_reversal', seconds: -1, txn: 'pi_1', event: 'evt_refund_retry' });
  check(!rev2.credited && rev2.duplicate && (await bonus(hh.a)) === 0, 'a replayed refund reverses nothing twice');
  const revUnknown = await credit(hh.a, { kind: 'topup_reversal', seconds: -1, txn: 'pi_never' });
  check(!revUnknown.credited && revUnknown.reason === 'original_not_found', 'a refund for a payment that was never credited changes nothing');
  const revOther = await credit(hh.d, { kind: 'topup_reversal', seconds: -1, txn: 'pi_x' });
  check(!revOther.credited && revOther.reason === 'original_not_found' && (await bonus(hh.b)) === 5400, "a reversal can't be applied against another household's top-up");

  // 6. Administrative adjustment: audited, clamped at 0, actor+reason mandatory.
  const adj = await credit(hh.d, { kind: 'admin_adjustment', seconds: 600, source: 'admin', txn: 'admin:key-0001', actor: 'admin-user-1', reason: 'goodwill after outage' });
  check(adj.credited && (await bonus(hh.d)) === 600, 'admin adjustment adds goodwill minutes');
  const neg = await credit(hh.d, { kind: 'admin_adjustment', seconds: -6000, source: 'admin', txn: 'admin:key-0002', actor: 'admin-user-1', reason: 'correction' });
  check(neg.credited && neg.appliedSeconds === -600 && (await bonus(hh.d)) === 0, 'a reduction larger than the bonus is clamped at 0 (never negative)');
  let noReason = false;
  try { await credit(hh.d, { kind: 'admin_adjustment', seconds: 60, source: 'admin', txn: 'admin:key-0003', actor: 'admin-user-1', reason: '' }); } catch { noReason = true; }
  check(noReason, 'an admin adjustment without a reason is rejected by the schema');

  // 7. Financial Fortress sees the credit: exhausted → top-up → monitoring allowed.
  const begin = async (h, sid, now, allowance = 600, enforce = true, period = P1) =>
    (await db.query('select public.begin_monitoring_session($1,$2,$3,$4,$5,$6,$7,$8) as r', [h, sid, period[0], period[1], now, allowance, enforce, JSON.stringify(MON)])).rows[0].r;
  const b1 = await begin(hh.e, 'CA-e1', at(0));
  await db.query('select public.attach_monitoring_stream($1,$2)', ['CA-e1', 'MZ-e1']);
  await db.query('select public.record_monitoring_progress($1,$2,$3,$4,$5,$6,$7)', ['CA-e1', 'MZ-e1', 600, 0.0001, at(600), true, 'completed']);
  const b2 = await begin(hh.e, 'CA-e2', at(700));
  check(b1.allowed && !b2.allowed && b2.reason === 'allowance_exhausted', 'Fortress refuses monitoring once the 10-min allowance is used');
  await credit(hh.e, { txn: 'pi_e', seconds: 300 });
  const b3 = await begin(hh.e, 'CA-e3', at(800));
  check(b3.allowed && b3.allowanceSeconds === 900 && b3.periodSeconds === 600, 'after a 5-min top-up Fortress itself allows monitoring again (allowance 900 s, used 600 s)');
  const b4 = await begin(hh.e, 'CA-e4', at(900), 600, true, P2);
  check(b4.allowed && b4.allowanceSeconds === 600, 'the top-up belongs to its period only: the next period starts from the plan allowance');

  // 8. Warning delivery outbox: only claimed points, once per channel, leased.
  let fkRefused = false;
  try { await db.query(`insert into public.allowance_notice_deliveries (household_id, period_start, kind, channel) values ($1,$2,'warn_75','email')`, [hh.f, P1[0]]); } catch { fkRefused = true; }
  check(fkRefused, 'a delivery cannot exist for a warning point Fortress never claimed');
  const claimed = await q1('select public.claim_usage_notification($1,$2,$3) as ok', [hh.f, P1[0], 'warn_75']);
  const enqueue = () => db.query(`insert into public.allowance_notice_deliveries (household_id, period_start, kind, channel) values ($1,$2,'warn_75','email') on conflict do nothing`, [hh.f, P1[0]]);
  await enqueue(); await enqueue();
  const n = await q1('select count(*)::int n from public.allowance_notice_deliveries where household_id=$1', [hh.f]);
  check(claimed.ok && n.n === 1, 'enqueuing the same warning twice leaves one delivery row');
  // Deliveries are created at the database's now(); lease times are relative to it.
  const dbNow = Date.parse((await q1('select now() as t')).t) + 1000;
  const rel = (sec) => new Date(dbNow + sec * 1000).toISOString();
  const lease1 = (await db.query('select * from public.claim_allowance_notice_batch($1, 10, 120)', [rel(0)])).rows;
  const lease2 = (await db.query('select * from public.claim_allowance_notice_batch($1, 10, 120)', [rel(60)])).rows;
  const lease3 = (await db.query('select * from public.claim_allowance_notice_batch($1, 10, 120)', [rel(200)])).rows;
  check(lease1.length === 1 && lease1[0].attempts === 1 && lease2.length === 0, 'a leased delivery is not handed to a second sender');
  check(lease3.length === 1 && lease3[0].attempts === 2, 'an expired lease (crashed sender) is retried, counting the attempt');
  await db.query(`update public.allowance_notice_deliveries set status='sent', sent_at=now(), lease_until=null where household_id=$1`, [hh.f]);
  const lease4 = (await db.query('select * from public.claim_allowance_notice_batch($1, 10, 120)', [rel(9999)])).rows;
  check(lease4.length === 0, 'a sent warning is never sent again');

  // 9. Access control.
  const denied = async (role, sql) => {
    await db.exec(`reset role; set role ${role};`);
    try { await db.query(sql); return false; } catch { return true; } finally { await db.exec('reset role; set role service_role;'); }
  };
  check(await denied('authenticated', `select public.credit_allowance('${hh.a}','2026-01-01','2026-02-01','topup',60,'stripe','production','forged',null,null,null,null,null,null,false)`), 'a signed-in customer cannot credit their own allowance');
  check(await denied('anon', `select public.credit_allowance('${hh.a}','2026-01-01','2026-02-01','topup',60,'stripe','production','forged2',null,null,null,null,null,null,false)`), 'anon cannot credit an allowance');
  check(await denied('authenticated', 'select * from public.allowance_credits'), 'customers cannot read the credit ledger directly');
  check(await denied('service_role', `insert into public.allowance_credits (household_id, kind, requested_seconds, applied_seconds, period_start, period_end, source, environment, provider_transaction_id) values ('${hh.a}','topup',60,60,'2026-01-01','2026-02-01','stripe','production','direct')`), 'even service_role cannot write credits except through credit_allowance');
  check(await denied('service_role', `update public.household_usage_periods set bonus_monitored_seconds = 99999 where household_id = '${hh.a}'`), 'service_role cannot set the bonus directly');
  await db.exec('reset role;');
  const rls = await db.query(`select relname from pg_class where relname in ('allowance_credits','allowance_notice_deliveries') and not relrowsecurity`);
  check(rls.rows.length === 0, 'RLS is enabled on every 063 table');
  const sec = await db.query(`select proname, proconfig from pg_proc where proname in ('credit_allowance','claim_allowance_notice_batch') and prosecdef`);
  check(sec.rows.length === 2 && sec.rows.every((r) => String(r.proconfig).includes('search_path=')), '063 RPCs are SECURITY DEFINER with a pinned search_path');

  // 10. Rollback removes exactly 063's objects (056 counters and bonus kept); re-applies cleanly.
  const before = await bonus(hh.e);
  await db.exec(await readFile(path.join(migrationsDir, '_rollbacks', '063_rollback_customer_allowance_credits_and_notices.sql'), 'utf8'));
  const gone = await q1(`select to_regclass('public.allowance_credits') t, to_regproc('public.credit_allowance') f, to_regclass('public.usage_notifications') kept`);
  check(gone.t === null && gone.f === null && gone.kept !== null && (await bonus(hh.e)) === before, 'rollback drops 063 only; Fortress tables and already-applied bonus are untouched');
  let reapplied = true;
  try { await db.exec(await readFile(path.join(migrationsDir, '063_customer_allowance_credits_and_notices.sql'), 'utf8')); } catch { reapplied = false; }
  check(reapplied, '063 re-applies cleanly after its rollback');

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
