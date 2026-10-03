// Prints worst-case cost exposure per household and company-wide, under the
// controls on main today vs the proposed controls, from the confirmed
// Twilio baseline (docs/finance/carrier-quotes.json). Internal analysis only.
// Run with: node scripts/exposure-report.js
'use strict';

const path = require('path');
const e = require('../services/finance/exposureModel');
const { economics } = require('../services/finance/unitEconomics');

const quotes = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'docs', 'finance', 'carrier-quotes.json'), 'utf8'));
const twilio = quotes.carriers[0];
const appLegBilled = { ...twilio, appLegPerMin: 0.004 * 0.79 };
const f = (n) => `£${n.toFixed(2)}`;
const afterFees = economics(twilio, { priceGbp: 4.99, channel: 'store15', totalMinutes: 0, monitoredShare: 0 }).afterFees;

console.log(`Worst-case exposure — ${twilio.name} [${twilio.status}]; £4.99 after VAT + 15% store fee = ${f(afterFees)}/month\n`);
for (const controls of [e.MAIN_TODAY, e.PROPOSED]) {
  console.log(`Controls: ${controls.label}`);
  console.log(`  per call ≤ ${controls.perCallMaxMinutes} min, monitoring ≤ ${controls.monitoringCapMinutes} min/call, channels/household ${controls.channelsPerHousehold ?? 'UNBOUNDED'}, monitoring £/day ${controls.monitoringDailyCapGbp ?? 'UNBOUNDED'}`);
  console.log('  scenario                                         per day     per 30 days');
  const rows = [
    ['1 line, trusted calls 24h', e.channelExposure(twilio, controls, { channels: 1, callerType: 'trusted' })],
    ['1 line, trusted 24h, app leg billed at list', e.channelExposure(appLegBilled, controls, { channels: 1, callerType: 'trusted' })],
    ['1 line, unknown calls 24h (monitoring-max)', e.monitoringMaxExposure(twilio, controls, { channels: 1 })],
    ['2 lines (call waiting), unknown 24h', e.monitoringMaxExposure(twilio, controls, { channels: 2 })],
    ['10-channel flood on the HCG number', e.monitoringMaxExposure(twilio, controls, { channels: 10 })],
    ['100-channel flood on the HCG number', e.monitoringMaxExposure(twilio, controls, { channels: 100 })],
  ];
  for (const [label, r] of rows) console.log(`  ${label.padEnd(48)} ${f(r.totalGbp).padStart(8)}   ${f(r.totalGbp * 30).padStart(10)}   (channels ${r.channels})`);
  const ceil = e.companyMonitoringCeiling(twilio, controls);
  console.log(`  company monitoring ceiling (${ceil.streams} streams):     ${f(ceil.perDayGbp).padStart(8)}   ${f(ceil.perMonthGbp).padStart(10)}   (inbound legs NOT bounded company-wide)\n`);
}
console.log('Genuine heavy households (15% monitored, 4-min calls):');
for (const h of [0.5, 1, 2, 4, 8]) {
  const r = e.heavyGenuineMonth(twilio, { hoursPerDay: h });
  console.log(`  ${String(h).padStart(3)} h/day  ${String(r.minutes).padStart(6)} min/month  cost ${f(r.totalGbp).padStart(7)}  contribution ${f(afterFees - r.totalGbp).padStart(8)}`);
}
