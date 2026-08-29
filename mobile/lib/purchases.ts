// RevenueCat (Apple StoreKit) subscription purchasing — iOS only.
// Android and web keep the existing Stripe Checkout/Billing Portal path
// entirely unchanged (lib/api.ts's createCheckoutSession/
// createPortalSession) — this file is never imported from those
// platforms' purchase flow, only from iOS-gated branches.
//
// App User ID is deliberately set to this household's own Supabase
// auth_user_id, never RevenueCat's own anonymous ID, so a purchase
// always maps back to the correct Home Call Guard account — see
// routes/mobileApi.js's POST /api/v1/billing/apple/revenuecat-webhook,
// which resolves the household via this exact same id. Entitlement
// state is never trusted from the client alone: this file only ever
// reflects what RevenueCat/StoreKit itself reports locally (for
// responsive UI), while the actual grant of protected-service access
// happens server-side, off RevenueCat's webhook — the same "server is
// the only source of truth" model the existing Stripe path already
// uses.
import { Platform } from "react-native";
import Purchases, { type CustomerInfo, type PurchasesPackage } from "react-native-purchases";

const REVENUECAT_API_KEY_IOS = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_IOS;

// Confirmed RevenueCat/App Store Connect configuration (2026-08-29) —
// none of these are secrets, same category as a Stripe Price ID:
//   App Store Connect product ID: co.uk.homecallguard.app.monthly
//     (bundle ID co.uk.homecallguard.app, £4.99/month, UK only)
//   RevenueCat entitlement:        hcg_protected
//   RevenueCat offering:           default
//   RevenueCat package:            $rc_monthly
// The offering's $rc_monthly package also has a RevenueCat Test Store
// product attached (for sandbox/dev testing) — RevenueCat's SDK resolves
// the correct underlying store product automatically based on the store
// the build is actually running against, so this file never needs to
// choose between them itself.
export const HCG_ENTITLEMENT_ID = "hcg_protected";
export const HCG_OFFERING_ID = "default";
export const HCG_PACKAGE_ID = "$rc_monthly";
// Expected only for a real App Store purchase — a Test Store purchase in
// development legitimately reports a different product identifier, so
// this is used for a dev-only sanity warning, never a hard failure.
const EXPECTED_APPLE_PRODUCT_ID = "co.uk.homecallguard.app.monthly";

let configuredForUserId: string | null = null;

// Idempotent and safe to call from multiple mount points without
// double-configuring the SDK or re-logging-in redundantly — same guard
// shape as lib/voiceClient.ts's registerForIncomingCalls. A no-op on
// Android/web, and a no-op (with a dev warning) if the API key hasn't
// been configured yet, so this can be wired into AuthContext
// unconditionally without any platform check at every call site.
export function configurePurchases(appUserId: string): void {
  if (Platform.OS !== "ios") return;

  if (!REVENUECAT_API_KEY_IOS) {
    if (__DEV__) {
      console.warn("RevenueCat: EXPO_PUBLIC_REVENUECAT_API_KEY_IOS not set — iOS purchases disabled");
    }
    return;
  }

  if (configuredForUserId === appUserId) return;

  if (configuredForUserId === null) {
    Purchases.configure({ apiKey: REVENUECAT_API_KEY_IOS, appUserID: appUserId });
    configuredForUserId = appUserId;
    return;
  }

  // Already configured under a different identity (e.g. a different
  // household signed in on this device previously) — switch identity
  // rather than re-configure, RevenueCat's own documented pattern.
  Purchases.logIn(appUserId)
    .then(() => {
      configuredForUserId = appUserId;
    })
    .catch(err => console.error("RevenueCat logIn failed:", err));
}

// Clears the RevenueCat identity on sign-out, mirroring why this
// matters everywhere else in this codebase (Priority 5/2 in other
// files' comments): no cached identity from a previous household may be
// attributed to whoever signs in next on this device.
export function resetPurchasesIdentity(): void {
  if (Platform.OS !== "ios" || !REVENUECAT_API_KEY_IOS) return;
  configuredForUserId = null;
  Purchases.logOut().catch(() => {
    // Best-effort — a failed logOut here must never block the app's own
    // sign-out flow, which has already cleared the real session.
  });
}

// Reports a RevenueCat/StoreKit purchase failure to the backend's own
// diagnostic beacon (routes/mobileApi.js's POST /debug/purchase-beacon,
// same pattern as lib/voiceClient.ts's beacon()) — console-logged
// server-side only, never written to the database. Found 2026-08-29: the
// real underlying SDK error (e.g. "product not available", a
// misconfigured offering, a network failure) was being swallowed
// entirely into subscribe.tsx's generic "we couldn't start checkout"
// message, making a genuine purchase failure undiagnosable without
// physical device + Xcode console access. Deliberately extracts only
// RevenueCat's own SDK-level diagnostic fields (code/message/
// underlyingErrorMessage — StoreKit/App Store error descriptions, never
// anything customer-identifying) rather than logging the raw error
// object, which could in principle carry more than intended.
function purchaseBeacon(stage: string, err: unknown): void {
  try {
    const base = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!base) return;
    const e = err as { code?: string; message?: string; underlyingErrorMessage?: string; userCancelled?: boolean } | null;
    const detail = e
      ? `code=${e.code ?? "?"} userCancelled=${e.userCancelled ?? "?"} message=${e.message ?? "?"} underlying=${e.underlyingErrorMessage ?? "?"}`.slice(0, 500)
      : undefined;
    fetch(`${base}/debug/purchase-beacon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, detail }),
    }).catch(() => {});
  } catch {
    // never let diagnostics break the real purchase flow
  }
}

export class PurchasesNotConfiguredError extends Error {
  constructor() {
    super("purchases_not_configured");
  }
}

// Throws PurchasesNotConfiguredError (rather than returning null) when
// the API key is missing, so call sites can show a real error instead
// of silently rendering an empty/broken subscribe screen.
//
// Selects the $rc_monthly package explicitly rather than taking
// availablePackages[0] — the "default" offering is configured with a
// single package, but a positional index would silently break (or
// silently pick the wrong product) if a second package is ever added to
// the offering later, so this fails loudly with a clear error instead.
export async function fetchHcgPackage(): Promise<PurchasesPackage> {
  if (!REVENUECAT_API_KEY_IOS) throw new PurchasesNotConfiguredError();

  let offerings;
  try {
    offerings = await Purchases.getOfferings();
  } catch (err) {
    purchaseBeacon("getOfferings-failed", err);
    throw err;
  }

  const offering = offerings.current;
  if (!offering) {
    purchaseBeacon("no-offering-available", null);
    throw new Error("no_offering_available");
  }

  const pkg = offering.availablePackages.find(p => p.identifier === HCG_PACKAGE_ID);
  if (!pkg) {
    // Most likely cause: the App Store Connect subscription isn't fully
    // "Ready to Submit" yet (missing metadata/localisation/review
    // screenshot) — StoreKit won't serve a product in that state to any
    // build, TestFlight included, so RevenueCat can't resolve $rc_monthly
    // to a real product and the offering comes back with no packages.
    purchaseBeacon("expected-package-not-found", null);
    throw new Error("expected_package_not_found");
  }

  if (__DEV__ && pkg.product.identifier !== EXPECTED_APPLE_PRODUCT_ID) {
    // Expected in local/sandbox testing against the RevenueCat Test
    // Store product — not a bug, just worth surfacing so a genuine App
    // Store misconfiguration isn't mistaken for this.
    console.warn(
      `RevenueCat: $rc_monthly resolved to product "${pkg.product.identifier}", ` +
      `not the expected App Store product "${EXPECTED_APPLE_PRODUCT_ID}" — ` +
      `expected when testing against the RevenueCat Test Store.`
    );
  }

  return pkg;
}

export async function purchaseHcgPackage(pkg: PurchasesPackage): Promise<CustomerInfo> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return customerInfo;
  } catch (err) {
    purchaseBeacon("purchasePackage-failed", err);
    throw err;
  }
}

export async function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

export function isEntitled(customerInfo: CustomerInfo): boolean {
  return !!customerInfo.entitlements.active[HCG_ENTITLEMENT_ID];
}
