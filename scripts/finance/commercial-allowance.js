#!/usr/bin/env node
// commercial-allowance.js — deterministic calculator behind
// docs/launch/2026-10-10-COMMERCIAL-ALLOWANCE-PROPOSAL.md (WS2, 2026-10-10).
//
// Pure + seeded. No network, no database, no env. Every rate comes from the
// authoritative register (services/finance/assumptions/hcg-unit-economics.v1.json)
// via economicsRegister / hcgUnitEconomics, so this model cannot drift from
// the unit-economics register. Fortress charges are computed with the exact
// fc_call_cost formula of migration 067 and the admission rules of 076
// (budget → trusted_only delivery reserve → unscreened reserve; a screened
// call needs first lease + the whole monitoring window from the budget).
//
// It decides NOTHING. It sizes candidate fc_budget_profiles for Andrew.
//
//   node scripts/finance/commercial-allowance.js            # human summary
//   node scripts/finance/commercial-allowance.js --json     # full results
//   node scripts/finance/commercial-allowance.js --md       # tables file
//
// Margin definition (identical to the register, HCG_UNIT_ECONOMICS_V1 §4):
//   gross margin = (net − payment/store fee − leakage − number rental
//                   − churned-number overhang − infra allocation − usage) ÷ net
//   net = price ÷ 1.2. Staff/marketing/company overheads are NOT deducted.
'use strict';

const register = require('../../services/finance/economicsRegister');
const econ = require('../../services/finance/hcgUnitEconomics');

const v = register.value;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const pct = (n) => Math.round(n * 1000) / 10;

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------
const FORTRESS = Object.freeze({
  conn: v('fortressConnectedRateGbpPerMin'),   // fc_policy.connected_rate_gbp_per_min (inbound + SDK leg at list)
  mon: v('fortressMonitoringRateGbpPerMin'),   // fc_policy.monitoring_rate_gbp_per_min (stream + whisper)
  uplift: v('fortressEstimateUplift'),
  gran: 60,            // billing_granularity_seconds
  fixed: v('twilioPollyGbpPerCall'),            // fc_policy.call_fixed_fee_gbp (067 default = the Polly greeting)
  leaseSeconds: 300,
  graceSeconds: 60,
  sms: v('twilioSmsGbpPerSegment'),
});

const BILLED = Object.freeze({
  inbound: v('twilioInboundGbpPerMin'),
  sdkList: register.appLegListGbpPerMin(),
  stream: v('twilioMediaStreamGbpPerMin'),
  whisper: register.transcriptionGbpPerMin(),
  polly: v('twilioPollyGbpPerCall'),
  sms: v('twilioSmsGbpPerSegment'),
});

/** migration 067 fc_call_cost, verbatim. */
function fcCallCost(seconds, monitored, monMaxSeconds, { conn = FORTRESS.conn, fixed = FORTRESS.fixed } = {}) {
  if (!(seconds > 0)) return 0;
  const g = FORTRESS.gran;
  const telMin = Math.ceil(seconds / g) * g / 60;
  const monMin = monitored ? Math.ceil(Math.min(seconds, monMaxSeconds) / g) * g / 60 : 0;
  return telMin * conn * FORTRESS.uplift + monMin * FORTRESS.mon * FORTRESS.uplift + fixed;
}

/** What Fortress must find in the budget before it will SCREEN a call. */
function screeningAdmissionGbp(monMaxSeconds) {
  return fcCallCost(FORTRESS.leaseSeconds + FORTRESS.graceSeconds, false, monMaxSeconds)
    + fcCallCost(monMaxSeconds, true, monMaxSeconds, { conn: 0, fixed: 0 });
}
const telLeaseGbp = () => fcCallCost(FORTRESS.leaseSeconds + FORTRESS.graceSeconds, false, 0);

/** Provider-billed cost of one delivered call (today, or with the SDK leg billed at list). */
function billedCall(seconds, monitored, monMaxSeconds, sdkBilled) {
  const mins = Math.ceil(seconds / 60);
  const monSecs = monitored ? Math.min(seconds, monMaxSeconds) : 0;
  return mins * BILLED.inbound
    + (sdkBilled ? mins * BILLED.sdkList : 0)
    + (monitored ? Math.ceil(monSecs / 60) * BILLED.stream + (monSecs / 60) * BILLED.whisper + BILLED.polly : 0);
}

/** Largest billed ÷ Fortress ratio any call can reach (worst-case conversion of a £ pool). */
function worstBilledRatio(sdkBilled) {
  // Long calls dominate (per-call fixed fee and per-second transcription make short calls cheaper billed).
  const secs = 1800;
  return Math.max(
    billedCall(secs, true, 1800, sdkBilled) / fcCallCost(secs, true, 1800),
    billedCall(secs, false, 1800, sdkBilled) / fcCallCost(secs, false, 1800),
  );
}

// ---------------------------------------------------------------------------
// Usage assumptions (ESTIMATED — no measured distribution exists)
// ---------------------------------------------------------------------------
const P = require('../../services/finance/assumptions/hcg-unit-economics.v1.json').usageProfiles;
const SEGMENTS = Object.freeze([
  { key: 'light', label: 'Light', share: 0.40, band: '≈ P0–P40', ...P.light },
  { key: 'typical', label: 'Typical', share: 0.45, band: '≈ P40–P85', ...P.typical },
  { key: 'heavy', label: 'Heavy', share: 0.10, band: '≈ P85–P95', ...P.heavy },
  { key: 'extreme', label: 'Extreme', share: 0.05, band: '≈ P95–P100', ...P.veryHeavy },
]);

// ---------------------------------------------------------------------------
// Deterministic random numbers
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(lambda, rnd) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0; let p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}
function normal(rnd) {
  const u = Math.max(rnd(), 1e-12); const w = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}
/** Call duration in seconds: exponential (cv = 1, as the WS2 scale sim) or lognormal (heavier tail). */
function duration(meanSec, cv, rnd) {
  let s;
  if (cv === 1) s = -Math.log(Math.max(rnd(), 1e-12)) * meanSec;
  else {
    const sigma = Math.sqrt(Math.log(1 + cv * cv));
    const mu = Math.log(meanSec) - sigma * sigma / 2;
    s = Math.exp(mu + sigma * normal(rnd));
  }
  return Math.max(5, Math.min(s, 4 * 3600));
}

// ---------------------------------------------------------------------------
// One household-month through a Fortress-faithful ledger
// ---------------------------------------------------------------------------
/**
 * profile: { budget, trustedReserve, unscreenedReserve, essential, monMaxSeconds }
 * mode:    'A' unconditional forwarding (every call reaches HCG)
 *          'B' trusted-caller bypass (trusted calls never reach HCG; unknown calls forwarded on no-answer)
 * reserveFirst: trusted calls draw the trusted reserve BEFORE the budget (a proposed 076 change; not built)
 */
function simulateMonth(seg, profile, { mode = 'A', cv = 1, rnd, reserveFirst = false, demandScale = 1 }) {
  const mon = profile.monMaxSeconds;
  const admit = screeningAdmissionGbp(mon);
  const lease = telLeaseGbp();
  const events = [];
  const nT = poisson(seg.trustedCalls * demandScale, rnd);
  const nU = poisson(seg.unknownCalls * demandScale, rnd);
  const nS = poisson(seg.sms * demandScale, rnd);
  const meanT = 60 * seg.trusted / seg.trustedCalls;
  const meanU = 60 * seg.unknownMinutes / seg.unknownCalls;
  for (let i = 0; i < nT; i++) events.push({ t: rnd(), k: 'T', s: duration(meanT, cv, rnd) });
  for (let i = 0; i < nU; i++) events.push({ t: rnd(), k: 'U', s: duration(meanU, cv, rnd) });
  for (let i = 0; i < nS; i++) events.push({ t: rnd(), k: 'S' });
  events.sort((a, b) => a.t - b.t);

  let budgetUsed = 0; let reserveUsed = 0; let unscreenedUsed = 0;
  const out = { fortress: 0, billed: 0, billedSdk: 0, demandFortress: 0, demandBilled: 0,
    pausedAt: null, refusedTrusted: 0, refusedUnknown: 0, unscreenedCalls: 0, unmonitoredUnknown: 0,
    trustedMinutes: 0, unknownMinutes: 0, trustedFortress: 0, cutCalls: 0 };
  const availBudget = () => profile.budget - budgetUsed;
  const checkPause = (t) => { if (out.pausedAt === null && availBudget() < admit) out.pausedAt = t; };

  for (const e of events) {
    if (e.k === 'S') {
      const c = FORTRESS.sms * FORTRESS.uplift;
      out.demandFortress += c; out.demandBilled += BILLED.sms;
      if (availBudget() >= c) { budgetUsed += c; out.fortress += c; out.billed += BILLED.sms; out.billedSdk += BILLED.sms; }
      checkPause(e.t);
      continue;
    }
    if (e.k === 'T') {
      out.trustedMinutes += e.s / 60;
      if (mode === 'B') continue; // never reaches HCG
      out.demandFortress += fcCallCost(e.s, false, mon); out.demandBilled += billedCall(e.s, false, mon, false);
      // Fortress (067/076): avail_reserve = avail_budget + delivery reserve, i.e. ONE ledger in which the
      // trusted_only reserve is extra headroom for trusted calls once the budget is spent (budget-first).
      // reserveFirst (proposed, not built): the reserve is drawn first, the budget after.
      const resLeft = profile.trustedReserve - reserveUsed;
      const room = availBudget() + resLeft;
      const admitted = reserveFirst ? (resLeft >= lease || availBudget() >= lease) && room >= lease : room >= lease;
      if (!admitted) { out.refusedTrusted++; checkPause(e.t); continue; }
      const secs = cutToHeadroom(e.s, false, mon, room + lease);
      const c = fcCallCost(secs, false, mon);
      if (reserveFirst) { const fromRes = Math.min(c, Math.max(0, resLeft)); reserveUsed += fromRes; budgetUsed += c - fromRes; }
      else budgetUsed += c; // consumed is shared; the reserve is the headroom below zero
      if (secs < e.s) out.cutCalls++;
      out.fortress += c; out.trustedFortress += c;
      out.billed += billedCall(secs, false, mon, false); out.billedSdk += billedCall(secs, false, mon, true);
      checkPause(e.t);
      continue;
    }
    // Unknown caller.
    out.unknownMinutes += e.s / 60;
    out.demandFortress += fcCallCost(e.s, true, mon); out.demandBilled += billedCall(e.s, true, mon, false);
    let monitored = false; let pool;
    if (availBudget() >= admit) { monitored = true; pool = 'budget'; }
    else if (availBudget() >= lease) { pool = 'budget'; out.unmonitoredUnknown++; }
    else if (profile.unscreenedReserve - unscreenedUsed >= lease) { pool = 'unscreened'; out.unscreenedCalls++; out.unmonitoredUnknown++; }
    else { out.refusedUnknown++; checkPause(e.t); continue; }
    const room = pool === 'budget' ? availBudget() : profile.unscreenedReserve - unscreenedUsed;
    const secs = cutToHeadroom(e.s, monitored, mon, room + lease);
    const c = fcCallCost(secs, monitored, mon);
    if (pool === 'budget') budgetUsed += c; else unscreenedUsed += c;
    if (secs < e.s) out.cutCalls++;
    out.fortress += c;
    out.billed += billedCall(secs, monitored, mon, false); out.billedSdk += billedCall(secs, monitored, mon, true);
    checkPause(e.t);
  }
  return out;
}

/**
 * Fortress never lets a live call spend past its funding pool by more than about
 * one lease: renewals need headroom and the provider timeLimit is a share of it.
 * Model: the call ends at the last whole minute whose cost fits room + one lease.
 */
function cutToHeadroom(seconds, monitored, monMaxSeconds, maxCost) {
  if (fcCallCost(seconds, monitored, monMaxSeconds) <= maxCost) return seconds;
  let mins = Math.ceil(seconds / 60);
  while (mins > 1 && fcCallCost(mins * 60, monitored, monMaxSeconds) > maxCost) mins--;
  return mins * 60;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------
function channelEconomics(priceIncVat, channel = 'stripe') {
  const rev = econ.revenue({ priceIncVatGbp: priceIncVat, channel });
  const fixed = econ.fixedPerCustomer({ channel, priceIncVatGbp: priceIncVat }).total;
  return { price: priceIncVat, channel, net: rev.net, fee: rev.fee, leakage: rev.leakage, afterFees: rev.afterFees, fixed, usageRoom: rev.afterFees - fixed };
}
const margin = (ch, usage) => (ch.afterFees - ch.fixed - usage) / ch.net;
const contribution = (ch, usage) => ch.afterFees - ch.fixed - usage;

// Overrun: a live call can pass its pool by at most about one lease (renewal needs headroom; the
// provider timeLimit is a share of it). Bound used here: one 360 s lease per reachable pool
// (budget ∪ trusted reserve, unscreened, essential). Stricter than the register's flat £0.10.
const OVERRUN_GBP = v('overrunAllowanceGbp');
function overrunFor(profile) {
  const pools = 1 + (profile.unscreenedReserve > 0 ? 1 : 0) + (profile.essential > 0 ? 1 : 0);
  return pools * telLeaseGbp();
}
function worstCase(profile, ch) {
  const overrun = overrunFor(profile);
  const fortress = profile.budget + profile.trustedReserve + profile.unscreenedReserve + profile.essential + overrun;
  const billedToday = fortress * worstBilledRatio(false);
  const billedSdk = fortress * worstBilledRatio(true);
  return {
    fortress, overrun, billedToday, billedSdk,
    contributionToday: ch.usageRoom - billedToday,
    contributionSdk: ch.usageRoom - billedSdk,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const DEFAULTS = Object.freeze({ households: 6000, seed: 20261010 });

function runSegment(seg, profile, opts) {
  const n = opts.households || DEFAULTS.households;
  // Common random numbers: the seed depends on the segment's demand only, never on the
  // profile, mode or price, so every case sees the SAME household-months and differences
  // between cases are policy effects, not sampling noise. (Events are drawn before any
  // ledger decision, and mode B draws exactly what mode A draws.)
  const rnd = mulberry32((opts.seed || DEFAULTS.seed) ^ hash(seg.key + '|' + seg.trusted + '|' + seg.trustedCalls + '|' + (opts.cv || 1) + '|' + (opts.demandScale || 1)));
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(simulateMonth(seg, profile, { ...opts, rnd }));
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / n;
  const sortedDemand = rows.map((r) => r.demandFortress).sort((a, b) => a - b);
  return {
    segment: seg.key,
    households: n,
    pausedShare: mean((r) => (r.pausedAt !== null ? 1 : 0)),
    pausedBeforeDay20Share: mean((r) => (r.pausedAt !== null && r.pausedAt < 20 / 30 ? 1 : 0)),
    anyRefusalShare: mean((r) => (r.refusedTrusted + r.refusedUnknown > 0 ? 1 : 0)),
    trustedRefusedShare: mean((r) => (r.refusedTrusted > 0 ? 1 : 0)),
    meanFortress: mean((r) => r.fortress),
    meanBilled: mean((r) => r.billed),
    meanBilledSdk: mean((r) => r.billedSdk),
    meanDemandFortress: mean((r) => r.demandFortress),
    meanDemandBilled: mean((r) => r.demandBilled),
    p50DemandFortress: quantile(sortedDemand, 0.5),
    p90DemandFortress: quantile(sortedDemand, 0.9),
    p99DemandFortress: quantile(sortedDemand, 0.99),
    maxFortress: Math.max(...rows.map((r) => r.fortress)),
  };
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function evaluate(profile, { mode = 'A', cv = 1, price = 5.99, channel = 'stripe', reserveFirst = false, households, seed, segments = SEGMENTS, demandScale = 1 } = {}) {
  const ch = channelEconomics(price, channel);
  const segs = segments.map((seg) => {
    const s = runSegment(seg, profile, { mode, cv, reserveFirst, households, seed, demandScale });
    return {
      ...s, share: seg.share,
      marginBilled: margin(ch, s.meanBilled),
      marginSdk: margin(ch, s.meanBilledSdk),
      marginFortress: margin(ch, s.meanFortress),
      contributionBilled: contribution(ch, s.meanBilled),
    };
  });
  const w = (f) => segs.reduce((s, x) => s + x.share * f(x), 0);
  const blended = {
    marginBilled: w((x) => contribution(ch, x.meanBilled)) / ch.net,
    marginSdk: w((x) => contribution(ch, x.meanBilledSdk)) / ch.net,
    marginFortress: w((x) => contribution(ch, x.meanFortress)) / ch.net,
    pausedShare: w((x) => x.pausedShare),
    trustedRefusedShare: w((x) => x.trustedRefusedShare),
  };
  return { profile, mode, cv, price, channel, reserveFirst, economics: ch, worstCase: worstCase(profile, ch), segments: segs, blended };
}

/** Uncapped demand cost per segment under A/B on every basis (no pool, nothing refused). */
function uncappedCosts({ cv = 1, households, seed } = {}) {
  const open = { budget: 1e6, trustedReserve: 0, unscreenedReserve: 0, essential: 0, monMaxSeconds: 1800 };
  const out = {};
  for (const mode of ['A', 'B']) {
    out[mode] = SEGMENTS.map((seg) => {
      const s = runSegment(seg, open, { mode, cv, households, seed });
      return { segment: seg.key, billed: s.meanBilled, billedSdk: s.meanBilledSdk, fortress: s.meanFortress, p90Fortress: s.p90DemandFortress };
    });
  }
  return out;
}

/** Smallest budget (5p steps) at which ≥ target of a segment never pauses. */
function minBudgetFor(segKey, { target = 0.9, mode = 'A', cv = 1, monMaxSeconds = 1800, trustedReserve = 0, reserveFirst = false, households, seed } = {}) {
  const seg = SEGMENTS.find((s) => s.key === segKey);
  for (let b = 0.5; b <= 20; b = Math.round((b + 0.05) * 100) / 100) {
    const s = runSegment(seg, { budget: b, trustedReserve, unscreenedReserve: 0, essential: 0, monMaxSeconds }, { mode, cv, reserveFirst, households, seed });
    if (1 - s.pausedShare >= target) return b;
  }
  return null;
}

/** Monitoring-efficiency estimate: billed £ saved per segment-month by capping monitoring at N seconds. */
function monitoringCapSavings(capSeconds, { cv = 1, households, seed } = {}) {
  const base = uncappedCosts({ cv, households, seed }).A;
  const open = { budget: 1e6, trustedReserve: 0, unscreenedReserve: 0, essential: 0, monMaxSeconds: capSeconds };
  return SEGMENTS.map((seg, i) => {
    const s = runSegment(seg, open, { mode: 'A', cv, households, seed });
    return { segment: seg.key, savedBilled: base[i].billed - s.meanBilled };
  });
}

// ---------------------------------------------------------------------------
// The candidate profiles (fc_budget_profiles + 076 unscreened reserve + fc_policy.monitoring_max_seconds)
// ---------------------------------------------------------------------------
const PROFILES = Object.freeze({
  current: { label: 'Current recommendation (cost-limits 2026-10-09)', budget: 3.00, trustedReserve: 0.50, unscreenedReserve: 0, essential: 0.10, monMaxSeconds: 1800 },
  opt1: { label: 'Option 1 (launch): one full-month pool at £5.99, no code change', budget: 4.20, trustedReserve: 0, unscreenedReserve: 0, essential: 0.10, monMaxSeconds: 1800 },
  opt1m: { label: 'Option 1 variant: 15-minute monitoring window, small trusted reserve', budget: 4.10, trustedReserve: 0.10, unscreenedReserve: 0, essential: 0.10, monMaxSeconds: 900 },
  opt1s: { label: 'Option 1-S: same £ as Option 1, trusted reserve drawn first (076 change, not built)', budget: 2.10, trustedReserve: 2.10, unscreenedReserve: 0, essential: 0.10, monMaxSeconds: 1800 },
  opt2: { label: 'Option 2: break-even even if the SDK leg is billed', budget: 3.25, trustedReserve: 0.20, unscreenedReserve: 0, essential: 0.10, monMaxSeconds: 1800 },
  opt3: { label: 'Option 3: £6.99 standard (meets 40% under A)', budget: 4.70, trustedReserve: 0.50, unscreenedReserve: 0, essential: 0.10, monMaxSeconds: 1800 },
  familyPlus: { label: 'Family tier £9.99 (plus profile)', budget: 7.20, trustedReserve: 0.50, unscreenedReserve: 0.20, essential: 0.10, monMaxSeconds: 1800 },
  bypass: { label: 'If the bypass passes (B): screening-only pool', budget: 2.60, trustedReserve: 0.50, unscreenedReserve: 0.20, essential: 0.10, monMaxSeconds: 1800 },
});

function computeAll(opts = {}) {
  const o = { households: opts.households || DEFAULTS.households, seed: opts.seed || DEFAULTS.seed };
  const ch599 = channelEconomics(5.99, 'stripe');
  const res = {
    asOf: '2026-10-10',
    inputs: { FORTRESS, BILLED, OVERRUN_GBP, segments: SEGMENTS, households: o.households, seed: o.seed,
      screeningAdmission1800: screeningAdmissionGbp(1800), screeningAdmission900: screeningAdmissionGbp(900), screeningAdmission600: screeningAdmissionGbp(600),
      telLease: telLeaseGbp(), worstBilledRatioToday: worstBilledRatio(false), worstBilledRatioSdk: worstBilledRatio(true) },
    channels: {
      stripe599: ch599,
      google599: channelEconomics(5.99, 'google15'),
      stripe499: channelEconomics(4.99, 'stripe'),
      stripe799: channelEconomics(7.99, 'stripe'),
      stripe999: channelEconomics(9.99, 'stripe'),
    },
    uncapped: uncappedCosts({ ...o, cv: 1 }),
    uncappedHeavyTail: uncappedCosts({ ...o, cv: 1.5 }),
    minBudgetTypical90: {
      A_1800: minBudgetFor('typical', { ...o, mode: 'A', monMaxSeconds: 1800 }),
      A_1800_heavyTail: minBudgetFor('typical', { ...o, mode: 'A', monMaxSeconds: 1800, cv: 1.5 }),
      A_900: minBudgetFor('typical', { ...o, mode: 'A', monMaxSeconds: 900 }),
      B_1800: minBudgetFor('typical', { ...o, mode: 'B', monMaxSeconds: 1800 }),
      B_1800_heavyTail: minBudgetFor('typical', { ...o, mode: 'B', monMaxSeconds: 1800, cv: 1.5 }),
    },
    monitoringCapSavings: { s900: monitoringCapSavings(900, o), s600: monitoringCapSavings(600, o) },
    options: {},
  };
  const cases = [
    ['current', PROFILES.current, { mode: 'A' }],
    ['opt1', PROFILES.opt1, { mode: 'A' }],
    ['opt1_heavyTail', PROFILES.opt1, { mode: 'A', cv: 1.5 }],
    ['opt1_google', PROFILES.opt1, { mode: 'A', channel: 'google15' }],
    ['opt1_grandfathered499', PROFILES.opt1, { mode: 'A', price: 4.99 }],
    ['opt1m', PROFILES.opt1m, { mode: 'A' }],
    ['opt1s', PROFILES.opt1s, { mode: 'A', reserveFirst: true }],
    ['opt1s_heavyTail', PROFILES.opt1s, { mode: 'A', reserveFirst: true, cv: 1.5 }],
    ['opt2', PROFILES.opt2, { mode: 'A' }],
    ['opt3', PROFILES.opt3, { mode: 'A', price: 6.99 }],
    ['opt3_heavyTail', PROFILES.opt3, { mode: 'A', price: 6.99, cv: 1.5 }],
    ['opt1_underB', PROFILES.opt1, { mode: 'B' }],
    ['bypass', PROFILES.bypass, { mode: 'B' }],
    ['bypass_heavyTail', PROFILES.bypass, { mode: 'B', cv: 1.5 }],
    ['bypass_google', PROFILES.bypass, { mode: 'B', channel: 'google15' }],
  ];
  for (const [k, p, c] of cases) res.options[k] = evaluate(p, { ...o, ...c });

  // Tier: Standard £5.99 (opt1 profile) for light/typical, Family £9.99 (plus profile) for heavy/extreme.
  const std = res.options.opt1;
  const fam = evaluate(PROFILES.familyPlus, { ...o, mode: 'A', price: 9.99, segments: SEGMENTS.filter((s) => s.key === 'heavy' || s.key === 'extreme') });
  const ch999 = res.channels.stripe999;
  const segRows = [
    ...std.segments.filter((s) => s.segment === 'light' || s.segment === 'typical').map((s) => ({ ...s, ch: ch599 })),
    ...fam.segments.map((s) => ({ ...s, ch: ch999 })),
  ];
  const blendedTier = (f) => segRows.reduce((s, x) => s + x.share * contribution(x.ch, f(x)), 0) / segRows.reduce((s, x) => s + x.share * x.ch.net, 0);
  res.tier = { standard: 'opt1', family: fam, blended: { marginBilled: blendedTier((x) => x.meanBilled), marginSdk: blendedTier((x) => x.meanBilledSdk), marginFortress: blendedTier((x) => x.meanFortress) } };

  // Price at which Option-1-style pooling reaches a 40% blended margin under A (pool scaled to the price's loss line).
  res.priceFor40 = priceFor40(o);
  // Trusted-minute sensitivity: blended margin at £5.99 (opt1) if the typical household has fewer trusted minutes.
  res.trustedSensitivity = [0.5, 0.67, 1, 1.33].map((f) => {
    const segs = SEGMENTS.map((s) => (s.key === 'typical' ? { ...s, trusted: s.trusted * f, trustedCalls: s.trustedCalls * f } : s));
    const e = evaluate(PROFILES.opt1, { ...o, mode: 'A', segments: segs });
    return { typicalTrustedMinutes: Math.round(P.typical.trusted * f), blendedMarginBilled: e.blended.marginBilled, typicalMarginBilled: e.segments.find((x) => x.segment === 'typical').marginBilled, typicalPaused: e.segments.find((x) => x.segment === 'typical').pausedShare };
  });
  return res;
}

function priceFor40(o) {
  for (const price of [5.99, 6.49, 6.99, 7.49, 7.99, 8.49, 8.99, 9.99]) {
    const e = evaluate(PROFILES.opt1, { ...o, mode: 'A', price });
    if (e.blended.marginBilled >= 0.4) return { price, blendedMarginBilled: e.blended.marginBilled, blendedMarginSdk: e.blended.marginSdk, blendedMarginFortress: e.blended.marginFortress };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const g = (n) => `£${r2(n).toFixed(2)}`;
const p = (n) => `${pct(n).toFixed(1)}%`;

function toMarkdown(res) {
  const L = [];
  L.push('# Commercial allowance model — generated tables (2026-10-10)');
  L.push('');
  L.push('Generated by `node scripts/finance/commercial-allowance.js --md`. Do not edit by hand; `tests/commercial-allowance.test.mjs` fails if this file is stale.');
  L.push(`Seeded Monte Carlo: ${res.inputs.households} household-months per segment per case, seed ${res.inputs.seed}. Durations exponential (as the WS2 scale sim) unless marked "heavy tail" (lognormal, CV 1.5). Usage profiles are the register's ILLUSTRATIVE profiles; no measured distribution exists.`);
  L.push('');
  L.push('## T1. Fortress admission thresholds and worst-case conversion');
  L.push('');
  L.push('| Item | Value |');
  L.push('|---|---|');
  L.push(`| One trusted/unscreened lease (360 s) | ${g(res.inputs.telLease)} (£${res.inputs.telLease.toFixed(4)}) |`);
  L.push(`| Screening admission, monitoring_max_seconds 1800 | £${res.inputs.screeningAdmission1800.toFixed(4)} |`);
  L.push(`| Screening admission, monitoring_max_seconds 900 | £${res.inputs.screeningAdmission900.toFixed(4)} |`);
  L.push(`| Screening admission, monitoring_max_seconds 600 | £${res.inputs.screeningAdmission600.toFixed(4)} |`);
  L.push(`| Max billed ÷ Fortress, today (SDK leg £0) | ${res.inputs.worstBilledRatioToday.toFixed(4)} |`);
  L.push(`| Max billed ÷ Fortress, SDK leg billed at list | ${res.inputs.worstBilledRatioSdk.toFixed(4)} |`);
  L.push('');
  L.push('## T2. Revenue side (register fee model)');
  L.push('');
  L.push('| Price / channel | Net ex VAT | Fee | Leakage | Fixed (number + overhang + infra) | Usage room at break-even (LOSS line) | Usage room at 40% |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [k, c] of Object.entries(res.channels)) L.push(`| ${k} | ${g(c.net)} | ${g(c.fee)} | ${g(c.leakage)} | ${g(c.fixed)} | ${g(c.usageRoom)} | ${g(c.usageRoom - 0.4 * c.net)} |`);
  L.push('');
  L.push('## T3. Uncapped cost per household-month (mean), A = unconditional forwarding, B = trusted bypass');
  L.push('');
  L.push('| Segment | A billed today | A SDK billed | A Fortress | A Fortress P90 | B billed today | B SDK billed | B Fortress | B Fortress P90 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (let i = 0; i < SEGMENTS.length; i++) {
    const a = res.uncapped.A[i]; const b = res.uncapped.B[i];
    L.push(`| ${SEGMENTS[i].label} | ${g(a.billed)} | ${g(a.billedSdk)} | ${g(a.fortress)} | ${g(a.p90Fortress)} | ${g(b.billed)} | ${g(b.billedSdk)} | ${g(b.fortress)} | ${g(b.p90Fortress)} |`);
  }
  L.push('');
  L.push('Heavy tail (lognormal CV 1.5):');
  L.push('');
  L.push('| Segment | A billed | A Fortress P90 | B billed | B Fortress P90 |');
  L.push('|---|---|---|---|---|');
  for (let i = 0; i < SEGMENTS.length; i++) {
    const a = res.uncappedHeavyTail.A[i]; const b = res.uncappedHeavyTail.B[i];
    L.push(`| ${SEGMENTS[i].label} | ${g(a.billed)} | ${g(a.p90Fortress)} | ${g(b.billed)} | ${g(b.p90Fortress)} |`);
  }
  L.push('');
  L.push('## T4. Uncapped margin at £5.99 (billed today / SDK billed / Fortress basis)');
  L.push('');
  L.push('| Segment | A Stripe | A Play 15% | B Stripe | B Play 15% |');
  L.push('|---|---|---|---|---|');
  const s = res.channels.stripe599; const gp = res.channels.google599;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const a = res.uncapped.A[i]; const b = res.uncapped.B[i];
    const tri = (ch, x) => `${p(margin(ch, x.billed))} / ${p(margin(ch, x.billedSdk))} / ${p(margin(ch, x.fortress))}`;
    L.push(`| ${SEGMENTS[i].label} | ${tri(s, a)} | ${tri(gp, a)} | ${tri(s, b)} | ${tri(gp, b)} |`);
  }
  const bl = (mode, ch, f) => res.uncapped[mode].reduce((acc, x, i) => acc + SEGMENTS[i].share * contribution(ch, f(x)), 0) / ch.net;
  L.push(`| **Blended (40/45/10/5), uncapped** | ${p(bl('A', s, (x) => x.billed))} / ${p(bl('A', s, (x) => x.billedSdk))} / ${p(bl('A', s, (x) => x.fortress))} | ${p(bl('A', gp, (x) => x.billed))} / ${p(bl('A', gp, (x) => x.billedSdk))} / ${p(bl('A', gp, (x) => x.fortress))} | ${p(bl('B', s, (x) => x.billed))} / ${p(bl('B', s, (x) => x.billedSdk))} / ${p(bl('B', s, (x) => x.fortress))} | ${p(bl('B', gp, (x) => x.billed))} / ${p(bl('B', gp, (x) => x.billedSdk))} / ${p(bl('B', gp, (x) => x.fortress))} |`);
  L.push('');
  L.push('## T5. Smallest screening budget at which ≥ 90% of typical households never pause (no trusted reserve counted)');
  L.push('');
  L.push('| Case | Budget |');
  L.push('|---|---|');
  for (const [k, b] of Object.entries(res.minBudgetTypical90)) L.push(`| ${k} | ${b == null ? 'none ≤ £20' : g(b)} |`);
  L.push('');
  L.push('## T6. Monitoring cap savings (billed £ per household-month vs 1800 s)');
  L.push('');
  L.push('| Segment | cap 900 s | cap 600 s |');
  L.push('|---|---|---|');
  for (let i = 0; i < SEGMENTS.length; i++) L.push(`| ${SEGMENTS[i].label} | ${g(res.monitoringCapSavings.s900[i].savedBilled)} (£${res.monitoringCapSavings.s900[i].savedBilled.toFixed(3)}) | ${g(res.monitoringCapSavings.s600[i].savedBilled)} (£${res.monitoringCapSavings.s600[i].savedBilled.toFixed(3)}) |`);
  L.push('');
  L.push('## T7. Candidate profiles (capped, simulated)');
  L.push('');
  for (const [k, e] of Object.entries(res.options)) {
    const pr = e.profile; const wc = e.worstCase;
    L.push(`### ${k} — ${PROFILES[Object.keys(PROFILES).find((x) => PROFILES[x] === pr)]?.label || ''}`);
    L.push('');
    L.push(`Mode ${e.mode}, ${e.channel} £${e.price}, ${e.cv === 1 ? 'exponential durations' : 'heavy tail'}${e.reserveFirst ? ', reserve-first' : ''}. Profile: period_budget_gbp ${pr.budget.toFixed(2)}, delivery_reserve_gbp ${pr.trustedReserve.toFixed(2)} trusted_only, unscreened_reserve_gbp ${pr.unscreenedReserve.toFixed(2)}, essential_reserve_gbp ${pr.essential.toFixed(2)}, monitoring_max_seconds ${pr.monMaxSeconds}.`);
    L.push('');
    L.push(`Worst case per customer: Fortress ${g(wc.fortress)} (incl. £${wc.overrun.toFixed(3)} overrun: one lease per pool) → billed today ≤ ${g(wc.billedToday)} (contribution ${g(wc.contributionToday)}), SDK billed ≤ ${g(wc.billedSdk)} (contribution ${g(wc.contributionSdk)}).`);
    L.push('');
    L.push('| Segment | Never pause | Pause before day 20 | Trusted refused (any) | Mean Fortress | Mean billed | Margin billed | Margin SDK billed | Margin Fortress |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const x of e.segments) L.push(`| ${x.segment} | ${p(1 - x.pausedShare)} | ${p(x.pausedBeforeDay20Share)} | ${p(x.trustedRefusedShare)} | ${g(x.meanFortress)} | ${g(x.meanBilled)} | ${p(x.marginBilled)} | ${p(x.marginSdk)} | ${p(x.marginFortress)} |`);
    L.push(`| **Blended** | ${p(1 - e.blended.pausedShare)} | | ${p(e.blended.trustedRefusedShare)} | | | **${p(e.blended.marginBilled)}** | ${p(e.blended.marginSdk)} | ${p(e.blended.marginFortress)} |`);
    L.push('');
  }
  const o3 = res.tier;
  L.push('### tier — Standard £5.99 (opt1) for light/typical + Family £9.99 (plus profile) for heavy/extreme');
  L.push('');
  const fp = o3.family.profile; const fwc = o3.family.worstCase;
  L.push(`Family profile: period_budget_gbp ${fp.budget.toFixed(2)}, delivery_reserve_gbp ${fp.trustedReserve.toFixed(2)} trusted_only, unscreened ${fp.unscreenedReserve.toFixed(2)}, essential ${fp.essential.toFixed(2)}. Worst case Fortress ${g(fwc.fortress)} → billed today ≤ ${g(fwc.billedToday)} (contribution ${g(fwc.contributionToday)}), SDK billed ≤ ${g(fwc.billedSdk)} (contribution ${g(fwc.contributionSdk)}).`);
  L.push('');
  L.push('| Family segment | Never pause | Margin billed | Margin SDK billed |');
  L.push('|---|---|---|---|');
  for (const x of o3.family.segments) L.push(`| ${x.segment} | ${p(1 - x.pausedShare)} | ${p(x.marginBilled)} | ${p(x.marginSdk)} |`);
  L.push(`| **Blended (both tiers)** | | **${p(o3.blended.marginBilled)}** | ${p(o3.blended.marginSdk)} |`);
  L.push('');
  L.push('## T8. Price for a 40% blended margin under A (Option-1 pool, billed today)');
  L.push('');
  L.push(res.priceFor40 ? `£${res.priceFor40.price} — blended ${p(res.priceFor40.blendedMarginBilled)} billed today, ${p(res.priceFor40.blendedMarginSdk)} SDK billed, ${p(res.priceFor40.blendedMarginFortress)} Fortress basis.` : 'Not reached at ≤ £9.99.');
  L.push('');
  L.push('## T9. Sensitivity: typical household trusted minutes (Option 1, £5.99 Stripe, A)');
  L.push('');
  L.push('| Typical trusted min/month | Typical margin (billed) | Blended margin (billed) | Typical paused |');
  L.push('|---|---|---|---|');
  for (const x of res.trustedSensitivity) L.push(`| ${x.typicalTrustedMinutes} | ${p(x.typicalMarginBilled)} | ${p(x.blendedMarginBilled)} | ${p(x.typicalPaused)} |`);
  L.push('');
  return L.join('\n');
}

module.exports = {
  FORTRESS, BILLED, SEGMENTS, PROFILES, DEFAULTS,
  fcCallCost, cutToHeadroom, screeningAdmissionGbp, telLeaseGbp, billedCall, worstBilledRatio,
  mulberry32, simulateMonth, channelEconomics, margin, contribution, worstCase, overrunFor,
  evaluate, uncappedCosts, minBudgetFor, monitoringCapSavings, computeAll, toMarkdown,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const res = computeAll();
  if (args.includes('--json')) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else process.stdout.write(toMarkdown(res) + '\n');
}
