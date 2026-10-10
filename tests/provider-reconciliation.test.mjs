// WS2 (2026-10-10) — offline Fortress ↔ provider reconciliation calculator.
// Fixture data only; no API calls.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { reconcile, toGbp } = require('../services/finance/providerReconciliation.js');
const FIX = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ws2-reconciliation', 'fixture.json'), 'utf8'));

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const r = reconcile(FIX);
const call = (s) => r.calls.find((c) => c.callSid.endsWith(s));

check(call('0a').status === 'matched' && call('0a').flags.length === 0 && call('0a').actualGbp === 0.03779, 'trusted call: inbound leg + £0 SDK child leg joined to the parent; billed = model; no flags');
check(call('0b').status === 'matched' && call('0b').flags.length === 0 && Math.abs(call('0b').actualGbp - (0.03023 + 0.01332 + 0.024 * 0.79)) < 1e-6,
  'monitored call: Twilio call + stream + OpenAI (USD→GBP) summed; within 20% of the model');
check(call('0c').flags.includes('undercount') && call('0c').flags.includes('model_gap'), 'billed above the Fortress estimate → undercount (any amount) and model_gap (>20%)');
check(call('0d').status === 'missing_provider', 'Fortress call older than the billing delay with no provider record → missing_provider');
check(call('0e').status === 'pending' && call('0e').flags.length === 0, 'call inside the 24 h billing-delay window → pending, not judged');
check(r.unmatched.length === 1 && r.unmatched[0].gbp === 0.0907, 'a billed call Fortress never authorised is reported (spend outside the Fortress)');
check(r.unpriced.length === 1, 'unknown currency is never guessed (reported as unpriced)');
check(!r.ok && r.alerts.some((a) => a.code === 'provider_spend_outside_fortress' && a.level === 'critical') && r.alerts.some((a) => a.code === 'estimate_undercount'),
  'critical alerts: spend outside Fortress, estimate undercount');
check(r.households['hh-b'].flagged && !r.households['hh-a'].flagged, 'per-household roll-up flags hh-b only');
check(toGbp({ price: '-0.5', priceUnit: 'USD' }, 0.79) === 0.395 && toGbp({ price: 1, priceUnit: 'JPY' }, 0.79) === null, 'currency normalisation');
const clean = reconcile({ ...FIX, fortressCalls: FIX.fortressCalls.slice(0, 2), providerRecords: FIX.providerRecords.slice(0, 5) });
check(clean.ok && clean.alerts.length === 0 && clean.totals.matched === 2, 'a clean export reconciles with no alerts');
const sdkBilled = reconcile({ ...FIX, fortressCalls: [FIX.fortressCalls[0]], providerRecords: [FIX.providerRecords[0], { ...FIX.providerRecords[1], price: '-0.0158' }] });
check(sdkBilled.calls[0].flags.includes('model_gap') && !sdkBilled.calls[0].flags.includes('undercount'),
  'if the SDK leg starts billing (list £0.00316/min): model_gap fires, while Fortress (which already budgets the leg at list) is NOT undercounted');
const strict = reconcile({ ...FIX, options: { gapThreshold: 0.001 } });
check(strict.calls.filter((c) => c.flags.includes('model_gap')).length >= 2, 'threshold is configurable');
let threw = false; try { reconcile({ fortressCalls: [], providerRecords: [] }); } catch { threw = true; }
check(threw, 'asOf is required');

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll reconciliation checks passed.');
