// "Every HCG server dies immediately after admission" — worst-case exposure
// proof at the authority (migrations 067 + 076, every migration applied,
// PGlite). Written for docs/launch/2026-10-10-TWILIO-DURATION-EVIDENCE.md.
//
// What it does: admits calls through the REAL fc_authorize_call, then NEVER
// renews, settles or terminates anything (the servers are gone). The only
// thing still bounding each call is the <Dial timeLimit> the authority
// returned. The test recomputes the worst case from the RETURNED
// timeLimitSeconds in JavaScript (independently of the DB's own
// worst_case_gbp column) and asserts Fortress invariant I5:
//
//   consumed + Σ worst(timeLimit + grace) of live calls  ≤  budget + adjustments + reserves
//
// per household, and the global worst-case / active-call caps across
// households. It also prices every admitted call with a per-leg TWILIO model
// (inbound parent leg, SDK child leg at list price, Media Stream, whisper,
// Polly) under the stated overhead assumption, so the £ figures quoted in the
// evidence doc come from this file, not from hand arithmetic.
//
// What it does NOT prove: that Twilio actually ends the call at timeLimit and
// that the parent leg ends within `grace` seconds after it when HCG is
// unreachable. That is provider behaviour — the staging test in the evidence
// doc §7 is the only way to demonstrate it.
//
// Run with: node tests/fortress-server-death-exposure.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { applyAll, rpcs, callCost, POLICY, PERIOD, at, num } from './financial-containment-harness.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const gbp = (v) => `£${Number(v).toFixed(4)}`;
const EPS = 1e-9;

// Independent JS worst case for one admitted call: what fc_call_cost charges
// for timeLimit + grace (the I4/I5 bound the authority claims).
const worstJs = (r) => callCost(r.timeLimitSeconds + POLICY.grace, { monitored: Boolean(r.monitoring) });

// Per-leg Twilio model of the SAME call if HCG dies at admission.
// Assumptions (each stated in the evidence doc §1/§2):
//   parent inbound leg ≤ timeLimit + OVERHEAD, OVERHEAD = Polly greeting 5 s +
//     ring ≤ 20 s timeout + 5 s Twilio buffer + action fetch ≤ 15 s hard cap +
//     fallback fetch / application-error message ≤ 15 s  = 60 s (= grace)
//   SDK child leg ≤ timeLimit, priced at list £0.00316/min (billed £0 today)
//   Media Stream ≤ min(parent, 1800 s): stops when the HCG WebSocket is gone
//     (assumption A, undocumented) — HCG stops it at 1800 s while alive
//   whisper ≤ min(parent, 1800 s) at £0.00474/min (only while HCG is alive)
//   Polly £0.0006 once
const RATE = { inbound: 0.007558, sdk: 0.00316, stream: 0.003329, whisper: 0.00474, polly: 0.0006 };
const OVERHEAD = 60;
const mins = (s) => Math.ceil(Math.max(0, s) / 60);
function twilioModel(r, { sdkBilled = true, streamOutlivesHcg = false } = {}) {
  const T = r.timeLimitSeconds;
  const parent = T + OVERHEAD;
  let c = mins(parent) * RATE.inbound + (sdkBilled ? mins(T) * RATE.sdk : 0);
  if (r.monitoring) {
    const streamS = streamOutlivesHcg ? parent : Math.min(parent, POLICY.monMax);
    c += mins(streamS) * RATE.stream + mins(Math.min(parent, POLICY.monMax)) * RATE.whisper + RATE.polly;
  }
  return c;
}

async function main() {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const R = rpcs(q);

  // Policy and SEEDED (not test-pinned) commercial profiles, as migrations leave them.
  const pol = (await q('select lease_seconds, termination_grace_seconds, max_call_seconds, backstop_share::float, connected_rate_gbp_per_min::float conn, monitoring_rate_gbp_per_min::float mon, estimate_uplift::float uplift, billing_granularity_seconds gran, call_fixed_fee_gbp::float fixed, monitoring_max_seconds, global_worst_case_floor_gbp::float wc, global_active_floor, global_exposure_floor_gbp::float ex, global_unattributed_daily_gbp::float ua, enforcement_mode from public.fc_policy'))[0];
  check(pol.lease_seconds === POLICY.lease && pol.termination_grace_seconds === POLICY.grace && pol.max_call_seconds === POLICY.maxCall
    && pol.backstop_share === POLICY.share && pol.conn === POLICY.conn && pol.mon === POLICY.mon && pol.uplift === POLICY.uplift
    && pol.gran === POLICY.gran && pol.fixed === POLICY.fixed && pol.monitoring_max_seconds === POLICY.monMax && pol.enforcement_mode === 'enforce',
  `policy defaults as documented: lease ${pol.lease_seconds}s, grace ${pol.termination_grace_seconds}s, max_call ${pol.max_call_seconds}s, share ${pol.backstop_share}, £${pol.conn}/£${pol.mon} per min ×${pol.uplift}, ${pol.gran}s blocks, enforce`);
  const std = (await q("select period_budget_gbp::float b, delivery_reserve_gbp::float r, delivery_reserve_scope s, essential_reserve_gbp::float e, coalesce(unscreened_reserve_gbp,0)::float u from public.fc_budget_profiles where profile = 'standard'"))[0];
  console.log(`  seeded standard profile: budget ${gbp(std.b)}, trusted reserve ${gbp(std.r)} (${std.s}), essential ${gbp(std.e)}, unscreened ${gbp(std.u)}`);
  const ceiling = (adj = 0) => std.b + adj + std.r + std.e + std.u;

  const mk = async (email) => {
    const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
    await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at)
             values ($1, 'paid_subscription', 'active', 'test', '2026-09-01T00:00:00Z')`, [id]);
    return id;
  };
  let n = 0; const sid = (tag) => `CA${tag}${String(++n).padStart(28, '0')}`;

  // I5 for one household, from the returned time limits only.
  async function assertI5(hh, admitted, label, adj = 0) {
    const a = await R.account(hh);
    const consumed = num(a.consumed_gbp) + num(a.essential_consumed_gbp) + num(a.unscreened_consumed_gbp || 0);
    const sumWorst = admitted.reduce((s, r) => s + worstJs(r), 0);
    const budgetFundedWorst = admitted.filter((r) => r.funding === 'budget').reduce((s, r) => s + worstJs(r), 0);
    const lim = ceiling(adj);
    check(consumed + sumWorst <= lim + EPS,
      `${label}: I5 consumed ${gbp(consumed)} + Σ worst ${gbp(sumWorst)} = ${gbp(consumed + sumWorst)} ≤ budget+adj+reserves ${gbp(lim)} (${admitted.length} live calls, never renewed)`);
    check(num(a.consumed_gbp) + budgetFundedWorst <= std.b + adj + EPS,
      `${label}: budget-funded calls alone stay inside budget+adj ${gbp(std.b + adj)} (unknown callers cannot reach the trusted reserve)`);
    const dbWorst = admitted.reduce((s, r) => s + num(r.worstCaseGbp || 0), 0);
    check(Math.abs(dbWorst - sumWorst) < 1e-6 || admitted.some((r) => r.worstCaseGbp === undefined),
      `${label}: JS recomputation of worst case agrees with the authority's own figure (${gbp(dbWorst)})`);
    for (const r of admitted) {
      if (twilioModel(r, { sdkBilled: true }) > worstJs(r) + EPS) {
        check(false, `${label}: per-leg Twilio model ${gbp(twilioModel(r))} ≤ Fortress worst ${gbp(worstJs(r))} for T=${r.timeLimitSeconds}s monitored=${r.monitoring}`);
        return { consumed, sumWorst };
      }
    }
    check(true, `${label}: per-leg Twilio model (parent ≤ T+60 s, SDK leg billed at list, stream stops with HCG) ≤ Fortress worst for every call`);
    return { consumed, sumWorst };
  }

  // ---------------- (a) single call, fresh household ----------------
  const A = await mk('a@example.com');
  const aT = await R.authorize(A, sid('t'), { known: true });
  check(aT.allowed && Number.isInteger(aT.timeLimitSeconds) && aT.timeLimitSeconds >= POLICY.lease,
    `(a) trusted call: timeLimit ${aT.timeLimitSeconds}s, worst ${gbp(worstJs(aT))}, funding ${aT.funding}`);
  await assertI5(A, [aT], '(a) single trusted call');

  const A2 = await mk('a2@example.com');
  const aU = await R.authorize(A2, sid('u'), { mon: true });
  check(aU.allowed && aU.monitoring === true,
    `(a) unknown monitored call: timeLimit ${aU.timeLimitSeconds}s, worst ${gbp(worstJs(aU))} (first lease + whole 30-min monitoring window)`);
  await assertI5(A2, [aU], '(a) single monitored unknown call');
  console.log(`  (a) per-leg Twilio model: trusted ${gbp(twilioModel(aT))} (SDK billed) / ${gbp(twilioModel(aT, { sdkBilled: false }))} (SDK £0 as today); unknown ${gbp(twilioModel(aU))} / ${gbp(twilioModel(aU, { sdkBilled: false }))}`);

  // ---------------- (b) concurrency: 3 calls (abuse cap) and 10 attempted (cap bypassed) ----------------
  const B = await mk('b@example.com');
  const b3 = [await R.authorize(B, sid('b'), { mon: true }), await R.authorize(B, sid('b'), { known: true }), await R.authorize(B, sid('b'), { known: true })];
  check(b3.every((r) => r.allowed), `(b) 3 concurrent calls admitted (1 monitored unknown + 2 trusted): limits ${b3.map((r) => r.timeLimitSeconds).join('/')} s`);
  const bRes = await assertI5(B, b3, '(b) 3 concurrent calls');

  const B10 = await mk('b10@example.com');
  const b10 = [];
  for (let i = 0; i < 10; i++) b10.push(await R.authorize(B10, sid('x'), { known: i % 2 === 0, mon: i % 2 === 1 }));
  const b10a = b10.filter((r) => r.allowed);
  check(b10a.length >= 1 && b10.filter((r) => !r.allowed).every((r) => r.reason === 'household_budget_exhausted'),
    `(b) 10 simultaneous calls with the per-household abuse cap assumed BROKEN: ${b10a.length} admitted, rest refused for budget`);
  const b10Res = await assertI5(B10, b10a, '(b) 10 attempted, cap bypassed');

  // ---------------- partially consumed household ----------------
  const C = await mk('c@example.com');
  const c1 = await R.authorize(C, sid('c'), { mon: true });
  await R.monStarted(c1 ? (await q("select call_sid from public.fc_reservations where id = $1", [c1.reservationId]))[0].call_sid : null);
  await R.settle((await q("select call_sid from public.fc_reservations where id = $1", [c1.reservationId]))[0].call_sid, 600, at(700), { monitoredSeconds: 600 });
  const cLive = [];
  for (let i = 0; i < 6; i++) { const r = await R.authorize(C, sid('c'), { known: i < 3, mon: i >= 3, now: at(800) }); if (r.allowed) cLive.push(r); }
  await assertI5(C, cLive, '(b′) after a 10-min monitored call was consumed, 6 more attempted');

  // ---------------- topped-up household (paid top-up modelled as +£5 adjustment) ----------------
  const D = await mk('d@example.com');
  await R.adjust(D, 5, 'topup-model-d');
  const dLive = [];
  for (let i = 0; i < 3; i++) { const r = await R.authorize(D, sid('d'), { known: i > 0, mon: i === 0 }); if (r.allowed) dLive.push(r); }
  await assertI5(D, dLive, '(b″) household with £5 extra credit, 3 concurrent', 5);
  const dMon = dLive.find((r) => r.monitoring);
  if (dMon) {
    const pess = twilioModel(dMon, { sdkBilled: true, streamOutlivesHcg: true });
    console.log(`  GAP (doc §5): monitored call with T=${dMon.timeLimitSeconds}s > 1800 s — if Twilio kept billing the Media Stream after HCG's WebSocket died AND billed the SDK leg at list, the per-leg cost would be ${gbp(pess)} vs Fortress worst ${gbp(worstJs(dMon))} (${pess > worstJs(dMon) ? 'EXCEEDS' : 'within'}); with the SDK leg at £0 (today): ${gbp(twilioModel(dMon, { sdkBilled: false, streamOutlivesHcg: true }))}`);
  }

  // ---------------- (c) global: many households, each calls until the global gate refuses ----------------
  // Simulated clean slate (earlier sections' calls marked settled) so the
  // global section measures fresh households only.
  const resetLive = async () => {
    await q("update public.fc_global_state set active_count = 0, active_reserved_gbp = 0, active_worst_case_gbp = 0");
    await q("update public.fc_reservations set state = 'settled', reserved_gbp = 0 where state in ('active','terminating')");
  };
  await resetLive();
  const before = (await q('select active_count, active_worst_case_gbp::float w from public.fc_global_state'))[0];
  const G = [];
  let refusedGlobal = null;
  for (let i = 0; i < 60 && !refusedGlobal; i++) {
    const hh = await mk(`g${i}@example.com`);
    const r = await R.authorize(hh, sid('g'), { known: true, mon: i % 2 === 1, now: at(900) });
    if (r.allowed) G.push(r); else refusedGlobal = r.reason;
  }
  const gs = (await q('select active_count, active_worst_case_gbp::float w, active_reserved_gbp::float res from public.fc_global_state'))[0];
  const allLive = await q("select backstop_seconds, monitored, worst_case_gbp::float w from public.fc_reservations where state in ('active','terminating')");
  const globalWorstJs = allLive.reduce((s, r) => s + callCost(r.backstop_seconds + POLICY.grace, { monitored: r.monitored }), 0);
  check(refusedGlobal && refusedGlobal.startsWith('global_'), `(c) global gate refuses new calls at ${gs.active_count} live calls (reason ${refusedGlobal}; active floor ${pol.global_active_floor}, worst-case floor ${gbp(pol.wc)}, exposure floor ${gbp(pol.ex)})`);
  check(gs.active_count <= pol.global_active_floor, `(c) live calls ${gs.active_count} ≤ active-call cap ${pol.global_active_floor} (no entitled count refreshed → floors)`);
  check(globalWorstJs <= pol.wc + EPS && Math.abs(globalWorstJs - gs.w) < 1e-4,
    `(c) Σ worst of ALL live calls if every server dies now = ${gbp(globalWorstJs)} ≤ global worst-case cap ${gbp(pol.wc)} (authority tracks ${gbp(gs.w)})`);
  console.log(`  (c) started with ${before.active_count} live calls from earlier sections; +${G.length} single calls on fresh households (alternating trusted / monitored unknown)`);

  // Unattributed calls (no household): 120 s backstop, own daily cap.
  await resetLive();
  const U = [];
  for (let i = 0; i < 200; i++) { const r = await R.authorize(null, sid('n'), { now: at(1000) }); if (r.allowed) U.push(r); else break; }
  const uWorst = U.reduce((s, r) => s + callCost(r.timeLimitSeconds + POLICY.grace), 0);
  check(U.length > 0 && U.every((r) => r.timeLimitSeconds === 120) && uWorst <= pol.ua + EPS,
    `unattributed calls (number with no household): ${U.length} admitted at timeLimit 120 s, Σ worst ${gbp(uWorst)} ≤ daily unattributed cap ${gbp(pol.ua)}`);

  // ---------------- arithmetic printed for the evidence doc ----------------
  const unit = POLICY.gran / 60 * POLICY.conn * POLICY.uplift;
  console.log(`  arithmetic: telephony block £${unit.toFixed(7)}/min (0.010718×1.1); first lease cost(360 s) ${gbp(callCost(360))}; monitoring window 30×0.008069×1.1 = ${gbp(30 * POLICY.mon * POLICY.uplift)}; max-call cost(14460 s, monitored) ${gbp(callCost(14460, { monitored: true }))}`);
  console.log(`  (b) 3-call household worst if servers die: consumed ${gbp(bRes.consumed)} + live ${gbp(bRes.sumWorst)}; 10-attempt household live ${gbp(b10Res.sumWorst)}`);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll server-death exposure checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
