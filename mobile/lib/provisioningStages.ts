// Pure logic for the B4 "waiting for your Home Call Guard number" screen
// (app/(setup)/activate.tsx) — replaces the old dead-end "Still setting up
// your line" / "Check again" state found broken in a real iPhone test
// (2026-08-08): it forced the customer to manually retry with no real
// progress indication.
//
// Deliberately truthful, not a fake percentage: membership and trusted
// contacts are always genuinely done by the time this screen can be
// reached at all (resumeSetupAt/SETUP_STEPS only route here after both),
// so they're hardcoded "done" rather than re-derived from data this
// screen doesn't have — see lib/setupFlow.ts's own resumeSetupAt for the
// same reasoning applied to the equivalent Home-tab case. The remaining
// two stages reflect two real, separate, backend-confirmed signals: the
// household's Twilio number (protection.twilioProvisioningStatus, polled
// via GET /api/v1/me/dashboard) and the activation code itself (GET
// /api/v1/activation/instructions, which can only succeed once the
// number exists).
import type { TwilioProvisioningStatus } from "./types";

export type ProvisioningStageState = "done" | "in_progress" | "pending";

export interface ProvisioningStage {
  key: string;
  label: string;
  state: ProvisioningStageState;
}

export function computeProvisioningStages(twilioProvisioningStatus: TwilioProvisioningStatus): ProvisioningStage[] {
  const numberReady = twilioProvisioningStatus === "active";
  return [
    { key: "membership", label: "Membership active", state: "done" },
    { key: "contacts", label: "Trusted contacts saved", state: "done" },
    {
      key: "number",
      label: "Getting your Home Call Guard number ready",
      state: numberReady ? "done" : "in_progress",
    },
    {
      key: "activationCode",
      label: "Creating your activation code",
      state: numberReady ? "in_progress" : "pending",
    },
  ];
}

// True the moment polling confirms the number exists — the signal to
// automatically re-fetch activation instructions and advance off this
// screen, without the customer ever needing to press "Check again".
export function shouldAutoAdvance(twilioProvisioningStatus: TwilioProvisioningStatus): boolean {
  return twilioProvisioningStatus === "active";
}

// A genuine terminal failure (Twilio account issue, etc.) — a real,
// honest state, never left indistinguishable from "still in progress".
export function isProvisioningFailed(twilioProvisioningStatus: TwilioProvisioningStatus): boolean {
  return twilioProvisioningStatus === "failed";
}

// Only the dashboard *poll itself* repeatedly failing (e.g. offline)
// should ever surface a manual retry button — legitimate "still
// pending" provisioning must never show one, since that's exactly the
// dead-end "Check again" pattern this screen replaces.
export function shouldShowManualRetry(consecutivePollFailures: number): boolean {
  return consecutivePollFailures >= 2;
}
