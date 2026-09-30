// Tests for services/finance/pricingScenarios.js (evidence model only; no price or allowance is changed).
// Run with: node tests/pricing-scenarios.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ps = require('../services/finance/pricingScenarios.js');
const twilio = require('../docs/finance/carrier-quotes.json').carriers[0];

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

// Hand reconciliation: 100 monitored min in 25 calls, no trusted, 1 SMS.
const usage = { trusted: 0, unknownMinutes: 100, trustedCalls: 0, unknownCalls: 25, sms: 1 };
const hand = 0.86917 + (100 + 0.55 * 25) * 0.007558 + (100 + 0.5 * 25) * 0.003329 + 100 * 0.006 * 0.79 + 25 * 0.0006 + 0.042325;
const c = ps.householdCost(twilio, usage, 100);
check(near(c.total, hand, 1e-9), `100 fully-used monitored minutes cost £${c.total.toFixed(4)} (hand-reconciled)`);
const r = ps.revenue(4.99, 'store15');
check(near(r.net, 4.1583) && near(r.afterFees, 3.5346), '£4.99 → net £4.16 → £3.53 after the 15% store fee');
const k = ps.contribution(twilio, { priceGbp: 4.99, channel: 'store15', usage, allowanceMinutes: 100 });
check(near(k.margin, (r.afterFees - hand) / r.net, 1e-9), 'margin = contribution ÷ net revenue');

// Allowance beyond usage: minutes past the allowance are billed inbound but not monitored.
const over = ps.householdCost(twilio, { trusted: 0, unknownMinutes: 300, trustedCalls: 0, unknownCalls: 75, sms: 0 }, 100);
check(over.monitored === 100 && over.unmonitoredUnknown === 200, 'past the allowance, unknown minutes continue unmonitored');
check(near(over.parts.transcription, 100 * 0.006 * 0.79, 1e-12), 'no transcription cost is incurred beyond the allowance');
check(over.parts.unknownConnected > 200 * 0.007558, 'unmonitored unknown minutes are still billed on the inbound leg');

// Trusted minutes are never free.
const trusted = ps.householdCost(twilio, { trusted: 1800, unknownMinutes: 0, trustedCalls: 450, unknownCalls: 0, sms: 0 }, 100);
check(near(trusted.parts.trustedCalls, (1800 + 0.55 * 450) * 0.007558, 1e-9) && trusted.parts.mediaStreams === 0, 'trusted minutes cost the inbound leg only, for their whole duration');

// Consistency between the allowance solver and the forward model.
const aMax = ps.maxAllowanceForMargin(twilio, { priceGbp: 6.99, channel: 'store15', targetMargin: 0.4, trusted: 0 });
const atMax = ps.contribution(twilio, { priceGbp: 6.99, channel: 'store15', usage: { trusted: 0, unknownMinutes: aMax, trustedCalls: 0, unknownCalls: aMax / 4, sms: 0 }, allowanceMinutes: aMax });
const atMaxPlus = ps.contribution(twilio, { priceGbp: 6.99, channel: 'store15', usage: { trusted: 0, unknownMinutes: aMax + 2, trustedCalls: 0, unknownCalls: (aMax + 2) / 4, sms: 0 }, allowanceMinutes: aMax + 2 });
check(atMax.margin >= 0.4 && atMaxPlus.margin < 0.4, `solver: ${aMax} min is the largest allowance keeping 40% at £6.99 (store)`);
const tMax = ps.trustedMinutesAtMargin(twilio, { priceGbp: 4.99, channel: 'store15', targetMargin: 0 });
const atT = ps.contribution(twilio, { priceGbp: 4.99, channel: 'store15', usage: { trusted: tMax, unknownMinutes: 0, trustedCalls: tMax / 4, unknownCalls: 0, sms: 0 }, allowanceMinutes: 0 });
check(atT.contribution >= 0 && atT.contribution < 0.02, `£4.99 breaks even at ${tMax} trusted minutes with no monitoring at all`);

// Stress scenarios move the right way.
const s25 = ps.contribution(twilio, { priceGbp: 6.99, channel: 'store15', usage, allowanceMinutes: 100, stress: 0.25 });
const app = ps.contribution(twilio, { priceGbp: 6.99, channel: 'store15', usage, allowanceMinutes: 100, appLegBilled: true });
const base = ps.contribution(twilio, { priceGbp: 6.99, channel: 'store15', usage, allowanceMinutes: 100 });
check(s25.contribution < base.contribution && app.contribution < base.contribution, 'a +25% provider rise or a billed app leg both reduce contribution');
check(near(s25.cost.total, base.cost.total * 1.25, 1e-9), '+25% stress scales every provider and AI cost by exactly 25%');

const th = ps.householdCostThresholds({ priceGbp: 6.99, channel: 'store15', targetMargin: 0.4 });
check(near(th.watchAtCostGbp, 5.825 * 0.6 - 5.825 * 0.15) && near(th.lossAtCostGbp, 5.825 * 0.85), 'WATCH/ALERT cost thresholds follow from the target margin');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
