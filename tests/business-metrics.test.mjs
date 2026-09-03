// Unit tests for the business/profitability dashboard's pure logic
// (services/businessMetrics/*.js) — 2026-09 build. No real Stripe/
// Twilio/OpenAI/Supabase calls; every I/O-touching function is exercised
// only via its pure calculation core, matching this codebase's
// established convention throughout (see tests/call-routing.test.mjs).
//
// Run with: node tests/business-metrics.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { splitVatInclusive } = require('../services/businessMetrics/vat.js');
const {
  resolveVatRate,
  resolveUsdToGbpRate,
  resolveFixedMonthlyCostsGbp,
  resolveOpenAiEstimateInputs,
  resolveFairUseThresholds,
} = require('../services/businessMetrics/config.js');
const { estimateOpenAiCostGbp, isOpenAiKeyConfigured } = require('../services/businessMetrics/openaiCosts.js');
const { estimateAppleRevenueGbp, netOfVat } = require('../services/businessMetrics/revenue.js');
const { summariseCalls, rankHouseholdsByUnknownCallCount } = require('../services/businessMetrics/callStats.js');
const {
  computeOverallStatus,
  checkOpenAiHealth,
  checkStripeHealth,
} = require('../services/businessMetrics/systemHealth.js');
const { computeProfitabilitySnapshot, computeBreakEvenMonitoredMinutes } = require('../services/businessMetrics/profitability.js');
const { classifyFairUseTier, classifyHouseholds } = require('../services/businessMetrics/fairUse.js');
const { sumUsageRecordsGbp } = require('../services/businessMetrics/twilioCosts.js');
const { getBackendReleaseInfo } = require('../services/businessMetrics/releaseInfo.js');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- VAT ---

{
  const result = splitVatInclusive(4.99, 0.20);
  check(Math.abs(result.netAmount - 4.1583) < 0.001, 'splitVatInclusive: £4.99 gross at 20% VAT nets to ~£4.1583');
  check(Math.abs(result.vatAmount - 0.8317) < 0.001, 'splitVatInclusive: the VAT element is ~£0.8317');
  check(Math.abs(result.netAmount + result.vatAmount - result.grossAmount) < 1e-9, 'splitVatInclusive: net + VAT always reconstructs gross exactly');
}
{
  const result = splitVatInclusive(0, 0.20);
  check(result.netAmount === 0 && result.vatAmount === 0, 'splitVatInclusive: zero gross produces zero net and zero VAT, never NaN');
}

// --- config resolution: every value is configuration-driven with a safe default ---

check(resolveVatRate({}) === 0.20, 'resolveVatRate defaults to the UK standard 20%');
check(resolveVatRate({ BUSINESS_VAT_RATE: '0.15' }) === 0.15, 'resolveVatRate is configurable via env');
check(resolveVatRate({ BUSINESS_VAT_RATE: '1.5' }) === 0.20, 'resolveVatRate rejects an out-of-range value and falls back to the default');

check(resolveUsdToGbpRate({}) > 0, 'resolveUsdToGbpRate has a positive default');
check(resolveUsdToGbpRate({ BUSINESS_FX_USD_TO_GBP: '0.80' }) === 0.80, 'resolveUsdToGbpRate is configurable via env');

{
  const costs = resolveFixedMonthlyCostsGbp({});
  check(costs.railway === 0 && costs.supabase === 0 && costs.resend === 0, 'resolveFixedMonthlyCostsGbp defaults every unconfigured provider to £0, not a guessed figure');
  const configured = resolveFixedMonthlyCostsGbp({ BUSINESS_FIXED_COST_RAILWAY_GBP: '20' });
  check(configured.railway === 20, 'resolveFixedMonthlyCostsGbp reads a configured value correctly');
}

{
  const thresholds = resolveFairUseThresholds({});
  check(thresholds.warningCallsPerMonth > 0 && thresholds.hardCallsPerMonth > thresholds.warningCallsPerMonth, 'resolveFairUseThresholds: the hard threshold is always above the warning threshold by default');
}

// --- OpenAI cost estimate: always labeled, never presented as actual ---

{
  const estimate = estimateOpenAiCostGbp(100, { env: {} });
  check(estimate.estimated === true, 'estimateOpenAiCostGbp always flags itself as an estimate — never omitted');
  check(estimate.estimatedCostGbp > 0, '100 monitored calls produce a nonzero estimated cost');
  check(estimateOpenAiCostGbp(0, { env: {} }).estimatedCostGbp === 0, 'zero calls produces exactly zero estimated cost, not a fixed baseline');
}
check(isOpenAiKeyConfigured({ OPENAI_API_KEY: 'sk-test' }) === true, 'isOpenAiKeyConfigured detects presence without reading/logging the value');
check(isOpenAiKeyConfigured({}) === false, 'isOpenAiKeyConfigured correctly reports absence');

// --- Apple revenue: estimate, clearly distinguished from actual ---

{
  const apple = estimateAppleRevenueGbp(10, 4.99);
  check(apple.estimated === true, 'estimateAppleRevenueGbp always flags itself as an estimate');
  check(Math.abs(apple.grossRevenueEstimateGbp - 49.9) < 0.001, '10 active Apple entitlements at £4.99 estimates to £49.90 gross');
  check(typeof apple.note === 'string' && apple.note.length > 0, 'estimateAppleRevenueGbp always carries an explanatory note about what it is not');
}

check(Math.abs(netOfVat(4.99).netAmount - 4.1583) < 0.001, 'netOfVat reuses the same VAT split for the real product price');

// --- call stats: built only from existing columns, honest about the missing duration column ---

{
  const summary = summariseCalls([
    { status: 'Known', risk_score: null },
    { status: 'Unknown', risk_score: 10, warning_sent: false, terminated_by_system: false },
    { status: 'Unknown', risk_score: 45, warning_sent: true, terminated_by_system: false },
    { status: 'Unknown', risk_score: 90, warning_sent: true, terminated_by_system: true },
  ]);
  check(summary.totalCalls === 4, 'summariseCalls counts every row');
  check(summary.knownContactCalls === 1, 'summariseCalls separates Known from Unknown correctly');
  check(summary.unknownMonitoredCalls === 3, 'summariseCalls counts Unknown calls correctly');
  check(summary.safeCalls === 1 && summary.suspiciousCalls === 1 && summary.highRiskCalls === 1, 'summariseCalls bands risk scores using the same 25/60 boundaries as the live scoring engine, not an independently invented scale');
  check(summary.warningsSent === 2, 'summariseCalls counts warnings sent');
  check(summary.callsTerminatedByHcg === 1, 'summariseCalls counts system terminations');
  check(summary.averageRiskScore === Number(((10 + 45 + 90) / 3).toFixed(1)), 'summariseCalls computes the average risk score only across Unknown/scored calls');
  check(summary.averageMonitoredDurationSeconds === null, 'summariseCalls is explicit that monitored duration is unavailable (null), never fabricated as 0 or omitted');
}
{
  const summary = summariseCalls([]);
  check(summary.totalCalls === 0 && summary.averageRiskScore === null, 'summariseCalls handles an empty call list without throwing, and never reports an average risk score with no data');
}

{
  const ranked = rankHouseholdsByUnknownCallCount([
    { household_id: 'h1', status: 'Unknown' },
    { household_id: 'h1', status: 'Unknown' },
    { household_id: 'h2', status: 'Unknown' },
    { household_id: 'h1', status: 'Known' }, // must not count
    { household_id: null, status: 'Unknown' }, // must not throw/crash
  ], 10);
  check(ranked.length === 2, 'rankHouseholdsByUnknownCallCount only counts Unknown calls with a real household id');
  check(ranked[0].householdId === 'h1' && ranked[0].unknownCallCount === 2, 'rankHouseholdsByUnknownCallCount ranks by count, highest first');
}

// --- system health: configured is never automatically GREEN ---

check(checkOpenAiHealth({}).status === 'RED', 'checkOpenAiHealth: no key configured is RED — scam-risk transcription cannot function at all');
check(checkOpenAiHealth({ OPENAI_API_KEY: 'sk-test' }).status === 'AMBER', 'checkOpenAiHealth: a configured key is AMBER, not GREEN — this app has no persisted evidence of recent successful transcription to justify GREEN');
check(checkStripeHealth(0).status === 'GREEN', 'checkStripeHealth: zero recent failed webhooks is GREEN');
check(checkStripeHealth(3).status === 'AMBER', 'checkStripeHealth: recent failed webhooks degrade status, never silently ignored');

check(computeOverallStatus({ a: { status: 'GREEN' }, b: { status: 'GREEN' } }) === 'GREEN', 'computeOverallStatus: all green is green');
check(computeOverallStatus({ a: { status: 'GREEN' }, b: { status: 'AMBER' } }) === 'AMBER', 'computeOverallStatus: any amber pulls the overall status down to amber');
check(computeOverallStatus({ a: { status: 'AMBER' }, b: { status: 'RED' } }) === 'RED', 'computeOverallStatus: any red wins over amber — a protection-critical failure is never masked by unrelated amber gaps');

// --- profitability: transparent, drill-down-able, never a mystery number ---

{
  const snapshot = computeProfitabilitySnapshot({
    stripeGrossRevenueGbp: 100,
    stripeFeesGbp: 3,
    appleRevenueEstimateGbp: 20,
    twilioCostGbp: 10,
    openaiCostEstimateGbp: 5,
    fixedMonthlyCostsGbp: 15,
    vatRateAppliedToGross: 0.20,
    activeCustomerCount: 20,
  });
  check(snapshot.revenue.totalGrossRevenueGbp === 120, 'computeProfitabilitySnapshot sums Stripe + Apple gross revenue correctly');
  check(Math.abs(snapshot.revenue.netRevenueExVatGbp - 100) < 0.01, 'computeProfitabilitySnapshot correctly backs VAT out of £120 gross at 20% to £100 net');
  check(snapshot.costs.totalVariableCostsGbp === 18, 'computeProfitabilitySnapshot sums variable costs (fees + Twilio + OpenAI) correctly');
  check(Math.abs(snapshot.profit.contributionGbp - 82) < 0.01, 'computeProfitabilitySnapshot: contribution = net revenue - variable costs');
  check(Math.abs(snapshot.profit.operatingProfitGbp - 67) < 0.01, 'computeProfitabilitySnapshot: operating profit further deducts fixed costs');
  check(snapshot.perCustomer.avgRevenuePerCustomerGbp === 5, 'computeProfitabilitySnapshot: per-customer averages divide by the real active customer count');
}
{
  const snapshot = computeProfitabilitySnapshot({
    stripeGrossRevenueGbp: 0, stripeFeesGbp: 0, appleRevenueEstimateGbp: 0,
    twilioCostGbp: 0, openaiCostEstimateGbp: 0, fixedMonthlyCostsGbp: 0,
    vatRateAppliedToGross: 0.20, activeCustomerCount: 0,
  });
  check(snapshot.perCustomer.avgRevenuePerCustomerGbp === null, 'computeProfitabilitySnapshot: zero customers produces null per-customer figures, never a division-by-zero artifact');
  check(snapshot.profit.grossMarginPercent === null, 'computeProfitabilitySnapshot: zero revenue produces a null margin, not a misleading 0% or Infinity');
}

{
  const breakEven = computeBreakEvenMonitoredMinutes({ netRevenuePerCustomerGbp: 4.16, fixedCostPerCustomerGbp: 0.87, costPerMonitoredMinuteGbp: 0.024 });
  check(breakEven > 100 && breakEven < 150, `computeBreakEvenMonitoredMinutes produces a plausible break-even figure (got ${breakEven})`);
  check(computeBreakEvenMonitoredMinutes({ netRevenuePerCustomerGbp: 1, fixedCostPerCustomerGbp: 5, costPerMonitoredMinuteGbp: 0.02 }) === 0, 'computeBreakEvenMonitoredMinutes: a customer already unprofitable before any monitoring cost returns 0, not a negative number');
  check(computeBreakEvenMonitoredMinutes({ netRevenuePerCustomerGbp: 4, fixedCostPerCustomerGbp: 0, costPerMonitoredMinuteGbp: 0 }) === null, 'computeBreakEvenMonitoredMinutes: an unconfigured (zero) per-minute cost returns null rather than dividing by zero');
}

// --- fair use: visibility/classification only ---

{
  const thresholds = { warningCallsPerMonth: 40, hardCallsPerMonth: 80 };
  check(classifyFairUseTier(10, thresholds) === 'normal', 'classifyFairUseTier: well under threshold is normal');
  check(classifyFairUseTier(40, thresholds) === 'approaching_threshold', 'classifyFairUseTier: exactly at the warning threshold is approaching (inclusive boundary)');
  check(classifyFairUseTier(80, thresholds) === 'over_hard_threshold', 'classifyFairUseTier: exactly at the hard threshold is already over (inclusive boundary)');
}
{
  const result = classifyHouseholds([{ householdId: 'h1', unknownCallCount: 90 }, { householdId: 'h2', unknownCallCount: 5 }], {});
  check(result.overHardThresholdCount === 1, 'classifyHouseholds correctly counts households over the hard threshold');
  check(result.approachingCount === 0, 'classifyHouseholds does not double-count a household in both tiers');
}

// --- Twilio usage summing ---

check(sumUsageRecordsGbp([{ price: '1.5' }, { price: '-0.2' }]) === 1.7, 'sumUsageRecordsGbp sums absolute values (Twilio reports cost as a negative price internally in some categories)');
check(sumUsageRecordsGbp([]) === 0, 'sumUsageRecordsGbp is 0 for no records');
check(sumUsageRecordsGbp(null) === 0, 'sumUsageRecordsGbp never throws on a null/missing list');

// --- release info: UNCONFIRMED when Railway vars are absent, never guessed ---

{
  const info = getBackendReleaseInfo({});
  check(info.gitCommitSha === null && info.gitCommitShaConfirmed === false, 'getBackendReleaseInfo reports null/unconfirmed rather than guessing a commit when RAILWAY_GIT_COMMIT_SHA is absent');
}
{
  const info = getBackendReleaseInfo({ RAILWAY_GIT_COMMIT_SHA: 'abc123', RAILWAY_GIT_BRANCH: 'main' });
  check(info.gitCommitSha === 'abc123' && info.gitCommitShaConfirmed === true, 'getBackendReleaseInfo reads real Railway-injected values when present');
}

console.log(failures === 0 ? '\nAll business-metrics checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
