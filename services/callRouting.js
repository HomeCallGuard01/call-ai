const { wouldCreateForwardingLoop } = require("./phone");
const { buildVoiceClientIdentity } = require("./voiceAccessToken");

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

// Same-phone delivery (2026-08-15, docs/operations/HANDOVER_2026-08-15.md
// §12-18): the actual fix for the carrier-forwarding loop is not the
// forwardedFrom guard above (a necessary safety net, but confirmed
// insufficient — ForwardedFrom is absent on the real carrier path that
// produced the incident) — it's delivering the approved call to the
// mobile app via Twilio's Voice SDK instead of dialling PSTN back into
// the customer's own forwarded number at all.
//
// Deliberately feature-flagged and defaulting OFF (PSTN, today's
// production behaviour, completely unchanged) rather than switching
// unconditionally: this has not yet been proven on a real physical
// device (see §18.4 — blocked on Apple/Firebase/EAS account setup), and
// flipping live call delivery to an unproven path is exactly the kind
// of premature production change this project's own history warns
// against. Once proven, this becomes the only path and the flag/PSTN
// branch can be deleted — this is deliberately NOT meant to be a
// permanent dual-mode system.
function isClientDeliveryEnabled() {
  return process.env.VOICE_SDK_CLIENT_DELIVERY_ENABLED === "true";
}

// Decides how an approved (known-contact or SAFE-classified) call should
// actually reach the customer. Never used for the SMS-warning
// destination (services/liveMonitoring's own use of
// resolveForwardingDestination directly, unchanged) — SMS always needs a
// real E.164 number, never a Voice SDK Client identity, regardless of
// which mode voice delivery is using.
//
// clientDeliveryEnabled defaults to reading the live env flag (the real
// call sites in server.js never pass it) but can be overridden directly
// — matching this codebase's existing injectable/testable pattern
// (buildVoiceAccessToken, setHouseholdPhoneNumber) — so this can be unit
// tested without mutating process.env.
function resolveCallDelivery(household, forwardedFrom, clientDeliveryEnabled = isClientDeliveryEnabled()) {
  if (!household) {
    return { mode: "fail-closed" };
  }

  if (clientDeliveryEnabled) {
    return { mode: "client", identity: buildVoiceClientIdentity(household.id) };
  }

  const destination = resolveForwardingDestination(household, forwardedFrom);

  if (destination.canForward) {
    return { mode: "pstn", number: destination.number };
  }

  return { mode: "fail-closed" };
}

module.exports = { resolveForwardingDestination, resolveCallDelivery, isClientDeliveryEnabled };
