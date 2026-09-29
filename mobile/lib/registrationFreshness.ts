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

// True unless we positively know this invite is addressed to a different
// Voice identity than the one this app registered (2026-09-29). Twilio
// reports the callee as "client:<identity>" or "<identity>". Unknown on
// either side → true: a cold-start invite (the push woke the app before
// it re-registered) must never be rejected for lack of local state.
export function isInviteForIdentity(inviteTo: string | null | undefined, registeredIdentity: string | null | undefined): boolean {
  if (!inviteTo || !registeredIdentity) return true;
  const to = inviteTo.startsWith("client:") ? inviteTo.slice("client:".length) : inviteTo;
  return to === registeredIdentity;
}

// Resolves with the promise's value, or rejects after `ms` — used to bound
// best-effort work (unregistering on sign-out) so it can never hang the UI.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
