// Pure, dependency-free (2026-09-29, P0 call-delivery resilience) — kept
// out of voiceClient.ts (which imports react-native and the Twilio SDK)
// so it can be unit tested directly (tests/mobile-registration-freshness.test.mjs).
//
// True when the last successful Voice SDK registration is at or past the
// point voiceClient.ts's own refresh timer would have re-registered
// (ttl minus the refresh margin, floored at 30 s — the same arithmetic as
// scheduleRefresh). Used on every foreground transition so a refresh that
// the OS prevented from running in the background still happens.
export function isRegistrationOverdue(
  nowMs: number,
  lastRegisteredAtMs: number,
  ttlSeconds: number,
  refreshMarginSeconds: number
): boolean {
  if (!lastRegisteredAtMs || !ttlSeconds) return false;
  const refreshAfterMs = Math.max(ttlSeconds - refreshMarginSeconds, 30) * 1000;
  return nowMs - lastRegisteredAtMs >= refreshAfterMs;
}
