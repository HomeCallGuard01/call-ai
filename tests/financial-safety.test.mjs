// Tests for the provider-neutral financial-safety layer:
//   services/finance/householdCosts.js       per-household month-to-date cost
//   services/finance/spendAnomaly.js         anomaly + fail-safe detection
//   services/finance/companySpendProtection.js  company protection level
//   services/finance/exposureModel.js        worst-case exposure
//   services/finance/spendMonitor.js         one monitoring run (injected I/O)
//   database/financialLedger.js loadSpendMonitorData (fake admin, paging)
// Alerting/recommendation only — nothing here enforces a customer limit.
// Run with: node tests/financial-safety.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { accumulateHouseholdCosts, householdContribution, peakConcurrency } = require('../services/finance/householdCosts.js');
const { detectAnomalies } = require('../services/finance/spendAnomaly.js');
const { assessProtection, ACTIONS } = require('../services/finance/companySpendProtection.js');
const exposure = require('../services/finance/exposureModel.js');
const { runSpendMonitor, dailyTotalsFromEntries } = require('../services/finance/spendMonitor.js');
const { loadSpendMonitorData } = require('../database/financialLedger.js');
const quotes = require('../docs/finance/carrier-quotes.json');

const twilio = quotes.carriers[0];
let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const codes = (alerts) => alerts.map((a) => `${a.code}:${a.severity}`);

const INBOUND = 0.007558;
const asOf = '2026-09-28T12:00:00Z';

function inboundLeg(id, household, callId, start, seconds) {
  const s = new Date(start);
  return { id, household_id: household, call_id: callId, leg_type: 'inbound_pstn', started_at: s.toISOString(),
    ended_at: new Date(s.getTime() + seconds * 1000).toISOString(), provider_duration_seconds: seconds,
    billed_quantity: Math.ceil(seconds / 60), billed_unit: 'minute' };
}
function inboundEntry(household, callId, at, seconds, extra = {}) {
  return { household_id: household, call_id: callId, category: 'inbound_voice', entry_class: 'cost', provenance: 'provider_actual',
    native_amount: Math.ceil(seconds / 60) * INBOUND, native_currency: 'GBP', occurred_at: at, ...extra };
}

// ─── householdCosts ─────────────────────────────────────────────────────
{
  const calls = [
    { id: 'c1', household_id: 'h1', status: 'Known', monitored_duration_seconds: null },
    { id: 'c2', household_id: 'h1', status: 'Unknown', monitored_duration_seconds: 150 },
    { id: 'c3', household_id: 'h2', status: 'Known' },
  ];
  const legs = [
    inboundLeg('l1', 'h1', 'c1', '2026-09-28T09:00:00Z', 239),  // 4 billed min, trusted
    inboundLeg('l2', 'h1', 'c2', '2026-09-28T09:02:00Z', 299),  // 5 billed min, unknown, overlaps l1
    { id: 'l2c', household_id: 'h1', call_id: 'c2', leg_type: 'app_client', started_at: '2026-09-28T09:02:05Z', provider_duration_seconds: 288, billed_quantity: 5, billed_unit: 'minute' },
    inboundLeg('l3', 'h2', 'c3', '2026-08-31T23:00:00Z', 600),  // last month: excluded
  ];
  const entries = [
    inboundEntry('h1', 'c1', '2026-09-28T09:00:00Z', 239),
    inboundEntry('h1', 'c2', '2026-09-28T09:02:00Z', 299),
    { household_id: 'h1', call_id: 'c2', category: 'app_leg', entry_class: 'cost', provenance: 'provider_actual', charge_observation: 'not_observed', native_amount: null, native_currency: null, occurred_at: '2026-09-28T09:02:05Z' },
    { household_id: 'h1', call_id: 'c2', category: 'media_stream', entry_class: 'cost', provenance: 'provider_allocated', native_amount: 0.01663, native_currency: 'GBP', occurred_at: '2026-09-28T09:02:00Z' },
    { household_id: 'h1', call_id: 'c2', category: 'transcription', entry_class: 'cost', provenance: 'estimated', native_amount: 0.015, native_currency: 'USD', occurred_at: '2026-09-28T09:02:00Z' },
    { household_id: 'h1', category: 'number_rental', entry_class: 'cost', provenance: 'provider_allocated', native_amount: 0.86917, native_currency: 'GBP', period_start: '2026-09-01T00:00:00Z' },
    { household_id: null, category: 'number_rental', entry_class: 'cost', provenance: 'provider_actual', native_amount: 0.86917, native_currency: 'GBP', period_start: '2026-09-01T00:00:00Z' },
    { household_id: 'h2', call_id: 'c3', category: 'inbound_voice', entry_class: 'cost', provenance: 'provider_actual', native_amount: 0.0756, native_currency: 'GBP', occurred_at: '2026-08-31T23:00:00Z' },
    { household_id: 'h1', category: 'subscription', entry_class: 'revenue', provenance: 'provider_actual', native_amount: 4.99, native_currency: 'GBP', occurred_at: '2026-09-02T00:00:00Z' },
    { household_id: 'h1', call_id: 'c1', category: 'inbound_voice', entry_class: 'cost', provenance: 'provider_actual', native_amount: 1, native_currency: 'GBP', occurred_at: '2026-09-28T15:00:00Z' }, // after asOf
  ];
  const acc = accumulateHouseholdCosts({ entries, legs, calls, asOf });
  const h1 = acc.households.find((h) => h.householdId === 'h1');
  check(near(h1.costGbp.inbound_trusted, 4 * INBOUND) && near(h1.costGbp.inbound_unknown, 5 * INBOUND),
    'inbound cost is split by call class: trusted (Known) vs unknown — trusted minutes are NOT free');
  check(h1.minutes.trustedBilled === 4 && h1.minutes.unknownBilled === 5 && near(h1.minutes.monitored, 2.5) && near(h1.minutes.unmonitoredUnknown, 2.5),
    'minutes: trusted 4, unknown 5, of which 2.5 monitored and 2.5 unmonitored');
  check(h1.quality.unknownItems === 1 && h1.costGbp.app_leg === 0, 'an app leg not yet priced counts as an UNKNOWN item, never as £0 spend');
  check(h1.quality.unconverted.USD === 0.015 && h1.costGbp.transcription === 0, 'USD transcription without an explicit rate is kept unconverted, not summed as GBP');
  check(near(acc.company.unallocatedGbp, 0.86917) && !acc.households.some((h) => h.householdId === null),
    'a cost with no household stays company-level unallocated; it is never spread across customers');
  check(!acc.households.some((h) => h.householdId === 'h2'), 'last month\'s legs and entries are excluded');
  check(near(h1.monthToDateGbp, 9 * INBOUND + 0.01663 + 0.86917), 'revenue and post-asOf rows are not counted as cost');
  check(h1.peakConcurrentInbound === 2, 'overlapping inbound legs give a peak concurrency of 2');
  check(near(h1.quality.actual + h1.quality.allocated, h1.monthToDateGbp), 'every GBP counted is labelled actual/allocated/estimated/manual');

  const withFx = accumulateHouseholdCosts({ entries, legs, calls, asOf, fx: { USD: 0.79 } });
  const h1fx = withFx.households.find((h) => h.householdId === 'h1');
  check(near(h1fx.costGbp.transcription, 0.015 * 0.79) && near(h1fx.quality.estimated, 0.015 * 0.79), 'with an explicit USD rate, transcription is converted and labelled estimated');

  // Projection: rental is a fixed monthly cost and is not scaled by run-rate.
  const days = withFx.elapsedDays;
  const variable = h1fx.monthToDateGbp - 0.86917;
  check(near(h1fx.projectedMonthGbp, variable * (30 / days) + 0.86917, 1e-5), 'month-end projection scales variable cost only, not number rental');
  check(near(peakConcurrency([[0, 10], [10, 20]]), 1), 'back-to-back calls are not counted as concurrent');
}

// Heavy trusted household is loss-making at £4.99 even with zero monitoring.
{
  const calls = []; const legs = []; const entries = [];
  for (let d = 1; d <= 27; d++) {
    for (let k = 0; k < 6; k++) { // 6 × 10-min trusted calls/day
      const id = `c${d}-${k}`;
      const at = `2026-09-${String(d).padStart(2, '0')}T${String(8 + k).padStart(2, '0')}:00:00Z`;
      calls.push({ id, household_id: 'heavy', status: 'Known' });
      legs.push(inboundLeg(`l${id}`, 'heavy', id, at, 600));
      entries.push(inboundEntry('heavy', id, at, 600));
    }
  }
  const acc = accumulateHouseholdCosts({ entries, legs, calls, asOf });
  const h = acc.households[0];
  const c = householdContribution(h, { channel: 'store15' });
  check(h.minutes.monitored === 0 && h.trustedShareOfCost === 1, 'a trusted-only household has zero monitored minutes and 100% trusted cost share');
  check(c.projectedLossMaking && c.projectedContributionGbp < 0, `60 trusted min/day projects a loss at £4.99 (store 15%): ${c.projectedContributionGbp.toFixed(2)}`);
  check(householdContribution({ monthToDateGbp: 1, projectedMonthGbp: 1 }, { channel: 'stripe' }).projectedLossMaking === false, 'an ordinary household is not flagged');
}

// ─── spendAnomaly ───────────────────────────────────────────────────────
{
  const now = '2026-09-28T12:00:00Z';
  check(codes(detectAnomalies({ now, lastIngestedAt: null })).includes('COST_DATA_MISSING:CRITICAL'), 'no ledger data at all is CRITICAL (unobserved, not zero)');
  check(codes(detectAnomalies({ now, lastIngestedAt: '2026-09-26T12:00:00Z' })).includes('COST_DATA_STALE:CRITICAL'), '48h-old data is CRITICAL stale');
  check(detectAnomalies({ now, lastIngestedAt: '2026-09-28T06:00:00Z' }).length === 0, 'fresh data and nothing else raises nothing');

  const base = [];
  for (let d = 14; d >= 1; d--) {
    const date = new Date(Date.parse('2026-09-28T00:00:00Z') - d * 86400000).toISOString().slice(0, 10);
    base.push({ date, category: 'inbound_voice', amount: 1, currency: 'GBP' });
    base.push({ date, category: 'number_rental', amount: 0.5, currency: 'GBP' });
  }
  const fresh = '2026-09-28T11:00:00Z';
  const spike = (amount, category = 'inbound_voice') => detectAnomalies({ now, lastIngestedAt: fresh, dailyTotals: [...base, { date: '2026-09-28', category, amount, currency: 'GBP' }] });
  check(codes(spike(10)).includes('SPEND_SPIKE:CRITICAL'), '£10 vs £1.50 median (6.7×) is a CRITICAL spike');
  check(codes(spike(5)).includes('SPEND_SPIKE:WARNING'), '£5 vs £1.50 median (3.3×) is a WARNING spike');
  check(spike(1.6).length === 0, 'a normal day is not a spike');
  check(!codes(detectAnomalies({ now, lastIngestedAt: fresh, dailyTotals: [{ date: '2026-09-27', category: 'inbound_voice', amount: 0.01, currency: 'GBP' }, { date: '2026-09-28', category: 'inbound_voice', amount: 0.5, currency: 'GBP' }] }, { minBaselineDays: 1 })).some((c) => c.startsWith('SPEND_SPIKE')),
    'a large ratio on tiny absolute amounts (< £2 excess) is not a spike');
  check(codes(detectAnomalies({ now, lastIngestedAt: fresh, dailyTotals: base.slice(-4).concat([{ date: '2026-09-28', category: 'inbound_voice', amount: 9, currency: 'GBP' }]) })).includes('SPIKE_BASELINE_INSUFFICIENT:WARNING'),
    'too little history is reported, not silently treated as normal');
  check(codes(spike(0.2, 'app_leg')).includes('NEW_COST_CATEGORY:CRITICAL'), 'the app leg being charged for the first time is CRITICAL (breaks the £0 app-leg assumption)');
  check(codes(spike(0.2, 'email')).includes('NEW_COST_CATEGORY:WARNING'), 'any other new category is a WARNING');

  const burstLegs = Array.from({ length: 12 }, (_, i) => ({ household_id: 'loop', leg_type: 'inbound_pstn', started_at: new Date(Date.parse('2026-09-28T10:00:00Z') + i * 20000).toISOString() }));
  const spread = Array.from({ length: 12 }, (_, i) => ({ household_id: 'busy', leg_type: 'inbound_pstn', started_at: new Date(Date.parse('2026-09-28T00:00:00Z') + i * 3600000).toISOString() }));
  const b = detectAnomalies({ now, lastIngestedAt: fresh, legs: [...burstLegs, ...spread] });
  check(b.some((a) => a.code === 'CALL_BURST' && a.subject === 'loop') && !b.some((a) => a.subject === 'busy'), '12 calls in 4 minutes is a CALL_BURST; 12 calls spread over a day is not');

  const hh = [...Array.from({ length: 9 }, (_, i) => ({ householdId: `n${i}`, projectedMonthGbp: 1.2, peakConcurrentInbound: 1 })),
    { householdId: 'outlier', projectedMonthGbp: 14, peakConcurrentInbound: 6, trustedShareOfCost: 0.9 }];
  const o = detectAnomalies({ now, lastIngestedAt: fresh, households: hh });
  check(codes(o).includes('HOUSEHOLD_COST_OUTLIER:WARNING') && codes(o).includes('CONCURRENT_CALLS:CRITICAL') && o.every((a) => a.subject === 'outlier'),
    'a household at 10× the median with 6 simultaneous calls is flagged; ordinary households are not');
}

// ─── companySpendProtection ─────────────────────────────────────────────
{
  const clean = assessProtection({ alerts: [], entitledHouseholds: 10, todaySpendGbp: 1, monthToDateGbp: 20 });
  check(clean.name === 'NORMAL' && clean.actions.length === 0, 'a clean evaluation is NORMAL with no actions');

  const stale = assessProtection({ alerts: [{ code: 'COST_DATA_STALE', severity: 'CRITICAL', detail: 'x' }], entitledHouseholds: 10 });
  check(stale.name === 'ALERT' && stale.actions.some((a) => a.id === 'fix_ingestion'), 'stale data is ALERT with a fix-ingestion action');
  check(!stale.actions.some((a) => a.kind === 'call_path'), 'stale data alone never recommends a call-path action');

  const emergency = assessProtection({ alerts: [{ code: 'CALL_BURST', severity: 'CRITICAL', subject: 'hX', detail: 'burst' }], entitledHouseholds: 10, todaySpendGbp: 40, monthToDateGbp: 60 });
  check(emergency.name === 'EMERGENCY' && emergency.thresholds.emergencyDailyGbp === 25, '£40 in a day at 10 households (floor £25) is EMERGENCY');
  check(emergency.actions.find((a) => a.id === 'reject_burst_source').status === 'recommendation_requires_approval', 'rejecting a burst source is only a recommendation without approval');
  check(emergency.actions.find((a) => a.id === 'pause_new_monitoring_flagged').households[0] === 'hX', 'monitoring pause is scoped to flagged households only');
  check(emergency.blocksCallDelivery === false && emergency.actions.every((a) => a.kind !== 'call_path' || a.status !== 'do_now'),
    'INVARIANT: no call-path action is ever executed by the evaluator');
  check(Object.values(ACTIONS).filter((a) => a.affectsCustomers).every((a) => a.kind !== 'notify'), 'every customer-affecting action is manual or call-path (owner-executed)');

  const scaled = assessProtection({ alerts: [], entitledHouseholds: 1000, todaySpendGbp: 40, monthToDateGbp: 900 });
  check(scaled.name === 'NORMAL' && scaled.thresholds.emergencyDailyGbp === 750, 'the same £40 day is normal at 1,000 households (thresholds scale)');
  check(assessProtection({ alerts: [], entitledHouseholds: 10, monthToDateGbp: 260 }).name === 'EMERGENCY', 'month-to-date above the emergency level is EMERGENCY');

  const approved = assessProtection({ alerts: [{ code: 'CALL_BURST', severity: 'CRITICAL', subject: 'hX', detail: 'b' }], entitledHouseholds: 10 }, { approvedActions: ['reject_burst_source'] });
  check(approved.actions.find((a) => a.id === 'reject_burst_source').status === 'approved_for_owner_to_execute', 'an action Andrew approves is marked for its owner to execute (still not executed here)');

  // Hysteresis.
  const r1 = assessProtection({ alerts: [], entitledHouseholds: 10, previous: emergency.state });
  const r2 = assessProtection({ alerts: [], entitledHouseholds: 10, previous: r1.state });
  const r3 = assessProtection({ alerts: [], entitledHouseholds: 10, previous: r2.state });
  check(r1.name === 'EMERGENCY' && r2.name === 'ALERT' && r3.name === 'ALERT', 'de-escalation needs 2 clean runs and drops one level at a time');
  const held = assessProtection({ alerts: [{ code: 'COST_DATA_STALE', severity: 'CRITICAL', detail: 's' }], entitledHouseholds: 10, previous: { level: 3, lowerRuns: 5 } });
  check(held.name === 'EMERGENCY', 'the level cannot step down while cost data is unobserved');
  check(assessProtection({ alerts: [{ code: 'X', severity: 'CRITICAL', detail: 'd' }], entitledHouseholds: 10, previous: { level: 0, lowerRuns: 0 } }).name === 'ALERT', 'escalation is immediate');
}

// ─── exposureModel: worst cases ─────────────────────────────────────────
{
  const { MAIN_TODAY, PROPOSED } = exposure;
  const trustedDay = exposure.channelExposure(twilio, MAIN_TODAY, { channels: 1, callerType: 'trusted' });
  check(near(trustedDay.totalGbp, 1440 * INBOUND, 1e-6), `one line of trusted calls all day costs £${trustedDay.totalGbp.toFixed(2)} (inbound leg only)`);
  const mon = exposure.monitoringMaxExposure(twilio, MAIN_TODAY, { channels: 1 });
  const expectMon = 1440 * INBOUND + 1440 * (0.003329 + 0.006 * 0.79) + 48 * 0.0006;
  check(near(mon.totalGbp, expectMon, 1e-6), `one channel of back-to-back 30-min unknown calls costs £${mon.totalGbp.toFixed(2)}/day on main`);
  const flood10 = exposure.monitoringMaxExposure(twilio, MAIN_TODAY, { channels: 10 });
  check(near(flood10.totalGbp, 10 * mon.totalGbp, 1e-6), 'on main there is no per-household channel limit: 10 channels = 10× (unbounded in N)');
  const floodProposed = exposure.monitoringMaxExposure(twilio, PROPOSED, { channels: 10 });
  check(floodProposed.channels === 4 && floodProposed.monitoringGbp === 2, 'proposed controls cap a flood at 4 channels and £2/day monitoring');
  check(floodProposed.totalGbp < flood10.totalGbp / 2, `proposed controls bound the 10-channel flood to £${floodProposed.totalGbp.toFixed(2)}/day (from £${flood10.totalGbp.toFixed(2)})`);
  const ceiling = exposure.companyMonitoringCeiling(twilio, MAIN_TODAY);
  check(near(ceiling.perDayGbp, 200 * 1440 * (0.003329 + 0.006 * 0.79), 1e-6), `company monitoring ceiling on main (200 streams) ≈ £${ceiling.perDayGbp.toFixed(0)}/day`);
  const heavy = exposure.heavyGenuineMonth(twilio, { hoursPerDay: 2 });
  check(heavy.totalGbp > 4.99 / 1.2, `a genuine 2h/day household costs £${heavy.totalGbp.toFixed(2)}/month — above £4.99 net revenue`);
  const appLegBilled = exposure.channelExposure({ ...twilio, appLegPerMin: 0.004 * 0.79 }, MAIN_TODAY, { channels: 1, callerType: 'trusted' });
  check(appLegBilled.totalGbp > trustedDay.totalGbp * 1.4, 'if the app leg starts being billed at list, trusted exposure rises > 40%');
}

// ─── spendMonitor: end-to-end with injected I/O ─────────────────────────
{
  const now = new Date('2026-09-28T12:00:00Z');
  const sent = [];
  const sendOk = async (type, message, context) => { sent.push({ type, message, context }); return true; };

  // Fail-safe on load failure.
  const failed = await runSpendMonitor({ load: async () => { throw new Error('connection refused'); }, sendCriticalAlert: sendOk, now });
  check(!failed.ok && failed.protection.name === 'ALERT' && failed.alerts[0].code === 'MONITOR_LOAD_FAILED', 'a load failure is ALERT (spend unobserved), never a clean result');
  check(sent.length === 1 && sent[0].type === 'spend_protection', 'the load failure is alerted');
  const again = await runSpendMonitor({ load: async () => { throw new Error('x'); }, sendCriticalAlert: sendOk, now, state: failed.state });
  check(sent.length === 1 && again.notified === 0, 'the same critical is not re-sent the same day');
  let attempts = 0;
  const sendFails = async () => { attempts++; return false; };
  const r1 = await runSpendMonitor({ load: async () => { throw new Error('x'); }, sendCriticalAlert: sendFails, now });
  await runSpendMonitor({ load: async () => { throw new Error('x'); }, sendCriticalAlert: sendFails, now, state: r1.state });
  check(attempts === 2, 'an undelivered alert (false / rate-limited) is retried on the next run');

  // Extreme: a flood to one household (40 simultaneous 30-min unknown calls, back to back since midnight).
  const calls = []; const legs = []; const entries = [];
  for (let d = 14; d >= 1; d--) { // quiet baseline: £0.40/day inbound
    const at = new Date(now.getTime() - d * 86400000).toISOString();
    entries.push({ household_id: 'q', category: 'inbound_voice', entry_class: 'cost', provenance: 'provider_actual', native_amount: 0.4, native_currency: 'GBP', occurred_at: at });
  }
  for (let slot = 0; slot < 24; slot++) {
    for (let ch = 0; ch < 40; ch++) {
      const id = `f${slot}-${ch}`;
      const at = new Date(Date.parse('2026-09-28T00:00:00Z') + slot * 30 * 60000 + ch * 1000).toISOString();
      calls.push({ id, household_id: 'victim', status: 'Unknown', monitored_duration_seconds: 1800 });
      legs.push(inboundLeg(`l${id}`, 'victim', id, at, 1800));
      entries.push(inboundEntry('victim', id, at, 1800));
      entries.push({ household_id: 'victim', call_id: id, category: 'media_stream', entry_class: 'cost', provenance: 'provider_allocated', native_amount: 30 * 0.003329, native_currency: 'GBP', occurred_at: at });
    }
  }
  sent.length = 0;
  const flood = await runSpendMonitor({
    load: async () => ({ entries, legs, calls, entitledHouseholds: 10, ownedNumbers: 12, lastIngestedAt: '2026-09-28T11:30:00Z' }),
    sendCriticalAlert: sendOk, now,
  });
  const fc = codes(flood.alerts);
  check(flood.ok && flood.protection.name === 'EMERGENCY', `a 40-channel flood (£${flood.metrics.company.todaySpendGbp}/day) puts the company in EMERGENCY`);
  check(['CALL_BURST:CRITICAL', 'CONCURRENT_CALLS:CRITICAL', 'SPEND_SPIKE:CRITICAL', 'DAILY_TELEPHONY_SPEND:CRITICAL', 'HOUSEHOLD_DAILY_MINUTES:CRITICAL'].every((c) => fc.includes(c)),
    'the flood raises burst, concurrency, spike, daily-spend and household-minutes criticals');
  check(flood.protection.actions.some((a) => a.id === 'reject_burst_source' && a.households.includes('victim') && a.status === 'recommendation_requires_approval'),
    'the targeted response is recommended for the victim household, pending approval');
  check(sent.length === 1 && sent[0].context.alerts.length >= 5 && sent[0].context.recommendedActionsNothingExecuted.length > 0, 'one consolidated alert carries every new critical and the recommended actions');
  const m = flood.metrics.households.find((h) => h.householdId === 'victim');
  check(m.unknownMinutes === 960 * 30 && m.monitoredMinutes === 960 * 30 && m.peakConcurrentInbound === 40 && m.projectedContributionGbp < -100, 'dashboard metrics expose minutes, concurrency and projected loss for the household');
  check(flood.metrics.currency === 'GBP' && typeof flood.metrics.company.unallocatedGbp === 'number' && flood.metrics.protectionLevel === 'EMERGENCY', 'company metrics are dashboard-shaped');

  // Performance: 100k legs (≈1,000 households' month) evaluate quickly.
  const bigLegs = []; const bigCalls = []; const bigEntries = [];
  for (let i = 0; i < 100000; i++) {
    const hh = `h${i % 1000}`; const id = `b${i}`;
    const at = new Date(Date.parse('2026-09-01T00:00:00Z') + (i % 27) * 86400000 + (i % 1440) * 60000).toISOString();
    bigCalls.push({ id, household_id: hh, status: i % 7 ? 'Known' : 'Unknown', monitored_duration_seconds: i % 7 ? null : 120 });
    bigLegs.push(inboundLeg(`l${id}`, hh, id, at, 240));
    bigEntries.push(inboundEntry(hh, id, at, 240));
  }
  const t0 = Date.now();
  const big = await runSpendMonitor({ load: async () => ({ entries: bigEntries, legs: bigLegs, calls: bigCalls, entitledHouseholds: 1000, lastIngestedAt: '2026-09-28T11:00:00Z' }), now });
  const ms = Date.now() - t0;
  check(big.ok && big.metrics.households.length === 1000 && ms < 5000, `100,000 legs across 1,000 households evaluate in ${ms} ms`);

  const d = dailyTotalsFromEntries([{ category: 'sms', entry_class: 'cost', native_amount: 0.0015, native_currency: 'GBP', occurred_at: '2026-09-28T01:00:00Z', evidence: { usage_category: 'failed-message-processing-fee' } }]);
  check(d[0].sourceCategory === 'failed-message-processing-fee', 'the supplier category is carried through so failed-SMS fees are still detected');
}

// ─── loadSpendMonitorData (fake admin, paging) ──────────────────────────
{
  const tables = {
    financial_entries: [{ id: 1, updated_at: '2026-09-28T10:00:00Z' }, { id: 2, updated_at: '2026-09-28T11:00:00Z' }, { id: 3, updated_at: '2026-09-27T11:00:00Z' }],
    telephony_call_legs: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    calls: [{ id: 'a' }],
    entitlements: [{ household_id: 'h1' }, { household_id: 'h1' }, { household_id: 'h2' }],
  };
  const seen = [];
  const admin = {
    from(table) {
      const q = { table, filters: [], lim: null, range: null, ord: null };
      const b = {
        select() { return b; }, in(...a) { q.filters.push(['in', ...a]); return b; }, or(...a) { q.filters.push(['or', ...a]); return b; },
        gte(...a) { q.filters.push(['gte', ...a]); return b; }, eq(...a) { q.filters.push(['eq', ...a]); return b; },
        order(col, opts) { q.ord = [col, opts]; return b; },
        limit(n) { q.lim = n; return b.then ? b : b; },
        range(from, to) { seen.push([table, from, to]); return Promise.resolve({ data: tables[table].slice(from, to + 1), error: null }); },
        then(resolve) {
          let rows = tables[table].slice();
          if (q.ord && q.ord[1] && q.ord[1].ascending === false) rows.sort((x, y) => (x[q.ord[0]] < y[q.ord[0]] ? 1 : -1));
          return Promise.resolve({ data: rows.slice(0, q.lim || rows.length), error: null }).then(resolve);
        },
      };
      return b;
    },
  };
  const data = await loadSpendMonitorData({ since: '2026-09-01T00:00:00Z', pageSize: 2 }, { admin });
  check(data.legs.length === 5 && seen.filter(([t]) => t === 'telephony_call_legs').length === 3, 'legs are fetched in pages until exhausted (never truncated at one page)');
  check(data.entitledHouseholds === 2, 'entitled households are counted once each');
  check(data.lastIngestedAt === '2026-09-28T11:00:00Z', 'lastIngestedAt is the newest ledger write');
  const failing = { from() { const b = { select: () => b, in: () => b, or: () => b, gte: () => b, eq: () => b, order: () => b, limit: () => Promise.resolve({ data: null, error: new Error('permission denied') }), range: () => Promise.resolve({ data: null, error: new Error('permission denied') }) }; return b; } };
  let threw = false;
  try { await loadSpendMonitorData({ since: '2026-09-01' }, { admin: failing }); } catch { threw = true; }
  check(threw, 'a database error propagates (so the monitor reports MONITOR_LOAD_FAILED instead of zero)');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
