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

module.exports = { classifyRevenueCatEvent, resolveOriginalTransactionId, GRANT_EVENT_TYPES, REVOKE_EVENT_TYPES };
