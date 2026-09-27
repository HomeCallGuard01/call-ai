// Prints HCG's definitive per-customer economics from the confirmed Twilio
// baseline (docs/finance/carrier-quotes.json, first carrier) — internal
// analysis only; changes no price.
// Run with: node scripts/unit-economics.js [priceGbp]
'use strict';

const path = require('path');
const { CHANNELS, economics, breakEven } = require('../services/finance/unitEconomics');

const quotes = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'docs', 'finance', 'carrier-quotes.json'), 'utf8'));
const twilio = quotes.carriers[0];
const price = Number(process.argv[2] || 4.99);
const MINUTES = [0, 25, 50, 100, 150, 200, 250, 300, 500];
const SHARES = [0.05, 0.1, 0.2, 0.3];
const f = (n) => (n < 0 ? '-' : ' ') + '£' + Math.abs(n).toFixed(2);

const w = economics(twilio, { priceGbp: price, channel: 'store15', totalMinutes: 100, monitoredShare: 0.1 });
console.log(`HCG unit economics — £${price} inc VAT, provider baseline: ${twilio.name} [${twilio.status}]\n`);
console.log('Worked example: 100 min/month, 10% monitored, Google Play/Apple 15%');
console.log(`  price ${f(w.gross)} → VAT ${f(-w.vat)} → net ${f(w.net)} → store fee ${f(-w.fee)} → ${f(w.afterFees)}`);
for (const [k, v] of Object.entries(w.costs.provider)) if (v) console.log(`  − ${k.padEnd(13)} ${f(v)}  CONFIRMED (Twilio)`);
console.log(`  − transcription ${f(w.costs.estimated.transcription)}  ESTIMATED (OpenAI list price)`);
console.log(`  = contribution ${f(w.contribution)} (${(w.marginOfNet * 100).toFixed(0)}% of net)\n`);

for (const channel of Object.keys(CHANNELS)) {
  console.log(`Contribution per customer/month — ${CHANNELS[channel].label}`);
  console.log(`  monitored ${MINUTES.map((m) => String(m).padStart(7)).join('')}   break-even`);
  for (const s of SHARES) {
    const row = MINUTES.map((m) => f(economics(twilio, { priceGbp: price, channel, totalMinutes: m, monitoredShare: s }).contribution).padStart(7)).join('');
    console.log(`  ${String(Math.round(s * 100)).padStart(6)}%  ${row}   ${breakEven(twilio, { priceGbp: price, channel, monitoredShare: s })} min`);
  }
  console.log('');
}
console.log('Provider costs CONFIRMED from Twilio Pricing API + billing; transcription ESTIMATED; payment/store fees ESTIMATED;');
console.log('assumptions: 4-min average call, +0.55 started minute per call, 1 warning SMS/month (currently FAILS to send — sender is voice-only).');
