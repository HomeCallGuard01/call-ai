// Tests for services/finance/spendGuard.js (alert evaluation only; no enforcement).
// Run with: node tests/spend-guard.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateSpend } = require('../services/finance/spendGuard.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const codes = (alerts) => alerts.map((a) => `${a.code}:${a.severity}`);

// The real 2026-09-27 shape: 19 numbers owned, ~9 entitled households.
const today = evaluateSpend({ entitledHouseholds: 9, ownedNumbers: 19 });
check(codes(today).includes('NUMBERS_ABOVE_ENTITLED:CRITICAL'), '19 numbers for 9 entitled households is CRITICAL (10 spare)');
check(codes(evaluateSpend({ entitledHouseholds: 9, ownedNumbers: 12 })).includes('NUMBERS_ABOVE_ENTITLED:WARNING'), '3+ spare numbers is a WARNING');
check(evaluateSpend({ entitledHouseholds: 9, ownedNumbers: 11 }).length === 0, 'a small internal/test allowance does not alert');

const quietDay = [
  { date: '2026-09-26', category: 'inbound_voice', amount: 0.12, currency: 'GBP', sourceCategory: 'calls-inbound' },
  { date: '2026-09-26', category: 'number_rental', amount: 0.86917, currency: 'GBP', sourceCategory: 'phonenumbers' },
];
check(evaluateSpend({ entitledHouseholds: 9, dailyTotals: quietDay }).length === 0, 'a normal day raises nothing');
const hotDay = [{ date: '2026-09-26', category: 'inbound_voice', amount: 12, currency: 'GBP', sourceCategory: 'calls-inbound' }];
check(codes(evaluateSpend({ entitledHouseholds: 9, dailyTotals: hotDay })).includes('DAILY_TELEPHONY_SPEND:CRITICAL'), '£12 in a day with 9 households is CRITICAL (> 3 × £3 floor)');
check(codes(evaluateSpend({ entitledHouseholds: 1000, dailyTotals: hotDay })).length === 0, 'the same £12 is normal at 1,000 households (threshold scales)');

const failedSms = [{ date: '2026-09-26', category: 'sms', amount: 0.004, currency: 'GBP', sourceCategory: 'failed-message-processing-fee', count: 1 }];
check(codes(evaluateSpend({ entitledHouseholds: 9, dailyTotals: failedSms })).includes('SMS_DELIVERY_FAILING:CRITICAL'),
  'a failed-message fee is a CRITICAL delivery alert (the 21661 voice-only sender defect), not just a cost');
const smsFlood = [{ date: '2026-09-26', category: 'sms', amount: 2, currency: 'GBP', sourceCategory: 'sms', count: 40 }];
check(codes(evaluateSpend({ entitledHouseholds: 9, dailyTotals: smsFlood })).includes('SMS_VOLUME:CRITICAL'), '40 SMS in a day for 9 households is CRITICAL');
const usd = [{ date: '2026-09-26', category: 'inbound_voice', amount: 50, currency: 'USD', sourceCategory: 'calls-inbound' }];
check(codes(evaluateSpend({ entitledHouseholds: 9, dailyTotals: usd })).includes('SPEND_UNEVALUATED_CURRENCY:WARNING'), 'non-GBP totals are flagged, never silently summed as GBP');

check(evaluateSpend({ entitledHouseholds: 10, monthToDateGbp: 21 }).length === 0, 'month-to-date well under the default budget (floor £90) raises nothing');
check(codes(evaluateSpend({ entitledHouseholds: 10, monthToDateGbp: 30 }, { monthlyBudgetGbp: 35 })).includes('MONTHLY_BUDGET:WARNING'), '80% of an explicit budget is a WARNING');
check(codes(evaluateSpend({ entitledHouseholds: 10, monthToDateGbp: 36 }, { monthlyBudgetGbp: 35 })).includes('MONTHLY_BUDGET:CRITICAL'), 'over budget is CRITICAL');
check(codes(evaluateSpend({ entitledHouseholds: 9, aiSpendGbp: 4 })).includes('DAILY_AI_SPEND:CRITICAL'), '£4/day AI spend at 9 households is CRITICAL');

const hh = evaluateSpend({ entitledHouseholds: 9, households: [
  { householdId: 'a', dayMinutes: 30, monthMinutes: 100, longestCallMinutes: 12 },
  { householdId: 'b', dayMinutes: 150, monthMinutes: 520, longestCallMinutes: 200 },
] });
check(hh.every((a) => a.subject === 'b'), 'an ordinary household raises nothing');
check(['HOUSEHOLD_DAILY_MINUTES:WARNING', 'HOUSEHOLD_MONTH_MINUTES:CRITICAL', 'LONG_CALL:CRITICAL'].every((c) => codes(hh).includes(c)),
  'abnormal per-household usage and a 200-minute call are flagged against the household');
check(hh[0].severity === 'CRITICAL', 'alerts are ordered CRITICAL first');
check(codes(evaluateSpend({ entitledHouseholds: 9, households: [{ householdId: 'c', monthMinutes: 300 }] }, { householdMonthMinutesWarning: 400 })).length === 0,
  'thresholds are overridable');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
