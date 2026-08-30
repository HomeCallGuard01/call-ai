// Pure logic for the B5 "Connecting Home Call Guard" screen
// (app/(setup)/connecting.tsx) — replaces the old second-phone
// verification screen (app/(setup)/verify.tsx, no longer part of the
// normal setup flow, see that file's own header comment) with a genuine,
// backend-confirmed Voice SDK reachability check. No customer action (a
// second phone, "call yourself", "press Try again") is required to reach
// the confirmed state — this screen polls GET /api/v1/me/dashboard's
// protection.voiceClientReachable (services/callRouting.js's
// isVoiceClientReachable, call-ai backend, migration 030) automatically
// while registerForIncomingCalls() runs.
//
// Deliberately dependency-free (no react-native/expo-router imports) so
// it's unit testable directly — see tests/voice-connection-screen.test.mjs,
// matching lib/provisioningStages.ts's own precedent for a screen with no
// rendering harness available.

export type VoiceConnectionState = "connecting" | "confirmed" | "unreachable";

// How often the screen polls the dashboard while waiting.
export const POLL_INTERVAL_MS = 3000;

// How long to keep polling before offering a recovery option, absent any
// poll failures — long enough to cover a normal cold Voice SDK
// registration (PushKit/FCM init + token fetch + voice.register(), all
// observed to complete within a few seconds on real devices per
// CURRENT_STATE.md's physical-device testing), short enough that a
// genuinely stuck registration doesn't leave the customer staring at a
// pulsing shield indefinitely.
export const MAX_WAIT_MS = 30_000;

// Same threshold as provisioningStages.ts's shouldShowManualRetry — two
// consecutive dropped requests means polling ITSELF is broken (e.g.
// offline), not that registration is merely slow, so recovery should show
// immediately rather than waiting out the full MAX_WAIT_MS.
const POLL_FAILURE_THRESHOLD = 2;

// True once either polling itself is broken, or a reasonable amount of
// time has passed with no confirmation — the two independent ways
// "connecting" can genuinely fail rather than merely being slow. Never
// triggered by anything else (a button press, returning to the screen) —
// the only two inputs are real signals from the polling loop itself.
export function shouldShowManualRecovery(consecutivePollFailures: number, elapsedMs: number): boolean {
  return consecutivePollFailures >= POLL_FAILURE_THRESHOLD || elapsedMs >= MAX_WAIT_MS;
}
