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

// The RevenueCat Entitlement identifier configured in the RevenueCat
// dashboard for Home Call Guard's one subscription product. Not a
// secret — entitlement identifiers are plain labels, same category as a
// Stripe Price ID. See docs/launch/APPLE_IAP_REMEDIATION.md for the
// proposed product identifier this maps to.
export const HCG_ENTITLEMENT_ID = "hcg_protected";

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

export class PurchasesNotConfiguredError extends Error {
  constructor() {
    super("purchases_not_configured");
  }
}

// Throws PurchasesNotConfiguredError (rather than returning null) when
// the API key is missing, so call sites can show a real error instead
// of silently rendering an empty/broken subscribe screen.
export async function fetchHcgPackage(): Promise<PurchasesPackage> {
  if (!REVENUECAT_API_KEY_IOS) throw new PurchasesNotConfiguredError();

  const offerings = await Purchases.getOfferings();
  const pkg = offerings.current?.availablePackages[0];
  if (!pkg) throw new Error("no_offering_available");
  return pkg;
}

export async function purchaseHcgPackage(pkg: PurchasesPackage): Promise<CustomerInfo> {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return customerInfo;
}

export async function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

export function isEntitled(customerInfo: CustomerInfo): boolean {
  return !!customerInfo.entitlements.active[HCG_ENTITLEMENT_ID];
}
