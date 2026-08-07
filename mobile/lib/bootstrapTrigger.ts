// Pure decision logic extracted from lib/AuthContext.tsx so it's directly
// unit testable (tests/mobile-app.test.mjs) without a real Supabase
// client or React rendering.
//
// The bug this exists to prevent: bootstrap only ever ran on SIGNED_IN
// and PASSWORD_RECOVERY — reopening the app with an already-valid,
// previously-established session never re-ran it. A customer whose
// household creation failed once (e.g. the backend outage this session's
// Priority 1 fix addressed) had no way to self-heal short of signing out
// and back in, since that's the only thing that produces a fresh
// SIGNED_IN event.
//
// Supabase's client emits `INITIAL_SESSION` to every listener exactly
// once, right when onAuthStateChange is subscribed, carrying whatever
// session already exists in storage (or null) — this is the "app started
// with an existing session" signal, and is now a trigger event alongside
// SIGNED_IN/PASSWORD_RECOVERY.

export const BOOTSTRAP_TRIGGER_EVENTS = new Set(["INITIAL_SESSION", "SIGNED_IN", "PASSWORD_RECOVERY"]);

// Decides whether this auth event should fire a bootstrap call.
// `alreadyBootstrappedUserId` is the id bootstrap last successfully (or
// is currently) ran for in this client lifetime — passing the same id
// again (e.g. INITIAL_SESSION firing once is already a one-time event
// per listener, but this guards defensively against any duplicate/replay
// of a trigger event for a user already handled) is refused, so a single
// app session can never fire two bootstrap calls for the same identity.
// A *different* user id (a genuine account switch) is always allowed
// through — see Priority 5: a new identity must never inherit a
// previous one's skipped bootstrap.
export function shouldTriggerBootstrap(params: {
  event: string;
  userId: string | null | undefined;
  alreadyBootstrappedUserId: string | null;
}): boolean {
  if (!params.userId) return false;
  if (!BOOTSTRAP_TRIGGER_EVENTS.has(params.event)) return false;
  if (params.alreadyBootstrappedUserId === params.userId) return false;
  return true;
}
