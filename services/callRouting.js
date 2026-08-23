// Resolves where a passthrough call (known contact, or a screened-safe
// unknown caller) should actually be dialled to. Pure and directly
// testable — no Twilio/Express involved — so the routing decision itself
// (never a hardcoded fallback, always fail closed on a missing number)
// can be proven without simulating a real call.
function resolveForwardingDestination(household) {
  const number = household && household.phone_number;

  if (typeof number === "string" && number.trim().length > 0) {
    return { canForward: true, number: number.trim() };
  }

  return { canForward: false, number: null };
}

// Pure decision, directly unit-testable without Twilio/Express — the
// "impossible by construction" claim (migration 028, 2026-08-23) lives
// here: for a self_protecting household, no plan this function can ever
// return includes a PSTN number, full stop. That's not a runtime check
// that could be wrong under some untested condition; it's a fact about
// which branch of this function's control flow even has access to
// `resolveForwardingDestination`'s result at all — the self_protecting
// branch returns before that call ever happens.
//
// clientIdentity is passed in (not built here) so this stays free of any
// dependency on services/voiceAccessToken.js's identity format — the
// caller (server.js) is the one place that format is decided.
function decideCallDeliveryPlan(household, clientIdentity) {
  if (household && household.self_protecting) {
    return { mode: "client-only", clientIdentity };
  }

  const destination = resolveForwardingDestination(household);

  if (destination.canForward) {
    return { mode: "client-and-number", clientIdentity, number: destination.number };
  }

  return { mode: "fail-closed" };
}

module.exports = { resolveForwardingDestination, decideCallDeliveryPlan };
