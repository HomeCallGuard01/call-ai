// Tests for services/finance/unitEconomics.js (the definitive per-customer model).
// Run with: node tests/unit-economics.test.mjs

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { economics, breakEven, componentCosts, grid } = require('../services/finance/unitEconomics.js');
const { breakEvenMinutes } = require('../services/finance/carrierComparison.js');
const twilio = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'finance', 'carrier-quotes.json')).carriers[0];

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const e = economics(twilio, { priceGbp: 4.99, channel: 'store15', totalMinutes: 100, monitoredShare: 0.1 });
check(close(e.vat, 4.99 - 4.99 / 1.2) && close(e.net, 4.99 / 1.2), 'VAT is backed out of the inc-VAT price at 20%');
check(close(e.fee, (4.99 / 1.2) * 0.15), 'store fee is 15% of the ex-VAT price');
check(close(e.costs.total, e.costs.providerTotal + e.costs.estimatedTotal), 'total cost = CONFIRMED provider costs + ESTIMATED AI costs');
check(close(e.contribution, e.net - e.fee - e.costs.total), 'contribution = net − fee − all costs');
check(e.costs.estimated.transcription > 0 && !('transcription' in e.costs.provider), 'transcription is kept separate from provider (confirmed) costs');

const zero = componentCosts(twilio, { totalMinutes: 0, monitoredShare: 0.1 });
check(close(zero.provider.numberRental, 0.86917) && zero.provider.inboundCalls === 0 && zero.estimated.transcription === 0,
  'a household with no calls costs only number rental (plus the assumed warning SMS)');

const be = breakEven(twilio, { priceGbp: 4.99, channel: 'store15', monitoredShare: 0.15 });
const beCompare = breakEvenMinutes(twilio, { priceGbp: 4.99, channel: 'store15', monitoredShare: 0.15 });
check(Math.abs(be - beCompare) <= 1, `break-even agrees with the carrier comparison model (${be} vs ${beCompare})`);
check(breakEven(twilio, { priceGbp: 5.99, channel: 'store15', monitoredShare: 0.15 }) > be, 'a higher price raises break-even minutes');
check(breakEven(twilio, { priceGbp: 4.99, channel: 'store15', monitoredShare: 0.3 }) < breakEven(twilio, { priceGbp: 4.99, channel: 'store15', monitoredShare: 0.05 }),
  'more monitoring lowers break-even minutes');

const rows = grid(twilio, { priceGbp: 4.99, minutes: [0, 100, 500], monitoredShares: [0.1] });
check(rows.length === 9 && rows.every((r) => Number.isFinite(r.contribution)), 'grid covers every channel × minutes × share');
check(rows.filter((r) => r.totalMinutes === 500).every((r) => r.contribution < 0), 'at 500 minutes/month every channel loses money at £4.99 (Twilio)');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
