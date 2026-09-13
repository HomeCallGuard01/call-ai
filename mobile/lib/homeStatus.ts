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

// 2026-09-12 correction (real physical-device test finding): a household
// can have genuine, currently-working, backend-confirmed end-to-end call
// delivery (endToEndDeliveryVerified — a real approved call was actually
// delivered, services/callRouting.js's computeProtectionStatus) while
// activation_verified_at stays permanently null, because that field is
// only ever set by the client-driven POST /api/v1/activation/verify poll
// — which never fires if the customer dials the carrier forwarding code
// manually (outside this app's own dialer-launch flow) rather than
// through the guided in-app step. A real delivered call is strictly
// stronger proof that setup genuinely worked than activation_verified_at
// ever was (it proves the whole pipeline, not just the inbound leg), so
// either fact alone is sufficient evidence that setup is done — treating
// them as an OR, not requiring activation_verified_at specifically, is
// what closes this gap. Both facts are monotonic/historical on the
// backend (activation_verified_at is set-once; delivery_verified_at only
// ever moves forward, never resets to null) — so once true, this stays
// true even if reachability later regresses (see computeHomeProtectionState's
// "reconnect_needed" state below for that case), which is exactly what's
// needed to satisfy "loss of Voice SDK reachability must not send an
// already-activated customer back through MMI setup."
export function hasProvenActivation(data: {
  protection: { activationVerifiedAt: string | null; endToEndDeliveryVerified: boolean };
}): boolean {
  return !!data.protection.activationVerifiedAt || data.protection.endToEndDeliveryVerified;
}

export function isSettingUp(data: {
  protection: { activationVerifiedAt: string | null; endToEndDeliveryVerified: boolean };
}): boolean {
  return !hasProvenActivation(data);
}

// 2026-09-07 correction: the Home screen's "You're protected" hero text
// used to be driven by isSettingUp alone — i.e. by activationVerifiedAt
// alone — which the production incident this closes proved means only
// that a call reached HCG, never that HCG could deliver one back out
// (services/callRouting.js's computeProtectionStatus, call-ai backend).
// A third, honest state is needed between "still setting up" (the
// customer has concrete steps left — isSettingUp above, now also
// satisfied by real delivery evidence, still drives resumeSetupAt/the
// "Finish setup" button) and "protected" (real end-to-end delivery
// evidence exists): the customer has finished every concrete step, but
// delivery hasn't been proven yet. This does not require any new
// customer action — it resolves automatically the next time a real
// approved call connects.
//
// 2026-09-12 addition: a FOURTH state, "reconnect_needed", distinguishes
// "forwarding/setup has never been proven" (setting_up — real steps
// left) from "this app has previously delivered a real call successfully
// but isn't currently reachable" (delivery has been proven at least
// once — endToEndDeliveryVerified — but the Voice SDK client isn't
// currently registered/reachable — deliveryReady false). Before this,
// that second case was indistinguishable from "never set up" and sent
// the customer straight back to device-picker/MMI setup, even though
// nothing about their carrier-level forwarding needs to change — only
// the app's own registration needs to recover, which happens
// automatically the next time the app is opened in the foreground. This
// also preserves the existing fail-safe: an unreachable client is never
// described as "protected" (fullyProtected still requires deliveryReady).
export type HomeProtectionState = "setting_up" | "confirming_delivery" | "reconnect_needed" | "protected";

export function computeHomeProtectionState(data: {
  protection: {
    activationVerifiedAt: string | null;
    endToEndDeliveryVerified: boolean;
    deliveryReady: boolean;
    fullyProtected: boolean;
  };
}): HomeProtectionState {
  if (isSettingUp(data)) return "setting_up";
  if (data.protection.fullyProtected) return "protected";
  if (!data.protection.endToEndDeliveryVerified) return "confirming_delivery";
  return "reconnect_needed";
}
