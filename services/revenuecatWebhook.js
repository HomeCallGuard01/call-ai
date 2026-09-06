// Pure classification of RevenueCat webhook event types into "grants/
// renews entitlement" vs "revokes entitlement" vs "acknowledge, no
// change" — directly unit-testable without any HTTP/Supabase involved,
// same convention as services/callRouting.js's decideCallDeliveryPlan.
//
// CANCELLATION is deliberately in neither set: RevenueCat fires it the
// moment a customer turns off auto-renew, but access continues until the
// period they've already paid for ends — the same semantics Stripe's own
// cancel_at_period_end already has in this codebase. The real "access
// ends now" signal is EXPIRATION, fired separately when that period
// actually elapses. Treating CANCELLATION as an immediate revoke would
// cut a customer off before the time they've paid for is up.
//
// TRANSFER is treated as a grant: RevenueCat fires it for the *gaining*
// app_user_id when a purchase is moved between identities (e.g. restored
// under a different login) — from this app's perspective that's "this
// household now has an active subscription," same as INITIAL_PURCHASE.
const GRANT_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "TRANSFER",
]);

const REVOKE_EVENT_TYPES = new Set(["EXPIRATION"]);

function classifyRevenueCatEvent(eventType) {
  if (GRANT_EVENT_TYPES.has(eventType)) return "grant";
  if (REVOKE_EVENT_TYPES.has(eventType)) return "revoke";
  return "acknowledge";
}

// RevenueCat's payload uses original_transaction_id as the stable
// per-subscription identifier across its whole renewal history;
// transaction_id changes every renewal. Falls back to transaction_id
// only for the rare event shape that omits the former, so this never
// throws on a well-formed RevenueCat payload.
function resolveOriginalTransactionId(event) {
  return event && (event.original_transaction_id || event.transaction_id) || null;
}

// TRANSFER is structurally different from every other event type this
// webhook handles, confirmed against a real captured TRANSFER payload
// (2026-08-31, RevenueCat's own delivery record for the sandbox event
// that first exposed this gap) rather than assumed: it has no
// `app_user_id` field at all. A transfer moves an existing subscriber's
// whole purchase history between identities, so RevenueCat represents
// identity as `transferred_from`/`transferred_to` arrays instead of the
// single app_user_id a purchase-type event carries.
//
// Only a single gaining identity is ever treated as resolvable.
// RevenueCat's schema allows transferred_to to carry more than one
// alias in principle, but this app has exactly one app_user_id per
// household (the Supabase auth_user_id) with no concept of merged or
// aliased identities — zero or multiple entries is genuinely ambiguous
// for this data model, not a case to guess at. Returning null here is
// what lets the caller fail safe (acknowledge, never guess an identity)
// rather than a placeholder to fill in later.
function resolveTransferGainingAppUserId(event) {
  const transferredTo = event && event.transferred_to;
  if (!Array.isArray(transferredTo) || transferredTo.length !== 1) return null;
  return transferredTo[0] || null;
}

// Resolves the app_user_id a given event is actually about, regardless
// of event type — the one thing routes/mobileApi.js's webhook handler
// needs before it can look up a household, and the one place that
// decision should live rather than being re-derived at the call site.
function resolveEventAppUserId(event) {
  if (event && event.type === "TRANSFER") {
    return resolveTransferGainingAppUserId(event);
  }
  return (event && event.app_user_id) || null;
}

// The one field every other grant-type event carries that TRANSFER
// genuinely does not (same real-payload confirmation as above): no
// original_transaction_id, no transaction_id — a transfer isn't a
// purchase, so it has no transaction of its own to report.
//
// Falls back to the event's own `id` (RevenueCat's own stable,
// non-fabricated identifier for this specific event) rather than
// leaving the grant without any reference at all. This is deliberately
// self-correcting, not a permanent stand-in: RevenueCat always emits a
// RENEWAL well before a genuine EXPIRATION for an active subscription,
// and the very next grant-type event for this subscription arrives with
// the real original_transaction_id — upsertActiveEntitlementFromRevenueCat's
// own mismatch handling (database/billing.js) already expires a
// reference-mismatched active entitlement and inserts a fresh one under
// the new reference automatically, no special-case cleanup needed here.
//
// Known, accepted limitation: if the subscription were to genuinely
// expire before any such follow-up event ever arrives, a real
// EXPIRATION event (carrying the real transaction id) would not match
// this synthetic reference and would not revoke it — see
// expireEntitlementFromRevenueCat's own exact-match requirement. Not
// fixed here — considered an acceptable gap given how routinely
// RENEWAL precedes EXPIRATION for any genuinely active subscription,
// not a case this webhook is expected to see in practice.
function resolveTransferReference(event) {
  return (event && event.id) ? `revenuecat_transfer_${event.id}` : null;
}

// Single entry point routes/mobileApi.js's webhook handler uses to get a
// reference for a grant-classified event, TRANSFER-aware. Every other
// event type's behavior is byte-for-byte unchanged: this just delegates
// straight to resolveOriginalTransactionId, the exact function already
// covered by its own existing tests.
function resolveGrantReference(event) {
  if (event && event.type === "TRANSFER") {
    return resolveTransferReference(event);
  }
  return resolveOriginalTransactionId(event);
}

module.exports = {
  classifyRevenueCatEvent,
  resolveOriginalTransactionId,
  resolveTransferGainingAppUserId,
  resolveEventAppUserId,
  resolveTransferReference,
  resolveGrantReference,
  GRANT_EVENT_TYPES,
  REVOKE_EVENT_TYPES,
};
