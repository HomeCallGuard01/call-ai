// providerReconciliation.js — OFFLINE reconciliation of the Fortress ledger
// against provider usage records (WS2, 2026-10-10). Pure; NO API calls: the
// provider records are supplied as data (an export / fixture).
//
// Why: Fortress authorises on ESTIMATES (connected + SDK leg at list, × 1.1
// uplift). Providers bill later (Twilio call prices settle minutes to hours
// after the call; OpenAI usage is daily). Today nothing feeds provider
// actuals back into Fortress (fc_record_actual has no production caller —
// report §1, gap G-8), so this calculator is the control that detects:
//   * undercount      — a call billed ABOVE its Fortress estimate (any amount):
//                       Fortress's bound is then not conservative;
//   * model_gap       — billed differs from the register's expected billed
//                       cost by more than the threshold (default 20%): a rate
//                       or behaviour changed (e.g. the SDK leg starts billing);
//   * unmatched_provider — a billed call Fortress never authorised (outage
//                       fallback, a bypass, a master-token call): the most
//                       important signal of spend outside the Fortress;
//   * missing_provider — a Fortress call with no provider record after the
//                       billing-delay window (export incomplete);
//   * pending          — inside the billing-delay window: not judged yet.
'use strict';

const register = require('./economicsRegister');

const DEFAULTS = Object.freeze({
  gapThreshold: 0.20,
  billingDelayHours: 24,
  usdToGbp: register.value('usdToGbp'),
  rates: {
    inboundPerMin: register.value('twilioInboundGbpPerMin'),
    sdkLegPerMin: register.value('twilioAppLegBilledGbpPerMin'),
    streamPerMin: register.value('twilioMediaStreamGbpPerMin'),
    transcriptionPerMin: register.transcriptionGbpPerMin(),
    pollyPerMonitoredCall: register.value('twilioPollyGbpPerCall'),
  },
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** Provider record → GBP (Twilio prices are negative numbers in price_unit). */
function toGbp(rec, usdToGbp) {
  const amt = Math.abs(num(rec.price !== undefined ? rec.price : rec.cost));
  const unit = String(rec.priceUnit || rec.price_unit || rec.currency || 'GBP').toUpperCase();
  if (unit === 'GBP') return amt;
  if (unit === 'USD') return amt * usdToGbp;
  return null;   // unknown currency: never guessed
}

/** Register-model billed cost for a Fortress call. */
function expectedBilled({ durationSeconds, monitoredSeconds = 0, monitored = false }, rates) {
  const mins = Math.ceil(Math.max(0, num(durationSeconds)) / 60);
  const monMins = Math.ceil(Math.max(0, num(monitoredSeconds)) / 60);
  return mins * (rates.inboundPerMin + rates.sdkLegPerMin) + monMins * (rates.streamPerMin + rates.transcriptionPerMin) + (monitored && monMins > 0 ? rates.pollyPerMonitoredCall : 0);
}

/**
 * @param {object} input
 * @param {Array} input.fortressCalls  [{callSid, householdId, committedGbp, durationSeconds, monitoredSeconds, monitored, settledAt}]
 * @param {Array} input.providerRecords [{provider:'twilio'|'openai', kind:'call'|'sdk_leg'|'stream'|'transcription'|'sms', sid, parentSid?, callSid?, price|cost, priceUnit|currency, startTime}]
 * @param {Date|string} input.asOf
 */
function reconcile({ fortressCalls = [], providerRecords = [], asOf, options = {} }) {
  const o = { ...DEFAULTS, ...options, rates: { ...DEFAULTS.rates, ...(options.rates || {}) } };
  const now = new Date(asOf).getTime();
  if (!Number.isFinite(now)) throw new Error('reconcile: asOf required');
  const byCall = new Map();
  const unmatched = [];
  const unpriced = [];
  const fortressSids = new Set(fortressCalls.map((c) => c.callSid));
  for (const rec of providerRecords) {
    const gbp = toGbp(rec, o.usdToGbp);
    if (gbp === null) { unpriced.push({ sid: rec.sid || null, reason: 'unknown_currency' }); continue; }
    // A child leg (<Dial><Client>) or a stream/transcription belongs to its parent call.
    const key = [rec.callSid, rec.parentSid, rec.sid].find((k) => k && fortressSids.has(k));
    if (!key) { if (rec.kind !== 'sms') unmatched.push({ provider: rec.provider, kind: rec.kind, sid: rec.sid || null, gbp: r6(gbp), startTime: rec.startTime || null }); continue; }
    byCall.set(key, (byCall.get(key) || 0) + gbp);
  }
  const calls = fortressCalls.map((c) => {
    const actual = byCall.has(c.callSid) ? byCall.get(c.callSid) : null;
    const expected = expectedBilled(c, o.rates);
    const estimate = num(c.committedGbp);
    const ageH = (now - new Date(c.settledAt).getTime()) / 3600e3;
    const flags = [];
    let status;
    if (actual === null) {
      status = ageH < o.billingDelayHours ? 'pending' : 'missing_provider';
      if (status === 'missing_provider') flags.push('missing_provider');
    } else {
      status = 'matched';
      if (actual > estimate + 1e-9) flags.push('undercount');
      const base = Math.max(expected, 1e-9);
      if (Math.abs(actual - expected) / base > o.gapThreshold) flags.push('model_gap');
    }
    return { callSid: c.callSid, householdId: c.householdId || null, status, estimateGbp: r6(estimate), expectedBilledGbp: r6(expected),
      actualGbp: actual === null ? null : r6(actual), ratioActualToEstimate: actual === null || estimate === 0 ? null : r6(actual / estimate), flags };
  });
  const matched = calls.filter((c) => c.status === 'matched');
  const sum = (arr, k) => r6(arr.reduce((s, c) => s + num(c[k]), 0));
  const totals = {
    calls: calls.length, matched: matched.length, pending: calls.filter((c) => c.status === 'pending').length,
    missingProvider: calls.filter((c) => c.status === 'missing_provider').length,
    estimateGbpMatched: sum(matched, 'estimateGbp'), expectedBilledGbpMatched: sum(matched, 'expectedBilledGbp'), actualGbpMatched: sum(matched, 'actualGbp'),
    unmatchedProviderGbp: r6(unmatched.reduce((s, u) => s + u.gbp, 0)), unmatchedProviderRecords: unmatched.length,
  };
  const aggGap = totals.expectedBilledGbpMatched > 0 ? (totals.actualGbpMatched - totals.expectedBilledGbpMatched) / totals.expectedBilledGbpMatched : null;
  const households = {};
  for (const c of calls) {
    const h = households[c.householdId || 'unattributed'] || (households[c.householdId || 'unattributed'] = { estimateGbp: 0, actualGbp: 0, flagged: false, flags: [] });
    h.estimateGbp = r6(h.estimateGbp + c.estimateGbp); h.actualGbp = r6(h.actualGbp + num(c.actualGbp));
    for (const f of c.flags) if (!h.flags.includes(f)) h.flags.push(f);
  }
  for (const h of Object.values(households)) h.flagged = h.flags.length > 0;
  const alerts = [];
  if (unmatched.length) alerts.push({ level: 'critical', code: 'provider_spend_outside_fortress', detail: `${unmatched.length} billed record(s), £${totals.unmatchedProviderGbp}` });
  if (calls.some((c) => c.flags.includes('undercount'))) alerts.push({ level: 'critical', code: 'estimate_undercount', detail: `${calls.filter((c) => c.flags.includes('undercount')).length} call(s) billed above estimate` });
  if (aggGap !== null && Math.abs(aggGap) > o.gapThreshold) alerts.push({ level: 'warning', code: 'model_gap', detail: `billed vs register model ${(aggGap * 100).toFixed(1)}%` });
  if (totals.missingProvider) alerts.push({ level: 'warning', code: 'missing_provider_records', detail: `${totals.missingProvider} call(s) older than ${o.billingDelayHours} h have no provider record` });
  if (unpriced.length) alerts.push({ level: 'warning', code: 'unpriced_records', detail: `${unpriced.length} record(s) in an unknown currency` });
  return { asOf: new Date(now).toISOString(), options: { gapThreshold: o.gapThreshold, billingDelayHours: o.billingDelayHours, usdToGbp: o.usdToGbp }, totals,
    aggregateModelGap: aggGap === null ? null : r6(aggGap), calls, households, unmatched, unpriced, alerts, ok: alerts.every((a) => a.level !== 'critical') };
}

module.exports = { DEFAULTS, reconcile, expectedBilled, toGbp };
