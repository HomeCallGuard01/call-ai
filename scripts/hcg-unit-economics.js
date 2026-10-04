#!/usr/bin/env node
// Prints every figure in docs/finance/HCG_UNIT_ECONOMICS_V1.md from the
// authoritative register (services/finance/assumptions/hcg-unit-economics.v1.json)
// via services/finance/hcgUnitEconomics.js. Internal analysis only: changes
// no price, allowance or policy.
//
//   node scripts/hcg-unit-economics.js            markdown tables, £5.99
//   node scripts/hcg-unit-economics.js 6.99       another candidate price
'use strict';

const register = require('../services/finance/economicsRegister');
const M = require('../services/finance/hcgUnitEconomics');

const PRICE = Number(process.argv[2] || register.value('priceIncVatGbp'));
const CH = ['stripe', 'apple15', 'apple30', 'google15'];
const g = (n) => (n < 0 ? '−£' : '£') + Math.abs(n).toFixed(2);
const g4 = (n) => (n < 0 ? '−£' : '£') + Math.abs(n).toFixed(4);
const pct = (n) => `${Math.round(n * 100) || 0}%`;
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const out = [];
const h = (t) => out.push(`\n### ${t}\n`);

out.push(`# HCG unit economics — generated tables (register v${register.REGISTER.version}, ${register.REGISTER.asOf}), price £${PRICE.toFixed(2)} incl VAT`);

h('A. Revenue waterfall');
out.push(table(['Channel', 'Gross', 'VAT', 'Net', 'Fee', 'Leakage 2%', 'After fees'], CH.map((c) => {
  const r = M.revenue({ priceIncVatGbp: PRICE, channel: c });
  return [M.CHANNELS[c].label, g(r.gross), g(r.vat), g(r.net), g(r.fee), g(r.leakage), g(r.afterFees)];
})));

h('B. Per-minute cost (including per-call rounding, stream rounding and greeting spread over a 4-minute call)');
const e = M.minuteCosts({ basis: 'expected' });
const f = M.minuteCosts({ basis: 'enforcement' });
out.push(table(['Basis', 'Trusted minute', 'Monitored minute', 'Marginal cost of monitoring', 'SMS segment'], [
  ['Expected (billed today)', g4(e.trustedPerMin), g4(e.monitoredPerMin), g4(e.monitoringMarginalPerMin), g4(e.smsPerSegment)],
  ['Fortress enforcement (app leg at list, ×1.10)', g4(f.trustedPerMin), g4(f.monitoredPerMin), g4(f.monitoringMarginalPerMin), g4(f.smsPerSegment)],
  ['Ratio enforcement ÷ expected', (f.trustedPerMin / e.trustedPerMin).toFixed(2) + '×', (f.monitoredPerMin / e.monitoredPerMin).toFixed(2) + '×', (f.monitoringMarginalPerMin / e.monitoringMarginalPerMin).toFixed(2) + '×', '1.10×'],
]));

function budgetRows(opts) {
  return CH.map((c) => {
    const b = M.budget({ priceIncVatGbp: PRICE, channel: c, ...opts });
    const mins = M.minutesFor(b.safeVariableBudget, { trustedShareOfMinutes: 0.75 });
    const fe = M.fortressEquivalent(b.safeVariableBudget);
    return [M.CHANNELS[c].label, g(b.costOfServiceBudget), g(b.fixed.total), g(b.variableBudget), g(b.reserve), g(b.overrun), `**${g(b.safeVariableBudget)}**`, `${mins.trustedOnly}`, `${mins.monitoredOnly}`, `${mins.blendedTotal}`, g(fe.gbp)];
  });
}
const BH = ['Channel', 'Cost-of-service budget @40%', 'Fixed/customer', 'Variable', 'Reserve 15%', 'Overrun', 'Safe variable (expected £)', 'Trusted-only min', 'Monitored-only min', 'Min @75% trusted', 'Fortress £ for same minutes'];
h('C1. Safe variable budget — base case (infra £0.25/customer allocation, RevenueCat £0)');
out.push(table(BH, budgetRows({})));
h('C2. Safe variable budget — 1,000 subscribers (infra £40/1,000), RevenueCat 1% on store channels');
out.push(table(BH, budgetRows({ subscribers: 1000, revenueCatAboveThreshold: true })));
h('C3. Safe variable budget — no leakage, no reserve, no overrun (the most optimistic reading of the same facts)');
out.push(table(BH, budgetRows({ leakageRate: 0, reserveRatio: 0, overrunGbp: 0 })));

h('C4. Fixed cost per customer (base)');
const fx = M.fixedPerCustomer({});
out.push(table(['Number rental', 'Churned-number overhang', 'Infrastructure allocation', 'RevenueCat', 'Total'], [[g4(fx.parts.number), g4(fx.parts.churnOverhang), g4(fx.parts.infrastructure), g4(fx.parts.revenueCat), g4(fx.total)]]));

h('D. Usage profiles: contribution and gross margin per customer-month (all unknown minutes monitored, no cap)');
const profiles = Object.entries(register.REGISTER.usageProfiles).filter(([k]) => !k.startsWith('_'));
out.push(table(['Profile', 'Trusted/unknown min', 'Usage cost', ...CH.map((c) => M.CHANNELS[c].label)], profiles.map(([, p]) => {
  const s0 = M.scenario({ priceIncVatGbp: PRICE, channel: 'stripe', usage: p });
  return [p.label, `${p.trusted}/${p.unknownMinutes}`, g(s0.usage), ...CH.map((c) => {
    const s = M.scenario({ priceIncVatGbp: PRICE, channel: c, usage: p });
    return `${g(s.contribution)} (${pct(s.margin)})${s.meetsTarget ? '' : ' ✗'}`;
  })];
})));

h('E. Trusted vs monitored: largest monitored allowance (fully used) that keeps 40%, given trusted minutes');
const TRUSTED = [0, 60, 150, 300, 500];
out.push(table(['Trusted min/month', ...CH.map((c) => M.CHANNELS[c].label)], TRUSTED.map((t) => [String(t), ...CH.map((c) => {
  const b = M.budget({ priceIncVatGbp: PRICE, channel: c });
  const left = b.safeVariableBudget - t * e.trustedPerMin;
  return left <= 0 ? '— (trusted alone exceeds)' : String(Math.floor(left / e.monitoredPerMin));
})])));

h('F. Warning levels — household £ consumed (expected basis) and the WATCH/LOSS lines');
out.push(table(['Channel', 'Safe budget', '50%', '75%', '90%', '100%', 'WATCH: total cost > (margin < 40%)', 'LOSS: total cost >', 'LOSS ≈ trusted-only minutes'], CH.map((c) => {
  const b = M.budget({ priceIncVatGbp: PRICE, channel: c });
  const lossMinutes = Math.floor((b.lossAtTotalCostGbp - b.fixed.total) / e.trustedPerMin);
  return [M.CHANNELS[c].label, g(b.safeVariableBudget), g(b.safeVariableBudget * 0.5), g(b.safeVariableBudget * 0.75), g(b.safeVariableBudget * 0.9), g(b.safeVariableBudget), g(b.watchAtTotalCostGbp), g(b.lossAtTotalCostGbp), String(lossMinutes)];
})));

h('G. Top-ups (monitored minutes; full cost incl. the connected leg) — minimum price per channel at 40% + 10% reserve');
const PACKS = [30, 60, 120, 250];
out.push(table(['Pack', 'Delivery cost', 'Marginal-only cost', ...CH.map((c) => `${M.CHANNELS[c].label} min → retail`)], PACKS.map((m) => {
  const cost = m * e.monitoredPerMin;
  return [`${m} monitored min`, g(cost), g(m * e.monitoringMarginalPerMin), ...CH.map((c) => { const p = M.topUpMinPrice(cost, c); return `${g(p)} → £${M.retailPricePoint(p).toFixed(2)}`; })];
})));
const TRUSTED_PACKS = [100, 250, 500];
out.push('');
out.push(table(['Trusted/unmonitored pack', 'Delivery cost', ...CH.map((c) => `${M.CHANNELS[c].label} min → retail`)], TRUSTED_PACKS.map((m) => {
  const cost = m * e.trustedPerMin;
  return [`${m} min`, g(cost), ...CH.map((c) => { const p = M.topUpMinPrice(cost, c); return `${g(p)} → £${M.retailPricePoint(p).toFixed(2)}`; })];
})));

h('H. Higher tiers — safe variable budget and what it buys (75% trusted mix)');
const TIERS = [5.99, 6.99, 7.99, 9.99, 12.99, 14.99];
out.push(table(['Price', ...CH.map((c) => M.CHANNELS[c].label)], TIERS.map((p) => [`£${p.toFixed(2)}`, ...CH.map((c) => {
  const b = M.budget({ priceIncVatGbp: p, channel: c });
  const mins = M.minutesFor(b.safeVariableBudget, { trustedShareOfMinutes: 0.75 });
  return `${g(b.safeVariableBudget)} ≈ ${mins.blendedTotal} min (${mins.monitoredOnly} monitored-only)`;
})])));

h('I. Telephony architecture sensitivity (HYPOTHETICAL rates; £' + PRICE.toFixed(2) + ', 1,000 subscribers for carrier minimums)');
const carriers = Object.entries(register.REGISTER.futureCarrierScenarios).filter(([k]) => !k.startsWith('_'));
out.push(table(['Architecture', 'Trusted min cost', 'Monitored min cost', 'Safe trusted-only min (Stripe / 15% store)', 'Typical margin Stripe / 15%', 'Heavy margin Stripe / 15%', 'Very heavy margin Stripe / 15%'], carriers.map(([, t]) => {
  const mc = M.minuteCosts({ telephony: t });
  const safe = ['stripe', 'google15'].map((c) => {
    const b = M.budget({ priceIncVatGbp: PRICE, channel: c, numberRentalGbp: t.numberGbp });
    const carrierFixed = t.fixedGbpPerMonth ? t.fixedGbpPerMonth / 1000 : 0;
    return mc.trustedPerMin > 0 ? String(Math.floor((b.safeVariableBudget - carrierFixed) / mc.trustedPerMin)) : 'unbounded by cost';
  }).join(' / ');
  const m = (prof) => ['stripe', 'google15'].map((c) => pct(M.scenario({ priceIncVatGbp: PRICE, channel: c, usage: register.REGISTER.usageProfiles[prof], telephony: t, subscribers: 1000 }).margin)).join(' / ');
  return [t.label, g4(mc.trustedPerMin), g4(mc.monitoredPerMin), safe, m('typical'), m('heavy'), m('veryHeavy')];
})));

h('J. Sensitivity of single unknowns (typical profile, Stripe and Apple 30% channels, margin)');
const typical = register.REGISTER.usageProfiles.typical;
const base = (c, o = {}) => M.scenario({ priceIncVatGbp: PRICE, channel: c, usage: typical, ...o }).margin;
const transDelta = (newGbpPerMin) => (newGbpPerMin - register.transcriptionGbpPerMin()) * typical.unknownMinutes;
const withExtraCost = (c, extra) => { const s = M.scenario({ priceIncVatGbp: PRICE, channel: c, usage: typical }); return (s.contribution - extra) / s.net; };
const rows = [
  ['Base', pct(base('stripe')), pct(base('apple30'))],
  ['Apple SBP confirmed (15%)', '—', pct(base('apple15'))],
  ['Leakage 0%', pct(base('stripe', { leakageRate: 0 })), pct(base('apple30', { leakageRate: 0 }))],
  ['Leakage 5%', pct(base('stripe', { leakageRate: 0.05 })), pct(base('apple30', { leakageRate: 0.05 }))],
  ['Infra at 100 subscribers (£0.40)', pct(base('stripe', { subscribers: 100 })), pct(base('apple30', { subscribers: 100 }))],
  ['Infra at 10,000 subscribers (£0.004)', pct(base('stripe', { subscribers: 10000 })), pct(base('apple30', { subscribers: 10000 }))],
  ['App leg billed at list', pct(M.scenario({ priceIncVatGbp: PRICE, channel: 'stripe', usage: typical, telephony: register.REGISTER.futureCarrierScenarios.twilioAppLegBilled }).margin), pct(M.scenario({ priceIncVatGbp: PRICE, channel: 'apple30', usage: typical, telephony: register.REGISTER.futureCarrierScenarios.twilioAppLegBilled }).margin)],
  ['Transcription → gpt-4o-mini-transcribe ($0.003)', pct(withExtraCost('stripe', transDelta(0.003 * register.value('usdToGbp')))), pct(withExtraCost('apple30', transDelta(0.003 * register.value('usdToGbp'))))],
  ['OpenAI retries 3× (worst day)', pct(withExtraCost('stripe', transDelta(register.transcriptionGbpPerMin() * 3))), pct(withExtraCost('apple30', transDelta(register.transcriptionGbpPerMin() * 3)))],
  ['FX 0.85 £/$ (weaker £)', pct(withExtraCost('stripe', transDelta(0.006 * 0.85))), pct(withExtraCost('apple30', transDelta(0.006 * 0.85)))],
];
out.push(table(['Change', 'Stripe', 'Apple'], rows));

h('K. Legacy figures reproduced from their own formulas');
const L = M.reconcileLegacyFigures();
out.push(table(['Figure', 'Reproduced', 'Formula'], [
  ['£0.86 envelope', g4(L.envelope086), 'economicPolicy.deriveVariableEnvelope() defaults'],
  ['£0.50 budget', `${g(L.budgetSlice050.formula)} formula / ${g(L.budgetSlice050.seeded)} seeded`, '58% slice of the envelope (migration 067 seed)'],
  ['£2.07 for 100 minutes', `${g4(L.hundredMinutes207.atRates)} → ${g4(L.hundredMinutes207.withUplift)}`, '100 × (Fortress connected + monitoring) × 1.10'],
  ...Object.entries(L.candidates125).map(([k, val]) => [`£1.25 candidate: ${k}`, g4(val), 'reconstruction (no source found)']),
]));

console.log(out.join('\n'));
