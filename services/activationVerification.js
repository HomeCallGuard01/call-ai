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

module.exports = {
  ACTIVATION_VERIFY_WINDOW_MS,
  isCallWithinVerificationWindow,
};
