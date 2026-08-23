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
// here: for a self-protecting household, no plan this function can ever
// return includes a PSTN number, full stop. That's not a runtime check
// that could be wrong under some untested condition; it's a fact about
// which branch of this function's control flow even has access to
// `resolveForwardingDestination`'s result at all — the self-protecting
// branch returns before that call ever happens.
//
// Fail-safe invariant (tightened 2026-08-23, same day as the original
// version): PSTN is permitted ONLY when the system positively knows this
// is a deliberately configured two-number household —
// household.self_protecting === true is checked, this being the one
// value that unlocks the PSTN branch. Every other state at all — true,
// null, undefined, a missing column (pre-migration-028 data), a
// malformed non-boolean value, a household object with no such property
// — falls through to client-only. The original version of this function
// treated a missing self_protecting field as "safe to PSTN-dial," which
// is exactly backwards for a not-yet-migrated household: silence/absence
// must never be read as permission. If clientIdentity itself is
// unavailable (household was null), this fails closed rather than
// building an unusable <Client>null</Client> plan.
//
// clientIdentity is passed in (not built here) so this stays free of any
// dependency on services/voiceAccessToken.js's identity format — the
// caller (server.js) is the one place that format is decided.
function decideCallDeliveryPlan(household, clientIdentity) {
  if (household && household.self_protecting === false) {
    const destination = resolveForwardingDestination(household);

    if (destination.canForward) {
      return { mode: "client-and-number", clientIdentity, number: destination.number };
    }

    return { mode: "fail-closed" };
  }

  if (!clientIdentity) {
    return { mode: "fail-closed" };
  }

  return { mode: "client-only", clientIdentity };
}

module.exports = { resolveForwardingDestination, decideCallDeliveryPlan };
