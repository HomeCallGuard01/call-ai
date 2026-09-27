// backfillPlan.js — builds (but never writes) the ledger records a
// historical backfill WOULD create, plus the dry-run report. Pure: every
// input is passed in, so the same plan is produced from live read-only data
// (scripts/ledger-backfill.js) or from test fixtures.
//
// Matching, strongest first — nothing is ever guessed:
//   via_call    parent CallSid equals calls.call_sid (exact provider-ID match)
//   via_parent  child leg of a matched parent
//   via_number  no calls row, and the dialled number belongs to exactly one
//               household today (caveat: numbers can be released and
//               reassigned; there is no assignment history to check against)
//   ambiguous   the dialled number maps to more than one household
//   unmatched   nothing links it
// Reports never include phone numbers.
'use strict';

const { money, problemsWithEntry, problemsWithLeg } = require('./contract');
const { reconcileDailyTotals, utcDate } = require('./reconcile');
const { transcriptionEstimate } = require('./estimates');

function normaliseNumber(n) {
  return String(n || '').replace(/[^\d+]/g, '');
}

function shortSid(sid) {
  return sid ? `${String(sid).slice(0, 8)}…` : null;
}

/**
 * @param {object} args
 * @param {object} args.adapter - provider adapter (services/telephony/<provider>/billingRecords.js)
 * @param {Array} args.hcgCalls - calls rows: id, call_sid, household_id, status, created_at, monitored_duration_seconds
 * @param {Array} args.households - id, twilio_number
 * @param {Array} args.providerCalls - provider call records (parents and children)
 * @param {Array} args.usageRecords - provider daily usage records
 * @param {Date} args.now
 * @param {number} args.mediaStreamRatePerMinute - used only where no daily total exists
 * @param {string} [args.currency]
 * @param {Array} [args.providerMessages] - provider SMS records
 * @param {Array} [args.ownedNumbers] - numbers the provider currently bills for: { sid, phoneNumber, dateCreated }
 * @param {number} [args.residualAfterDays] - supplier day totals older than this with no pending items are fully reconciled (residual → UNALLOCATED)
 */
function buildBackfillPlan({ adapter, hcgCalls, households, providerCalls, usageRecords, now, mediaStreamRatePerMinute, currency = 'GBP', providerMessages = [], ownedNumbers = [], residualAfterDays = 2 }) {
  const hcgBySid = new Map(hcgCalls.filter((c) => c.call_sid).map((c) => [c.call_sid, c]));
  const householdsByNumber = new Map();
  for (const h of households) {
    const n = normaliseNumber(h.twilio_number);
    if (!n) continue;
    householdsByNumber.set(n, [...(householdsByNumber.get(n) || []), h.id]);
  }

  const parents = providerCalls.filter((c) => !c.parentCallSid);
  const children = providerCalls.filter((c) => c.parentCallSid);
  const links = new Map();

  function linkFor(call) {
    const hcg = hcgBySid.get(call.sid);
    if (hcg) {
      if (hcg.household_id) return { callId: hcg.id, householdId: hcg.household_id, householdMatch: 'via_call', exact: true };
      return { callId: hcg.id, ...numberLink(call), exact: true };
    }
    return { callId: null, ...numberLink(call), exact: false };
  }
  function numberLink(call) {
    const candidates = householdsByNumber.get(normaliseNumber(call.to)) || [];
    if (candidates.length === 1) return { householdId: candidates[0], householdMatch: 'via_number' };
    if (candidates.length > 1) return { householdId: null, householdMatch: 'ambiguous' };
    return { householdId: null, householdMatch: 'unmatched' };
  }

  for (const p of parents) links.set(p.sid, linkFor(p));
  for (const c of children) {
    const parentLink = links.get(c.parentCallSid);
    if (parentLink && parentLink.householdId) {
      links.set(c.sid, { callId: parentLink.callId, householdId: parentLink.householdId, householdMatch: 'via_parent', exact: false });
    } else if (parentLink) {
      links.set(c.sid, { callId: parentLink.callId, householdId: null, householdMatch: parentLink.householdMatch, exact: false });
    } else {
      const hcgParent = hcgBySid.get(c.parentCallSid);
      links.set(c.sid, hcgParent
        ? { callId: hcgParent.id, householdId: hcgParent.household_id || null, householdMatch: hcgParent.household_id ? 'via_parent' : 'unmatched', exact: false }
        : { callId: null, householdId: null, householdMatch: 'unmatched', exact: false });
    }
  }

  const legs = [];
  const entries = [];
  const invalid = [];
  for (const call of providerCalls) {
    const { leg, entry } = adapter.normaliseCall(call, links.get(call.sid), { now });
    const legProblems = problemsWithLeg(leg);
    const entryProblems = problemsWithEntry(entry);
    if (legProblems.length || entryProblems.length) invalid.push({ sid: shortSid(call.sid), problems: [...legProblems, ...entryProblems] });
    legs.push(leg);
    entries.push(entry);
  }

  // SMS: priced per message by the provider. Linked to a household only via
  // the HCG number it was sent from; the customer's number is never stored.
  const smsMatches = { via_number: 0, ambiguous: 0, unmatched: 0 };
  for (const m of providerMessages) {
    const candidates = householdsByNumber.get(normaliseNumber(m.from)) || [];
    const link = candidates.length === 1 ? { householdId: candidates[0], householdMatch: 'via_number' }
      : { householdId: null, householdMatch: candidates.length > 1 ? 'ambiguous' : 'unmatched' };
    smsMatches[link.householdMatch] += 1;
    const entry = adapter.normaliseMessage(m, link, { now });
    const problems = problemsWithEntry(entry);
    if (problems.length) invalid.push({ sid: shortSid(m.sid), problems });
    entries.push(entry);
  }

  // Media Streams: allocate each day's Twilio total across that day's
  // monitored calls; fall back to an explicit estimate where no total exists.
  const { totals: supplierTotals, unmapped } = adapter.supplierDailyTotals(usageRecords);
  const streamTotalsByDate = new Map(
    supplierTotals.filter((t) => t.category === 'media_stream').map((t) => [t.date, t])
  );
  const parentBySid = new Map(parents.map((p) => [p.sid, p]));
  const monitoredByDate = new Map();
  for (const hcg of hcgCalls) {
    const seconds = Number(hcg.monitored_duration_seconds);
    if (!hcg.call_sid || !(seconds > 0)) continue;
    const parent = parentBySid.get(hcg.call_sid);
    const occurredAt = parent ? parent.startTime : hcg.created_at;
    const date = utcDate(occurredAt);
    const link = links.get(hcg.call_sid);
    const item = { callSid: hcg.call_sid, streamSeconds: seconds, occurredAt, callId: hcg.id, householdId: (link && link.householdId) || hcg.household_id || null };
    monitoredByDate.set(date, [...(monitoredByDate.get(date) || []), item]);
  }
  let mediaAllocated = 0;
  let mediaEstimated = 0;
  let unallocatedDays = 0;
  for (const t of supplierTotals.filter((x) => x.category === 'media_stream' && x.amount > 0)) {
    if (!monitoredByDate.has(t.date)) {
      entries.push(adapter.unallocatedDailyCharge({ date: t.date, category: 'media_stream', sourceCategory: t.sourceCategory, amount: t.amount, currency: t.currency, count: t.count, now,
        reason: 'Media Streams billed on a day with no HCG monitored call on record (e.g. staging or unlogged calls)' }));
      unallocatedDays += 1;
    }
  }
  // Polly greetings: one per monitored call; shared equally across the day's.
  let ttsAllocated = 0;
  for (const t of supplierTotals.filter((x) => x.category === 'tts' && x.amount > 0)) {
    const calls = monitoredByDate.get(t.date) || [];
    if (calls.length) {
      const shares = adapter.allocateDailyTts({ date: t.date, usageTotal: t.amount, currency: t.currency, calls, now });
      entries.push(...shares);
      ttsAllocated += shares.length;
    } else {
      entries.push(adapter.unallocatedDailyCharge({ date: t.date, category: 'tts', sourceCategory: t.sourceCategory, amount: t.amount, currency: t.currency, count: t.count, now,
        reason: 'Polly billed on a day with no HCG monitored call on record' }));
      unallocatedDays += 1;
    }
  }
  // Number rental: daily totals matched to numbers renewing that day.
  const numberInputs = ownedNumbers.map((n) => {
    const holders = householdsByNumber.get(normaliseNumber(n.phoneNumber)) || [];
    return { sid: n.sid, dateCreated: n.dateCreated, householdId: holders.length === 1 ? holders[0] : null };
  });
  let rentalAllocated = 0;
  for (const t of supplierTotals.filter((x) => x.category === 'number_rental' && x.amount > 0)) {
    const rows = adapter.allocateDailyNumberRental({ date: t.date, usageTotal: t.amount, usageCount: t.count, currency: t.currency, numbers: numberInputs, now });
    entries.push(...rows);
    for (const r of rows) (r.provenance === 'provider_allocated' ? rentalAllocated += 1 : unallocatedDays += 1);
  }
  // Transcription (OpenAI): no per-call supplier billing is available, so
  // each monitored call gets a labelled USD estimate (never reconciled
  // against Twilio totals; reported separately).
  let transcriptionEstimates = 0;
  for (const calls of monitoredByDate.values()) {
    for (const c of calls) {
      entries.push(transcriptionEstimate({ callSid: c.callSid, callId: c.callId, householdId: c.householdId, monitoredSeconds: c.streamSeconds, occurredAt: c.occurredAt }));
      transcriptionEstimates += 1;
    }
  }
  for (const [date, calls] of monitoredByDate) {
    const total = streamTotalsByDate.get(date);
    if (total) {
      const allocated = adapter.allocateDailyMediaStreams({ date, usageTotal: total.amount, currency: total.currency, calls, now });
      entries.push(...allocated);
      mediaAllocated += allocated.length;
    } else {
      for (const c of calls) {
        entries.push(adapter.mediaStreamEstimate({ ...c, ratePerMinute: mediaStreamRatePerMinute, currency }));
        mediaEstimated += 1;
      }
    }
  }

  // Residual: any supplier day total not fully explained by the entries
  // above (e.g. an SMS processing fee with no priced message) is recorded as
  // UNALLOCATED once the day is settled — never dropped. Days still holding
  // pending items are left for reconciliation instead, to avoid double
  // counting a charge that is about to be priced.
  const settledBefore = new Date(now.getTime() - residualAfterDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const supplierDay = new Map();
  for (const t of supplierTotals) {
    const k = `${t.date}|${t.category}`;
    const v = supplierDay.get(k) || { date: t.date, category: t.category, amount: 0, currency: t.currency };
    v.amount = money(v.amount + t.amount);
    supplierDay.set(k, v);
  }
  const ledgerDay = new Map();
  const pendingDay = new Set();
  for (const e of entries) {
    const d = utcDate(e.occurred_at);
    if (!d) continue;
    const k = `${d}|${e.category}`;
    if (e.charge_observation === 'pending' || e.charge_observation === 'unavailable') pendingDay.add(k);
    if (e.amount != null) ledgerDay.set(k, money((ledgerDay.get(k) || 0) + Number(e.amount)));
  }
  const residuals = [];
  const overages = [];
  for (const [k, v] of supplierDay) {
    const diff = money(v.amount - (ledgerDay.get(k) || 0));
    if (diff < -0.0005) overages.push({ ...v, ledger: ledgerDay.get(k), difference: diff });
    if (diff > 0.0005 && v.date < settledBefore && !pendingDay.has(k)) {
      const r = adapter.unallocatedDailyCharge({ date: v.date, category: v.category, sourceCategory: `${v.category}-residual`, amount: diff, currency: v.currency, now,
        reason: 'supplier day total not explained by any priced or allocated item' });
      entries.push(r);
      residuals.push({ date: v.date, category: v.category, amount: diff });
    }
  }

  // ---------- report ----------
  const count = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const parentLinks = parents.map((p) => links.get(p.sid));
  const unmatchedLegs = legs.filter((l) => l.household_match === 'unmatched');
  const ambiguousLegs = legs.filter((l) => l.household_match === 'ambiguous');
  const providerSids = new Set(providerCalls.map((c) => c.sid));
  const hcgWithoutProvider = hcgCalls.filter((c) => c.call_sid && !providerSids.has(c.call_sid));

  const ledgerByCategory = {};
  for (const e of entries) {
    const k = `${e.category}|${e.provenance}`;
    ledgerByCategory[k] = money((ledgerByCategory[k] || 0) + (e.amount == null ? 0 : Number(e.amount)));
  }
  const supplierByCategory = {};
  for (const t of supplierTotals) supplierByCategory[t.category] = money((supplierByCategory[t.category] || 0) + t.amount);

  // Every mapped supplier category is reconstructed (per call, per message,
  // allocated, or explicitly UNALLOCATED).
  const RECONSTRUCTED = ['inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts', 'sms', 'number_rental'];
  const ledgerFor = (category) => money(entries.filter((e) => e.category === category && e.amount != null).reduce((s, e) => s + Number(e.amount), 0));
  const categoryComparison = RECONSTRUCTED.map((category) => {
    const supplier = supplierByCategory[category] ?? 0;
    const ledger = ledgerFor(category);
    return { category, supplierTotal: supplier, ledgerTotal: ledger, discrepancy: money(ledger - supplier) };
  });
  const supplierReconstructable = money(categoryComparison.reduce((s, r) => s + r.supplierTotal, 0));
  const ledgerReconstructed = money(categoryComparison.reduce((s, r) => s + r.ledgerTotal, 0));
  const notReconstructed = Object.entries(supplierByCategory)
    .filter(([category]) => !RECONSTRUCTED.includes(category))
    .map(([category, total]) => ({ category, supplierTotal: total }));

  const daily = reconcileDailyTotals({
    entries: entries.filter((e) => RECONSTRUCTED.includes(e.category)),
    supplierTotals: supplierTotals.filter((t) => RECONSTRUCTED.includes(t.category)),
  });

  const report = {
    generatedAt: now.toISOString(),
    mode: 'dry-run (no writes)',
    hcgCalls: { total: hcgCalls.length, withCallSid: hcgCalls.filter((c) => c.call_sid).length, withoutProviderRecord: hcgWithoutProvider.length },
    providerLegs: { total: providerCalls.length, parents: parents.length, children: children.length, byLegType: count(legs, (l) => l.leg_type) },
    exactCallIdMatches: parentLinks.filter((l) => l.exact).length,
    householdMatches: count(legs, (l) => l.household_match),
    unmatched: {
      count: unmatchedLegs.length,
      items: unmatchedLegs.map((l) => ({ sid: shortSid(l.provider_call_id), legType: l.leg_type, date: utcDate(l.started_at), status: l.provider_status, seconds: l.provider_duration_seconds })),
    },
    ambiguous: {
      count: ambiguousLegs.length,
      items: ambiguousLegs.map((l) => ({ sid: shortSid(l.provider_call_id), legType: l.leg_type, date: utcDate(l.started_at) })),
    },
    chargeObservations: count(entries.filter((e) => e.provenance === 'provider_actual'), (e) => `${e.category}:${e.charge_observation}`),
    mediaStreams: { allocatedFromDailyTotals: mediaAllocated, estimatedNoDailyTotal: mediaEstimated },
    tts: { allocatedShares: ttsAllocated },
    transcription: {
      estimatedCalls: transcriptionEstimates,
      estimatedUsd: money(entries.filter((e) => e.category === 'transcription').reduce((s, e) => s + Number(e.amount || 0), 0)),
      status: 'ESTIMATED, unreconciled (no OpenAI per-call billing available)',
    },
    numberRental: { allocatedShares: rentalAllocated },
    sms: { messages: providerMessages.length, householdMatches: smsMatches },
    unallocated: {
      entries: entries.filter((e) => e.evidence && String(e.evidence.allocation_status || '').startsWith('unallocated')).length,
      total: money(entries.filter((e) => e.household_id == null && e.amount != null).reduce((s, e) => s + Number(e.amount), 0)),
      byCategory: entries.filter((e) => e.household_id == null && e.amount != null).reduce((m, e) => { m[e.category] = money((m[e.category] || 0) + Number(e.amount)); return m; }, {}),
      wholeDaysUnallocated: unallocatedDays,
      residuals,
    },
    ledgerExceedsSupplier: overages,
    entriesPlanned: entries.length,
    legsPlanned: legs.length,
    invalidRecords: invalid,
    totals: {
      currency,
      supplierTotalReconstructableCategories: supplierReconstructable,
      ledgerReconstructedTotal: ledgerReconstructed,
      discrepancy: money(ledgerReconstructed - supplierReconstructable),
      byCategory: categoryComparison,
      ledgerByCategoryAndProvenance: ledgerByCategory,
      supplierCategoriesNotReconstructedPerCall: notReconstructed,
      unmappedSupplierCategories: unmapped,
    },
    dailyMismatches: daily.filter((d) => d.status === 'mismatch' || d.flags.length),
    caveats: [
      'via_number matches use the CURRENT number→household mapping; numbers can be released and reassigned and no assignment history exists.',
      'Media Streams are not priced per call by Twilio: per-call figures are shares of the daily usage total (provider_allocated) or HCG estimates where no total exists.',
      'Usage-record days are treated as UTC.',
      'App legs with no price are recorded as not_observed (never £0).',
      'Number rental and Polly are priced per day by Twilio; per-number/per-call figures are shares of those totals. Rental is attributed to each number\'s CURRENT household only (no assignment history).',
      'UNALLOCATED = a real supplier charge with no evidence-based customer; household is left empty rather than guessed. Recent days (< residualAfterDays) are not residualised while items may still be pending.',
    ],
  };

  return { legs, entries, report };
}

module.exports = { buildBackfillPlan, normaliseNumber };
