// iPhone availability and platform-aware onboarding choices (2026-09-30,
// iOS technical parity). Pure — no React Native imports — so it is unit
// tested directly (tests/ios-parity.test.mjs).
//
// Mirrors lib/landlineAvailability.ts: the backend's IOS_COMING_SOON flag
// (GET /api/v1/launch-flags) is the single source of truth, and anything but
// an explicit `iosComingSoon: false` counts as coming soon (fail closed).
// The server still enforces the same flag at checkout
// (services/providerPolicy.js evaluateHouseholdCheckoutEligibility).

export type AppPlatform = "ios" | "android" | "web" | string;
export type OnboardingDeviceType = "iphone" | "android";

export function resolveIosComingSoon(flags: unknown): boolean {
  if (flags !== null && typeof flags === "object" && (flags as { iosComingSoon?: unknown }).iosComingSoon === false) {
    return false;
  }
  return true;
}

// Only the iOS app can onboard an iPhone, and only once the flag is off.
export function isIphoneOnboardingAvailable(platform: AppPlatform, iosComingSoon: boolean): boolean {
  return platform === "ios" && !iosComingSoon;
}

// Which device cards the picker shows. The iOS app never shows an Android
// option (App Review 2.3.10 — Build 11 was rejected for exactly this);
// Android is unchanged (iPhone "Coming soon" + Android).
export function deviceOptionTypesFor(platform: AppPlatform): OnboardingDeviceType[] {
  return platform === "ios" ? ["iphone"] : ["iphone", "android"];
}

export function iphoneCardLabel(platform: AppPlatform, iosComingSoon: boolean): string {
  return isIphoneOnboardingAvailable(platform, iosComingSoon) ? "iPhone" : "iPhone — Coming soon";
}

// The carrier-compatibility request's deviceType. An iPhone household records
// its carrier exactly like an Android one — without it, checkout eligibility
// fell through to "unverified carrier" and an iPhone customer could never pay
// even with IOS_COMING_SOON=false.
export function carrierDeviceTypeFor(deviceType: string | null | undefined): "iphone" | "mobile" {
  return deviceType === "iphone" ? "iphone" : "mobile";
}

// Customer copy that must not mention the other platform (2.3.10 on iOS).
export function contactsPermissionHelp(platform: AppPlatform): string {
  const common =
    "When you tap Sync contacts, your phone will ask for permission. Choosing Full Access makes syncing easiest, both now and every time you sync again in future.";
  const tail =
    " Whichever you choose, Home Call Guard only ever stores the name and phone number needed to recognise a trusted caller — never any other information from your address book.";
  if (platform === "ios") {
    return `${common} If you'd rather share only some contacts, that's fine too — this is called Limited Access, and you can add more at any time by tapping "Add more contacts" on the sync screen, or later via Settings > Home Call Guard > Contacts > Edit Selected Contacts.${tail}`;
  }
  return `${common} If you'd rather share only some contacts, go to Settings > Apps > Home Call Guard > Permissions > Contacts to change access at any time.${tail}`;
}
