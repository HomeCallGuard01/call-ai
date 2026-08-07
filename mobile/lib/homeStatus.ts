// Pure decision logic extracted from app/(tabs)/index.tsx and
// app/(tabs)/account/index.tsx so it can be unit tested directly with
// plain Node (no React Native rendering needed) — see
// tests/mobile-fail-closed-status.test.mjs. Kept dependency-free
// (no react-native, no expo-router imports) specifically so it stays
// testable this way.
//
// The bug this exists to prevent: the Home screen used to compute
// `isSettingUp = data && !data.protection.activationVerifiedAt` and
// render "Protected" whenever that was falsy — which included the case
// where `data` was `null` because bootstrap/dashboard had never
// succeeded at all, not just the case where activation was genuinely
// confirmed. Any code path that decides what to show the user must go
// through deriveLoadOutcome() below, which cannot express "show
// Protected" without a real, just-fetched (or previously-fetched-this-
// session) DashboardResponse.

export type LoadOutcome =
  | { kind: "not_entitled" }
  | { kind: "has_data"; isStale: boolean }
  | { kind: "unavailable" };

// Given what happened on a load/refresh attempt, decides the next screen
// state. Fail-closed by construction: "has_data" is reachable only from
// a fetch that just succeeded, or a failure when real data already
// existed from earlier *in this same session* (hadPriorData) — never
// from a failure with no prior data, which always resolves to
// "unavailable" rather than presenting a guess as fact.
export function deriveLoadOutcome(params: {
  succeeded: boolean;
  isNotEntitledError: boolean;
  hadPriorData: boolean;
}): LoadOutcome {
  if (params.succeeded) return { kind: "has_data", isStale: false };
  if (params.isNotEntitledError) return { kind: "not_entitled" };
  if (params.hadPriorData) return { kind: "has_data", isStale: true };
  return { kind: "unavailable" };
}

export function isSettingUp(data: { protection: { activationVerifiedAt: string | null } }): boolean {
  return !data.protection.activationVerifiedAt;
}
