// Tests for services/finance/carrierComparison.js and the quotes template.
// Run with: node tests/carrier-comparison.test.mjs

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { compareCarriers, monthlyCost, breakEvenMinutes, missingFields } = require('../services/finance/carrierComparison.js');
const template = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'finance', 'carrier-quotes.json'));

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const twilio = template.carriers[0];
check(twilio.status === 'CONFIRMED' && missingFields(twilio).length === 0, 'the Twilio baseline in the template is CONFIRMED and complete');
check(template.carriers.slice(2).every((c) => c.status === 'UNKNOWN' && missingFields(c).length === 8),
  'unquoted carriers stay UNKNOWN with every price null (nothing invented)');

const zero = monthlyCost(twilio, { totalMinutes: 0, monitoredShare: 0.15 });
check(Math.abs(zero - (0.86917 + 0.042325)) < 1e-9, 'a household with no calls costs the number rental plus the assumed warning SMS');
const be = breakEvenMinutes(twilio, { priceGbp: 4.99, channel: 'store15', monitoredShare: 0.15 });
check(be >= 255 && be <= 275, `£4.99 Store break-even on Twilio is about 264 minutes (got ${be})`);

const rows = compareCarriers(template.carriers, template.scenario);
check(rows[0].computable && rows[0].monthlyCostByMinutes[100].vsBaselineGbp === 0, 'the baseline compares to itself with zero difference');
check(rows[1].computable && rows[1].breakEvenMinutes.store15 < rows[0].breakEvenMinutes.store15, 'billing the app leg lowers break-even minutes');
check(!rows[2].computable && rows[2].missing.includes('inboundPerMin'), 'an unquoted carrier is reported as not computable, naming the missing prices');

const perSecond = { ...twilio, name: 'per-second test', status: 'HYPOTHETICAL', billingIncrementSec: 1 };
check(monthlyCost(perSecond, { totalMinutes: 250, monitoredShare: 0.15 }) < monthlyCost(twilio, { totalMinutes: 250, monitoredShare: 0.15 }),
  'per-second billing costs less than per-started-minute billing at the same rate');
const channel = { ...twilio, name: 'channel test', status: 'HYPOTHETICAL', inboundPerMin: 0, channelMonthly: 12, channelsPerThousandHouseholds: 40, fxToGbp: 1 };
check(Math.abs(monthlyCost(channel, { totalMinutes: 0, monitoredShare: 0 }) - (0.86917 + 0.042325 + 0.48)) < 1e-9,
  'channel billing adds each household\'s share of the channel fee (12 × 40 / 1000 = £0.48)');
const usd = { ...twilio, name: 'usd test', fxToGbp: 0.5 };
check(Math.abs(monthlyCost(usd, { totalMinutes: 0, monitoredShare: 0 }) - (0.86917 + 0.042325) * 0.5) < 1e-9, 'quotes are converted with the quote\'s own fxToGbp');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
