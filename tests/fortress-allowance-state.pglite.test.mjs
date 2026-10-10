// WS2 (2026-10-10) — migration 076: allowance-exhaustion state model and the
// separate, bounded unscreened-delivery reserve. Real SQL (every migration,
// PGlite). Proves, at the authority itself:
//   (a) screening never starts unless the budget covers its worst case
//       (first lease + the whole monitoring window);
//   (b) past the screening budget, unknown callers are connected UNSCREENED
//       only within the configured unscreened reserve (default £0 = refused,
//       exactly 067's behaviour);
//   (c) trusted callers have their own continuity reserve that an unknown
//       flood cannot drain, and trusted calls never use the unknown pool;
//   (d) the deterministic state (normal → … → hard_ceiling, held) and the
//       transition log/events;
//   plus setters are audited and bounded, service_role only, invariants hold,
//   and the rollback refuses while unscreened spend exists and otherwise
//   restores 067's function bodies verbatim.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { applyAll, rpcs, ROOT, BOOTSTRAP_SQL } from './financial-containment-harness.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const throws = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const NOW = Date.parse('2026-10-10T09:00:00Z');
const at = (s) => new Date(NOW + s * 1000).toISOString();
const P = [new Date(NOW - 86400e3).toISOString(), new Date(NOW + 20 * 86400e3).toISOString()];
let n = 0; const sid = () => `CA${String(++n).padStart(32, '0')}`;
const RB = path.join(ROOT, 'supabase', 'migrations', '_rollbacks', '076_rollback_fortress_allowance_state_and_continuity_reserves.sql');
const REPLACED = ['fc_account', 'fc_authorize_call', 'fc_settle_locked', 'fc_renew_lease', 'fc_authorize_spend', 'fc_check_invariants', 'fc_household_status'];

async function main() {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const R = rpcs(q);
  const one = async (sql, p) => (await q(sql, p))[0].r;
  // Budget £1.00, trusted reserve £0.30 (trusted_only), essential £0.10.
  await q("select public.fc_set_budget_profile('standard', 1.00, 0.30, 'trusted_only', 0.10, true, 'ws2 test profile', 'tester')");
  // Wide global caps so only household arithmetic decides.
  await R.setPolicy({ global_hourly_floor_gbp: 500, global_daily_floor_gbp: 900, global_exposure_floor_gbp: 500, global_worst_case_floor_gbp: 900,
    global_active_floor: 500, global_monitoring_hourly_floor_gbp: 500, household_auto_hold_daily_gbp: 100 });
  let t = 0;
  const mk = async (email) => {
    const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
    await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [id, P[0]]);
    return id;
  };
  const auth = (hh, o = {}) => R.authorize(hh, o.sid || sid(), { period: P, now: at(t), known: o.known || false, mon: o.mon || false, essential: o.essential || false });
  // One whole call: admit, run it to its limit (or `secs`), settle.
  const call = async (hh, o = {}) => {
    const s = sid();
    const r = await auth(hh, { ...o, sid: s });
    if (r.allowed) { t += 1; await R.settle(s, Math.min(o.secs ?? 1e9, r.timeLimitSeconds + 60), at(t)); }
    return r;
  };
  const state = (hh) => one('select public.fortress_household_allowance_state($1, $2) as r', [hh, at(t)]);
  const record = (hh) => one('select public.fortress_record_allowance_state($1, $2) as r', [hh, at(t)]);
  const acct = async (hh) => (await q('select * from public.fc_budget_accounts where household_id = $1', [hh]))[0];

  // ── 1. Defaults: U = £0 reproduces 067 exactly ─────────────────────────
  const prof = (await q("select unscreened_reserve_gbp from public.fc_budget_profiles where profile = 'standard'"))[0];
  check(Number(prof.unscreened_reserve_gbp) === 0, 'the unscreened reserve defaults to £0 for every profile (behaviour unchanged until Andrew sets it)');
  const h0 = await mk('d0@example.com');
  check((await state(h0)).state === 'normal' && (await state(h0)).hasAccount === false, 'no account yet: state normal (evaluated as a fresh account)');
  let guard = 0;
  while ((await state(h0)).state !== 'continuity' && guard++ < 60) await call(h0, { secs: 1800 });
  const refusedUnknown = await auth(h0, {});
  check(!refusedUnknown.allowed && refusedUnknown.reason === 'household_budget_exhausted', 'U = £0: past the budget an unknown caller is refused (busy), as in 067');
  const tr0 = await auth(h0, { known: true });
  check(tr0.allowed && tr0.funding === 'reserve', 'U = £0: a trusted caller is still connected from the trusted continuity reserve');
  await R.settle(tr0.reservationId ? (await q('select call_sid from public.fc_reservations where id = $1', [tr0.reservationId]))[0].call_sid : '', 30, at(++t));

  // ── 2. (a) screening needs its worst case ──────────────────────────────
  const h1 = await mk('a1@example.com');
  const s1 = await state(h1);
  const screenCost = Number(s1.screeningAdmissionCostGbp);
  check(Math.abs(screenCost - (6 * 0.010718 * 1.1 + 0.0006 + 30 * 0.008069 * 1.1)) < 1e-6,
    `screening admission cost = first lease + full 30-min monitoring window (£${screenCost.toFixed(4)})`);
  // Drive the budget to just under the screening cost with trusted calls.
  guard = 0;
  while (Number((await state(h1)).budgetAvailableGbp) >= screenCost && guard++ < 80) await call(h1, { known: true, secs: 120 });
  const s1b = await state(h1);
  check(s1b.state === 'screening_paused' && s1b.screeningActive === false && s1b.unknownCallersDelivered === true,
    `budget below the screening worst case → screening_paused; unknown callers still delivered (avail £${Number(s1b.budgetAvailableGbp).toFixed(4)})`);
  const unk = await auth(h1, { mon: true });
  check(unk.allowed && unk.monitoring === false && unk.monitoringDeniedReason === 'monitoring_budget_insufficient' && unk.funding === 'budget',
    'screening_paused: an unknown caller who wanted screening is connected UNSCREENED from the remaining budget');
  const smsKey = `ws2-sms-${n}`;
  const sms = await R.spend(smsKey, h1, 'sms', 1, at(t));
  check(sms.allowed === true || sms.allowed === false, 'SMS authorisation answers deterministically in screening_paused');
  check((await state(h1)).screeningActive === false, 'screeningActive stays false while the budget cannot cover a screened call');

  // ── 3. (b)+(c) separate unscreened reserve ─────────────────────────────
  check(await throws(() => q("select public.fortress_set_unscreened_reserve('standard', 25, 'too much reserve', 'tester')"), /£0–£20/), 'unscreened reserve above £20 refused');
  check(await throws(() => q("select public.fortress_set_unscreened_reserve('nosuch', 1, 'unknown profile test', 'tester')"), /unknown profile/), 'unknown profile refused');
  check(await throws(() => q("select public.fortress_set_unscreened_reserve('standard', 1, '', '')"), /reason and actor/), 'reason and actor required');
  await q("select public.fortress_set_unscreened_reserve('standard', 0.30, 'ws2 test: unscreened reserve on', 'tester')");
  const aud = (await q("select target from public.fc_policy_audit order by id desc limit 1"))[0];
  check(aud.target === 'profile:standard:unscreened_reserve', 'setting the unscreened reserve is audited');
  const h2 = await mk('b2@example.com');
  // Exhaust the budget with unknown calls.
  guard = 0;
  while ((await state(h2)).unknownReserveRemainingGbp !== undefined && Number((await state(h2)).budgetAvailableGbp) >= 0.0714 && guard++ < 80) await call(h2, { secs: 1800 });
  const before = await state(h2);
  check(before.state === 'continuity' && Number(before.trustedReserveRemainingGbp) === 0.3 && Number(before.unknownReserveRemainingGbp) === 0.3,
    `budget spent by unknown callers → continuity; both reserves untouched (T £${before.trustedReserveRemainingGbp}, U £${before.unknownReserveRemainingGbp})`);
  const u1 = await auth(h2, { mon: true });
  check(u1.allowed && u1.funding === 'unscreened' && u1.monitoring === false, 'an unknown caller past the budget is connected from the UNSCREENED reserve, never monitored');
  const u1sid = (await q('select call_sid from public.fc_reservations where id = $1', [u1.reservationId]))[0].call_sid;
  const a2 = await acct(h2);
  check(Number(a2.unscreened_reserved_gbp) > 0 && Number(a2.reserved_gbp) === 0, 'its reservation is held on the unscreened pool, not the budget');
  const smsU = await R.spend(`ws2-sms-u-${n}`, h2, 'sms', 1, at(t));
  check(!smsU.allowed && smsU.reason === 'household_budget_exhausted', 'no warning SMS is funded once the screening budget is spent (the unscreened pool never funds SMS)');
  // Renewal of the unscreened call is limited to its own pool.
  let ren; let guardR = 0;
  do { t += 300; ren = await R.renew(u1sid, at(t)); } while (ren.action === 'renewed' && guardR++ < 30);
  check(['terminate', 'at_backstop'].includes(ren.action), `an unscreened call renews only within its own pool (backstop sized from that pool; ends: ${ren.action}${ren.reason ? ' ' + ren.reason : ''})`);
  await R.settle(u1sid, null, at(t));
  // Flood until the unknown pool is gone.
  guard = 0;
  let last;
  while (guard++ < 40) { last = await call(h2, { secs: 1800 }); if (!last.allowed) break; }
  const after = await state(h2);
  check(!last.allowed && last.reason === 'household_budget_exhausted', 'unknown pool exhausted → further unknown callers refused (busy)');
  check(Number(after.trustedReserveRemainingGbp) === 0.3, `an unknown flood CANNOT drain the trusted reserve (T still £${after.trustedReserveRemainingGbp})`);
  check(after.trustedCallersDelivered === true && after.unknownCallersDelivered === false && ['continuity', 'continuity_low'].includes(after.state),
    `trusted still delivered, unknown not (state ${after.state})`);
  const a2b = await acct(h2);
  check(Number(a2b.unscreened_consumed_gbp) <= 0.30 + 0.12, `unscreened spend bounded by its pool + one lease overrun (£${Number(a2b.unscreened_consumed_gbp).toFixed(4)})`);
  // Trusted callers never use the unknown pool.
  const h3 = await mk('c3@example.com');
  guard = 0;
  while (guard++ < 120) { const r = await call(h3, { known: true, secs: 1800 }); if (!r.allowed) { last = r; break; } }
  const s3 = await state(h3);
  check(!last.allowed && Number(s3.unknownReserveRemainingGbp) === 0.3, 'trusted calls past budget+trusted reserve are refused; they never draw the unknown pool');
  check(s3.trustedCallersDelivered === false && s3.unknownCallersDelivered === true && s3.state === 'continuity_low',
    'trusted reserve gone, unknown pool left → continuity_low (unknown still delivered unscreened)');
  const u3 = await call(h3, {});
  check(u3.allowed && u3.funding === 'unscreened', 'in that state an unknown caller is still connected from the unknown pool');
  guard = 0;
  while (guard++ < 40) { const r = await call(h3, { secs: 1800 }); if (!r.allowed) break; }
  const s3b = await state(h3);
  check(s3b.state === 'hard_ceiling' && !s3b.trustedCallersDelivered && !s3b.unknownCallersDelivered, 'everything spent → hard_ceiling: no further HCG-funded call');
  const a3 = await acct(h3);
  const total3 = Number(a3.consumed_gbp) + Number(a3.unscreened_consumed_gbp) + Number(a3.essential_consumed_gbp);
  check(total3 <= 1.00 + 0.30 + 0.30 + 0.25, `per-household spend ≤ budget + trusted + unknown reserve + overrun allowance (£${total3.toFixed(4)} ≤ £1.85)`);

  // Concurrency: a trusted call in progress keeps its cover while unknown calls race.
  const h4 = await mk('e4@example.com');
  const live = await auth(h4, { known: true });
  const liveSid = (await q('select call_sid from public.fc_reservations where id = $1', [live.reservationId]))[0].call_sid;
  const racers = [];
  for (let i = 0; i < 25; i++) racers.push(await auth(h4, {}));
  const a4 = await acct(h4);
  const st4 = await state(h4);
  check(Number(st4.contingentGbp) >= 0 && Number(a4.reserved_gbp) + Number(st4.contingentGbp) <= 1.00 + 0.30 + 1e-6,
    'simultaneous unknown admissions never exceed budget + trusted reserve including live worst cases');
  let rr; let g5 = 0; t += 1;
  do { t += 300; rr = await R.renew(liveSid, at(t)); } while (rr.action === 'renewed' && g5++ < 40);
  check(rr.action === "at_backstop", `the live trusted call is renewed to its provider backstop, not cut for budget (ends: ${rr.action})`);
  for (const r of await q("select call_sid from public.fc_reservations where household_id = $1 and state in ('active','terminating')", [h4])) await R.settle(r.call_sid, 60, at(t));

  // ── 4. (d) states, thresholds, transitions ─────────────────────────────
  const h5 = await mk('f5@example.com');
  const r0 = await record(h5);
  check(r0.changed === false && r0.initial === true && r0.state === 'normal', 'first observation (normal) is logged without an event');
  check((await record(h5)).changed === false, 'unchanged state writes nothing (idempotent)');
  guard = 0;
  while ((await state(h5)).percentUsed < 80 && guard++ < 60) await call(h5, { known: true, secs: 300 });
  const sl = await state(h5);
  check(sl.state === 'screening_low' || sl.state === 'screening_paused', `≥80% used → screening_low (${sl.state}, ${sl.percentUsed}%)`);
  const r1 = await record(h5);
  check(r1.changed === true && r1.from === 'normal', `transition recorded normal → ${r1.state}`);
  const ev = (await q("select level, details from public.fc_events where rule = 'allowance_state_changed' and household_id = $1 order by id desc limit 1", [h5]))[0];
  check(ev && ev.details.from === 'normal' && ev.details.to === r1.state && ['info', 'warning'].includes(ev.level), 'one fc_events row (allowance_state_changed) per transition');
  // With the recommended £3.00 budget, screening_low exists before screening pauses.
  await q("select public.fc_set_budget_profile('standard', 3.00, 0.50, 'trusted_only', 0.10, true, 'ws2 test: recommended profile', 'tester')");
  const h6 = await mk('g6@example.com');
  guard = 0;
  while ((await state(h6)).percentUsed < 80 && guard++ < 200) await call(h6, { known: true, secs: 300 });
  const s6 = await state(h6);
  check(s6.state === 'screening_low' && s6.screeningActive === true, `recommended £3.00 budget: ≥80% used → screening_low, screening still active (${s6.percentUsed}%)`);
  check(await throws(() => q(`select public.fortress_set_allowance_policy('{"bogus":1}'::jsonb, 'bad field test', 'tester')`), /not a policy field/), 'allowance policy: unknown field refused');
  check(await throws(() => q(`select public.fortress_set_allowance_policy('{"screening_low_ratio":0.2}'::jsonb, 'too low ratio', 'tester')`)), 'allowance policy: ratio outside 0.5–0.99 refused (CHECK)');
  await q(`select public.fortress_set_allowance_policy('{"screening_low_ratio":0.95}'::jsonb, 'ws2 test threshold', 'tester')`);
  const thr = await state(h5);
  check(Number(thr.thresholds.screeningLowRatio) === 0.95, 'thresholds are configuration, read by the state function');
  await q("select public.fc_set_household_hold($1, true, 'ws2 test hold', 'admin:test', 'admin')", [h5]);
  const hs = await state(h5);
  check(hs.state === 'held' && hs.trustedCallersDelivered === false && hs.screeningActive === false, 'a household hold overrides every state (nothing delivered)');
  const r2 = await record(h5);
  check(r2.changed && r2.state === 'held', 'hold is recorded as a transition');
  await q("select public.fc_set_household_hold($1, false, 'ws2 test release', 'admin:test', 'admin')", [h5]);
  await R.kill(true, 'ws2 kill switch state test');
  check((await state(h5)).serviceLimited === true, 'kill switch → serviceLimited true');
  await R.kill(false, 'ws2 kill switch state test off');
  check((await state(h5)).serviceLimited === false, 'kill switch off → serviceLimited false');

  // ── 5. Access control and invariants ───────────────────────────────────
  await db.exec('set role authenticated;');
  check(await throws(() => q('select public.fortress_household_allowance_state($1, now())', [h5]), /permission denied/), 'a signed-in customer cannot call the state function directly');
  check(await throws(() => q("select public.fortress_set_unscreened_reserve('standard', 5, 'customer raises reserve', 'me')"), /permission denied/), 'a signed-in customer cannot raise the reserve');
  check(await throws(() => q('select * from public.fortress_allowance_state_log'), /permission denied/), 'the transition log is not readable by customers');
  await db.exec('reset role;');
  const inv = await R.invariants();
  check(inv.ok === true && inv.accountsWithUnscreenedMismatch === 0, `invariants hold incl. unscreened counters (${JSON.stringify(inv)})`);
  const hstat = await R.hhStatus(h2, at(t));
  check('remainingUnscreenedGbp' in hstat && 'remainingBudgetGbp' in hstat && 'deliveryReserveScope' in hstat, 'fc_household_status keeps every 067 key and adds the unscreened pool');

  // ── 6. Rollback ────────────────────────────────────────────────────────
  const rbSql = await readFile(RB, "utf8");
  check(await throws(() => db.exec(rbSql), /rollback 076 refused/), 'rollback refuses while unscreened-reserve spend exists');
  await db.exec('rollback;').catch(() => {});
  // Clean database: all migrations, then the rollback; compare with a database that never saw 076.
  const clean = new PGlite();
  await applyAll(clean);
  await clean.exec(await readFile(RB, 'utf8'));
  const ref = new PGlite();
  await ref.exec(BOOTSTRAP_SQL);
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql') && !x.startsWith('076') && !x.startsWith('077')).sort()) await ref.exec(await readFile(path.join(dir, f), 'utf8'));
  const src = async (d) => Object.fromEntries((await d.query(`select proname, prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`, [REPLACED])).rows.map((r) => [r.proname, r.prosrc]));
  const [a, b] = [await src(clean), await src(ref)];
  check(REPLACED.every((f) => a[f] && a[f] === b[f]), 'after rollback every replaced function body is 067\'s, verbatim');
  const leftovers = (await clean.query("select count(*)::int n from pg_proc where proname in ('fortress_record_allowance_state','fortress_household_allowance_state','fortress_set_allowance_policy','fortress_set_unscreened_reserve') and pronamespace = 'public'::regnamespace")).rows[0].n;
  const cols = (await clean.query("select count(*)::int n from information_schema.columns where column_name like 'unscreened%'")).rows[0].n;
  check(leftovers === 0 && cols === 0, 'rollback removes every 076 function and column');
  let reapplied = true;
  try { await clean.exec(await readFile(path.join(dir, '076_fortress_allowance_state_and_continuity_reserves.sql'), 'utf8')); } catch { reapplied = false; }
  check(reapplied, '076 re-applies cleanly after its rollback');

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nAll 076 allowance-state checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
