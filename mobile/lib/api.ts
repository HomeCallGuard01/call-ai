// Thin fetch wrapper for the backend's /api/v1 routes (routes/mobileApi.js).
// Every call attaches the current Supabase session's access token as a
// Bearer header — requireAuthApi.js verifies it server-side. Deliberately
// not a generic "wrap every possible endpoint" client: only the specific
// calls the V1 app actually makes, matching the Launch Feature Matrix.
import { Platform } from "react-native";
import { supabase } from "./supabase";
import type {
  RegisterResponse,
  ResendConfirmationResponse,
  DashboardResponse,
  NotEntitledResponse,
  ActivationVerifyResponse,
  ActivationInstructionsResponse,
  ContactResponse,
  CheckoutSessionResponse,
  PortalSessionResponse,
  ApiErrorResponse,
  DeviceType,
  LandlineProvider,
  VoiceTokenResponse,
  SyncContactsResponse,
} from "./types";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

if (!API_BASE_URL) {
  throw new Error(
    "EXPO_PUBLIC_API_BASE_URL must be set (see .env.example) — the deployed backend's base URL, " +
      "e.g. https://www.homecallguard.co.uk"
  );
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Not Entitled is a normal, expected outcome (no active subscription yet),
// distinguished from ApiError so callers aren't tempted to treat it like
// a real failure — see APP_VISUAL_SPECIFICATION.md's B1/C1 branching,
// which depends on being able to tell "not subscribed" apart from
// "something went wrong."
export class NotEntitledError extends Error {
  constructor() {
    super("not_entitled");
  }
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new ApiError(401, "unauthenticated", "No active session");
  }

  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
  });
}

async function parseJsonOrThrow<T>(response: Response, allow402 = false): Promise<T> {
  if (response.status === 402 && allow402) {
    const body = (await response.json()) as NotEntitledResponse;
    if (body.error === "not_entitled") {
      throw new NotEntitledError();
    }
  }

  if (!response.ok) {
    let body: ApiErrorResponse | null = null;
    try {
      body = (await response.json()) as ApiErrorResponse;
    } catch {
      // Response body wasn't JSON (e.g. a network-layer error page) —
      // fall through to the generic error below rather than throwing a
      // confusing parse error on top of the original failure.
    }
    throw new ApiError(response.status, body?.error || "unknown_error", body?.message);
  }

  return (await response.json()) as T;
}

// Called from AuthContext whenever Supabase reports a genuine sign-in
// (never on a routine token refresh) — see that file for why this lives
// there rather than being called individually from register/login/
// reset-password screens. Idempotent server-side (ensureHouseholdAndRole),
// so calling it more than once is always safe, just occasionally
// redundant. Takes the access + refresh token directly rather than going
// through authorizedFetch, since the backend needs both to construct a
// user-scoped Supabase client (see routes/mobileApi.js's own comment on
// why a bearer token alone isn't enough for this one endpoint).
export async function bootstrapHousehold(accessToken: string, refreshToken: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/v1/me/bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(response.status, body?.error || "unknown_error", body?.message);
  }
}

// No Authorization header — this happens before any session exists.
// Replaces the old direct supabase.auth.signUp() call from
// (auth)/register.tsx: the decision of whether this is a genuinely new
// signup, a resend to an existing unconfirmed email, or an existing
// confirmed account is made server-side (routes/mobileApi.js,
// services/mobileRegistration.js) using the service-role admin client
// this mobile client must never hold. See lib/registrationOutcome.ts for
// what the app does with the returned status.
export async function registerAccount(email: string, password: string): Promise<RegisterResponse> {
  const response = await fetch(`${API_BASE_URL}/api/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return parseJsonOrThrow<RegisterResponse>(response);
}

// Powers (auth)/confirm-email.tsx's "Resend confirmation email" button.
// Replaces the old direct supabase.auth.resend() call, which showed the
// same "sent again" notice unconditionally regardless of whether
// anything was actually sent.
export async function resendConfirmationEmail(email: string): Promise<ResendConfirmationResponse> {
  const response = await fetch(`${API_BASE_URL}/api/v1/register/resend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return parseJsonOrThrow<ResendConfirmationResponse>(response);
}

// "already_active" (409) is a normal, expected outcome (e.g. the
// customer double-tapped, or already subscribed via the web on another
// device) — surfaced as a distinct error code rather than a generic
// failure so B2 can show "you're already protected" instead of a scary
// error banner.
export async function createCheckoutSession(): Promise<CheckoutSessionResponse> {
  const response = await authorizedFetch("/api/v1/billing/create-checkout-session", { method: "POST" });
  return parseJsonOrThrow<CheckoutSessionResponse>(response);
}

// Throws ApiError with code "not_manageable" (409) for complimentary/
// founding/promotional/staff access, which has no real Stripe
// subscription behind it to manage — D1 should hide/disable the
// "Manage membership" button rather than let this be called in that case.
export async function createPortalSession(): Promise<PortalSessionResponse> {
  const response = await authorizedFetch("/api/v1/billing/manage-membership", { method: "POST" });
  return parseJsonOrThrow<PortalSessionResponse>(response);
}

// Throws NotEntitledError if there's no active subscription yet — callers
// (the Home screen, the setup flow) branch on that specifically, per
// APP_VISUAL_SPECIFICATION.md's C1/B1 states.
export async function fetchDashboard(): Promise<DashboardResponse> {
  const response = await authorizedFetch("/api/v1/me/dashboard");
  return parseJsonOrThrow<DashboardResponse>(response, true);
}

// GET /api/v1/voice/token — see lib/types.ts's VoiceTokenResponse comment.
// Callers are responsible for re-fetching before ttlSeconds elapses (or
// on a registration failure that looks like an expired token) — the
// Voice SDK client itself does not auto-refresh.
//
// ?platform= is required (2026-08-2X, iOS pre-flight): the backend picks
// an entirely different Twilio Push Credential for Android (FCM) vs iOS
// (APN/VoIP) and fails closed (400) without a recognised value — see
// routes/mobileApi.js's resolvePushCredentialSid. Platform.OS already
// returns exactly "ios" or "android" on this app's two shipping targets.
export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
  const response = await authorizedFetch(`/api/v1/voice/token?platform=${Platform.OS}`);
  return parseJsonOrThrow<VoiceTokenResponse>(response, true);
}

export async function verifyActivation(): Promise<ActivationVerifyResponse> {
  const response = await authorizedFetch("/api/v1/activation/verify", { method: "POST" });
  return parseJsonOrThrow<ActivationVerifyResponse>(response);
}

// Throws ApiError with code "not_provisioned" (409) if the household's
// Twilio number isn't assigned yet — B4 should route back to a
// "still setting up" state rather than show a broken screen in that case.
// protectedNumber is optional: when passed (iPhone/Android setup, where
// the customer confirms the number of the phone actually being
// forwarded), the backend blocks with a "forwarding_loop" ApiError if it
// matches the household's own destination number — see
// routes/mobileApi.js and services/phone.js's wouldCreateForwardingLoop.
export async function fetchActivationInstructions(
  deviceType: DeviceType,
  provider?: LandlineProvider,
  protectedNumber?: string
): Promise<ActivationInstructionsResponse> {
  const params = new URLSearchParams({ deviceType });
  if (provider) params.set("provider", provider);
  if (protectedNumber) params.set("protectedNumber", protectedNumber);

  const response = await authorizedFetch(`/api/v1/activation/instructions?${params.toString()}`);
  return parseJsonOrThrow<ActivationInstructionsResponse>(response);
}

export async function addContact(name: string, number: string): Promise<ContactResponse> {
  const response = await authorizedFetch("/api/v1/contacts", {
    method: "POST",
    body: JSON.stringify({ name, number }),
  });
  return parseJsonOrThrow<ContactResponse>(response);
}

// POST /api/v1/contacts/sync — one request for the whole device contact
// list (or whatever subset iOS/Android has authorised), instead of one
// addContact() call per contact. Server-side dedup means calling this
// repeatedly with the same contacts is always safe — see
// routes/mobileApi.js's own comment for the full rationale.
export async function syncContacts(contacts: { name: string; number: string }[]): Promise<SyncContactsResponse> {
  const response = await authorizedFetch("/api/v1/contacts/sync", {
    method: "POST",
    body: JSON.stringify({ contacts }),
  });
  return parseJsonOrThrow<SyncContactsResponse>(response);
}

export async function updateContact(id: string, name: string, number: string): Promise<ContactResponse> {
  const response = await authorizedFetch(`/api/v1/contacts/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name, number }),
  });
  return parseJsonOrThrow<ContactResponse>(response);
}

export async function deleteContact(id: string): Promise<{ ok: true }> {
  const response = await authorizedFetch(`/api/v1/contacts/${id}`, { method: "DELETE" });
  return parseJsonOrThrow<{ ok: true }>(response);
}
