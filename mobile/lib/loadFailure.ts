// Pure, dependency-free classification of a failed dashboard-load error
// into what the customer should actually be told — see
// app/(tabs)/index.tsx's load() and homeStatus.ts's deriveLoadOutcome,
// which this feeds.
//
// 2026-09-20 fix: the Home screen used to collapse every non-402 failure
// (a genuinely expired/invalid session, a real backend 5xx, and an
// actual network/no-response failure) into the same generic "Can't check
// right now — check your connection" message — confirmed via a real
// production account whose session never carried through from email
// confirmation, landing on this exact screen for a reason that had
// nothing to do with connectivity. Only a genuine network/no-response
// failure should say that; a 401 means the session itself needs
// refreshing, and a 5xx means the problem is server-side, not the
// customer's connection.
//
// Duck-typed on `.status` (matching lib/api.ts's ApiError shape) rather
// than importing ApiError directly, so this file can stay dependency-free
// (no react-native, no supabase-js) and be unit tested with plain Node —
// matching this codebase's existing convention (homeStatus.ts,
// carousel.ts, contactSelection.ts, etc. are all extracted the same way).
export type LoadFailureReason = "session_expired" | "server_error" | "network_error";

function hasNumericStatus(err: unknown): err is { status: number } {
  return !!err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number";
}

// Any error carrying a numeric HTTP status came from a real response our
// own backend sent — that's never a connectivity problem, whatever the
// status code. 401 specifically means the session itself is no longer
// valid (expired/invalid token) — everything else with a status (5xx, or
// any other non-402 4xx reaching this classifier) is treated as a server-
// side problem, since our backend did respond, just not successfully.
// Anything with no numeric status at all (a plain TypeError from
// fetch() itself — no response was ever received) is the one genuine
// "check your connection" case.
export function classifyLoadFailure(err: unknown): LoadFailureReason {
  if (hasNumericStatus(err)) {
    if (err.status === 401) return "session_expired";
    return "server_error";
  }
  return "network_error";
}
