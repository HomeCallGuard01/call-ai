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
 */
function buildBackfillPlan({ adapter, hcgCalls, households, providerCalls, usageRecords, now, mediaStreamRatePerMinute, currency = 'GBP' }) {
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

  // Categories the ledger reconstructs per call in this phase.
  const RECONSTRUCTED = ['inbound_voice', 'app_leg', 'outbound_voice', 'media_stream'];
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
    ],
  };

  return { legs, entries, report };
}

module.exports = { buildBackfillPlan, normaliseNumber };
