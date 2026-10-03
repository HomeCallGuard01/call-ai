// Tests for services/finance/failureScenarios.js — every failure scenario
// has a finite, code-derived exposure bound (except those only a provider
// setting can stop, which must say so), and bounds move with the limits.
// Run with: node tests/failure-scenarios.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeFailureScenarios } = require('../services/finance/failureScenarios.js');
const { runSpendMonitor } = require('../services/finance/spendMonitor.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const { scenarios, rates } = computeFailureScenarios();
const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
const required = ['business_user', 'call_left_connected', 'call_24h', 'forwarding_loop', 'ten_simultaneous', 'hundred_simultaneous', 'malicious_attack',
  'monitoring_malfunction', 'transcription_price_change', 'app_leg_charged', 'data_stale', 'allowance_mid_call'];
check(required.every((id) => byId[id]), 'every failure scenario Andrew listed has an exposure entry');
const numbers = scenarios.flatMap((s) => Object.entries(s).filter(([, v]) => typeof v === 'number').map(([, v]) => v));
check(numbers.every((v) => Number.isFinite(v) && v >= 0), 'every exposure figure is a finite £ amount');
check(byId.call_24h.perCallGbp < byId.call_24h.withoutControlGbp / 5, `a 24-hour call is capped at £${byId.call_24h.perCallGbp} (vs £${byId.call_24h.withoutControlGbp} uncapped)`);
check(byId.hundred_simultaneous.perDayGbp === byId.ten_simultaneous.perDayGbp, '100 simultaneous calls cost no more than 10 (refusals are unbilled)');
check(byId.ten_simultaneous.perDayGbp < 20 && byId.ten_simultaneous.perPeriodGbp < 50, `flood bound per household: £${byId.ten_simultaneous.perDayGbp}/day, £${byId.ten_simultaneous.perPeriodGbp}/period`);
check(byId.allowance_mid_call.perEventGbp < 0.1, `allowance reached mid-call costs at most £${byId.allowance_mid_call.perEventGbp} extra`);
check(byId.app_leg_charged.perDayGbp === 0 && rates.appLegPerMin > 0, 'the app leg is already priced into the limits, so its billing starting loosens nothing');
check(/NOT DETECTABLE/.test(byId.transcription_price_change.stoppedBy) && byId.transcription_price_change.provider, 'the transcription price risk is stated as undetectable by HCG, with the provider-side stop named');
check(/NOTHING in HCG software/.test(byId.server_down.stoppedBy), 'the outage case says plainly that HCG software cannot stop it');
const tighter = computeFailureScenarios({ env: { SAFETY_MAX_CALL_MINUTES: '120', SAFETY_HOUSEHOLD_DAILY_HARD_GBP: '6' } });
const t = Object.fromEntries(tighter.scenarios.map((s) => [s.id, s]));
check(t.call_left_connected.perCallGbp < byId.call_left_connected.perCallGbp && t.ten_simultaneous.perDayGbp < byId.ten_simultaneous.perDayGbp, 'tightening the configured limits tightens the computed exposure (numbers come from the code)');

// Margin-derived WATCH (below target margin) vs loss-making ALERT.
const now = new Date('2026-09-28T12:00:00Z');
const entry = (hh, amount, day) => ({ household_id: hh, category: 'inbound_voice', entry_class: 'cost', provenance: 'provider_actual', native_amount: amount, native_currency: 'GBP', occurred_at: `2026-09-${day}T10:00:00Z` });
const entries = [];
for (let d = 10; d <= 27; d++) { entries.push(entry('ok', 0.02, d)); entries.push(entry('thin', 0.11, d)); entries.push(entry('loss', 0.2, d)); }
const r = await runSpendMonitor({ load: async () => ({ entries, legs: [], calls: [], entitledHouseholds: 3, lastIngestedAt: '2026-09-28T11:00:00Z' }), now, config: { priceGbp: 4.99, targetMargin: 0.4 } });
const codesFor = (h) => r.alerts.filter((a) => a.subject === h).map((a) => a.code);
check(codesFor('ok').length === 0, 'a household inside the target margin raises nothing');
check(codesFor('thin').includes('HOUSEHOLD_BELOW_TARGET_MARGIN') && !codesFor('thin').includes('HOUSEHOLD_PROJECTED_LOSS'), 'a household under the 40% target margin but still profitable is WATCH only');
check(codesFor('loss').includes('HOUSEHOLD_PROJECTED_LOSS') && !codesFor('loss').includes('HOUSEHOLD_BELOW_TARGET_MARGIN'), 'a loss-making household is flagged as a projected loss (ALERT level), not merely thin margin');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
