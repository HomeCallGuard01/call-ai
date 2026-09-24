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

import type { LoadFailureReason } from "./loadFailure";

export type LoadOutcome =
  | { kind: "not_entitled" }
  | { kind: "has_data"; isStale: boolean }
  | { kind: "unavailable"; reason: LoadFailureReason };

// Given what happened on a load/refresh attempt, decides the next screen
// state. Fail-closed by construction: "has_data" is reachable only from
// a fetch that just succeeded, or a failure when real data already
// existed from earlier *in this same session* (hadPriorData) — never
// from a failure with no prior data, which always resolves to
// "unavailable" rather than presenting a guess as fact.
//
// failureReason (2026-09-20) — see lib/loadFailure.ts's own header for
// why this exists: "unavailable" used to be one undifferentiated state,
// which meant an expired session and a real backend error both showed
// the same "check your connection" copy as a genuine network failure.
// Optional and defaults to "network_error" so any existing call site
// that hasn't been updated to classify its error keeps working exactly
// as before.
export function deriveLoadOutcome(params: {
  succeeded: boolean;
  isNotEntitledError: boolean;
  hadPriorData: boolean;
  failureReason?: LoadFailureReason;
}): LoadOutcome {
  if (params.succeeded) return { kind: "has_data", isStale: false };
  if (params.isNotEntitledError) return { kind: "not_entitled" };
  if (params.hadPriorData) return { kind: "has_data", isStale: true };
  return { kind: "unavailable", reason: params.failureReason ?? "network_error" };
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
// Onboarding-verification UX change (2026-09-23) — "awaiting_confirmation"
// is a NEW fifth state, inserted between "setting_up" (real steps still
// left: no contacts, no device/carrier chosen, forwarding never even
// attempted) and "confirming_delivery" (forwarding proven, delivery not
// yet). It covers a customer who has completed every concrete setup
// action — including turning on call forwarding — but for whom neither
// activation_verified_at nor endToEndDeliveryVerified exists yet: setup
// is genuinely finished, only evidence is outstanding. Before this state
// existed, this customer was shown "setting_up" with a "Finish setup"
// button that sent them back to device-picker/MMI setup to redo
// something they'd already done correctly (the exact bug
// hasCompletedActivationStep/resumeSetupAt above also fixes). No
// customer action is required here either — it resolves automatically
// the moment the first genuine forwarded call reaches /voice, same as
// every other automatic transition in this state machine.
// Home protection-status wording improvement (2026-09-24) — "delivery_problem"
// is a SIXTH state: a household that would otherwise be "protected" (real
// past evidence, currently reachable) but whose most recent actual dial
// attempt genuinely failed (services/callRouting.js's
// hasRecentDeliveryProblem — a real, OBSERVED Twilio DialCallStatus other
// than "completed", more recent than the last confirmed success). This is
// the one state in this whole model that is NOT purely reassuring: it
// reflects a real, known event, not an absence of recent confirmation
// (that distinction — "known problem" vs. "just no recent news" — is the
// entire point of this addition; see Home's own render for the "Test my
// protection now" route offered here). Deliberately does not override
// "awaiting_confirmation"/"confirming_delivery"/"reconnect_needed" — those
// already correctly withhold "protected" for their own reasons; this only
// ever downgrades what would otherwise have been shown as "protected".
export type HomeProtectionState =
  | "setting_up"
  | "awaiting_confirmation"
  | "confirming_delivery"
  | "reconnect_needed"
  | "delivery_problem"
  | "protected";

export function computeHomeProtectionState(
  data: {
    protection: {
      activationVerifiedAt: string | null;
      endToEndDeliveryVerified: boolean;
      deliveryReady: boolean;
      fullyProtected: boolean;
      recentDeliveryProblem?: boolean;
    };
  },
  hasCompletedActivationStep = false
): HomeProtectionState {
  if (isSettingUp(data)) {
    return hasCompletedActivationStep ? "awaiting_confirmation" : "setting_up";
  }
  if (data.protection.fullyProtected) {
    return data.protection.recentDeliveryProblem ? "delivery_problem" : "protected";
  }
  if (!data.protection.endToEndDeliveryVerified) return "confirming_delivery";
  return "reconnect_needed";
}
