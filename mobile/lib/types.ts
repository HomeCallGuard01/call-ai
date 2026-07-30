// Mirrors the exact JSON shapes returned by routes/mobileApi.js
// (call-ai backend) — kept as explicit types specifically because
// APP_DECISION_005 flagged the web app's JSON contract as informal
// (shaped only by what upload.html's JS happens to read); this file is
// the one place that contract is written down for the mobile app.

export type MembershipStatus = "active" | "trial" | "payment_issue" | "cancelled";

export type TwilioProvisioningStatus = "pending" | "active" | "failed";

export interface DashboardContact {
  id: string;
  name: string;
  number: string;
}

export interface DashboardActivityItem {
  number: string;
  status: string;
  result: string | null;
  time: string;
}

export interface DashboardResponse {
  protection: {
    twilioProvisioningStatus: TwilioProvisioningStatus;
    activationVerifiedAt: string | null;
    recentUnconfirmedCallSeen: boolean;
  };
  membership: {
    planName: string;
    priceLabel: string;
    status: MembershipStatus;
    nextBillingDate: string | null;
    accessUntil: string | null;
    trialEndDate: string | null;
    manageable: boolean;
  };
  contacts: DashboardContact[];
  activity: DashboardActivityItem[];
  stats: {
    callsScreened: number;
    suspectedScamsBlocked: number;
    trustedCallsRecognised: number;
  };
}

// GET /api/v1/me/dashboard can also fail with 402 { error: "not_entitled" }
// when there's no active subscription yet — see requireEntitlement.js.
export interface NotEntitledResponse {
  error: "not_entitled";
}

export interface CheckoutSessionResponse {
  url: string;
}

export interface PortalSessionResponse {
  url: string;
}

export interface ActivationVerifyResponse {
  verified: boolean;
  verifiedAt?: string;
}

// B3's device/provider selection — shared between app/(setup)/
// device-picker.tsx (where it's chosen) and lib/api.ts (where it's sent
// to GET /api/v1/activation/instructions), so both stay in sync with
// exactly what services/activationInstructions.js accepts server-side.
export type DeviceType = "iphone" | "android" | "landline";
export type LandlineProvider = "bt" | "sky" | "virgin" | "talktalk" | "plusnet" | "other";

// GET /api/v1/activation/instructions — never includes a bare Twilio
// number, only the fully-formed, ready-to-dial code (see
// services/activationInstructions.js). Can also fail with 409
// { error: "not_provisioned" } if the household's Twilio number isn't
// assigned yet.
export interface ActivationInstructionsResponse {
  code: string;
  cancelCode: string;
  requiresPreliminaryCall: boolean;
  preliminaryCallNumber: string | null;
  preliminaryCallNote: string | null;
  explanation: string;
}

export interface ContactResponse {
  id: string;
  name: string;
  number: string;
}

export interface ApiErrorResponse {
  error: string;
  message?: string;
}
