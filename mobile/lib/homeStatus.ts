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

// 2026-09-07 correction: the Home screen's "You're protected" hero text
// used to be driven by isSettingUp alone — i.e. by activationVerifiedAt
// alone — which the production incident this closes proved means only
// that a call reached HCG, never that HCG could deliver one back out
// (services/callRouting.js's computeProtectionStatus, call-ai backend).
// A third, honest state is needed between "still setting up" (the
// customer has concrete steps left — isSettingUp above, still correct
// and unchanged, still drives resumeSetupAt/the "Finish setup" button)
// and "protected" (real end-to-end delivery evidence exists): the
// customer has finished every concrete step, but delivery hasn't been
// proven yet. This does not require any new customer action — it
// resolves automatically the next time a real approved call connects.
export type HomeProtectionState = "setting_up" | "confirming_delivery" | "protected";

export function computeHomeProtectionState(data: {
  protection: { activationVerifiedAt: string | null; fullyProtected: boolean };
}): HomeProtectionState {
  if (isSettingUp(data)) return "setting_up";
  if (!data.protection.fullyProtected) return "confirming_delivery";
  return "protected";
}
