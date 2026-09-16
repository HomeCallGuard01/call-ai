// Extracted from routes/mobileApi.js so the "is this call recent enough
// to count as proof activation worked" logic is directly unit-testable —
// matching this codebase's established pattern of pulling business logic
// out of route handlers into pure, injectable functions.
//
// 30 minutes comfortably covers "dial the forwarding code, then come back
// and check" (APP_DECISION_003, docs/mobile-app/) without accepting a
// stale call from a much earlier, possibly abandoned setup attempt as
// current proof.
const ACTIVATION_VERIFY_WINDOW_MS = 30 * 60 * 1000;

function isCallWithinVerificationWindow(call, now = new Date()) {
  if (!call || !call.created_at) return false;

  const callTime = new Date(call.created_at).getTime();
  if (Number.isNaN(callTime)) return false;

  return now.getTime() - callTime <= ACTIVATION_VERIFY_WINDOW_MS;
}

// P0 Batch 1, component C: closes a confirmed real gap — a household with
// genuine inbound calls could still show activation_verified_at: null
// indefinitely, because the only thing that ever set it was the
// client-invoked POST /activation-verify / POST /api/v1/activation/verify
// endpoints (gated on the 30-minute window above AND a customer tapping
// "check now" or a lucky dashboard poll).
//
// This function is the automatic replacement: called from server.js's
// POST /voice handler with the `household` already resolved from
// Twilio's own request (getHouseholdByTwilioNumber(req.body.To)) — i.e.
// only ever reachable from a genuine, Twilio-originated inbound call,
// never from any client-invoked route. A real call reaching /voice for a
// household's Twilio number IS the proof forwarding works — there is
// nothing further to wait for or verify client-side.
//
// Deliberately does NOT take "was this call within N minutes" as an
// input — unlike isCallWithinVerificationWindow (which answers "is a
// past call recent enough to count as proof, for a client-driven check
// happening now"), this runs at the moment the call itself is happening,
// so recency is not in question.
//
// Skips the RPC call entirely once already verified — markActivationVerified
// is itself idempotent DB-side (migration 021), so this is purely an
// efficiency guard against calling it on every single subsequent call to
// an already-verified household, not a correctness requirement.
async function stampActivationVerifiedOnRealCall(household, deps = {}) {
  const { markActivationVerified } = deps;

  if (!household || !household.id) {
    return { stamped: false };
  }

  if (household.activation_verified_at) {
    return { stamped: false, alreadyVerified: true };
  }

  const verifiedAt = await markActivationVerified(household.id);
  return { stamped: true, verifiedAt };
}

module.exports = {
  ACTIVATION_VERIFY_WINDOW_MS,
  isCallWithinVerificationWindow,
  stampActivationVerifiedOnRealCall,
};
