// Mirrors the exact JSON shapes returned by routes/mobileApi.js
// (call-ai backend) — kept as explicit types specifically because
// APP_DECISION_005 flagged the web app's JSON contract as informal
// (shaped only by what upload.html's JS happens to read); this file is
// the one place that contract is written down for the mobile app.

// POST /api/v1/register and POST /api/v1/register/resend — see
// services/mobileRegistration.js for the decision logic behind these.
export interface RegisterResponse {
  status: "pending_confirmation" | "already_registered";
}

export interface ResendConfirmationResponse {
  status: "resent" | "already_registered" | "no_action";
}

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
    // 2026-09-07 correction (services/callRouting.js's computeProtectionStatus):
    // activationVerifiedAt alone proves only that a call reached HCG, never
    // that one can be delivered back out. Any "You're protected" copy must
    // gate on fullyProtected, never activationVerifiedAt alone — see that
    // function's own comment for why deliveryReady and
    // endToEndDeliveryVerified are kept as separate, distinct facts rather
    // than collapsed into one flag. (A households.device_type-based
    // landline delivery path was designed alongside this and deferred
    // before release — this field intentionally carries no
    // device-classification data.)
    deliveryReady: boolean;
    endToEndDeliveryVerified: boolean;
    fullyProtected: boolean;
  };
  membership: {
    planName: string;
    priceLabel: string;
    status: MembershipStatus;
    nextBillingDate: string | null;
    accessUntil: string | null;
    trialEndDate: string | null;
    manageable: boolean;
    // entitlements.source — 'stripe' | 'apple_revenuecat' | 'admin_manual'
    // | ... (free-text server-side, see database/billing.js). Used to
    // send an iOS customer to the billing portal that actually applies
    // to their membership, not just whichever platform they're on.
    billingSource: string;
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

// POST /api/v1/voice/registered (migration 035, 2026-09-07) — called from
// lib/voiceClient.ts's performRegistration() once voice.register() has
// genuinely resolved, so services/callRouting.js's isVoiceClientReachable
// has a real, current signal.
export interface VoiceRegisteredResponse {
  ok: true;
  registeredAt: string;
}

// DELETE /api/v1/me/account (services/accountDeletion.js, call-ai repo).
// appleManualCancellationRequired is true only for an apple_revenuecat
// entitlement — HCG has no API to cancel an Apple subscription itself
// (only the subscriber, via Settings, or Apple can), so the UI must
// tell the customer to do that themselves rather than implying deletion
// alone stops the Apple charge.
export interface DeleteAccountResponse {
  ok: true;
  entitlement: { source: string | null; action: string };
  appleManualCancellationRequired: boolean;
  // Surfaced rather than assumed true — a false here means the household
  // was genuinely anonymised (no PII, no billing) but the Supabase Auth
  // credential itself could not be removed; not currently shown in the
  // UI (the account is functionally empty either way), but available for
  // support/logging rather than silently dropped.
  authUserDeleted: boolean;
  twilioReleaseError: string | null;
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

// GET /api/v1/voice/token — a short-lived Twilio Access Token (VoiceGrant)
// the app uses to register the Voice SDK client and receive an approved
// call directly on this handset, bypassing PSTN entirely (see
// docs/operations/HANDOVER_2026-08-15.md §12-13). Can also fail with 503
// { error: "voice_not_configured" } if the backend's Twilio Voice SDK
// credentials aren't set yet.
export interface VoiceTokenResponse {
  token: string;
  identity: string;
  ttlSeconds: number;
}

export interface ContactResponse {
  id: string;
  name: string;
  number: string;
}

// POST /api/v1/contacts/sync — added/skippedDuplicates are provided
// separately from `message` so the UI can rely on the exact server-
// composed wording ("N contacts synced." / "N new contacts added. M
// were already synced." / "Your contacts are already up to date.")
// without re-deriving pluralisation itself.
export interface SyncContactsResponse {
  added: number;
  skippedDuplicates: number;
  message: string;
}

export interface ApiErrorResponse {
  error: string;
  message?: string;
}
