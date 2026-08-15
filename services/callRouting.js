const { wouldCreateForwardingLoop } = require("./phone");

// Resolves where a passthrough call (known contact, or a screened-safe
// unknown caller) should actually be dialled to. Pure and directly
// testable — no Twilio/Express involved — so the routing decision itself
// (never a hardcoded fallback, always fail closed on a missing number)
// can be proven without simulating a real call.
//
// forwardedFrom (2026-08-15): Twilio's ForwardedFrom param, present only
// when this specific call itself arrived via a carrier-level forward.
// household.phone_number is the customer's real number — the same number
// carrier call-forwarding (*21*) sends to us in the first place — so
// dialling it back is only ever unsafe when we have direct evidence THIS
// call was forwarded from that exact number: unconditional forwarding
// intercepts every call to that number, including our own dial-back
// attempt, which re-enters /voice as a brand-new call and repeats
// forever (the real production loop this guard closes). Gating strictly
// on forwardedFrom, rather than always refusing to dial phone_number,
// keeps every other call (known contact, safe unknown caller, no
// forwarding involved) working exactly as before.
function resolveForwardingDestination(household, forwardedFrom) {
  const number = household && household.phone_number;

  if (typeof number !== "string" || number.trim().length === 0) {
    return { canForward: false, number: null };
  }

  const trimmed = number.trim();

  if (wouldCreateForwardingLoop(forwardedFrom, trimmed)) {
    return { canForward: false, number: null };
  }

  return { canForward: true, number: trimmed };
}

module.exports = { resolveForwardingDestination };
