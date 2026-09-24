// Pure logic for the guided setup flow's shape: what the three macro
// steps are, and — given the real, backend-confirmed state of an
// account — which single screen a customer should land on next. Kept
// dependency-free (no react-native/expo-router imports) so it's unit
// testable directly; see tests/mobile-app.test.mjs.
//
// The macro-step model deliberately compresses device-picker + activate
// + verify (three screens) into one visible "Activate" step — from the
// customer's perspective these are one coherent action ("turn on call
// forwarding"), and surfacing three separate progress steps for it would
// overstate the remaining effort more than it clarifies anything.

export const SETUP_STEPS = ["Membership", "Trusted contacts", "Activate"] as const;
export type SetupStepName = (typeof SETUP_STEPS)[number];

export interface SetupResumeState {
  isEntitled: boolean;
  contactCount: number;
  // Renamed from isActivationVerified (2026-09-12, physical-test finding):
  // a real successful end-to-end delivery is at least as strong a proof
  // that setup is done as the legacy activation_verified_at flag — see
  // lib/homeStatus.ts's hasProvenActivation, which callers must use to
  // compute this rather than reading activationVerifiedAt alone. Without
  // this, a household with fully proven, currently-working delivery (real
  // production case, 2026-09-12) was sent back through this same
  // device-picker/MMI flow forever, because activation_verified_at alone
  // never gets set for a customer who dialled the forwarding code
  // manually or whose only proof is a real delivered call.
  isActivationProven: boolean;
  // Onboarding-verification UX change (2026-09-23): distinct from
  // isActivationProven. True the moment the customer completes the
  // activation *step* (dialled/confirmed the forwarding code and reached
  // B9) — see lib/setupCompletionStorage.ts — regardless of whether a
  // real forwarded call has proven it yet. Before this field existed, an
  // activated-but-not-yet-verified customer was indistinguishable from
  // one who had never attempted activation at all, so resumeSetupAt
  // below sent BOTH back to device-picker/MMI setup — asking someone who
  // had already correctly dialled their carrier code to do it again, for
  // no reason, every time they reopened the app before their first
  // forwarded call arrived. Optional/defaults to false so every existing
  // caller/test that doesn't know about this yet keeps its exact
  // previous behaviour.
  hasCompletedActivationStep?: boolean;
  // Complimentary/admin-account onboarding fix (2026-09-24): whether
  // households.device_type (or carrier_provider_key, for a mobile
  // household) is on record at all. A household whose entitlement was
  // granted directly (grantComplimentaryEntitlement, admin_manual) can
  // reach real, evidenced protection — a genuine forwarded call stamps
  // activation_verified_at/delivery_verified_at regardless of how the
  // customer dialled the code — without ever having passed through
  // device-picker.tsx's carrier-capture step at all, since that step is
  // normally only reached via the paid Subscribe flow. Real production
  // case (2026-09-24): a complimentary household with two genuinely
  // successful delivered calls, and device_type/carrier_provider_key
  // both still null. Optional/defaults to true (not false) — the
  // opposite default from hasCompletedActivationStep above, deliberately:
  // an unset value here must never manufacture a new gate for every
  // existing test/caller that doesn't pass it, and "assume it's fine"
  // is the correct fail-safe default for a support-information gap, as
  // opposed to hasCompletedActivationStep's "assume not done yet".
  hasDeviceOnRecord?: boolean;
}

export type SetupResumeTarget =
  | { screen: "subscribe" }
  | { screen: "contacts" }
  | { screen: "device-picker" }
  // Complimentary/admin-account onboarding fix (2026-09-24): distinct
  // from "device-picker" — this household is already genuinely,
  // evidence-based protected (isActivationProven or
  // hasCompletedActivationStep is true); it is missing only the support
  // information (device/provider), never routed here to redo activation.
  // See device-picker.tsx's own "confirm" mode.
  | { screen: "confirm-device" }
  | { screen: "complete" };

// The single source of truth for "where does this customer continue
// setup from" — used both when a signed-in customer opens the app with
// setup incomplete (Home's "Finish setup") and when B1 itself checks on
// arrival whether to skip steps already done (e.g. a family member
// finishing setup on an already-paid, already-entitled account).
export function resumeSetupAt(state: SetupResumeState): SetupResumeTarget {
  if (!state.isEntitled) return { screen: "subscribe" };
  if (state.contactCount === 0) return { screen: "contacts" };
  if (!state.isActivationProven && !state.hasCompletedActivationStep) return { screen: "device-picker" };
  // Explicit "!== false": missing/undefined defaults to "on record" (see
  // this field's own comment) — only a caller that positively knows and
  // reports false ever routes here. Never gates on this alone before the
  // activation checks above: an activated household must never be sent
  // to "confirm-device" instead of "complete" as if support-information
  // completeness were a stronger requirement than real protection
  // evidence — it is explicitly the opposite, per this fix's own brief.
  if (state.hasDeviceOnRecord === false) return { screen: "confirm-device" };
  return { screen: "complete" };
}

// Which macro-step (1-indexed, matching SETUP_STEPS) a given setup
// screen belongs to, for the progress indicator. Screens not part of
// the guided flow (welcome, confirmation, complete) return null — the
// indicator simply isn't shown on those. device-picker moved here
// (2026-09-13) too: it now runs before Subscribe as a pre-flight
// device/carrier-compatibility check, not as part of the numbered
// "Activate" step — see that screen's own header comment.
const STEP_BY_SCREEN: Record<string, number> = {
  subscribe: 1,
  contacts: 2,
  activate: 3,
  verify: 3,
};

export function stepIndexForScreen(screen: string): number | null {
  return STEP_BY_SCREEN[screen] ?? null;
}
