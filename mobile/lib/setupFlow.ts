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
  isActivationVerified: boolean;
}

export type SetupResumeTarget =
  | { screen: "subscribe" }
  | { screen: "contacts" }
  | { screen: "device-picker" }
  | { screen: "complete" };

// The single source of truth for "where does this customer continue
// setup from" — used both when a signed-in customer opens the app with
// setup incomplete (Home's "Finish setup") and when B1 itself checks on
// arrival whether to skip steps already done (e.g. a family member
// finishing setup on an already-paid, already-entitled account).
export function resumeSetupAt(state: SetupResumeState): SetupResumeTarget {
  if (!state.isEntitled) return { screen: "subscribe" };
  if (state.contactCount === 0) return { screen: "contacts" };
  if (!state.isActivationVerified) return { screen: "device-picker" };
  return { screen: "complete" };
}

// Which macro-step (1-indexed, matching SETUP_STEPS) a given setup
// screen belongs to, for the progress indicator. Screens not part of
// the guided flow (welcome, confirmation, complete) return null —
// the indicator simply isn't shown on those.
const STEP_BY_SCREEN: Record<string, number> = {
  subscribe: 1,
  contacts: 2,
  "device-picker": 3,
  activate: 3,
  verify: 3,
};

export function stepIndexForScreen(screen: string): number | null {
  return STEP_BY_SCREEN[screen] ?? null;
}
