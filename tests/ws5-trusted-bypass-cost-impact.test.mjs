// WS5 (trusted-caller bypass) cost impact, 2026-10-10.
//
// Pure model, no I/O. Reuses the authoritative unit-economics register
// (services/finance/hcgUnitEconomics.js) and asks one question: what does a
// household cost HCG per month if trusted calls never reach HCG (Android
// SILENCE + carrier no-reply forwarding, CFNRy) instead of today's
// unconditional forwarding (**21*)?
//
// CONDITIONAL: the "bypass" rows are only true for an Android customer on a
// carrier where WS5 Test A (silence leaves the call eligible for CFNRy) AND
// Test B (CFNRy to an HCG number is accepted) have PASSED. Neither has run.
//
// Bypass modelling (all ESTIMATED):
//   - trusted minutes and trusted calls leave HCG's bill entirely;
//   - LEAKAGE: a trusted call the customer does not answer rings for the
//     no-reply timer and is then diverted to HCG. Share of trusted calls =
//     LEAKAGE_SHARE (placeholder 15%, the WS3 roadmap figure; measured in
//     Test B step B3 and later by telemetry). Treatment:
//       'reject'  → <Reject>, never connected: £0 (Twilio docs; confirm on
//                   the Call resource in Test B);
//       'message' → a short "not available" message: 1 started inbound minute
//                   + one Polly greeting per leaked call;
//   - unknown-caller usage (connected + monitoring + SMS) is UNCHANGED: HCG
//     still answers every unknown call after the no-reply timer. Unknown
//     calls the customer chooses to answer on the silenced screen would
//     lower cost; not modelled (conservative);
//   - number rental, churn overhang and infra allocation are UNCHANGED.
//
// Run:  node tests/ws5-trusted-bypass-cost-impact.test.mjs           (checks)
//       node tests/ws5-trusted-bypass-cost-impact.test.mjs --print   (tables)

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const register = require('../services/finance/economicsRegister.js');
const model = require('../services/finance/hcgUnitEconomics.js');

const RAW = require('../services/finance/assumptions/hcg-unit-economics.v1.json');
const PROFILES = ['light', 'typical', 'heavy', 'veryHeavy'].map((k) => ({ key: k, ...RAW.usageProfiles[k] }));
const LEAKAGE_SHARE = 0.15;
const INBOUND = register.value('twilioInboundGbpPerMin');
const POLLY = register.value('twilioPollyGbpPerCall');

function leakageCost(profile, treatment, share = LEAKAGE_SHARE) {
  if (treatment === 'reject') return 0;
  const calls = profile.trustedCalls * share;
  return calls * (1 * INBOUND + POLLY);
}

function row(profile, channel, { bypass = false, treatment = 'reject', share = LEAKAGE_SHARE } = {}) {
  const usage = bypass ? { ...profile, trusted: 0, trustedCalls: 0 } : profile;
  const s = model.scenario({ usage, channel });
  const leak = bypass ? leakageCost(profile, treatment, share) : 0;
  const telephonyUsage = s.usage + leak;
  const cost = s.fixed + telephonyUsage;
  const contribution = s.net - s.fee - s.leakage - cost;
  return {
    profile: profile.key, channel, bypass, treatment,
    trustedPart: bypass ? leak : s.usageParts.trusted,
    unknownPart: s.usage - (bypass ? 0 : s.usageParts.trusted),
    usage: telephonyUsage,
    numberRental: register.value('numberRentalGbpPerMonth'),
    fixed: s.fixed,
    totalCostOfService: cost,
    net: s.net, fee: s.fee, revenueLeakage: s.leakage,
    contribution, margin: contribution / s.net,
  };
}

const gbp = (n) => (n < 0 ? `−£${(-n).toFixed(2)}` : `£${n.toFixed(2)}`);
const pct = (n) => `${Math.round(n * 100)}%`;

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else { console.log(`✗ ${msg}`); failures += 1; }
}
const near = (a, b, tol = 0.006) => Math.abs(a - b) <= tol;

// 1. Baseline reproduces the register's published table D (Stripe, £5.99).
const typicalToday = row(PROFILES[1], 'stripe');
check(near(typicalToday.usage, 2.08), `typical usage today = register £2.08 (got ${typicalToday.usage.toFixed(4)})`);
check(near(typicalToday.contribution, 1.28), `typical Stripe contribution today = register £1.28 (got ${typicalToday.contribution.toFixed(4)})`);
check(near(row(PROFILES[0], 'stripe').contribution, 2.56), 'light Stripe contribution today = register £2.56');
check(near(row(PROFILES[2], 'stripe').contribution, -1.60), 'heavy Stripe contribution today = register −£1.60');
check(near(typicalToday.fee, 0.36, 0.005) && near(typicalToday.net - 4.9917, 0, 0.001), 'revenue waterfall: net £4.99, Stripe fee £0.36');

// 2. Bypass invariants.
for (const p of PROFILES) {
  const today = row(p, 'stripe');
  const rej = row(p, 'stripe', { bypass: true, treatment: 'reject' });
  const msg = row(p, 'stripe', { bypass: true, treatment: 'message' });
  check(rej.trustedPart === 0, `${p.key}: bypass + reject → trusted cost £0`);
  check(near(today.usage - rej.usage, today.trustedPart, 1e-9), `${p.key}: saving = exactly today's trusted cost (${gbp(today.trustedPart)})`);
  check(msg.usage > rej.usage && msg.usage - rej.usage < 0.25, `${p.key}: message leakage costs a little more than reject (${gbp(msg.usage - rej.usage)})`);
  check(near(rej.fixed, today.fixed, 1e-9), `${p.key}: fixed costs unchanged by bypass`);
}
// 3. Trusted cost becomes independent of how long people talk.
const longTalk = { ...PROFILES[1], trusted: 5000 };
check(near(row(longTalk, 'stripe', { bypass: true }).usage, row(PROFILES[1], 'stripe', { bypass: true }).usage, 1e-9),
  'bypass: 5,000 trusted minutes cost the same as 150');

if (process.argv.includes('--print')) {
  const lines = [];
  for (const channel of ['stripe', 'google15']) {
    lines.push(`\n#### Channel: ${channel === 'stripe' ? 'Stripe (Android today)' : 'Google Play Billing 15% (likely required before Play Production)'}\n`);
    lines.push('| Profile (trusted/unknown min; trusted/unknown calls) | Today: trusted £ | Today: unknown £ | Today: usage | Today: total cost | Today: margin | Bypass+reject: usage | total | margin | Bypass+message: usage | total | margin |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const p of PROFILES) {
      const t = row(p, channel);
      const r = row(p, channel, { bypass: true, treatment: 'reject' });
      const m = row(p, channel, { bypass: true, treatment: 'message' });
      lines.push(`| ${p.label} (${p.trusted}/${p.unknownMinutes}; ${p.trustedCalls}/${p.unknownCalls}) | ${gbp(t.trustedPart)} | ${gbp(t.unknownPart)} | ${gbp(t.usage)} | ${gbp(t.totalCostOfService)} | ${gbp(t.contribution)} (${pct(t.margin)}) | ${gbp(r.usage)} | ${gbp(r.totalCostOfService)} | ${gbp(r.contribution)} (${pct(r.margin)}) | ${gbp(m.usage)} | ${gbp(m.totalCostOfService)} | ${gbp(m.contribution)} (${pct(m.margin)}) |`);
    }
  }
  const t = row(PROFILES[1], 'stripe');
  lines.push(`\nWaterfall (Stripe): gross £5.99, VAT ${gbp(5.99 - t.net)}, net ${gbp(t.net)}, fee ${gbp(t.fee)}, revenue leakage ${gbp(t.revenueLeakage)}, fixed ${gbp(t.fixed)} (number £${t.numberRental.toFixed(2)} + churn overhang + infra £0.25)`);
  const sens = [0.05, 0.15, 0.30].map((s) => `${pct(s)}: ${gbp(row(PROFILES[1], 'stripe', { bypass: true, treatment: 'message', share: s }).usage)}`).join(', ');
  lines.push(`Typical, bypass + message leakage, usage by leakage share → ${sens}`);
  console.log(lines.join('\n'));
}

console.log(failures === 0 ? '\nALL WS5 COST CHECKS PASSED' : `\n${failures} WS5 COST CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
