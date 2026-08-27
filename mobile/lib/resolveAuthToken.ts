// Pure decision extracted from lib/api.ts's authorizedFetch so the
// explicit-token-vs-fallback choice is unit testable without
// react-native in the loop (same reasoning as lib/homeStatus.ts) — see
// tests/mobile-app.test.mjs.
//
// An explicit token (already held by the caller via useAuth(), never
// re-derived) always wins over the fallback session lookup — this is
// what lets authorizedFetch skip supabase.auth.getSession() entirely
// when a caller already has a valid session, avoiding the intermittent
// real-Android-device bug where that call returned null even with a
// genuinely valid session in memory (see lib/api.ts's authorizedFetch
// comment for the full history).
export function resolveAuthToken(
  explicitToken: string | undefined,
  fallbackSessionToken: string | undefined | null
): string | null {
  if (explicitToken) return explicitToken;
  if (fallbackSessionToken) return fallbackSessionToken;
  return null;
}
