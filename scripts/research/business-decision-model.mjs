#!/usr/bin/env node
// business-decision-model.mjs — AGENT 4 financial model, 2026-10-10.
// Deterministic, plain Node, no network, no env, no database.
// Behind docs/research/2026-10-10-business-decision/AGENT-4-FINANCIAL-MODEL.md
//
//   node scripts/research/business-decision-model.mjs        # all markdown tables
//
// Provider rates are read from the unit-economics register
// (services/finance/assumptions/hcg-unit-economics.v1.json) wherever the
// register has them; everything else is declared in ASSUMPTIONS below with a
// status. Nothing here decides a price or changes any policy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const REG = JSON.parse(readFileSync(path.join(here, '../../services/finance/assumptions/hcg-unit-economics.v1.json'), 'utf8')).assumptions;
const rv = (k) => REG[k].value;

const FX = rv('usdToGbp'); // 0.79
const SDK_LIST = rv('twilioAppLegListUsdPerMin') * FX; // £0.00316

// ---------------------------------------------------------------------------
// Assumptions (status: K=known/billed, C=configured, E=estimated, U=unknown)
// ---------------------------------------------------------------------------
const BASE = {
  vat: rv('vatRate'),
  stripePct: rv('stripeCardPct') + rv('stripeBillingPct') + rv('stripeTaxPct'), // 2.7% of gross
  stripeFixed: rv('stripeCardFixedGbp'),
  playRate: rv('googlePlayServiceFeeRate'),
  appleRate: rv('appleSmallBusinessRate'), // 15% SBP base (enrolment UNKNOWN); sensitivity 30%
  revenueCatRate: rv('revenueCatRateAboveThreshold'),
  revenueCatFreeGbp: rv('revenueCatFreeMtrUsd') * FX,
  mix: { stripe: 0.5, play: 0.3, apple: 0.2 }, // E: policy assumption
  leakage: rv('revenueLeakageRate'), // 2% refunds/chargebacks/failed renewals
  disputeRate: 0.002, disputeFee: 20, // E: Stripe disputes per Stripe customer-month, £20 fee
  fraudRate: 0.005, // E: Stripe customer-months that are stolen-card: pool used, then charged back
  payFailRate: 0.03, payFailServedMonths: 0.25, // E: dunning grace served unpaid
  churn: rv('monthlyChurnRate'), heldMonths: rv('numberHeldAfterChurnMonths'),
  roundUp60: rv('roundUpMinutesPerCall'), streamRoundUp: rv('streamRoundUpPerMonitoredCall'),
  uplift: rv('fortressEstimateUplift'), lease: 0.0713, // one 360 s Fortress lease, per reachable pool
  essential: 0.10,
  usageMult: 1,
  sdkBilled: false,
  platformInfraFixed: 75, // E: Railway Pro, Supabase Pro, Resend, monitoring, domains, dev-programme fees amortised
  supportRate: 25, // E: £/hour founder time
  targetMargin: rv('targetGrossMargin'),
  topUpFactor: 0.6, // C: migration 077 credit ≤ paid ÷ 1.2 × 0.60
  mixKey: 'brief',
};

// Usage profiles = register usageProfiles. Shares: brief (15% heavy, 10% extreme) or WS2 40/45/10/5.
const PROFILES = {
  light:   { trusted: 60,  trustedCalls: 20,  unknown: 15,  unknownCalls: 6,  sms: 0 },
  typical: { trusted: 150, trustedCalls: 45,  unknown: 40,  unknownCalls: 15, sms: 1 },
  heavy:   { trusted: 400, trustedCalls: 100, unknown: 80,  unknownCalls: 30, sms: 2 },
  extreme: { trusted: 800, trustedCalls: 200, unknown: 200, unknownCalls: 60, sms: 3 },
};
const MIXES = {
  brief: { light: 0.30, typical: 0.45, heavy: 0.15, extreme: 0.10 },
  ws2:   { light: 0.40, typical: 0.45, heavy: 0.10, extreme: 0.05 },
};

const TW = {
  inbound: rv('twilioInboundGbpPerMin'), stream: rv('twilioMediaStreamGbpPerMin'),
  whisper: rv('transcriptionUsdPerMin') * FX, polly: rv('twilioPollyGbpPerCall'),
  sms: rv('twilioSmsGbpPerSegment'), number: rv('numberRentalGbpPerMonth'),
};
const BYOC_PER_MIN = 0.004 * FX; // E / PROVIDER_CONFIRMATION_REQUIRED: Twilio BYOC/SIP-interface per-minute list
const MAG_NUMBER = 0.5, MAG_MIN = 100; // Magrathea Annex 3 v6.0 (PUBLISHED); P6 £100/mo CONFIRMED, whether rentals count UNKNOWN

// Architectures. trustedRate/unknownRate are £/started-min for the connected leg(s);
// sdk = whether the Twilio Voice SDK app leg is in the path (billed £0 today, list £0.00316).
const ARCH = {
  A:  { label: 'A Twilio today', trustedRate: TW.inbound, unknownRate: TW.inbound, sdk: true, roundUp: BASE.roundUp60,
        stream: TW.stream, whisper: TW.whisper, polly: TW.polly, numberGbp: TW.number, numbers: (n) => n,
        carrierMin: 0, extraInfra: 0, varInfra: 0.05, supportMin: 4, networkFee: 0, trustedThrough: true },
  B1: { label: 'B1 Magrathea + BYOC, Twilio SDK leg', trustedRate: BYOC_PER_MIN, unknownRate: BYOC_PER_MIN, sdk: true, roundUp: BASE.roundUp60,
        stream: TW.stream, whisper: TW.whisper, polly: TW.polly, numberGbp: MAG_NUMBER, numbers: (n) => n,
        carrierMin: MAG_MIN, extraInfra: 150, varInfra: 0.08, supportMin: 4, networkFee: 0, trustedThrough: true },
  B2: { label: 'B2 Magrathea + self-hosted delivery', trustedRate: 0, unknownRate: 0, sdk: false, roundUp: 0.1,
        stream: 0, whisper: TW.whisper, polly: 0, numberGbp: MAG_NUMBER, numbers: (n) => n,
        carrierMin: MAG_MIN, extraInfra: 250, varInfra: 0.10, supportMin: 4, networkFee: 0, trustedThrough: true },
  C:  { label: 'C Twilio, pooled numbers (50 hh/number)', trustedRate: TW.inbound, unknownRate: TW.inbound, sdk: true, roundUp: BASE.roundUp60,
        stream: TW.stream, whisper: TW.whisper, polly: TW.polly, numberGbp: TW.number, numbers: (n) => Math.max(2, Math.ceil(n / 50)), pooled: true,
        carrierMin: 0, extraInfra: 0, varInfra: 0.05, supportMin: 4, networkFee: 0, trustedThrough: true },
  D:  { label: 'D on-device, no Twilio/no forwarding', trustedRate: 0, unknownRate: 0, sdk: false, roundUp: 0, noTelephony: true,
        stream: 0, whisper: 0, polly: 0, numberGbp: 0, numbers: () => 0,
        carrierMin: 0, extraInfra: 0, varInfra: 0.15, supportMin: 2, networkFee: 0, trustedThrough: false },
  E:  { label: 'E network-side screening (unknown only; generic £0.50 fee placeholder — AQL INCOMPLETE, rate card missing)', trustedRate: 0, unknownRate: TW.inbound, sdk: true, roundUp: BASE.roundUp60,
        stream: TW.stream, whisper: TW.whisper, polly: TW.polly, numberGbp: TW.number, numbers: (n) => n,
        carrierMin: 0, extraInfra: 0, varInfra: 0.05, supportMin: 3, networkFee: 0.5, trustedThrough: false },
};
const ARCH_KEYS = Object.keys(ARCH);
const PRICES = [5.99, 7.99, 8.99, 9.99];
const SCALES = [10, 50, 100, 500, 1000];

const r2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const r0 = (x) => Math.round(x).toLocaleString('en-GB');
const pc = (x) => (Math.round(x * 1000) / 10).toFixed(1) + '%';

// ---------------------------------------------------------------------------
// Per-segment usage cost
// ---------------------------------------------------------------------------
function segmentCost(arch, p, cfg, sdkAtList) {
  const m = cfg.usageMult;
  const sdk = arch.sdk ? (sdkAtList ? SDK_LIST : 0) : 0;
  const tStarted = (p.trusted + p.trustedCalls * arch.roundUp) * m;
  const uStarted = (p.unknown + p.unknownCalls * arch.roundUp) * m;
  const trusted = arch.trustedThrough ? tStarted * (arch.trustedRate + sdk) : 0;
  const unknown = arch.noTelephony ? 0 : uStarted * (arch.unknownRate + sdk)
    + (p.unknown + p.unknownCalls * cfg.streamRoundUp) * m * arch.stream
    + p.unknown * m * arch.whisper + p.unknownCalls * m * arch.polly;
  const sms = arch.noTelephony ? 0 : p.sms * m * TW.sms;
  return { trusted, unknown, sms, total: trusted + unknown + sms };
}

function feeFor(channel, gross, cfg) {
  const net = gross / (1 + cfg.vat);
  if (channel === 'stripe') return gross * cfg.stripePct + cfg.stripeFixed;
  if (channel === 'play') return net * cfg.playRate;
  return net * cfg.appleRate;
}

// Pool (Fortress £, all pools incl. essential) sized so a customer who uses ALL of it is
// break-even on the worst base channel even if the SDK leg is billed at list. Capped at
// 1.2 × the heavy segment's Fortress demand (no point being more generous than that).
function designPool(arch, price, cfg, n) {
  if (arch.noTelephony) return { poolF: 0, room: null };
  const net = price / (1 + cfg.vat);
  const worstFee = Math.max(...Object.keys(cfg.mix).filter((c) => cfg.mix[c] > 0).map((c) => feeFor(c, price, cfg)));
  const numberPer = arch.numbers(n) * arch.numberGbp / n + (arch.pooled ? 0 : cfg.churn * cfg.heldMonths * arch.numberGbp);
  const room = net - worstFee - cfg.leakage * net - numberPer - arch.networkFee - arch.varInfra;
  const heavyF = segmentCost(arch, PROFILES.heavy, { ...cfg, usageMult: 1 }, true).total * cfg.uplift;
  const extremeF = segmentCost(arch, PROFILES.extreme, { ...cfg, usageMult: 1 }, true).total * cfg.uplift;
  const ceilingF = Math.max(1.2 * heavyF, extremeF); // no need to be more generous than the extreme profile
  const breakEvenF = Math.max(0, room * cfg.uplift - 2 * cfg.lease);
  return { poolF: Math.min(breakEvenF, ceilingF), room, capped: ceilingF < breakEvenF };
}

function poolSplit(arch, poolF, cfg) {
  if (!poolF) return { B: 0, T: 0, E: 0 };
  const E = cfg.essential;
  const trustedCosts = arch.trustedThrough && (arch.trustedRate > 0 || arch.sdk);
  const T = trustedCosts ? (poolF - E) / 2 : Math.min(0.2, poolF - E); // 1-S split where trusted minutes cost money; else 0.20 floor
  return { B: poolF - E - T, T, E };
}

// ---------------------------------------------------------------------------
// Monthly result for (arch, price, N)
// ---------------------------------------------------------------------------
function evaluate(archKey, price, n, cfgOver = {}) {
  const cfg = { ...BASE, ...cfgOver };
  const arch = { ...ARCH[archKey], ...(cfgOver.arch?.[archKey] || {}) };
  const mix = MIXES[cfg.mixKey];
  const net = price / (1 + cfg.vat);
  const { poolF } = designPool(arch, price, cfg, n);

  // Capped usage per customer (billed basis per cfg.sdkBilled)
  let usage = 0, servedTypical = 1, servedHeavy = 1, servedExtreme = 1;
  for (const [seg, share] of Object.entries(mix)) {
    const billed = segmentCost(arch, PROFILES[seg], cfg, cfg.sdkBilled).total;
    const fortress = segmentCost(arch, PROFILES[seg], cfg, true).total * cfg.uplift;
    const served = arch.noTelephony || fortress === 0 ? 1 : Math.min(1, poolF / fortress);
    if (seg === 'typical') servedTypical = served;
    if (seg === 'heavy') servedHeavy = served;
    if (seg === 'extreme') servedExtreme = served;
    usage += share * billed * served;
  }
  const worstUsage = arch.noTelephony ? 0 : (poolF + 2 * cfg.lease) / cfg.uplift; // list basis = ceiling

  // Fees by channel
  let fees = 0;
  for (const [ch, s] of Object.entries(cfg.mix)) fees += s * feeFor(ch, price, cfg);
  const storeGross = n * price * (cfg.mix.play + cfg.mix.apple);
  const revenueCat = Math.max(0, storeGross - cfg.revenueCatFreeGbp) * cfg.revenueCatRate / n;
  const disputes = cfg.mix.stripe * cfg.disputeRate * cfg.disputeFee;
  const numberPer = arch.numbers(n) * arch.numberGbp / n + (arch.pooled ? 0 : cfg.churn * cfg.heldMonths * arch.numberGbp);
  const fraud = cfg.mix.stripe * cfg.fraudRate * (worstUsage + numberPer + cfg.disputeFee + net); // revenue reversed too
  const payFail = cfg.payFailRate * cfg.payFailServedMonths * (usage + numberPer);
  const leakage = cfg.leakage * net;

  const variable = fees + revenueCat + disputes + leakage + fraud + payFail + numberPer + usage + arch.varInfra + arch.networkFee;
  const contribution = net - variable;
  const support = arch.supportMin / 60 * cfg.supportRate;
  const carrierShortfall = Math.max(0, arch.carrierMin - arch.numbers(n) * arch.numberGbp);
  const fixed = cfg.platformInfraFixed + arch.extraInfra + carrierShortfall;

  const T = {
    grossRevenue: n * price, netRevenue: n * net,
    variableCost: n * variable, contribution: n * contribution,
    fullyLoaded: n * (contribution - support) - fixed,
    fixed, support: n * support,
  };
  T.contributionMargin = T.contribution / T.netRevenue;
  T.fullyLoadedMargin = T.fullyLoaded / T.netRevenue;
  // Worst-case month: every customer consumes its whole pool (SDK at list), plus fixed + support.
  const worstVariable = variable - usage - payFail + worstUsage + cfg.payFailRate * cfg.payFailServedMonths * (worstUsage + numberPer);
  T.worstMonth = n * (net - worstVariable - support) - fixed;
  // Worst single customer on the worst channel (Apple at cfg.appleRate or Play), maxed pool, no chargeback.
  const worstChFee = Math.max(...Object.keys(cfg.mix).filter((c) => cfg.mix[c] > 0).map((c) => feeFor(c, price, cfg)));
  T.worstCustomer = net - worstChFee - leakage - numberPer - worstUsage - arch.varInfra - arch.networkFee;
  T.worstFraud = -(worstUsage + numberPer + cfg.disputeFee + feeFor('stripe', price, cfg));
  T.poolF = poolF; T.servedTypical = servedTypical; T.servedHeavy = servedHeavy; T.servedExtreme = servedExtreme;
  T.unit = { net, fees, revenueCat, disputes, leakage, fraud, payFail, numberPer, usage, varInfra: arch.varInfra, networkFee: arch.networkFee, contribution, support };
  return T;
}

function breakEven(archKey, price, cfgOver = {}, target = 0) {
  for (let n = 1; n <= 20000; n++) {
    const t = evaluate(archKey, price, n, cfgOver);
    if (t.fullyLoaded >= target * t.netRevenue) return n;
  }
  return null;
}

// Erlang B: channels for ≤1% blocking
function erlangChannels(erl, block = 0.01) {
  let b = 1, c = 0;
  while (b > block) { c++; b = (erl * b) / (c + erl * b); }
  return c;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const out = [];
const P = (s = '') => out.push(s);

P('### R1. Per-customer unit economics at 100 customers, £5.99, base mix (£/customer/month, billed today)');
P('| Arch | Net | Fees+RC | Leak+disp+fraud+payfail | Number | Usage (capped) | Var infra + network fee | **Contribution** | Support | Pool (Fortress £) |');
P('|---|---|---|---|---|---|---|---|---|---|');
for (const k of ARCH_KEYS) {
  const u = evaluate(k, 5.99, 100).unit; const t = evaluate(k, 5.99, 100);
  P(`| ${ARCH[k].label} | ${r2(u.net)} | ${r2(u.fees + u.revenueCat)} | ${r2(u.leakage + u.disputes + u.fraud + u.payFail)} | ${r2(u.numberPer)} | ${r2(u.usage)} | ${r2(u.varInfra + u.networkFee)} | **${r2(u.contribution)}** | ${r2(u.support)} | ${r2(t.poolF)} |`);
}
P();

P('### R2. Uncapped usage cost by segment (£/household/month; billed today / SDK at list)');
P('| Arch | Light | Typical | Heavy | Extreme |'); P('|---|---|---|---|---|');
for (const k of ARCH_KEYS) {
  const cells = Object.keys(PROFILES).map((s) => `${r2(segmentCost(ARCH[k], PROFILES[s], BASE, false).total)} / ${r2(segmentCost(ARCH[k], PROFILES[s], BASE, true).total)}`);
  P(`| ${k} | ${cells.join(' | ')} |`);
}
P();

for (const price of PRICES) {
  P(`### R3-${price}. £${price} incl VAT — monthly £ by scale (revenue gross / contribution / CM% / fully-loaded / FL% / worst-case month)`);
  P('| Arch | N | Gross rev | Net rev | Variable cost | Contribution | CM % | Fixed+support | Fully loaded | FL % | Worst-case month |');
  P('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of ARCH_KEYS) for (const n of SCALES) {
    const t = evaluate(k, price, n);
    P(`| ${k} | ${n} | ${r0(t.grossRevenue)} | ${r0(t.netRevenue)} | ${r0(t.variableCost)} | ${r0(t.contribution)} | ${pc(t.contributionMargin)} | ${r0(t.fixed + t.support)} | ${r0(t.fullyLoaded)} | ${pc(t.fullyLoadedMargin)} | ${r0(t.worstMonth)} |`);
  }
  P();
}

P('### R3c. All prices — monthly £: contribution / fully-loaded / worst-case month (every customer maxes its pool, SDK at list)');
P('| Arch | Price | N=10 | N=50 | N=100 | N=500 | N=1,000 |'); P('|---|---|---|---|---|---|---|');
for (const k of ARCH_KEYS) for (const price of PRICES) {
  P(`| ${k} | £${price} | ${SCALES.map((n) => { const t = evaluate(k, price, n); return `${r0(t.contribution)} / ${r0(t.fullyLoaded)} / ${r0(t.worstMonth)}`; }).join(' | ')} |`);
}
P();

P('### R4. Margin matrix — contribution % / fully-loaded % (target 40%)');
P('| Arch | Price | N=10 | N=50 | N=100 | N=500 | N=1,000 |'); P('|---|---|---|---|---|---|---|');
for (const k of ARCH_KEYS) for (const price of PRICES) {
  P(`| ${k} | £${price} | ${SCALES.map((n) => { const t = evaluate(k, price, n); return `${pc(t.contributionMargin)} / ${pc(t.fullyLoadedMargin)}`; }).join(' | ')} |`);
}
P();

P('### R5. Break-even customers (fully-loaded ≥ 0) and customers for fully-loaded ≥ 40%');
P('| Arch | £5.99 | £7.99 | £8.99 | £9.99 |'); P('|---|---|---|---|---|');
for (const k of ARCH_KEYS) {
  P(`| ${k} | ${PRICES.map((p) => `${breakEven(k, p) ?? 'never'} / ${breakEven(k, p, {}, 0.4) ?? 'never'}`).join(' | ')} |`);
}
P();

P('### R6. Allowance design per price (pool sized for break-even on worst base channel with SDK billed; N=100)');
P('| Arch | Price | Pool (Fortress £) | Budget B / Trusted T / Essential E | Monitored-min allowance in B | Typical served | Heavy served | Extreme served | Worst maxed customer (worst channel) | Maxed stolen-card customer |');
P('|---|---|---|---|---|---|---|---|---|---|');
for (const k of ARCH_KEYS.filter((x) => x !== 'D')) for (const price of PRICES) {
  const t = evaluate(k, price, 100); const s = poolSplit(ARCH[k], t.poolF, BASE);
  const a = ARCH[k];
  const monPerMinF = ((a.unknownRate + (a.sdk ? SDK_LIST : 0)) + a.stream + a.whisper) * BASE.uplift; // connected + monitoring per min
  P(`| ${k} | £${price} | ${r2(t.poolF)} | ${r2(s.B)} / ${r2(s.T)} / ${r2(s.E)} | ${monPerMinF ? r0(s.B / monPerMinF) : '—'} | ${pc(t.servedTypical)} | ${pc(t.servedHeavy)} | ${pc(t.servedExtreme)} | ${r2(t.worstCustomer)} | ${r2(t.worstFraud)} |`);
}
P();

P('### R7. Sensitivity — contribution % at N=100 / N=1,000 (fully-loaded % at 1,000 in brackets)');
const SENS = [
  ['Base', {}],
  ['Usage ×2', { usageMult: 2 }],
  ['SDK leg billed at list', { sdkBilled: true }],
  ['Apple 30%', { appleRate: rv('appleStandardRate') }],
  ['WS2 mix 40/45/10/5', { mixKey: 'ws2' }],
  ['Support halved (2 min/month)', { supportRate: 12.5 }],
  ['All three adverse', { usageMult: 2, sdkBilled: true, appleRate: rv('appleStandardRate') }],
];
P('| Scenario | Price | ' + ARCH_KEYS.join(' | ') + ' |'); P('|---|---|' + ARCH_KEYS.map(() => '---').join('|') + '|');
for (const [name, o] of SENS) for (const price of [5.99, 7.99, 9.99]) {
  P(`| ${name} | £${price} | ${ARCH_KEYS.map((k) => { const a = evaluate(k, price, 100, o), b = evaluate(k, price, 1000, o); return `${pc(a.contributionMargin)} / ${pc(b.contributionMargin)} (${pc(b.fullyLoadedMargin)})`; }).join(' | ')} |`);
}
P();

P('### R3d. Headline grid — N=100 and N=1,000: contribution £ (CM%) | fully-loaded £ (FL%) | worst-case month £; break-even N (FL ≥ 0)');
P('| Arch | Price | N=100 contribution | N=100 fully loaded | N=100 worst | N=1,000 contribution | N=1,000 fully loaded | N=1,000 worst | Break-even N |');
P('|---|---|---|---|---|---|---|---|---|');
for (const k of ARCH_KEYS) for (const price of PRICES) {
  const a = evaluate(k, price, 100), b = evaluate(k, price, 1000);
  P(`| ${k} | £${price} | ${r0(a.contribution)} (${pc(a.contributionMargin)}) | ${r0(a.fullyLoaded)} (${pc(a.fullyLoadedMargin)}) | ${r0(a.worstMonth)} | ${r0(b.contribution)} (${pc(b.contributionMargin)}) | ${r0(b.fullyLoaded)} (${pc(b.fullyLoadedMargin)}) | ${r0(b.worstMonth)} | ${breakEven(k, price) ?? 'never'} |`);
}
P();

P('### R7c. Sensitivity — contribution % at N=1,000, £5.99 / £7.99');
P('| Scenario | ' + ARCH_KEYS.join(' | ') + ' |'); P('|---|' + ARCH_KEYS.map(() => '---').join('|') + '|');
for (const [name, o] of SENS.filter(([nm]) => !nm.startsWith('Support'))) P(`| ${name} | ${ARCH_KEYS.map((k) => `${pc(evaluate(k, 5.99, 1000, o).contributionMargin)} / ${pc(evaluate(k, 7.99, 1000, o).contributionMargin)}`).join(' | ')} |`);
P();

P('### R6c. Allowance design, £5.99 and £7.99 (N=100; worst maxed customer on worst channel, SDK at list)');
P('| Arch | Price | Pool F£ | B / T / E | Monitored min in B | Served typ / heavy / extreme | Worst maxed customer £ |');
P('|---|---|---|---|---|---|---|');
for (const k of ARCH_KEYS.filter((x) => x !== 'D')) for (const price of [5.99, 7.99]) {
  const t = evaluate(k, price, 100); const sp = poolSplit(ARCH[k], t.poolF, BASE); const a = ARCH[k];
  const perMin = ((a.unknownRate + (a.sdk ? SDK_LIST : 0)) + a.stream + a.whisper) * BASE.uplift;
  P(`| ${k} | £${price} | ${r2(t.poolF)} | ${r2(sp.B)} / ${r2(sp.T)} / ${r2(sp.E)} | ${r0(sp.B / perMin)} | ${pc(t.servedTypical)} / ${pc(t.servedHeavy)} / ${pc(t.servedExtreme)} | ${r2(t.worstCustomer)} |`);
}
P();

P('### R8. Worst maxed customer under sensitivities, £5.99 (£/customer/month, worst channel)');
P('| Scenario | ' + ARCH_KEYS.join(' | ') + ' |'); P('|---|' + ARCH_KEYS.map(() => '---').join('|') + '|');
for (const [name, o] of SENS) P(`| ${name} | ${ARCH_KEYS.map((k) => r2(evaluate(k, 5.99, 100, o).worstCustomer)).join(' | ')} |`);
P();

P('### R9. Global caps per stage (Fortress, WS2 D-4 scaling) vs sum of household pools (arch A, £5.99)');
P('| N | Daily absolute cap max(25, 0.60N) | Global worst-case cap max(40, 0.50N) | Active calls max(20, ⌈N/5⌉) | Σ household pools, billed ceiling/month | Expected A billed usage/day |');
P('|---|---|---|---|---|---|');
for (const n of [10, 25, 50, 100, 250, 500, 1000]) {
  const t = evaluate('A', 5.99, n);
  P(`| ${n} | £${r0(Math.max(25, 0.6 * n))} | £${r0(Math.max(40, 0.5 * n))} | ${Math.max(20, Math.ceil(n / 5))} | £${r0(n * (t.poolF + 2 * BASE.lease) / BASE.uplift)} | £${r2(n * t.unit.usage / 30)} |`);
}
P();

P('### R10. Prepaid credit (top-up) bounds — Stripe, credit only after settled payment, credit ≤ gross ÷ 1.2 × 0.60 (077)');
P('| Top-up gross | Net | Stripe fee | Max credit (Fortress £) | Max billed cost | Contribution if fully used | Loss if used then charged back |');
P('|---|---|---|---|---|---|---|');
for (const g of [2.99, 4.99, 9.99]) {
  const net = g / 1.2, fee = feeFor('stripe', g, BASE), credit = net * BASE.topUpFactor, billed = credit / BASE.uplift;
  P(`| £${g} | ${r2(net)} | ${r2(fee)} | ${r2(credit)} | ${r2(billed)} | ${r2(net - fee - billed)} (${pc((net - fee - billed) / net)}) | ${r2(-(billed + fee + BASE.disputeFee))} |`);
}
P();

P('### R11. Capacity — busy-hour channels (Erlang B 1%) for traffic reaching HCG, typical-mix minutes, 12% of daily traffic in busy hour');
P('| Arch | Min/hh/month via HCG | N=100 | N=500 | N=1,000 | Numbers needed N=1,000 | Note |'); P('|---|---|---|---|---|---|---|');
for (const k of ARCH_KEYS) {
  const a = ARCH[k]; const mix = MIXES.brief;
  const mins = a.noTelephony ? 0 : Object.entries(mix).reduce((s, [seg, sh]) => s + sh * ((a.trustedThrough ? PROFILES[seg].trusted : 0) + PROFILES[seg].unknown), 0);
  const ch = (n) => mins ? erlangChannels(n * mins / 30 * 0.12 / 60) : 0;
  const note = k === 'C' ? 'Twilio: no per-number channel limit; Magrathea pooled would need ≥ ⌈channels/10⌉ numbers' : (k.startsWith('B') ? 'Magrathea 10 channels/number: per-household numbers never binding' : '');
  P(`| ${k} | ${r0(mins)} | ${ch(100)} | ${ch(500)} | ${ch(1000)} | ${a.numbers(1000)} | ${note} |`);
}
P();

P('### R12. E: maximum per-subscriber network fee that still gives 40% contribution (N=1,000)');
P('| Price | Max network fee £/sub/month |'); P('|---|---|');
for (const price of PRICES) {
  let fee = 0; while (evaluate('E', price, 1000, { arch: { E: { networkFee: fee + 0.01 } } }).contributionMargin >= 0.4 && fee < 10) fee += 0.01;
  P(`| £${price} | ${r2(fee)} |`);
}

P();
// Erlang B blocking probability for `c` channels at `erl` offered Erlangs
function erlangB(erl, c) { let b = 1; for (let i = 1; i <= c; i++) b = (erl * b) / (i + erl * b); return b; }
const busyErl = (n, minsPerHh) => n * minsPerHh / 30 * 0.12 / 60;

P('### R13. Number pooling — per-customer vs small pool vs one shared number (traffic via HCG under A/C = 280 min/hh/month, busy hour 12% of daily)');
P('Pooling removes rental only; it adds no capacity. Busy-hour channels needed (Erlang B 1%) are the same in every column.');
P('| N | Busy-hour Erl / channels needed | Twilio per-customer £/mo | Twilio pool ⌈N/50⌉ (min 2) £/mo | Twilio single number £/mo | Magrathea per-customer £/mo (≥£100 min) | Magrathea pool numbers (≥2, ⌈ch/10⌉) / £/mo | Magrathea single number: blocking at 10 ch | Telnyx channel billing £/mo (list $15→$10/ch) |');
P('|---|---|---|---|---|---|---|---|---|');
for (const n of SCALES) {
  const erl = busyErl(n, 280), ch = erlangChannels(erl);
  const magPoolN = Math.max(2, Math.ceil(ch / 10));
  const telnyxPerCh = (ch > 250 ? 10 : ch > 50 ? 12 : ch > 10 ? 14 : 15) * FX;
  P(`| ${n} | ${erl.toFixed(2)} / ${ch} | ${r2(n * TW.number)} | ${r2(Math.max(2, Math.ceil(n / 50)) * TW.number)} | ${r2(TW.number)} | ${r2(Math.max(MAG_MIN, n * MAG_NUMBER))} | ${magPoolN} / ${r2(Math.max(MAG_MIN, magPoolN * MAG_NUMBER))} | ${pc(erlangB(erl, 10))} | ${r2(ch * telnyxPerCh)} |`);
}
P();

// Cheapest price (1p steps) meeting a target
const fmtP = (p) => p == null ? '> £25' : p <= 3 ? '≤ £3.00' : `£${p.toFixed(2)}`;
function priceFor(archKey, n, metric, target = 0.4) {
  for (let p = 3; p <= 25; p = Math.round((p + 0.01) * 100) / 100) {
    const t = evaluate(archKey, p, n); if (t[metric] >= target) return p;
  }
  return null;
}
P('### R14. Decision options at £5.99 (monthly £; contribution / CM% / fully-loaded) and the price needed for 40%');
P('| Option | Architecture | Engineering change | N | Net revenue | Variable cost | Contribution (CM%) | Fixed + support | Fully loaded (FL%) | Price for CM ≥ 40% | Price for FL ≥ 40% |');
P('|---|---|---|---|---|---|---|---|---|---|---|');
const OPTS = [
  ['1. Launch now', 'A', 'none'],
  ['2. Short change', 'C', 'number pooling + attribution'],
  ['3a. Delay (weeks)', 'B2', 'self-hosted SIP delivery'],
  ['3b. Delay (months)', 'E', 'network partner (AQL INCOMPLETE)'],
];
for (const [name, k, change] of OPTS) for (const n of [100, 1000]) {
  const t = evaluate(k, 5.99, n);
  P(`| ${name} | ${k} | ${change} | ${n} | ${r0(t.netRevenue)} | ${r0(t.variableCost)} | ${r0(t.contribution)} (${pc(t.contributionMargin)}) | ${r0(t.fixed + t.support)} | ${r0(t.fullyLoaded)} (${pc(t.fullyLoadedMargin)}) | ${fmtP(priceFor(k, n, 'contributionMargin'))} | ${fmtP(priceFor(k, n, 'fullyLoadedMargin'))} |`);
}

console.log(out.join('\n'));
