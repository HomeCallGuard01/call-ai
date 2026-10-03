// householdCosts.js — month-to-date cost per household, component by
// component, from ledger rows (migration 051 shapes: financial_entries,
// telephony_call_legs) plus the HCG calls they link to. Pure and
// provider-neutral: it reads ledger categories, never a supplier API.
//
// What it answers, per household:
//   - minutes: trusted (Known caller) vs unknown; monitored vs unmonitored
//   - cost by component (number, inbound trusted/unknown, app leg, streams,
//     TTS, SMS, transcription, other), in GBP
//   - how much of that is supplier-confirmed vs allocated vs estimated,
//     and how many items are still UNKNOWN (never counted as £0)
//   - a month-end projection and contribution against the £4.99 price
//     (internal only — nothing here is shown to or enforced on a customer)
//
// Money rules (LEDGER_REPORTING_INTERFACE.md): currencies are never added
// together. Non-GBP rows are converted only when an explicit rate is given
// (fx.USD etc.); otherwise they are counted as unconverted, not dropped.
'use strict';

const { CHANNELS } = require('./unitEconomics');

const COMPONENTS = ['number_rental', 'inbound_trusted', 'inbound_unknown', 'inbound_unclassified', 'app_leg', 'outbound_voice',
  'media_stream', 'tts', 'sms', 'transcription', 'other'];

const QUALITY = { provider_actual: 'actual', provider_allocated: 'allocated', estimated: 'estimated', manual: 'manual' };

function callClass(call) {
  if (!call) return 'unclassified';
  const s = String(call.status || '').toLowerCase();
  if (s === 'known') return 'trusted';
  if (s === 'unknown') return 'unknown';
  return 'unclassified';
}

function componentFor(entry, cls) {
  switch (entry.category) {
    case 'inbound_voice': return cls === 'trusted' ? 'inbound_trusted' : cls === 'unknown' ? 'inbound_unknown' : 'inbound_unclassified';
    case 'number_rental': case 'app_leg': case 'outbound_voice': case 'media_stream': case 'tts': case 'sms': case 'transcription':
      return entry.category;
    case 'ai_inference': return 'transcription';
    default: return 'other';
  }
}

function emptyHousehold(householdId) {
  return {
    householdId,
    calls: { trusted: 0, unknown: 0, unclassified: 0 },
    minutes: { trustedBilled: 0, unknownBilled: 0, unclassifiedBilled: 0, monitored: 0, unmonitoredUnknown: 0, appLeg: 0 },
    longestCallMinutes: 0,
    dayMinutes: {},
    peakConcurrentInbound: 0,
    costGbp: Object.fromEntries(COMPONENTS.map((c) => [c, 0])),
    quality: { actual: 0, allocated: 0, estimated: 0, manual: 0, unknownItems: 0, unconverted: {} },
    monthToDateGbp: 0,
  };
}

function toGbp(amount, currency, fx) {
  if (currency === 'GBP') return amount;
  const rate = fx && fx[currency];
  return Number.isFinite(rate) ? amount * rate : null;
}

// Largest number of inbound legs overlapping in time (sweep line).
function peakConcurrency(intervals) {
  const events = [];
  for (const [s, e] of intervals) { events.push([s, 1]); events.push([e, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let peak = 0;
  for (const [, d] of events) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

function billedMinutes(leg) {
  if (leg.billed_unit === 'minute' && leg.billed_quantity != null) return Number(leg.billed_quantity);
  const sec = Number(leg.provider_duration_seconds);
  return Number.isFinite(sec) ? Math.ceil(sec / 60) : 0;
}

/**
 * @param {object} input
 * @param {object[]} input.entries  financial_entries rows (cost/fee class only are used)
 * @param {object[]} input.legs     telephony_call_legs rows
 * @param {object[]} input.calls    calls rows: id, household_id, status, monitored_duration_seconds
 * @param {Date|string} input.asOf  evaluation time; the month is asOf's UTC month
 * @param {object} [input.fx]       explicit conversion rates to GBP, e.g. { USD: 0.79 }
 */
function accumulateHouseholdCosts({ entries = [], legs = [], calls = [], asOf, fx = {} }) {
  const now = new Date(asOf);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const inMonth = (t) => { const ms = new Date(t).getTime(); return ms >= monthStart && ms < monthEnd && ms <= now.getTime(); };
  const today = now.toISOString().slice(0, 10);

  const callsById = new Map(calls.map((c) => [c.id, c]));
  const households = new Map();
  const hh = (id) => { if (!households.has(id)) households.set(id, emptyHousehold(id)); return households.get(id); };
  const company = { unallocatedGbp: 0, unallocatedByComponent: {}, unknownItems: 0, unconverted: {} };

  for (const e of entries) {
    if (e.entry_class !== 'cost' && e.entry_class !== 'fee') continue;
    if (!['number_rental', 'inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts', 'sms', 'transcription', 'ai_inference',
      'channel_capacity', 'platform_fee'].includes(e.category)) continue; // direct service costs only; overheads are company-level
    const when = e.occurred_at || e.period_start;
    if (!when || !inMonth(when)) continue;
    const cls = callClass(e.call_id ? callsById.get(e.call_id) : null);
    const comp = componentFor(e, cls);
    const target = e.household_id ? hh(e.household_id) : null;
    if (e.native_amount == null) {
      if (target) target.quality.unknownItems += 1; else company.unknownItems += 1;
      continue;
    }
    const gbp = toGbp(Number(e.native_amount), e.native_currency, fx);
    if (gbp == null) {
      const bag = target ? target.quality.unconverted : company.unconverted;
      bag[e.native_currency] = (bag[e.native_currency] || 0) + Number(e.native_amount);
      continue;
    }
    if (!target) {
      company.unallocatedGbp += gbp;
      company.unallocatedByComponent[comp] = (company.unallocatedByComponent[comp] || 0) + gbp;
      continue;
    }
    target.costGbp[comp] += gbp;
    target.quality[QUALITY[e.provenance] || 'estimated'] += gbp;
    target.monthToDateGbp += gbp;
  }

  const intervalsByHousehold = new Map();
  for (const leg of legs) {
    if (!leg.household_id || !leg.started_at || !inMonth(leg.started_at)) continue;
    const h = hh(leg.household_id);
    const mins = billedMinutes(leg);
    if (leg.leg_type === 'app_client') { h.minutes.appLeg += mins; continue; }
    if (leg.leg_type !== 'inbound_pstn') continue;
    const call = leg.call_id ? callsById.get(leg.call_id) : null;
    const cls = callClass(call);
    h.calls[cls] += 1;
    h.minutes[`${cls}Billed`] += mins;
    const secs = Number(leg.provider_duration_seconds) || 0;
    h.longestCallMinutes = Math.max(h.longestCallMinutes, secs / 60);
    const day = new Date(leg.started_at).toISOString().slice(0, 10);
    h.dayMinutes[day] = (h.dayMinutes[day] || 0) + mins;
    const s = new Date(leg.started_at).getTime();
    const end = leg.ended_at ? new Date(leg.ended_at).getTime() : s + secs * 1000;
    if (!intervalsByHousehold.has(h.householdId)) intervalsByHousehold.set(h.householdId, []);
    intervalsByHousehold.get(h.householdId).push([s, Math.max(end, s)]);
    if (cls === 'unknown') {
      const monitored = (Number(call && call.monitored_duration_seconds) || 0) / 60;
      h.minutes.monitored += monitored;
      h.minutes.unmonitoredUnknown += Math.max(0, mins - monitored);
    }
  }
  for (const [id, iv] of intervalsByHousehold) households.get(id).peakConcurrentInbound = peakConcurrency(iv);

  const daysInMonth = (monthEnd - monthStart) / 86400000;
  const elapsedDays = Math.max((now.getTime() - monthStart) / 86400000, 1 / 24);
  const result = [...households.values()].map((h) => {
    const fixed = h.costGbp.number_rental;
    const variable = h.monthToDateGbp - fixed;
    const projectedMonthGbp = variable * (daysInMonth / elapsedDays) + Math.max(fixed, 0);
    return {
      ...h,
      todayMinutes: h.dayMinutes[today] || 0,
      monthMinutes: h.minutes.trustedBilled + h.minutes.unknownBilled + h.minutes.unclassifiedBilled,
      costGbp: roundAll(h.costGbp),
      monthToDateGbp: r6(h.monthToDateGbp),
      projectedMonthGbp: r6(projectedMonthGbp),
      trustedShareOfCost: h.monthToDateGbp > 0 ? r6(h.costGbp.inbound_trusted / h.monthToDateGbp) : 0,
    };
  });

  return {
    month: new Date(monthStart).toISOString().slice(0, 7),
    asOf: now.toISOString(),
    elapsedDays: r6(elapsedDays),
    daysInMonth,
    households: result.sort((a, b) => b.projectedMonthGbp - a.projectedMonthGbp),
    company: {
      householdCostGbp: r6(result.reduce((s, h) => s + h.monthToDateGbp, 0)),
      unallocatedGbp: r6(company.unallocatedGbp),
      unallocatedByComponent: roundAll(company.unallocatedByComponent),
      unknownItems: company.unknownItems + result.reduce((s, h) => s + h.quality.unknownItems, 0),
      unconverted: company.unconverted,
    },
  };
}

// Contribution of one household for the month at a given price and payment
// channel (internal economics; the household's real channel comes from its
// entitlement when known).
function householdContribution(household, { priceGbp = 4.99, channel = 'store15', vatRate = 0.2 } = {}) {
  const net = priceGbp / (1 + vatRate);
  const fee = CHANNELS[channel].fee(priceGbp, net);
  const afterFees = net - fee;
  return {
    channel,
    afterFeesGbp: r6(afterFees),
    contributionMtdGbp: r6(afterFees - household.monthToDateGbp),
    projectedContributionGbp: r6(afterFees - household.projectedMonthGbp),
    projectedLossMaking: household.projectedMonthGbp > afterFees,
  };
}

function r6(n) { return Math.round(Number(n) * 1e6) / 1e6; }
function roundAll(o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r6(v)])); }

module.exports = { accumulateHouseholdCosts, householdContribution, peakConcurrency, COMPONENTS };
