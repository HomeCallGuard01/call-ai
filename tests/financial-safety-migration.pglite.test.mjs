// Migration 056 (financial safety: allowance + call admission) against a
// real Postgres engine (PGlite), after every earlier migration.
// PGlite is a single connection, so "simultaneous" requests below are
// issued together and serialised by the engine: this proves the rules and
// idempotency under a burst, not multi-connection lock contention (the
// RPCs take per-household advisory locks for that — see the migration).
// Run with: node tests/financial-safety-migration.pglite.test.mjs

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

const LIMITS = {
  maxCallsPerHousehold: 3,
  maxCallSeconds: 14400,
  costPerMinuteGbp: 0.010718,
  burstMaxAttempts: 10,
  burstWindowSeconds: 120,
  callerMaxAttempts: 6,
  callerWindowSeconds: 600,
  householdDailyHardGbp: 10,
  householdPeriodHardGbp: 40,
  householdPeriodUnknownBlockGbp: 20,
  householdDailyWatchGbp: 3,
  companyDailyEmergencyGbp: 25,
  companyHourlyEmergencyGbp: 6.25,
  companyDailyHardGbp: 100,
};
const MON = { staleAfterSeconds: 90, globalHourlyCostLimitGbp: 5, globalDailyCostLimitGbp: 30, periodCostLimitGbp: 5, dailyCostLimitGbp: 1.5, maxHouseholdStreams: 2, globalMaxStreams: 20 };
const PERIOD = ['2026-09-15T10:00:00Z', '2026-10-15T10:00:00Z'];
const T0 = Date.parse('2026-09-30T09:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try { await db.exec(await readFile(path.join(migrationsDir, f), 'utf8')); } catch (err) { console.error(`✗ ${f}: ${err.message}`); process.exitCode = 1; return; }
  }
  check(files.includes('056_financial_safety_allowance_and_admission.sql'), 'migration 056 applies cleanly after every earlier migration');

  const mk = async (email) => (await db.query('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email])).rows[0].id;
  const hh = {};
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) hh[k] = await mk(`${k}@example.com`);

  await db.exec('set role service_role;');
  const admit = async (h, sid, { caller = null, known = false, loop = false, now = at(0), limits = LIMITS } = {}) =>
    (await db.query('select public.admit_call($1,$2,$3,$4,$5,$6,$7,$8,$9) as r', [h, sid, caller, known, loop, PERIOD[0], PERIOD[1], now, JSON.stringify(limits)])).rows[0].r;
  const end = async (sid, now) => (await db.query('select public.end_call($1,$2,$3) as r', [sid, now, 'test'])).rows[0].r;
  const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0];

  // 1. Simultaneous-call limit, including a burst of 10 requests issued together.
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => admit(hh.a, `CA-a-${i}`, { now: at(i) })));
  const admitted = burst.filter((r) => r.allowed).length;
  check(admitted === 3 && burst.filter((r) => r.reason === 'household_call_limit').length === 7, '10 simultaneous calls → exactly 3 admitted, 7 refused (household_call_limit)');
  const attempts = await q1('select count(*)::int n from public.telephony_call_attempts where household_id = $1', [hh.a]);
  check(attempts.n === 10, 'every decision is recorded once (10 attempts)');

  // 2. Idempotent Twilio retry.
  const retryAdmitted = await admit(hh.a, 'CA-a-0', { now: at(30) });
  const retryRejected = await admit(hh.a, 'CA-a-9', { now: at(30) });
  const attempts2 = await q1('select count(*)::int n from public.telephony_call_attempts where household_id = $1', [hh.a]);
  check(retryAdmitted.allowed && retryAdmitted.existing && !retryRejected.allowed && attempts2.n === 10, 'a retried /voice gets its original answer and is not counted again');

  // 3. end_call bills started minutes, frees the slot, and is idempotent.
  const e1 = await end('CA-a-0', at(61));
  const e1b = await end('CA-a-0', at(500));
  check(e1.ok && e1.billedMinutes === 2 && e1b.alreadyEnded && e1b.billedMinutes === 2, '61 s → 2 started minutes; a second end_call changes nothing');
  const day = await q1('select telephony_minutes, telephony_cost_gbp::float c, calls_admitted, calls_rejected from public.household_usage_days where household_id = $1', [hh.a]);
  check(day.telephony_minutes === 2 && Math.abs(day.c - 2 * 0.010718) < 1e-5 && day.calls_admitted === 3 && day.calls_rejected === 7, 'daily counters: 2 min, £0.0214, 3 admitted, 7 refused');
  const freed = await admit(hh.a, 'CA-a-new', { now: at(200), limits: { ...LIMITS, burstMaxAttempts: 100 } });
  check(freed.allowed, 'ending a call frees its slot');

  // 4. Burst (loop/flood) and caller flood, with calls ending immediately.
  let burstReason = null;
  for (let i = 0; i < 12; i++) {
    const r = await admit(hh.b, `CA-b-${i}`, { now: at(i * 5) });
    if (r.allowed) await end(`CA-b-${i}`, at(i * 5 + 2)); else { burstReason = r.reason; break; }
  }
  check(burstReason === 'household_burst', 'the 11th call attempt within 2 minutes is refused (household_burst)');
  const later = await admit(hh.b, 'CA-b-later', { now: at(400) });
  check(later.allowed, 'once the burst window passes, calls are admitted again');

  const flood = [];
  for (let i = 0; i < 7; i++) {
    const r = await admit(hh.c, `CA-c-${i}`, { caller: 'k-spam', now: at(i * 60) });
    flood.push(r.reason);
    if (r.allowed) await end(`CA-c-${i}`, at(i * 60 + 10));
  }
  const other = await admit(hh.c, 'CA-c-other', { caller: 'k-mum', now: at(420) });
  check(flood[6] === 'caller_flood' && flood.slice(0, 6).every((x) => x === null) && other.allowed, 'the 7th call in 10 minutes from one caller is refused; other callers still get through');
  const anon = await admit(hh.c, 'CA-c-anon', { caller: null, now: at(430) });
  check(anon.allowed, 'withheld numbers (no caller key) are not lumped together as one flooding caller');

  // 5. Forwarding loop.
  const loop = await admit(hh.d, 'CA-d-loop', { loop: true });
  check(!loop.allowed && loop.reason === 'forwarding_loop', 'a call from an HCG number (forwarding loop) is refused');

  // 6. Household daily hard ceiling — including the elapsed cost of calls STILL IN PROGRESS.
  const pricey = { ...LIMITS, costPerMinuteGbp: 0.5 };
  await admit(hh.e, 'CA-e-long', { now: at(0), limits: pricey });
  const during = await admit(hh.e, 'CA-e-next', { now: at(21 * 60), limits: pricey });
  check(!during.allowed && during.reason === 'household_daily_hard' && during.dayCostGbp >= 10, 'a call still in progress counts towards today\'s £ (21 min × £0.50 ≥ £10 → refused), never as £0');

  // 7. A call whose end is never reported is closed at its FULL maximum.
  const short = { ...LIMITS, maxCallSeconds: 600 };
  await admit(hh.f, 'CA-f-lost', { now: at(0), limits: short });
  await admit(hh.f, 'CA-f-next', { now: at(2 * 3600), limits: short });
  const lost = await q1('select status, billed_minutes, end_source from public.telephony_call_sessions where call_sid = $1', ['CA-f-lost']);
  check(lost.status === 'ended' && lost.billed_minutes === 10 && lost.end_source === 'stale_closed_at_max', 'a lost call is closed conservatively at its 10-minute maximum');

  // 8. Period ceilings: unknown block then hard block; kill switch.
  await db.exec('reset role;');
  await db.query(`insert into public.household_usage_periods (household_id, period_start, period_end, telephony_cost_gbp) values ($1, $2, $3, 25)`, [hh.g, PERIOD[0], PERIOD[1]]);
  await db.exec('set role service_role;');
  const unk = await admit(hh.g, 'CA-g-unk', { known: false });
  const kn = await admit(hh.g, 'CA-g-known', { known: true });
  check(unk.reason === 'household_period_unknown_block' && kn.allowed, 'over the period unknown-block ceiling: unknown callers refused, trusted callers still delivered');
  await db.exec('reset role;');
  await db.query('update public.household_usage_periods set telephony_cost_gbp = 45 where household_id = $1', [hh.g]);
  await db.exec('set role service_role;');
  const hard = await admit(hh.g, 'CA-g-known2', { known: true });
  check(hard.reason === 'household_period_hard', 'over the period hard ceiling every new call is refused');

  // 9. Company emergency: refuses only households already abnormal today; company hard blocks unknown callers.
  await db.exec('reset role;');
  await db.query(`insert into public.platform_usage_hours (hour_start, telephony_cost_gbp) values ($1, 30) on conflict (hour_start) do update set telephony_cost_gbp = 30`, [at(0).slice(0, 13) + ':00:00Z']);
  await db.query(`insert into public.household_usage_days (household_id, day, telephony_cost_gbp) values ($1, '2026-09-30', 4)`, [hh.h]);
  await db.exec('set role service_role;');
  const abnormal = await admit(hh.h, 'CA-h-1', { now: at(100) });
  const normal = await admit(hh.i, 'CA-i-1', { now: at(100) });
  check(abnormal.reason === 'company_emergency_abnormal' && normal.allowed, 'company EMERGENCY refuses only already-abnormal households; normal households are unaffected');
  await db.exec('reset role;');
  await db.query(`update public.platform_usage_hours set telephony_cost_gbp = 120 where hour_start = $1`, [at(0).slice(0, 13) + ':00:00Z']);
  await db.exec('set role service_role;');
  const cu = await admit(hh.j, 'CA-j-unknown', { now: at(110) });
  const ck = await admit(hh.j, 'CA-j-known', { now: at(111), known: true });
  check(cu.reason === 'company_hard_unknown_block' && ck.allowed, 'company HARD refuses new unknown callers everywhere; trusted callers still delivered');

  await db.exec('reset role;');
  await db.query('update public.financial_safety_state set telephony_suspended = true, monitoring_suspended = true where id = 1');
  await db.exec('set role service_role;');
  const killed = await admit(hh.i, 'CA-i-kill', { now: at(120) });
  check(killed.reason === 'telephony_kill_switch', 'the manual telephony kill switch refuses every new call');

  // 10. Layer A: monitoring sessions, allowance enforcement flag, bonus seconds, delta-only metering.
  const begin = async (h, sid, allowance, enforce, now = at(0)) => (await db.query('select public.begin_monitoring_session($1,$2,$3,$4,$5,$6,$7,$8) as r', [h, sid, PERIOD[0], PERIOD[1], now, allowance, enforce, JSON.stringify(MON)])).rows[0].r;
  const killedMon = await begin(hh.a, 'CA-m-kill', 6000, true);
  check(killedMon.reason === 'global_kill_switch', 'monitoring kill switch stops new monitoring');
  await db.exec('reset role;');
  await db.query('update public.financial_safety_state set telephony_suspended = false, monitoring_suspended = false where id = 1');
  await db.exec('set role service_role;');

  const m1 = await begin(hh.b, 'CA-m1', 120, true);
  const m1r = await begin(hh.b, 'CA-m1', 120, true);
  check(m1.allowed && m1r.allowed && m1r.existing, 'monitoring reservation is idempotent per CallSid');
  const att = (await db.query('select public.attach_monitoring_stream($1,$2) as r', ['CA-m1', 'MZ1'])).rows[0].r;
  const dup = (await db.query('select public.attach_monitoring_stream($1,$2) as r', ['CA-m1', 'MZ2'])).rows[0].r;
  check(att.ok && att.enforceAllowance === true && !dup.ok && dup.reason === 'duplicate_stream', 'one stream per reservation; a second stream is refused');
  const prog = async (total, final = false) => (await db.query('select public.record_monitoring_progress($1,$2,$3,$4,$5,$6,$7) as r', ['CA-m1', 'MZ1', total, 0.008069 / 60, at(total), final, final ? 'call_ended' : null])).rows[0].r;
  const p1 = await prog(60); const p1dup = await prog(60); const p2 = await prog(130, true); const p3 = await prog(500);
  check(p1.deltaSeconds === 60 && p1dup.deltaSeconds === 0 && p2.deltaSeconds === 70 && p3.deltaSeconds === 0 && p2.periodSeconds === 130,
    'progress counts only the positive delta; duplicates and post-end reports add nothing');
  const exhausted = await begin(hh.b, 'CA-m2', 120, true);
  const notEnforced = await begin(hh.b, 'CA-m3', 120, false);
  check(exhausted.reason === 'allowance_exhausted' && notEnforced.allowed, 'allowance exhaustion stops new monitoring only when enforcement is switched on');
  await db.exec('reset role;');
  await db.query('update public.household_usage_periods set bonus_monitored_seconds = 600 where household_id = $1 and period_start = $2', [hh.b, PERIOD[0]]);
  await db.exec('set role service_role;');
  const bonus = await begin(hh.b, 'CA-m4', 120, true);
  check(bonus.allowed && bonus.allowanceSeconds === 720, 'a future top-up (bonus seconds) extends the allowance without a schema change');
  const s2 = await begin(hh.c, 'CA-s1', 6000, false); const s3 = await begin(hh.c, 'CA-s2', 6000, false); const s4 = await begin(hh.c, 'CA-s3', 6000, false);
  check(s2.allowed && s3.allowed && s4.reason === 'household_stream_limit', 'at most 2 simultaneous monitored streams per household');
  const periodRow = await q1('select monitored_seconds, monitoring_cost_gbp::float c from public.household_usage_periods where household_id = $1 and period_start = $2', [hh.b, PERIOD[0]]);
  check(periodRow.monitored_seconds === 130 && Math.abs(periodRow.c - 130 * 0.008069 / 60) < 1e-5, 'period counters hold exact monitored seconds and monitoring £');

  // 11. Warning points claimed once per period; SMS budget.
  const claim = async (h, kind, ps = PERIOD[0]) => (await db.query('select public.claim_usage_notification($1,$2,$3) as r', [h, ps, kind])).rows[0].r;
  check(await claim(hh.b, 'warn_75') && !(await claim(hh.b, 'warn_75')) && await claim(hh.b, 'warn_90') && await claim(hh.b, 'warn_75', PERIOD[1]),
    '75/90/100 warnings are claimed exactly once per billing period, and again next period');
  const sms = async (h, i) => (await db.query('select public.claim_sms_send($1,$2,$3,$4,$5,$6) as r', [h, PERIOD[0], PERIOD[1], at(i), 0.042325, JSON.stringify({ householdDailySms: 3, householdPeriodSms: 20, companyDailySms: 50 })])).rows[0].r;
  const smsResults = [await sms(hh.d, 1), await sms(hh.d, 2), await sms(hh.d, 3), await sms(hh.d, 4)];
  check(smsResults.slice(0, 3).every((r) => r.allowed) && smsResults[3].reason === 'household_daily_sms_limit', 'SMS stop at the household daily ceiling');

  // 12. Access control.
  const denied = async (role, sql) => {
    await db.exec(`reset role; set role ${role};`);
    try { await db.query(sql); return false; } catch { return true; } finally { await db.exec('reset role; set role service_role;'); }
  };
  check(await denied('anon', `select public.admit_call(null,'x',null,false,false,now(),now(),now(),'{}')`), 'anon cannot execute admit_call');
  check(await denied('authenticated', 'select * from public.household_usage_periods'), 'authenticated users cannot read usage counters');
  check(await denied('authenticated', 'update public.financial_safety_state set telephony_suspended = true'), 'authenticated users cannot flip the kill switch');
  check(await denied('service_role', `select public.fs_add_usage(null,null,null,now(),0,0,0,0,0,0,0,0)`), 'internal helpers are not callable even by service_role');
  check(await denied('service_role', `insert into public.household_usage_days (household_id, day) values ('${hh.a}', '2026-01-01')`), 'service_role cannot write counters directly (only through the RPCs)');
  await db.exec('reset role;');
  const rls = await db.query(`select relname from pg_class where relname in ('household_usage_periods','household_usage_days','platform_usage_hours','monitoring_sessions','telephony_call_sessions','telephony_call_attempts','usage_notifications','financial_safety_events','financial_safety_state') and not relrowsecurity`);
  check(rls.rows.length === 0, 'RLS is enabled on every 056 table');

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
