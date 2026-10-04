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

// 2026-09-13 architecture correction: this function used to be
// isVoiceClientReachable, gating <Dial><Client> on
// households.voice_client_registered_at being no older than the Access
// Token's ~1-hour TTL plus a 15-minute grace window. That conflated two
// genuinely independent lifetimes — confirmed directly against Twilio's
// own current Voice Mobile SDK documentation: the Access Token used to
// establish a registration is short-lived (~1 hour), but the underlying
// push-registration binding it creates has a TTL of roughly ONE YEAR of
// idle time, entirely independent of the token that created it. Treating
// a multi-hour-old (or multi-day-old) timestamp as "unreachable" was
// therefore architecturally wrong, not just a too-strict number — a real
// household that registered hours ago is, per Twilio's own model, still
// almost certainly reachable, and was being incorrectly refused a
// genuine, potentially-successful <Dial><Client> attempt.
//
// voice_client_registered_at is therefore historical evidence that this
// household's identity has successfully completed at least one
// registration — not a live heartbeat with a short expiry. The only
// genuinely different case is no registration at all: a household that
// has never once completed voice.register() has no identity for Twilio
// to dial, full stop, regardless of how long ago "never" was. Anything
// else — ten minutes old, two hours old, several days old — is treated
// identically: attempt the real <Dial><Client> and let Twilio's own
// DialCallStatus (the existing /call-delivery-failed handling, which
// already alerts and fails gracefully on a genuine no-answer/failed
// outcome) be the authoritative signal if the client turns out to
// actually be unreachable — never a pre-emptive guess based on a
// timestamp. Pure and directly unit-testable, same as before.
function hasVoiceClientRegistrationHistory(registeredAt) {
  return Boolean(registeredAt);
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
// hasVoiceClientRegistrationHistory, this function only branches on the
// boolean. The parameter name is unchanged even after the 2026-09-13
// reachability-model fix: decideCallDeliveryPlan's own contract (true ->
// dial, false -> self-protecting-unreachable) hasn't changed, only how
// the caller computes the boolean has.
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
//     ever actually delivered: whether hasVoiceClientRegistrationHistory
//     says this household's Voice SDK client has ever successfully
//     registered. Updated 2026-09-13: this used to also require that
//     registration be recent (within the Access Token's ~1-hour TTL),
//     which was an architecture error (see hasVoiceClientRegistrationHistory's
//     own comment) — Twilio's real push-registration binding lasts
//     roughly a year, so a registration from hours or days ago is not a
//     meaningful regression signal on its own.
//
//   endToEndDeliveryVerified — delivery_verified_at (036): real Twilio
//     evidence (DialCallStatus === "completed") that an approved call
//     actually connected at least once. This is the only thing that can
//     ever justify "You're protected" — reachability alone is not proof,
//     and forwarding alone is not proof.
//
// fullyProtected (the actual "You're protected" gate) requires both
// endToEndDeliveryVerified AND deliveryReady — unchanged formula. Note
// deliveryReady can now only be false when this household has *never*
// registered a Voice SDK client at all; it will no longer flip false
// purely because of elapsed time since a genuine past registration. A
// real regression (app uninstalled, genuinely dead binding) is instead
// expected to surface through delivery_verified_at/the existing
// /call-delivery-failed alerting the next time a call is actually
// attempted — reconciling exactly how "reconnect_needed" should behave
// on Home/Account is a separate follow-up, not addressed by this fix.
//
// deliveryHealth (optional, 2026-09-29 — the "separate follow-up" above):
// the result of services/deliveryHealth.js's computeDeliveryHealth for
// this household. When it is UNREACHABLE — conclusive evidence from real
// calls that the app cannot currently receive them (e.g. the push
// provider reported the device token dead, household f06bc964, 24–26 Sep
// 2026) — deliveryReady and therefore fullyProtected become false, so no
// surface keeps claiming "Protection Active" for a phone HCG knows it
// cannot reach. SUSPECT deliberately does NOT change these booleans (not
// conclusive); it is surfaced as guidance instead. Callers that do not
// pass it get exactly the previous behaviour. Display only — routing
// (decideCallDeliveryPlan) never reads this.
function computeProtectionStatus(household, now, deliveryHealth = null) {
  const forwardingVerified = !!(household && household.activation_verified_at);
  const knownUnreachable = !!(deliveryHealth && deliveryHealth.state === "UNREACHABLE");
  const deliveryReady = hasVoiceClientRegistrationHistory(household && household.voice_client_registered_at) && !knownUnreachable;
  const endToEndDeliveryVerified = !!(household && household.delivery_verified_at);
  const fullyProtected = endToEndDeliveryVerified && deliveryReady;

  return { forwardingVerified, deliveryReady, endToEndDeliveryVerified, fullyProtected };
}

// Cost-protection safeguard (2026-09-26) — closes a real, confirmed gap: a
// household with no currently-active entitlement (cancelled and past its
// billing period, an expired trial, or one that never subscribed at all)
// continued to receive full paid AI monitoring — Media Streams + Whisper
// transcription — for as long as their carrier-side forwarding and Twilio
// number both remained live. That window is not small: cancellation gives
// a deliberate 30-day grace period before a number is released (see
// docs/launch/TWILIO_NUMBER_LIFECYCLE.md), and nothing in /voice ever
// checked entitlement status at all — middleware/requireEntitlement.js
// only ever gated the authenticated web/mobile API routes, never the
// Twilio webhook. Found via a read-only production audit (2026-09-26),
// not a hypothetical.
//
// Deliberately narrow: this decides ONLY whether to start paid, per-call
// AI monitoring for an unknown caller — the actual cost driver. It never
// affects whether the call itself connects: server.js's
// dialHouseholdOrFailClosed still runs unconditionally either way, so a
// household with a lapsed subscription still has calls answered/forwarded
// exactly as before; they simply stop receiving paid AI screening once
// there is no active entitlement to pay for it. Known-contact calls were
// never monitored in the first place (server.js's /voice never calls
// attachLiveMonitoring for a known contact), so this function is only
// ever consulted on the one branch where the cost is actually incurred.
//
// activeEntitlement is passed in, never looked up here, so this stays
// pure and directly testable — the caller resolves it via
// database/billing.js's getActiveEntitlement, the exact same function
// every other entitlement check in this codebase already uses
// (requireEntitlement, the web/mobile dashboards, account deletion).
// Fails closed: a null/undefined household or a null/undefined
// activeEntitlement (no active row, or the lookup itself failed) both
// result in false — monitoring is the exception that must be affirmatively
// earned, never the default.
function shouldStartPaidMonitoring(household, activeEntitlement) {
  return !!(household && activeEntitlement);
}

// Diagnostic instrumentation (2026-09-24) — a genuine, OBSERVED delivery
// failure is real evidence of a problem, distinct from fullyProtected's
// historical-evidence-based "protected" (which this function does not
// change or weaken — see this file's own header note on that). Pure and
// separately testable: takes the most recent dial outcome
// (database/calls.js's getMostRecentDialOutcome) and the household's own
// delivery_verified_at, and answers "is there a real failed attempt more
// recent than our last confirmed success" — never flags a problem purely
// from silence/staleness (that's UNAVAILABLE information, not evidence of
// one), and never flags a problem for a call that was never actually
// dialled (dialCallStatus null — e.g. screened out, or genuinely
// unreachable and routed to self-protecting-unreachable without ever
// building a <Dial> at all).
function hasRecentDeliveryProblem(mostRecentDialOutcome, deliveryVerifiedAt) {
  if (!mostRecentDialOutcome || !mostRecentDialOutcome.dial_call_status) return false;
  if (mostRecentDialOutcome.dial_call_status === "completed") return false;

  if (!deliveryVerifiedAt) return true;

  const failedAt = new Date(mostRecentDialOutcome.created_at).getTime();
  const verifiedAt = new Date(deliveryVerifiedAt).getTime();
  if (!Number.isFinite(failedAt) || !Number.isFinite(verifiedAt)) return true;

  return failedAt > verifiedAt;
}

// Soft-launch integration 2026-10-04 (staging finding F-1, Andrew's decision):
// a household whose receiving app has never registered cannot be delivered
// an approved call. /voice decides this BEFORE any HCG-funded step and
// rejects the call unbilled — no Fortress reservation, no announcement, no
// media stream, no paid apology. Pure; same inputs as decideCallDeliveryPlan.
function isUndeliverableNoRegisteredClient(household, clientIdentity) {
  if (!household) return false;
  const voiceClientReachable = hasVoiceClientRegistrationHistory(household.voice_client_registered_at);
  return decideCallDeliveryPlan(household, clientIdentity, { voiceClientReachable }).mode === "self-protecting-unreachable";
}

module.exports = {
  isUndeliverableNoRegisteredClient,
  resolveForwardingDestination,
  decideCallDeliveryPlan,
  hasVoiceClientRegistrationHistory,
  computeProtectionStatus,
  hasRecentDeliveryProblem,
  shouldStartPaidMonitoring,
};
