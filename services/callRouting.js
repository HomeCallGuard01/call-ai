const { DEFAULT_TTL_SECONDS } = require("./voiceAccessToken");

// Resolves where a passthrough call (known contact, or a screened-safe
// unknown caller) should actually be dialled to. Pure and directly
// testable — no Twilio/Express involved — so the routing decision itself
// (never a hardcoded fallback, always fail closed on a missing number)
// can be proven without simulating a real call. Not called by
// decideCallDeliveryPlan below (no PSTN delivery mode exists in this
// release — see that function's own comment) — still used directly by
// server.js's attachLiveMonitoring for the SMS-warning destination
// lookup, which predates and is unrelated to call-delivery routing.
function resolveForwardingDestination(household) {
  const number = household && household.phone_number;

  if (typeof number === "string" && number.trim().length > 0) {
    return { canForward: true, number: number.trim() };
  }

  return { canForward: false, number: null };
}

// A registered-at timestamp is only meaningful for roughly as long as the
// Access Token it came from is valid, plus a grace window for the app's
// own re-registration to actually complete (network latency, a briefly
// backgrounded app catching up on its next foreground/refresh cycle) —
// not indefinitely. Reuses voiceAccessToken.js's real TTL rather than a
// second, potentially-drifting constant. 15 minutes of grace is
// deliberately generous relative to mobile/lib/voiceClient.ts's own
// 5-minute pre-expiry refresh margin and 60s failure-retry — a genuinely
// still-registered app should never sit this close to the edge under
// normal operation; this window exists for "briefly can't reach the
// backend to refresh," not as the expected steady state.
const REACHABILITY_GRACE_SECONDS = 15 * 60;

// Pure, directly unit-testable — no Twilio/Express/Date.now() ambiguity
// (now is passed in, never read internally) — matches this codebase's
// existing convention of pure/injectable time-dependent functions.
function isVoiceClientReachable(registeredAt, now) {
  if (!registeredAt) return false;

  const registeredMs = new Date(registeredAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (!Number.isFinite(registeredMs) || !Number.isFinite(nowMs)) return false;

  const ageSeconds = (nowMs - registeredMs) / 1000;
  return ageSeconds >= 0 && ageSeconds <= DEFAULT_TTL_SECONDS + REACHABILITY_GRACE_SECONDS;
}

// Pure decision, directly unit-testable without Twilio/Express — the
// "impossible by construction" claim (originally migration 028,
// 2026-08-23; corrected 2026-09-07 after production evidence showed the
// original self_protecting=true-for-everyone default routed 100% of
// approved calls into a Voice-SDK Client dial with no reachability check
// at all) lives here: no plan this function can ever return includes a
// PSTN number, full stop, for any household, under any circumstance.
// That's not a runtime check that could be wrong under some untested
// condition; it's a fact about this function's control flow — there is
// no branch anywhere in it that ever calls resolveForwardingDestination
// or constructs a `number` field.
//
// A separate PSTN delivery path for explicitly-classified landline
// households (households.device_type, a customer-entered classification)
// was designed and implemented 2026-09-07/08, then deferred before
// release: read-only production evidence against 184 real inbound calls
// (2026-09-08) found Twilio's ForwardedFrom request parameter — the only
// available live signal for proving a landline's PSTN destination can't
// loop — is populated with the Twilio number itself on every single call,
// never with the actual diverting line, making any comparison against it
// structurally unable to ever detect a real loop. Shipping that guard
// would have given the *appearance* of proof while providing none. Full
// evidence and the deferred design: docs/mobile-app/
// APP_DECISION_008_call_delivery_architecture.md's 2026-09-08 update.
// households.device_type and its persistence/RPC were removed from this
// release along with it — nothing in this codebase reads or writes that
// column right now; it was never applied to any database.
//
// Until a real landline-safe mechanism exists, every household — mobile,
// unclassified, or a not-yet-built landline case — is treated identically
// and conservatively: client-only when a Voice SDK client is currently
// reachable, otherwise a distinct, alertable, still-never-PSTN failure.
//
// clientIdentity is passed in (not built here) so this stays free of any
// dependency on services/voiceAccessToken.js's identity format — the
// caller (server.js) is the one place that format is decided.
//
// voiceClientReachable is passed in (not computed here) so this stays
// free of any Date/now ambiguity — the caller computes it via
// isVoiceClientReachable, this function only branches on the boolean.
function decideCallDeliveryPlan(household, clientIdentity, { voiceClientReachable = false } = {}) {
  if (!household) {
    // Matches the real /voice call sites, where household can genuinely
    // be null (no household matches the dialled Twilio number) — fails
    // closed rather than throwing or ever building a Client dial with a
    // null identity, regardless of whatever voiceClientReachable happens
    // to be passed (which the real caller always correctly derives as
    // false for a null household anyway — this is defence in depth, not
    // a reachable production path).
    return { mode: "fail-closed" };
  }

  if (voiceClientReachable) {
    return { mode: "client-only", clientIdentity };
  }

  return { mode: "self-protecting-unreachable" };
}

// Pure, shared by both GET /dashboard-data (server.js) and
// GET /api/v1/me/dashboard (routes/mobileApi.js) so "You're protected"
// means exactly the same thing on the web dashboard and in the mobile
// app — three deliberately distinct states, never collapsed into one
// flag (2026-09-07 correction; see migration 036's own comment for the
// full incident this closes):
//
//   forwardingVerified — activation_verified_at (021): a real call
//     reached Home Call Guard. Proves only the inbound leg.
//
//   deliveryReady — a capability/readiness fact, never proof anything was
//     ever actually delivered: whether isVoiceClientReachable says the
//     Voice SDK client is *currently* reachable.
//
//   endToEndDeliveryVerified — delivery_verified_at (036): real Twilio
//     evidence (DialCallStatus === "completed") that an approved call
//     actually connected at least once. This is the only thing that can
//     ever justify "You're protected" — reachability alone is not proof,
//     and forwarding alone is not proof.
//
// fullyProtected (the actual "You're protected" gate) requires both
// endToEndDeliveryVerified AND that the client is *currently* still
// reachable — a mobile delivery capability can regress after one real
// success (app uninstalled, token expired), so proof of a past delivery
// alone is not enough to keep claiming protection indefinitely.
function computeProtectionStatus(household, now) {
  const forwardingVerified = !!(household && household.activation_verified_at);
  const deliveryReady = isVoiceClientReachable(household && household.voice_client_registered_at, now);
  const endToEndDeliveryVerified = !!(household && household.delivery_verified_at);
  const fullyProtected = endToEndDeliveryVerified && deliveryReady;

  return { forwardingVerified, deliveryReady, endToEndDeliveryVerified, fullyProtected };
}

module.exports = {
  resolveForwardingDestination,
  decideCallDeliveryPlan,
  isVoiceClientReachable,
  computeProtectionStatus,
  REACHABILITY_GRACE_SECONDS,
};
