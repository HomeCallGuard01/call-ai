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

module.exports = { resolveForwardingDestination };
