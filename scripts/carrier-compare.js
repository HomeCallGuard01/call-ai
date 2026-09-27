// Prints HCG's cost per customer and break-even minutes for each carrier in
// docs/finance/carrier-quotes.json, against the confirmed Twilio baseline.
// Carriers with unquoted prices are shown as UNKNOWN with the missing fields.
// Run with: node scripts/carrier-compare.js [path/to/quotes.json]
'use strict';

const path = require('path');
const { compareCarriers } = require('../services/finance/carrierComparison');

const file = process.argv[2] || path.join(__dirname, '..', 'docs', 'finance', 'carrier-quotes.json');
const input = JSON.parse(require('fs').readFileSync(file, 'utf8'));
const s = input.scenario;
const rows = compareCarriers(input.carriers, s);
console.log(`Scenario: £${s.priceGbp}/month incl. VAT, ${s.monitoredShare * 100}% of minutes monitored. Costs are telephony + transcription per household per month (GBP).`);
for (const r of rows) {
  if (!r.computable) {
    console.log(`\n${r.name} [${r.status}] — cannot compute; missing: ${r.missing.join(', ')}`);
    continue;
  }
  console.log(`\n${r.name} [${r.status}]  break-even: Stripe ${r.breakEvenMinutes.stripe} min / Store 15% ${r.breakEvenMinutes.store15} min`);
  for (const [m, v] of Object.entries(r.monthlyCostByMinutes)) {
    console.log(`  ${String(m).padStart(5)} min: £${v.costGbp.toFixed(2)}  (${v.vsBaselineGbp >= 0 ? '+' : ''}${v.vsBaselineGbp.toFixed(2)} vs baseline)`);
  }
}
