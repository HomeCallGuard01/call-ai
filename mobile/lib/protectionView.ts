// Customer protection view model (2026-10-04, mobile 1.0.2 customer
// experience). Pure and dependency-free so tests/mobile-protection-view
// .test.mjs runs it directly under plain Node, exactly like homeStatus.ts.
//
// One job: turn the server's canonical protection state into the words and
// single next action the Home screen shows. It never decides whether a
// customer is protected — that is services/lifecycle/activationState.js on
// the backend (protection.fullyProtected / activationStage /
// protectionBlockers). This file only chooses wording for what the server
// already decided, so iPhone and Android can never disagree about it.
//
// Rules this file guarantees (tests assert each one):
//   1. "Your phone is protected" ONLY when protection.fullyProtected === true
//      AND (when the server sends one) activationStage === "protected", AND
//      this phone can actually present calls.
//   2. Every setup checklist tick comes from a server gate. A step the app
//      merely asked the customer to do is never ticked. When the server
//      cannot establish state (stateKnown / accountActive blocker, stage
//      "ambiguous"/"unavailable"), no step is ticked at all.
//   3. Forwarding proven + app not reachable (the September incident: nine
//      calls reached HCG, none reached the customer) is an ATTENTION state
//      with a prominent action — never a reassuring "almost there".
//   4. No provider/billing/internal vocabulary reaches the customer (no
//      Twilio, quarantine, hold, entitlement, Fortress, UUIDs).
//
// Older backends that send no activationStage fall back to the previous,
// tested lib/homeStatus.ts model (legacyHomeState below — a local copy so
// this file stays import-free for plain-Node tests; tests/mobile-protection-
// view.test.mjs asserts it equals homeStatus.ts's computeHomeProtectionState
// for every input) so an older server never makes the app claim more than it
// did before.

type LegacyState = "setting_up" | "awaiting_confirmation" | "confirming_delivery" | "reconnect_needed" | "delivery_problem" | "protected";

export function legacyHomeState(
  p: { activationVerifiedAt: string | null; endToEndDeliveryVerified: boolean; deliveryReady: boolean; fullyProtected: boolean; recentDeliveryProblem?: boolean },
  hasCompletedActivationStep: boolean
): LegacyState {
  const proven = !!p.activationVerifiedAt || p.endToEndDeliveryVerified;
  if (!proven) return hasCompletedActivationStep ? "awaiting_confirmation" : "setting_up";
  if (p.fullyProtected) return p.recentDeliveryProblem ? "delivery_problem" : "protected";
  if (!p.endToEndDeliveryVerified) return "confirming_delivery";
  return "reconnect_needed";
}

export type ProtectionTone = "protected" | "setup" | "attention" | "unknown";

export type ProtectionAction =
  | "reconnect_app" // re-register this phone for incoming calls, then refresh
  | "open_settings" // microphone / notifications are off
  | "set_up_forwarding" // turn on (or update) call forwarding
  | "resume_setup" // go back into the guided setup flow
  | "update_payment" // Membership screen
  | "contact_support"
  | "refresh";

export interface ProtectionHeadline {
  tone: ProtectionTone;
  // Upper-case display headline; the screen renders it as-is.
  headline: string;
  body: string;
  action: { kind: ProtectionAction; label: string } | null;
  // true only for tone "protected" — the one flag the hero shield's green
  // state reads.
  isProtected: boolean;
}

export type ChecklistStepKey = "membership" | "number" | "forwarding" | "app" | "first_call";

export interface ChecklistStep {
  key: ChecklistStepKey;
  label: string;
  // "done" / "todo" come from a server gate; "unknown" means the server
  // could not establish it, so nothing is claimed either way.
  state: "done" | "todo" | "unknown";
}

export interface ProtectionInput {
  protection: {
    fullyProtected: boolean;
    deliveryReady: boolean;
    endToEndDeliveryVerified: boolean;
    activationVerifiedAt: string | null;
    recentDeliveryProblem?: boolean;
    activationStage?: string;
    protectionBlockers?: string[];
    twilioProvisioningStatus?: string;
  };
  membership?: { status?: string; accessUntil?: string | null } | null;
  // customerAllowance.membership.testPurchase — an App Store sandbox
  // (TestFlight / App Review) purchase. The server deliberately assigns no
  // real protected number to these.
  testPurchase?: boolean;
  // customerAllowance (services/allowance/customerAllowance.js). When the
  // server says unknown callers are NOT being checked right now
  // (monitoringActive === false), the app must not claim protection —
  // the same rule the 2026-10-03 allowance work put on the old Home hero.
  allowance?: { status?: string; monitoringActive?: boolean | null; callsContinue?: boolean } | null;
}

export interface DeviceInput {
  // false only when a microphone/notification permission is definitely off
  // (lib/callReadinessModel.ts canPresentCalls). Unknown counts as true.
  canPresentCalls: boolean;
  // Local, per-device "the customer finished the forwarding step" marker
  // (lib/setupCompletionStorage.ts). Only ever used by the legacy fallback
  // for older backends — never to tick a checklist step.
  hasCompletedActivationStep?: boolean;
}

export const HEADLINES = {
  protected: "YOUR PHONE IS PROTECTED",
  setup: "FINISH SETTING UP PROTECTION",
  attention: "PROTECTION NEEDS ATTENTION",
  unknown: "WE CAN'T CONFIRM YOUR PROTECTION",
} as const;

const UNKNOWN_STAGES = new Set(["ambiguous", "unavailable", "account_deleted"]);
const STATE_UNKNOWN_BLOCKERS = ["stateKnown", "accountActive"];

function hasCanonical(input: ProtectionInput): boolean {
  return typeof input.protection.activationStage === "string" && Array.isArray(input.protection.protectionBlockers);
}

function stateUnknown(input: ProtectionInput): boolean {
  const p = input.protection;
  if (!hasCanonical(input)) return false;
  if (UNKNOWN_STAGES.has(p.activationStage!)) return true;
  return p.protectionBlockers!.some(b => STATE_UNKNOWN_BLOCKERS.includes(b));
}

// The strict "protected" test. Canonical servers must agree on both fields;
// a disagreement (should be impossible — the backend asserts it) fails
// closed.
export function isServerProtected(input: ProtectionInput): boolean {
  const p = input.protection;
  if (p.fullyProtected !== true) return false;
  if (hasCanonical(input)) return p.activationStage === "protected" && p.protectionBlockers!.length === 0;
  return true;
}

// Forwarding was proven for an earlier number but not the current one: the
// server stages this as awaiting_forwarding, but the customer needs to be
// told to UPDATE forwarding, not that they never set it up.
function forwardingIsForOldNumber(input: ProtectionInput): boolean {
  const p = input.protection;
  return p.activationStage === "awaiting_forwarding" && !!p.activationVerifiedAt;
}

const t = (tone: ProtectionTone, body: string, action: ProtectionHeadline["action"]): ProtectionHeadline => ({
  tone,
  headline: HEADLINES[tone],
  body,
  action,
  isProtected: tone === "protected",
});

const DEVICE_BODY =
  "This phone can't ring for protected calls because a permission is turned off. Turn it back on in Settings.";

export function describeProtection(input: ProtectionInput, device: DeviceInput): ProtectionHeadline {
  const p = input.protection;
  const paymentIssue = input.membership?.status === "payment_issue";

  if (stateUnknown(input)) {
    return t("unknown", "We couldn't confirm your protection just now. Pull down to refresh, or contact us if this continues.", {
      kind: "refresh",
      label: "Check again",
    });
  }

  if (isServerProtected(input)) {
    if (!device.canPresentCalls) return t("attention", DEVICE_BODY, { kind: "open_settings", label: "Open Settings" });
    if (paymentIssue) {
      return t("attention", "There's a problem with your payment. Update your payment details to keep your protection running.", {
        kind: "update_payment",
        label: "Update payment",
      });
    }
    const al = input.allowance;
    if (al && al.monitoringActive === false && al.status !== "inactive") {
      return t(
        "attention",
        al.callsContinue === false
          ? "This month's allowance is used up. Calls forwarded to Home Call Guard may not get through until your allowance resets."
          : "People you trust ring straight through. Calls from other numbers still reach you, but they aren't being checked for scams right now.",
        null
      );
    }
    if (p.recentDeliveryProblem) {
      return t("attention", "A recent call didn't reach this phone. Reconnect this phone to make sure protected calls come through.", {
        kind: "reconnect_app",
        label: "Reconnect this phone",
      });
    }
    return t("protected", "Home Call Guard is protecting calls to this phone. People you trust ring straight through.", null);
  }

  if (!hasCanonical(input)) return legacyDescribe(input, device);

  const stage = p.activationStage!;
  switch (stage) {
    case "signed_up":
    case "membership_ended":
      return t("setup", "You don't have an active membership. Start your membership to protect this phone.", {
        kind: "resume_setup",
        label: "Start protection",
      });
    case "membership_upcoming":
      return t("setup", "Your membership hasn't started yet. Protection will begin as soon as it does.", null);
    case "on_hold":
      return t("attention", "Protection on your account is paused. Please contact us and we'll sort it out.", {
        kind: "contact_support",
        label: "Contact support",
      });
    case "number_failed":
      return t("attention", "We couldn't set up your protected number. Please contact us and we'll fix it for you.", {
        kind: "contact_support",
        label: "Contact support",
      });
    case "awaiting_number":
      if (input.testPurchase) {
        return t("setup", "This is a test purchase, so no protected number is set up. A real membership sets one up automatically.", null);
      }
      return t("setup", "We're getting your protected number ready. This usually only takes a moment.", { kind: "refresh", label: "Check again" });
    case "number_conflict":
      return t("attention", "Your protected number needs updating before calls can be protected. Please contact us and we'll help.", {
        kind: "contact_support",
        label: "Contact support",
      });
    case "awaiting_forwarding":
      if (forwardingIsForOldNumber(input)) {
        return t("attention", "Your call forwarding is set to an old number. Update it so your calls reach Home Call Guard.", {
          kind: "set_up_forwarding",
          label: "Update call forwarding",
        });
      }
      return t("setup", "Turn on call forwarding so your calls reach Home Call Guard.", { kind: "set_up_forwarding", label: "Turn on call forwarding" });
    case "awaiting_app":
    case "reconnect_needed":
      // The September incident: forwarding works (calls reach HCG) but this
      // phone is not registered to receive them. Always prominent.
      if (!device.canPresentCalls) return t("attention", DEVICE_BODY, { kind: "open_settings", label: "Open Settings" });
      return t(
        "attention",
        "Calls are reaching Home Call Guard, but this phone isn't connected to receive them. Reconnect now — until you do, protected calls can't reach you.",
        { kind: "reconnect_app", label: "Reconnect this phone" }
      );
    case "awaiting_first_delivery":
      if (!device.canPresentCalls) return t("attention", DEVICE_BODY, { kind: "open_settings", label: "Open Settings" });
      return t("setup", "Everything is set up. Protection will be confirmed when your first protected call reaches this phone.", null);
    default:
      // A stage this app version doesn't know: never protected, never guessed.
      return t("unknown", "We couldn't confirm your protection just now. Pull down to refresh, or contact us if this continues.", {
        kind: "refresh",
        label: "Check again",
      });
  }
}

// Older backend (no activationStage): same decisions as the previous Home
// screen, re-worded into the new tones. Notably the incident shape
// (forwarding proven, app never reachable) now resolves to attention here
// too, because deliveryReady is false.
function legacyDescribe(input: ProtectionInput, device: DeviceInput): ProtectionHeadline {
  const p = input.protection;
  const legacy = legacyHomeState(p, !!device.hasCompletedActivationStep);
  if (!device.canPresentCalls && legacy !== "setting_up") {
    return t("attention", DEVICE_BODY, { kind: "open_settings", label: "Open Settings" });
  }
  switch (legacy) {
    case "setting_up":
      return t("setup", "Finish the setup steps to protect this phone.", { kind: "resume_setup", label: "Finish setup" });
    case "awaiting_confirmation":
      return t("setup", "Protection will be confirmed when your first call reaches Home Call Guard.", null);
    case "confirming_delivery":
      if (!p.deliveryReady) {
        return t(
          "attention",
          "Calls are reaching Home Call Guard, but this phone isn't connected to receive them. Reconnect now — until you do, protected calls can't reach you.",
          { kind: "reconnect_app", label: "Reconnect this phone" }
        );
      }
      return t("setup", "Everything is set up. Protection will be confirmed when your first protected call reaches this phone.", null);
    case "reconnect_needed":
    case "delivery_problem":
      return t("attention", "This phone isn't currently connected to receive protected calls. Reconnect now.", {
        kind: "reconnect_app",
        label: "Reconnect this phone",
      });
    default:
      return t("unknown", "We couldn't confirm your protection just now.", { kind: "refresh", label: "Check again" });
  }
}

// ── Setup checklist ──────────────────────────────────────────────────────
// Five customer steps, each mapped to the server gate(s) that prove it.
const STEP_GATES: { key: ChecklistStepKey; label: string; gates: string[] }[] = [
  { key: "membership", label: "Membership active", gates: ["entitledNow", "notOnHold"] },
  { key: "number", label: "Your protected number is ready", gates: ["numberActive", "numberNotQuarantined"] },
  { key: "forwarding", label: "Call forwarding on", gates: ["forwardingVerifiedForCurrentNumber"] },
  { key: "app", label: "This phone ready to receive protected calls", gates: ["appReachable"] },
  { key: "first_call", label: "First protected call received", gates: ["deliveryVerifiedForCurrentNumber"] },
];

export function buildSetupChecklist(input: ProtectionInput): ChecklistStep[] {
  const p = input.protection;
  if (hasCanonical(input)) {
    const unknown = stateUnknown(input);
    const blockers = new Set(p.protectionBlockers);
    return STEP_GATES.map(({ key, label, gates }) => ({
      key,
      label,
      state: unknown ? "unknown" : gates.some(g => blockers.has(g)) ? "todo" : "done",
    }));
  }
  // Older backend: only facts it actually reports. Membership is implied by
  // the dashboard loading at all (it 402s otherwise).
  const fromBool = (b: boolean | undefined): ChecklistStep["state"] => (b === true ? "done" : b === false ? "todo" : "unknown");
  const numberReady = p.twilioProvisioningStatus === undefined ? undefined : p.twilioProvisioningStatus === "active";
  return [
    { key: "membership", label: STEP_GATES[0].label, state: "done" },
    { key: "number", label: STEP_GATES[1].label, state: fromBool(numberReady) },
    { key: "forwarding", label: STEP_GATES[2].label, state: fromBool(!!p.activationVerifiedAt || p.endToEndDeliveryVerified) },
    { key: "app", label: STEP_GATES[3].label, state: fromBool(p.deliveryReady) },
    { key: "first_call", label: STEP_GATES[4].label, state: fromBool(p.endToEndDeliveryVerified) },
  ];
}

// ── Membership wording ───────────────────────────────────────────────────
export type MembershipTone = "good" | "warning" | "neutral";

export function describeMembership(
  m: { status?: string; accessUntil?: string | null; trialEndDate?: string | null; complimentary?: boolean; testPurchase?: boolean } | null | undefined,
  formatDate: (iso: string) => string
): {
  label: string;
  detail: string | null;
  tone: MembershipTone;
} {
  if (!m || !m.status) return { label: "Protection unavailable", detail: "You don't have an active membership.", tone: "neutral" };
  if (m.testPurchase) return { label: "Test purchase", detail: "Made with an App Store test account. No payment is taken.", tone: "neutral" };
  switch (m.status) {
    case "active":
      return m.complimentary ? { label: "Active — complimentary", detail: "No payment is taken for this membership.", tone: "good" } : { label: "Active", detail: null, tone: "good" };
    case "trial":
      return { label: "Free trial", detail: m.trialEndDate ? `Trial ends ${formatDate(m.trialEndDate)}` : null, tone: "good" };
    case "payment_issue":
      return { label: "Payment needs attention", detail: "Update your payment details to keep your protection running.", tone: "warning" };
    case "cancelled":
      return m.accessUntil
        ? { label: `Cancelled — protection continues until ${formatDate(m.accessUntil)}`, detail: null, tone: "neutral" }
        : { label: "Cancelled", detail: "Your protection ends at the end of this billing period.", tone: "neutral" };
    default:
      return { label: "Protection unavailable", detail: null, tone: "neutral" };
  }
}

// HCG account reference shown to the customer for support. Only a value in
// the permanent HCG-XXXXXXXX format is ever shown — never a phone/routing
// number or an internal id.
// Format from migration 062: "HCG-" + 7-digit serial + Luhn check digit
// (households.account_number CHECK '^HCG-[0-9]{8,}$').
export const HCG_ACCOUNT_NUMBER_PATTERN = /^HCG-[0-9]{8,}$/;

export function displayAccountNumber(value: unknown): string | null {
  return typeof value === "string" && HCG_ACCOUNT_NUMBER_PATTERN.test(value) ? value : null;
}
