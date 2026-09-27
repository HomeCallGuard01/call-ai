// billingRecords.js — Twilio adapter for the provider-neutral financial
// ledger (services/ledger/contract.js, migration 048). The ONLY place that
// knows Twilio's call and usage-record shapes; everything downstream works
// on neutral legs and entries, so another provider is a sibling adapter
// (services/telephony/<provider>/billingRecords.js), not a ledger change.
//
// Verified Twilio behaviour this relies on (read-only checks against the
// HCG account, 2026-09-26/27):
//   - A Call resource carries `duration` (seconds), `price` (negative, in
//     the account currency, GBP here) and `priceUnit`. The inbound parent
//     leg is priced per started minute (239 s → 4 × £0.00756 = £0.03023).
//   - The <Dial><Client> child leg (`to` = client:…) has come back with
//     price null on every call seen. That is recorded as NOT OBSERVED after
//     the reconciliation window — never as a £0 charge — so a later price
//     (Twilio starting to bill it) shows up as a flagged change.
//   - Media Streams and Polly are NOT priced per call; they only exist as
//     daily usage records (`calls-media-stream-minutes`, `amazon-polly`).
//     Per call they're either an HCG estimate or a share of that daily
//     total, always labelled as such.
//   - Usage-record dates are treated as UTC days (assumption; the daily
//     reconciliation report is what would expose a timezone offset).
'use strict';

const { billedQuantityForDuration, money } = require('../../ledger/contract');
const { apportion } = require('../../ledger/allocation');

const PROVIDER = 'twilio';
const TERMINAL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const DEFAULT_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Twilio usage-record categories → ledger categories, for daily
// reconciliation. Built from the categories actually billed on the HCG
// account since 2026-07-01 (read-only listing, 2026-09-27): calls =
// calls-inbound + calls-outbound + calls-media-stream-minutes exactly, and
// calls-text-to-speech duplicates amazon-polly, so those roll-ups/duplicates
// are ignored rather than counted twice. `calls-client` has never appeared
// (app legs unbilled so far); it is mapped so that the day it does, it is
// reconciled against the ledger's not_observed app legs and alerted on.
// Any other non-zero category is reported as unmapped, never dropped.
const USAGE_CATEGORY_MAP = {
  'calls-inbound': 'inbound_voice',
  'calls-client': 'app_leg',
  'calls-outbound': 'outbound_voice',
  'calls-media-stream-minutes': 'media_stream',
  'amazon-polly': 'tts',
  'failed-message-processing-fee': 'sms',
  'sms': 'sms',
  'phonenumbers': 'number_rental',
};
const ROLLUP_OR_DUPLICATE_CATEGORIES = new Set([
  'totalprice', 'calls', 'calls-inbound-local', 'calls-inbound-mobile', 'calls-inbound-tollfree',
  'calls-text-to-speech', 'phonenumbers-local', 'phonenumbers-mobile', 'phonenumbers-tollfree',
  'phonenumbers-setups', 'channels', 'sms-inbound', 'sms-outbound', 'functions', 'usage-functions',
]);

function legTypeFor(call) {
  const to = String(call.to || '');
  if (call.direction === 'inbound') return 'inbound_pstn';
  if (to.startsWith('client:')) return 'app_client';
  if (to.startsWith('sip:')) return 'sip';
  if (String(call.direction || '').startsWith('outbound')) return 'outbound_pstn';
  return 'other';
}

const CATEGORY_FOR_LEG = {
  inbound_pstn: 'inbound_voice',
  app_client: 'app_leg',
  outbound_pstn: 'outbound_voice',
  sip: 'outbound_voice',
  other: 'other',
};

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Only the billing-relevant fields, verbatim. Phone numbers are never
// copied; an app-leg target (client:household_<uuid>) is kept because it
// is an HCG identifier, not personal data.
function evidenceFor(call) {
  const to = String(call.to || '');
  return {
    sid: call.sid,
    parent_call_sid: call.parentCallSid || null,
    account_sid: call.accountSid || null,
    direction: call.direction || null,
    status: call.status || null,
    duration: call.duration == null ? null : String(call.duration),
    price: call.price == null ? null : String(call.price),
    price_unit: call.priceUnit || null,
    start_time: iso(call.startTime),
    end_time: iso(call.endTime),
    client_identity: to.startsWith('client:') ? to : null,
  };
}

/**
 * What Twilio has told us about the price of one call leg.
 * @returns {{ charge_observation, native_amount, amount, native_currency, reconciliation_status }}
 */
function observeCallPrice(call, now, windowMs) {
  const currency = call.priceUnit ? String(call.priceUnit).toUpperCase() : null;
  if (call.price != null && call.price !== '') {
    const native = Number(call.price);
    if (Number.isFinite(native)) {
      return native === 0
        ? { charge_observation: 'reported_zero', native_amount: 0, amount: 0, native_currency: currency, reconciliation_status: 'final' }
        : { charge_observation: 'reported_amount', native_amount: native, amount: money(Math.abs(native)), native_currency: currency, reconciliation_status: 'final' };
    }
  }
  const settledAt = new Date(call.endTime || call.startTime || 0).getTime();
  const pastWindow = TERMINAL_STATUSES.has(call.status) && Number.isFinite(settledAt) && now.getTime() - settledAt >= windowMs;
  return pastWindow
    ? { charge_observation: 'not_observed', native_amount: null, amount: null, native_currency: null, reconciliation_status: 'final' }
    : { charge_observation: 'pending', native_amount: null, amount: null, native_currency: null, reconciliation_status: 'pending' };
}

/**
 * Turns one Twilio Call resource into a neutral leg plus its provider_actual
 * charge entry.
 *
 * @param {object} call - Twilio Call resource (or the same fields)
 * @param {object} link - { callId, householdId, householdMatch } resolved by the caller
 * @param {object} [opts] - { now: Date, reconciliationWindowMs }
 */
function normaliseCall(call, link = {}, opts = {}) {
  const now = opts.now || new Date();
  const windowMs = opts.reconciliationWindowMs || DEFAULT_RECONCILIATION_WINDOW_MS;
  const legType = legTypeFor(call);
  const duration = call.duration == null || call.duration === '' ? null : Number(call.duration);
  const observed = observeCallPrice(call, now, windowMs);
  const finalisedAt = observed.reconciliation_status === 'final' ? now.toISOString() : null;
  const billedMinutes = duration == null ? null : billedQuantityForDuration('per_started_minute', duration, 60);

  const leg = {
    provider: PROVIDER,
    provider_account_ref: call.accountSid || null,
    provider_call_id: call.sid,
    provider_parent_call_id: call.parentCallSid || null,
    leg_type: legType,
    provider_direction: call.direction || null,
    provider_status: call.status || null,
    call_id: link.callId || null,
    household_id: link.householdId || null,
    household_match: link.householdMatch || 'unmatched',
    started_at: iso(call.startTime),
    ended_at: iso(call.endTime),
    provider_duration_seconds: Number.isFinite(duration) ? duration : null,
    billing_model: 'per_started_minute',
    billing_increment_seconds: 60,
    billed_quantity: billedMinutes,
    billed_unit: 'minute',
    // A leg is only final once BOTH its duration (terminal status) and its
    // charge outcome are settled; otherwise it stays in the reconciliation
    // worker's queue until the provider prices it or the window passes.
    reconciliation_status: TERMINAL_STATUSES.has(call.status) && observed.reconciliation_status === 'final' ? 'final' : 'pending',
    finalised_at: TERMINAL_STATUSES.has(call.status) && observed.reconciliation_status === 'final' ? now.toISOString() : null,
    retrieved_at: now.toISOString(),
    provider_evidence: evidenceFor(call),
  };

  const category = CATEGORY_FOR_LEG[legType];
  const entry = {
    source_system: PROVIDER,
    supplier: PROVIDER,
    entry_key: `${call.sid}:${category}`,
    native_reference: call.sid,
    entry_class: 'cost',
    category,
    cost_class: 'variable_direct',
    billing_model: 'per_started_minute',
    provenance: 'provider_actual',
    ...observed,
    native_quantity: observed.charge_observation === 'reported_amount' || observed.charge_observation === 'reported_zero' ? billedMinutes : null,
    native_unit: observed.charge_observation === 'reported_amount' || observed.charge_observation === 'reported_zero' ? 'minute' : null,
    occurred_at: iso(call.startTime),
    household_id: link.householdId || null,
    call_id: link.callId || null,
    telephony_leg_id: null, // set by the repository once the leg row exists
    evidence: { price: evidenceFor(call).price, price_unit: call.priceUnit || null, duration: evidenceFor(call).duration, billed_quantity_derivation: 'ceil(duration/60), Twilio per-started-minute billing' },
    retrieved_at: now.toISOString(),
    finalised_at: finalisedAt,
  };

  return { leg, entry };
}

/**
 * HCG's own estimate of one call's Media Stream cost, used until the day's
 * Twilio usage record can be apportioned. Same entry_key as the allocated
 * figure that later replaces it (see reconcile.decideEntryWrite), so a call
 * never carries both.
 */
function mediaStreamEstimate({ callSid, streamSeconds, ratePerMinute, currency = 'GBP', occurredAt, householdId = null, callId = null }) {
  const minutes = billedQuantityForDuration('per_started_minute', streamSeconds, 60);
  return {
    source_system: 'hcg',
    supplier: PROVIDER,
    entry_key: `${callSid}:media_stream`,
    native_reference: callSid,
    entry_class: 'cost',
    category: 'media_stream',
    cost_class: 'variable_direct',
    billing_model: 'per_started_minute',
    provenance: 'estimated',
    charge_observation: null,
    native_amount: null,
    native_currency: currency,
    native_quantity: minutes,
    native_unit: 'minute',
    amount: money(minutes * ratePerMinute),
    occurred_at: iso(occurredAt),
    household_id: householdId,
    call_id: callId,
    allocation_basis: `HCG estimate: ceil(${streamSeconds}s / 60) = ${minutes} min × ${ratePerMinute} ${currency}/min (Twilio does not price Media Streams per call)`,
    reconciliation_status: 'provisional',
  };
}

/**
 * Apportions one day's Twilio Media Streams usage-record total across that
 * day's monitored calls, weighted by stream seconds. Entries are
 * provider_allocated and cite the usage record.
 *
 * Same (source_system 'hcg', entry_key '<CallSid>:media_stream') as the
 * estimate, so reconcile.decideEntryWrite upgrades the estimate in place
 * (estimated → provider_allocated) and a call never carries both figures.
 * source_system is 'hcg' because HCG computes the share; supplier is
 * 'twilio' because that is who bills it.
 */
function allocateDailyMediaStreams({ date, usageTotal, currency, calls, now = new Date() }) {
  const shares = apportion(usageTotal, calls.map((c) => ({ key: c.callSid, weight: c.streamSeconds })));
  const byKey = new Map(calls.map((c) => [c.callSid, c]));
  return shares
    .filter((s) => s.weight > 0)
    .map((s) => {
      const c = byKey.get(s.key);
      return {
        source_system: 'hcg',
        supplier: PROVIDER,
        entry_key: `${s.key}:media_stream`,
        native_reference: s.key,
        entry_class: 'cost',
        category: 'media_stream',
        cost_class: 'variable_direct',
        billing_model: 'per_started_minute',
        provenance: 'provider_allocated',
        charge_observation: null,
        native_amount: null,
        native_currency: currency,
        native_quantity: null,
        native_unit: null,
        amount: s.amount,
        occurred_at: iso(c.occurredAt),
        household_id: c.householdId || null,
        call_id: c.callId || null,
        allocation_basis: `Twilio daily Media Streams total apportioned by stream seconds (${s.weight}s of the day's monitored streams)`,
        source_reference: `twilio usage record calls-media-stream-minutes ${date}: ${usageTotal} ${currency}`,
        reconciliation_status: 'provisional',
        retrieved_at: now.toISOString(),
      };
    });
}

/**
 * Twilio daily usage records → neutral supplier totals for reconciliation.
 * Only mapped leaf categories are returned; unmapped ones are listed so a
 * new chargeable category is never silently ignored.
 */
function supplierDailyTotals(usageRecords) {
  const totals = [];
  const unmapped = [];
  for (const r of usageRecords) {
    const price = Number(r.price);
    if (!Number.isFinite(price)) continue;
    if (ROLLUP_OR_DUPLICATE_CATEGORIES.has(r.category)) continue;
    const category = USAGE_CATEGORY_MAP[r.category];
    // An explicit £0 day for a mapped category is kept: it is the supplier's
    // own figure (e.g. 2026-09-07: five 2–5 s streams billed 0 Media Streams
    // minutes) and must win over an HCG estimate. Zero unmapped categories
    // are just noise and are skipped.
    if (price === 0 && !category) continue;
    const date = String(r.startDate instanceof Date ? r.startDate.toISOString() : r.startDate).slice(0, 10);
    const entry = { date, category, amount: money(Math.abs(price)), currency: String(r.priceUnit || '').toUpperCase(), sourceCategory: r.category, count: r.count == null ? null : Number(r.count) };
    if (category) totals.push(entry);
    else unmapped.push(entry);
  }
  return { totals, unmapped };
}

// ---------------------------------------------------------------------------
// Costs that are not a call leg. Every Twilio charge gets an explicit
// treatment; nothing is dropped because it can't be tied to one call.
//   SMS             priced per message by Twilio → provider_actual per message
//   Polly (TTS)     priced per day → shared across that day's greeted calls
//   Number rental   priced per day (on each number's monthly anniversary) →
//                   shared across the numbers renewing that day when the
//                   count matches, otherwise UNALLOCATED
//   Anything else   → an explicit UNALLOCATED account-level entry
// UNALLOCATED means: a real supplier charge with no evidence-based customer
// to attribute it to. household_id stays null; nothing is guessed.
// ---------------------------------------------------------------------------

/**
 * One Twilio Message resource → provider_actual SMS cost entry. Phone
 * numbers are never stored; `link` (household, matched by the caller) is.
 */
function normaliseMessage(message, link = {}, opts = {}) {
  const now = opts.now || new Date();
  const windowMs = opts.reconciliationWindowMs || DEFAULT_RECONCILIATION_WINDOW_MS;
  const terminal = ['delivered', 'undelivered', 'failed', 'sent', 'received', 'canceled', 'read'].includes(message.status);
  const observed = observeCallPrice(
    { price: message.price, priceUnit: message.priceUnit, status: terminal ? 'completed' : 'queued', endTime: message.dateSent || message.dateCreated, startTime: message.dateCreated },
    now,
    windowMs
  );
  const segments = message.numSegments == null ? null : Number(message.numSegments);
  const priced = observed.charge_observation === 'reported_amount' || observed.charge_observation === 'reported_zero';
  return {
    source_system: PROVIDER,
    supplier: PROVIDER,
    entry_key: `${message.sid}:sms`,
    native_reference: message.sid,
    entry_class: 'cost',
    category: 'sms',
    cost_class: 'variable_direct',
    billing_model: 'per_transaction',
    provenance: 'provider_actual',
    ...observed,
    native_quantity: priced ? segments : null,
    native_unit: priced ? 'segment' : null,
    occurred_at: iso(message.dateSent || message.dateCreated),
    household_id: link.householdId || null,
    call_id: null,
    evidence: {
      sid: message.sid,
      direction: message.direction || null,
      status: message.status || null,
      num_segments: segments,
      price: message.price == null ? null : String(message.price),
      price_unit: message.priceUnit || null,
      household_match: link.householdMatch || 'unmatched',
    },
    retrieved_at: now.toISOString(),
    finalised_at: observed.reconciliation_status === 'final' ? now.toISOString() : null,
  };
}

/**
 * Polly/TTS: Twilio prices it per day. Shared equally across that day's
 * greeted (monitored) calls — one greeting each.
 */
function allocateDailyTts({ date, usageTotal, currency, calls, now = new Date() }) {
  const shares = apportion(usageTotal, calls.map((c) => ({ key: c.callSid, weight: 1 })));
  const byKey = new Map(calls.map((c) => [c.callSid, c]));
  return shares.map((s) => {
    const c = byKey.get(s.key);
    return {
      source_system: 'hcg',
      supplier: PROVIDER,
      entry_key: `${s.key}:tts`,
      native_reference: s.key,
      entry_class: 'cost',
      category: 'tts',
      cost_class: 'variable_direct',
      billing_model: 'per_transaction',
      provenance: 'provider_allocated',
      charge_observation: null,
      native_amount: null,
      native_currency: currency,
      native_quantity: null,
      native_unit: null,
      amount: s.amount,
      occurred_at: iso(c.occurredAt),
      household_id: c.householdId || null,
      call_id: c.callId || null,
      allocation_basis: `Twilio daily Polly total shared equally across the day's ${calls.length} greeted call(s)`,
      source_reference: `twilio usage record amazon-polly ${date}: ${usageTotal} ${currency}`,
      reconciliation_status: 'provisional',
      retrieved_at: now.toISOString(),
    };
  });
}

/**
 * Number rental: Twilio bills each number monthly on the anniversary of its
 * purchase, and reports only a daily total. When the numbers renewing that
 * day (by anniversary) exactly account for the day's count, the total is
 * shared across them (provider_allocated, attributed to each number's
 * CURRENT household only — there is no assignment history yet). Otherwise
 * the whole day is UNALLOCATED rather than guessed.
 *
 * @param {object} args
 * @param {string} args.date - YYYY-MM-DD (UTC)
 * @param {number} args.usageTotal - the day's number-rental total
 * @param {number} args.usageCount - numbers billed that day (usage record count)
 * @param {Array<{ sid, dateCreated, householdId, environment }>} args.numbers - currently owned numbers
 */
function allocateDailyNumberRental({ date, usageTotal, usageCount, currency, numbers, now = new Date() }) {
  const day = Number(date.slice(8, 10));
  const lastDayOfMonth = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
  const renewing = numbers.filter((n) => {
    const created = new Date(n.dateCreated);
    if (Number.isNaN(created.getTime()) || created.toISOString().slice(0, 10) > date) return false;
    const anniversary = Math.min(created.getUTCDate(), lastDayOfMonth);
    return anniversary === day;
  });
  if (renewing.length === 0 || renewing.length !== Number(usageCount)) {
    return [unallocatedDailyCharge({ date, category: 'number_rental', sourceCategory: 'phonenumbers', amount: usageTotal, currency, count: usageCount, now,
      reason: renewing.length === 0 ? 'no currently-owned number renews on this day (likely a number since released)' : `renewal count mismatch: ${renewing.length} owned number(s) renew today vs ${usageCount} billed` })];
  }
  const shares = apportion(usageTotal, renewing.map((n) => ({ key: n.sid, weight: 1 })));
  const byKey = new Map(renewing.map((n) => [n.sid, n]));
  return shares.map((s) => {
    const n = byKey.get(s.key);
    return {
      source_system: 'hcg',
      supplier: PROVIDER,
      entry_key: `number:${s.key}:${date}`,
      native_reference: s.key,
      entry_class: 'cost',
      category: 'number_rental',
      cost_class: 'semi_variable',
      billing_model: 'per_number',
      provenance: 'provider_allocated',
      charge_observation: null,
      native_amount: null,
      native_currency: currency,
      native_quantity: 1,
      native_unit: 'number-month',
      amount: s.amount,
      occurred_at: `${date}T00:00:00.000Z`,
      household_id: n.householdId || null,
      call_id: null,
      allocation_basis: `Twilio daily number-rental total shared across the ${renewing.length} number(s) whose monthly anniversary is ${date}; attributed to the number's current household (no assignment history)`,
      source_reference: `twilio usage record phonenumbers ${date}: ${usageCount} number(s), ${usageTotal} ${currency}`,
      evidence: { number_sid: s.key, environment: n.environment || null, allocation_status: n.householdId ? 'allocated' : 'unallocated_number_without_household' },
      reconciliation_status: 'provisional',
      retrieved_at: now.toISOString(),
    };
  });
}

/**
 * A real supplier day-total that no evidence ties to a customer or call.
 * Recorded as the supplier's actual account-level charge, explicitly
 * UNALLOCATED — visible in every total, never dropped, never guessed.
 */
function unallocatedDailyCharge({ date, category, sourceCategory, amount, currency, count = null, reason, now = new Date() }) {
  return {
    source_system: PROVIDER,
    supplier: PROVIDER,
    entry_key: `usage:${sourceCategory}:${date}:unallocated`,
    native_reference: `usage:${sourceCategory}:${date}`,
    entry_class: 'cost',
    category,
    cost_class: category === 'number_rental' ? 'semi_variable' : 'variable_direct',
    billing_model: category === 'number_rental' ? 'per_number' : 'other',
    provenance: 'provider_actual',
    charge_observation: amount === 0 ? 'reported_zero' : 'reported_amount',
    native_amount: amount, // usage records report positive prices; kept as reported
    native_currency: currency,
    native_quantity: count,
    native_unit: count == null ? null : 'usage-count',
    amount,
    occurred_at: `${date}T00:00:00.000Z`,
    household_id: null,
    call_id: null,
    evidence: { allocation_status: 'unallocated', reason, usage_category: sourceCategory },
    reconciliation_status: 'final',
    retrieved_at: now.toISOString(),
    finalised_at: now.toISOString(),
  };
}

/**
 * Read-only data access for the adapter. `client` is a Twilio REST client.
 */
function createTwilioBillingSource(client) {
  return {
    provider: PROVIDER,
    listCalls: ({ startTimeAfter, startTimeBefore }) => client.calls.list({ startTimeAfter, startTimeBefore }),
    fetchCall: (sid) => client.calls(sid).fetch(),
    listDailyUsage: ({ startDate, endDate }) => client.usage.records.daily.list({ startDate, endDate }),
    listMessages: ({ dateSentAfter, dateSentBefore }) => client.messages.list({ dateSentAfter, dateSentBefore }),
    listOwnedNumbers: async () => (await client.incomingPhoneNumbers.list()).map((n) => ({ sid: n.sid, phoneNumber: n.phoneNumber, dateCreated: n.dateCreated })),
  };
}

module.exports = {
  PROVIDER,
  USAGE_CATEGORY_MAP,
  ROLLUP_OR_DUPLICATE_CATEGORIES,
  TERMINAL_STATUSES,
  DEFAULT_RECONCILIATION_WINDOW_MS,
  legTypeFor,
  normaliseCall,
  observeCallPrice,
  mediaStreamEstimate,
  normaliseMessage,
  allocateDailyTts,
  allocateDailyNumberRental,
  unallocatedDailyCharge,
  allocateDailyMediaStreams,
  supplierDailyTotals,
  createTwilioBillingSource,
};
