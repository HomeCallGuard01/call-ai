#!/usr/bin/env node
// Fortress scale simulation (WS2, 2026-10-10). DETERMINISTIC, NO NETWORK.
//
// Builds a scratch PGlite database from EVERY migration in this tree, applies
// the recommended launch policy (docs/launch/2026-10-09-COST-LIMITS-
// RECOMMENDATION.md §3.4, verbatim values) or a scaled variant, then drives
// the REAL Fortress SQL (fc_authorize_call / fc_renew_lease / fc_settle_call /
// fc_authorize_spend) with a discrete-event simulation of N households for a
// simulated day:
//   * 90% genuine households drawn from the register's usage profiles
//     (light 40% / typical 45% / heavy 10% / very heavy 5%), Poisson arrivals,
//     exponential durations, unknown callers want screening;
//   * 10% EXTREMELY heavy households: 3 concurrent calls at all times (the
//     abuse-layer cap), 2 of them monitored unknown floods, re-dialled 5 s
//     after every end, retried every 5 min after a refusal (15 min while the
//     breaker is open) (stops once held:
//     a held household's calls are <Reject>ed unbilled);
//   * attacker extras: a spoofed-trusted flood (calls marked trusted), and
//     calls to numbers with no household (unattributed).
// The lease sweeper is modelled exactly: a renewal 60 s before each lease
// expiry; a refused renewal ends the call at its terminateAt; a call never
// outlives its <Dial timeLimit>.
//
// Usage: node scripts/sim/fortress-scale-sim.mjs [--n 100] [--policy recommended|scaled] [--hours 24] [--seed 1] [--extreme-share 0.10] [--json]
// Output: a summary (and JSON with --json). Same inputs ⇒ same output.
import { PGlite } from '@electric-sql/pglite';
import { applyAll } from '../../tests/financial-containment-harness.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const register = require('../../services/finance/economicsRegister.js');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const N = Number(args.n || 100);
const POLICY = String(args.policy || 'recommended');
const HOURS = Number(args.hours || 24);
const EXTREME_SHARE = args['extreme-share'] === undefined ? 0.10 : Number(args['extreme-share']);
let seed = Number(args.seed || 1) >>> 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const expo = (mean) => -Math.log(1 - rnd()) * mean;

const T0 = Date.parse('2026-10-12T00:00:00Z');
const PERIOD = ['2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'];
const END = HOURS * 3600;
const iso = (s) => new Date(T0 + Math.round(s * 1000)).toISOString();

// Billed-cost truth model (register; SDK leg billed £0 today — shown both ways).
const RATE = {
  inbound: register.value('twilioInboundGbpPerMin'),
  sdkList: register.appLegListGbpPerMin ? register.appLegListGbpPerMin() : 0.00316,
  stream: register.value('twilioMediaStreamGbpPerMin'),
  whisper: register.transcriptionGbpPerMin ? register.transcriptionGbpPerMin() : 0.00474,
  polly: register.value('twilioPollyGbpPerCall'),
  sms: register.value('twilioSmsGbpPerSegment'),
};
const NET_REVENUE = { stripe599: 4.99 - (5.99 * 0.027 + 0.20) - 4.99 * register.value('revenueLeakageRate') };

const RECOMMENDED = {
  max_call_seconds: 7200, household_auto_hold_daily_gbp: 2.00,
  global_hourly_floor_gbp: 4, global_hourly_per_household_gbp: 0.24,
  global_daily_floor_gbp: 10, global_daily_per_household_gbp: 0.60, global_daily_absolute_max_gbp: 25,
  global_exposure_floor_gbp: 5, global_exposure_per_household_gbp: 0.20,
  global_worst_case_floor_gbp: 20, global_worst_case_per_household_gbp: 0.80,
  global_active_floor: 10, global_active_households_per_call: 3,
  global_monitoring_hourly_floor_gbp: 2.5, global_monitoring_hourly_per_household_gbp: 0.10,
  global_unattributed_daily_gbp: 0.25, global_number_purchases_per_day: 3,
};
// WS2 proposal for N ≫ 25: the absolute daily ceiling and the live-call cap
// must scale with the cohort, or genuine traffic trips the breaker. Values
// derived from this simulation (report §4) — a DECISION for Andrew.
const SCALED = { ...RECOMMENDED, global_daily_absolute_max_gbp: Math.max(25, Math.ceil(N * 0.60)), global_active_households_per_call: 2 };

const PROFILES = [
  ['light', 0.40], ['typical', 0.45], ['heavy', 0.10], ['veryHeavy', 0.05],
].map(([k, w]) => ({ key: k, w, ...register.REGISTER.usageProfiles[k] }));

async function main() {
  const started = Date.now();
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const one = async (sql, p) => (await q(sql, p))[0].r;
  const policy = POLICY === 'scaled' ? SCALED : RECOMMENDED;
  await q('select public.fc_set_policy($1::jsonb, $2, $3)', [JSON.stringify(policy), `sim ${POLICY}`, 'sim']);
  for (const p of ['standard', 'plus', 'complimentary', 'internal_test']) {
    await q("select public.fc_set_budget_profile($1, 3.00, 0.50, 'trusted_only', 0.10, true, 'sim: AL-2 option A', 'sim')", [p]);
  }

  // Households
  const H = [];
  const extremeCount = Math.round(N * EXTREME_SHARE);
  for (let i = 0; i < N; i++) {
    const id = (await q('insert into public.households (email) values ($1) returning id', [`sim${i}@example.invalid`]))[0].id;
    await q("insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)", [id, PERIOD[0]]);
    let kind = 'extreme'; let prof = null;
    if (i >= extremeCount) {
      let x = rnd(); prof = PROFILES[PROFILES.length - 1];
      for (const p of PROFILES) { if (x < p.w) { prof = p; break; } x -= p.w; }
      kind = prof.key;
    }
    H.push({ i, id, kind, prof, live: 0, held: false, fortressGbp: 0, billedGbp: 0, billedSdkGbp: 0, calls: 0, refused: {}, cut: 0, monitored: 0 });
  }
  await one('select public.fc_refresh_entitled_count($1) as r', [iso(0)]);

  // Event queue (binary heap on time, FIFO tiebreak).
  const heap = []; let seq = 0;
  const push = (t, e) => { heap.push({ t, s: seq++, e }); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].t < heap[i].t || (heap[p].t === heap[i].t && heap[p].s < heap[i].s)) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; for (const c of [l, r]) if (c < heap.length && (heap[c].t < heap[m].t || (heap[c].t === heap[m].t && heap[c].s < heap[m].s))) m = c; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };

  for (const h of H) {
    if (h.kind === 'extreme') { for (let k = 0; k < 3; k++) push(rnd() * 60, { type: 'arrive', h, known: k === 2, mon: k < 2, dur: 7200 * 4 }); }
    else {
      const perDay = (h.prof.trustedCalls + h.prof.unknownCalls) / 30;
      const unknownShare = h.prof.unknownCalls / (h.prof.trustedCalls + h.prof.unknownCalls);
      h.rate = perDay / 86400; h.unknownShare = unknownShare;
      h.meanTrusted = 60 * h.prof.trusted / h.prof.trustedCalls; h.meanUnknown = 60 * h.prof.unknownMinutes / h.prof.unknownCalls;
      push(expo(1 / h.rate), { type: 'arrive', h });
    }
  }
  // Attacker extras: spoofed-trusted flood on 1 extreme household; 500 unattributed calls.
  if (H[0] && H[0].kind === 'extreme') H[0].spoofTrusted = true;   // spoofed trusted CLI flood (Fortress sees is_known = true)
  for (let k = 0; k < 500; k++) push(rnd() * END, { type: 'unattributed' });

  const minutes = new Map(); // hour → Fortress committed+reserved snapshot
  const globalLog = []; const breakerTrips = []; let unattrib = { allowed: 0, refused: 0 };
  let sidN = 0; const sid = () => `CA${String(++sidN).padStart(32, '0')}`;
  const calls = new Map();
  let rpc = 0;

  async function startCall(t, h, { known, mon, dur }) {
    if (h.live >= 3) return 'household_concurrency';
    const s = sid(); rpc++;
    const r = await one('select public.fc_authorize_call($1,$2,$3,$4,false,$5,$6,$7,null) as r', [h.id, s, known, mon, PERIOD[0], PERIOD[1], iso(t)]);
    if (!r.allowed) { h.refused[r.reason] = (h.refused[r.reason] || 0) + 1; if (r.reason === 'household_hold') h.held = true; return r.reason; }
    h.live++; h.calls++; if (r.monitoring) h.monitored++;
    const end = t + Math.min(dur, r.timeLimitSeconds);
    const c = { s, h, t0: t, end, mon: r.monitoring, known, limit: r.timeLimitSeconds, lease: Date.parse(r.leaseExpiresAt) / 1000 - T0 / 1000, done: false };
    calls.set(s, c);
    push(end, { type: 'end', c });
    if (c.lease - 60 < end) push(Math.max(t + 1, c.lease - 60), { type: 'renew', c });
    // The media stream starts (production: markMonitoringStarted on the stream's start frame).
    if (r.monitoring) { rpc++; await one('select public.fc_mark_monitoring_started($1) as r', [s]); }
    if (r.monitoring && rnd() < 0.05) { rpc++; await one("select public.fc_authorize_spend($1,$2,'sms',1,$3,$4,$5,null) as r", [`${s}:w`, h.id, PERIOD[0], PERIOD[1], iso(t + 30)]); }
    return null;
  }
  async function endCall(t, c, source) {
    if (c.done) return; c.done = true; c.h.live--;
    const secs = Math.max(1, Math.round(t - c.t0)); rpc++;
    const r = await one('select public.fc_settle_call($1,$2,null,$3,$4) as r', [c.s, secs, source, iso(t)]);
    const mins = Math.ceil(secs / 60);
    const monMins = c.mon ? Math.min(mins, 30) : 0;
    const billed = mins * RATE.inbound + monMins * (RATE.stream + RATE.whisper) + (c.mon ? RATE.polly : 0);
    c.h.billedGbp += billed; c.h.billedSdkGbp += billed + mins * RATE.sdkList;
    c.h.fortressGbp += Number(r.committedGbp || 0);
    calls.delete(c.s);
    const h = c.h;
    if (h.kind === 'extreme') push(t + 5, { type: 'arrive', h, known: c.known, mon: c.mon, dur: 7200 * 4 });
  }

  let nextSnap = 0;
  let nextRefresh = 1800;
  while (heap.length) {
    const { t, e } = pop();
    if (t > END) break;
    // The production sweeper refreshes the entitled count every 30 min
    // (leaseSweeper.js); without it the count goes stale after 26 h and the
    // caps fall to their floors (fail-safe: the breaker trips).
    while (t >= nextRefresh) { rpc++; await one('select public.fc_refresh_entitled_count($1) as r', [iso(nextRefresh)]); nextRefresh += 1800; }
    while (t >= nextSnap) {
      const g = await one('select public.fc_global_status($1) as r', [iso(nextSnap)]);
      globalLog.push({ hour: nextSnap / 3600, dayCommitted: Number(g.window.dayCommitted), hourCommitted: Number(g.window.hourCommitted), active: g.activeCount, reserved: Number(g.activeReservedGbp), breaker: g.breakerOpen, caps: g.caps });
      nextSnap += 3600;
    }
    if (e.type === 'arrive') {
      const h = e.h;
      if (h.kind === 'extreme') {
        const reason = await startCall(t, h, { known: h.spoofTrusted ? true : e.known, mon: h.spoofTrusted ? false : e.mon, dur: e.dur });
        // Refusals are <Reject>ed unbilled; the attacker retries (every 5 min, or 15 min while the breaker is open).
        if (reason && reason !== 'household_hold' && reason !== 'household_concurrency') push(t + (reason === 'breaker_open' ? 900 : 300), { type: 'arrive', h, known: e.known, mon: e.mon, dur: e.dur });
      } else {
        const unknown = rnd() < h.unknownShare;
        const dur = Math.max(5, expo(unknown ? h.meanUnknown : h.meanTrusted));
        await startCall(t, h, { known: !unknown, mon: unknown, dur });
        push(t + expo(1 / h.rate), { type: 'arrive', h });
      }
    } else if (e.type === 'renew') {
      const c = e.c; if (c.done) continue;
      rpc++;
      const r = await one('select public.fc_renew_lease($1,$2,null) as r', [c.s, iso(t)]);
      if (r.action === 'renewed') { c.lease = Date.parse(r.leaseExpiresAt) / 1000 - T0 / 1000; if (c.lease - 60 < c.end) push(Math.max(t + 1, c.lease - 60), { type: 'renew', c }); }
      else if (r.action === 'not_due') push(t + 30, { type: 'renew', c });
      else if (r.action === 'terminate') { const at = Math.max(t, Date.parse(r.terminateAt) / 1000 - T0 / 1000); if (at < c.end) { c.end = at; c.h.cut++; push(at, { type: 'end', c, cut: r.reason }); } }
    } else if (e.type === 'end') {
      if (e.c.end !== t && !e.cut) continue; // superseded by an earlier cut
      await endCall(t, e.c, e.cut ? `terminated:${e.cut}` : 'completed');
    } else if (e.type === 'unattributed') {
      rpc++;
      const r = await one('select public.fc_authorize_call(null,$1,false,false,false,$2,$3,$4,null) as r', [sid(), PERIOD[0], PERIOD[1], iso(t)]);
      if (r.allowed) { unattrib.allowed++; } else unattrib.refused++;
    }
  }
  // Close out live calls at END.
  for (const c of [...calls.values()]) await endCall(Math.min(END, c.end), c, 'sim_end');
  const g = await one('select public.fc_global_status($1) as r', [iso(END)]);
  const inv = await one('select public.fc_check_invariants() as r', []);
  // fc_events.created_at is wall-clock; the breaker's own opened_at is SIM time.
  const trips = (await q("select breaker_opened_at, breaker_reason from public.fc_global_state where id = 1 and breaker_open"))
    .map((r) => ({ hour: +((Date.parse(new Date(r.breaker_opened_at).toISOString()) - T0) / 3600e3).toFixed(2), reason: r.breaker_reason }));
  const holds = (await q("select count(*)::int n from public.fc_household_holds"))[0].n;

  const byKind = {};
  for (const h of H) {
    const k = byKind[h.kind] || (byKind[h.kind] = { n: 0, fortress: [], billed: [], billedSdk: [], refusedNonHold: 0, refusedBudget: 0, refusedGlobal: 0, cut: 0, held: 0, calls: 0 });
    k.n++; k.fortress.push(h.fortressGbp); k.billed.push(h.billedGbp); k.billedSdk.push(h.billedSdkGbp); k.calls += h.calls; k.cut += h.cut; k.held += h.held ? 1 : 0;
    for (const [r, c] of Object.entries(h.refused)) {
      if (r === 'household_budget_exhausted') k.refusedBudget += c;
      else if (r !== 'household_hold') k.refusedGlobal += c;
    }
  }
  const stat = (a) => { const s = [...a].sort((x, y) => x - y); const p = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))]; return { mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(4), p50: +p(0.5).toFixed(4), p99: +p(0.99).toFixed(4), max: +s[s.length - 1].toFixed(4) }; };
  const kinds = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { households: v.n, calls: v.calls, held: v.held, cutCalls: v.cut,
    refusedBudget: v.refusedBudget, refusedGlobal: v.refusedGlobal, fortressGbp: stat(v.fortress), billedGbp: stat(v.billed), billedWithSdkGbp: stat(v.billedSdk) }]));
  const totalFortress = H.reduce((s, h) => s + h.fortressGbp, 0);
  const totalBilled = H.reduce((s, h) => s + h.billedGbp, 0);
  const genuine = H.filter((h) => h.kind !== 'extreme');
  const genuineGlobalRefusals = genuine.reduce((s, h) => s + Object.entries(h.refused).filter(([r]) => r.startsWith('global') || r === 'breaker_open' || r === 'kill_switch').reduce((x, [, c]) => x + c, 0), 0);
  const genuineAttempts = genuine.reduce((s, h) => s + h.calls + Object.values(h.refused).reduce((x, c) => x + c, 0), 0);
  // Month-scale projection of GENUINE demand against the per-period profile
  // (£3.00 budget + £0.50 trusted reserve): who would exhaust screening / hit
  // the ceiling before the period ends at this day's rate (linear, illustrative).
  const scale = (24 / HOURS) * 30;
  const proj = genuine.map((h) => h.fortressGbp * scale);
  const monthly = {
    screeningExhaustedShare: +(proj.filter((x) => x > 3.0).length / Math.max(1, genuine.length)).toFixed(4),
    ceilingReachedShare: +(proj.filter((x) => x > 3.5).length / Math.max(1, genuine.length)).toFixed(4),
    byKind: Object.fromEntries(PROFILES.map((p) => { const g = genuine.filter((h) => h.kind === p.key).map((h) => h.fortressGbp * scale); return [p.key, { households: g.length, overBudget: g.filter((x) => x > 3.0).length, overCeiling: g.filter((x) => x > 3.5).length }]; })),
  };
  const out = {
    n: N, policy: POLICY, hours: HOURS, extremeShare: EXTREME_SHARE, seed: Number(args.seed || 1), rpcCalls: rpc, wallSeconds: Math.round((Date.now() - started) / 1000),
    caps: g.caps, final: { breakerOpen: g.breakerOpen, breakerReason: g.breakerReason, dayCommittedGbp: +Number(g.window.dayCommitted).toFixed(4) },
    breakerTrips: trips, householdsHeld: holds,
    totals: { fortressGbp: +totalFortress.toFixed(2), billedGbp: +totalBilled.toFixed(2), unattributed: unattrib },
    genuine: { attempts: genuineAttempts, refusedByGlobalControls: genuineGlobalRefusals, refusedShare: genuineAttempts ? +(genuineGlobalRefusals / genuineAttempts).toFixed(4) : 0 },
    perKind: kinds, genuineMonthlyProjection: monthly, invariantsOk: inv.ok,
    revenueNetPerMonthStripe599: +NET_REVENUE.stripe599.toFixed(2),
    hourly: globalLog.map((x) => ({ h: x.hour, dayCommitted: +x.dayCommitted.toFixed(2), hourCommitted: +x.hourCommitted.toFixed(2), active: x.active, breaker: x.breaker })),
  };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`Fortress scale sim — N=${N} policy=${POLICY} ${HOURS}h seed=${out.seed} (${rpc} RPCs, ${out.wallSeconds}s)`);
    console.log(`caps: hourly £${g.caps.hourly} daily £${g.caps.daily} active ${g.caps.active} exposure £${g.caps.exposure} worstCase £${g.caps.worstCase}`);
    console.log(`breaker trips: ${trips.length ? trips.map((r) => `${r.reason} at hour ${r.hour}`).join(', ') : 'none'}; final breakerOpen=${g.breakerOpen}`);
    console.log(`households held: ${holds}; total Fortress £${out.totals.fortressGbp}; billed £${out.totals.billedGbp}; unattributed ${JSON.stringify(unattrib)}`);
    console.log(`genuine attempts ${genuineAttempts}, refused by GLOBAL controls ${genuineGlobalRefusals} (${(out.genuine.refusedShare * 100).toFixed(1)}%)`);
    for (const [k, v] of Object.entries(kinds)) console.log(`  ${k.padEnd(9)} n=${v.households} calls=${v.calls} held=${v.held} cut=${v.cutCalls} refBudget=${v.refusedBudget} refGlobal=${v.refusedGlobal} fortress(run) max £${v.fortressGbp.max} p99 £${v.fortressGbp.p99} billed(run) max £${v.billedGbp.max}`);
    console.log(`genuine month projection: ${(monthly.screeningExhaustedShare * 100).toFixed(1)}% exhaust the £3.00 screening budget, ${(monthly.ceilingReachedShare * 100).toFixed(1)}% reach the £3.50 ceiling — ${JSON.stringify(monthly.byKind)}`);
    console.log(`invariants ok: ${inv.ok}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
