// iPhone availability and platform-aware onboarding choices (2026-09-30,
// iOS technical parity). Pure — no React Native imports — so it is unit
// tested directly (tests/ios-parity.test.mjs).
//
// APPROVED by Andrew on 2 October 2026, exactly as implemented here:
// - inside the iOS app, iPhone is an available, normal setup path;
// - selecting iPhone continues through carrier check, setup and Apple IAP;
// - for now the household stays recorded as device_type "mobile";
// - IOS_COMING_SOON may keep gating the separate Stripe/web iPhone path.
// Not to be redesigned as part of 1.0.2. (The unadopted flag-gated
// alternative, deviceType "iphone", is on readiness/ios-parity 2f8d31f.)
//
// iOS 1.0.2 release decision (2026-10-01, release/ios-1.0.2): the iOS app is
// distributed only through the App Store, so when it runs on an iPhone the
// iPhone IS the supported path — it buys through Apple in-app purchase and
// continues to the carrier check exactly like Android, with no dependency on
// the backend IOS_COMING_SOON flag. A flag-gated path would show "iPhone —
// Coming soon" inside an approved iPhone app (an App Review 2.1 dead end for a
// reviewer creating a new account) until a backend deploy, migration 061 and
// IOS_COMING_SOON=false had all reached production.
//
// IOS_COMING_SOON (services/featureFlags.js) keeps its existing job: it blocks
// Stripe checkout for households recorded as device_type "iphone" (website
// and the Android app's waiting list). The iOS app therefore records its
// carrier as a UK mobile line (deviceType "mobile"); it buys through Apple and
// is not subject to that Stripe-side gate.

export type AppPlatform = "ios" | "android" | "web" | string;
export type OnboardingDeviceType = "iphone" | "android";

// Only the iOS app onboards an iPhone; everywhere else it is "Coming soon".
export function isIphoneOnboardingAvailable(platform: AppPlatform): boolean {
  return platform === "ios";
}

// Which device cards the picker shows. The iOS app never shows an Android
// option (App Review 2.3.10 — Build 11 was rejected for exactly this);
// Android is unchanged (iPhone "Coming soon" + Android).
export function deviceOptionTypesFor(platform: AppPlatform): OnboardingDeviceType[] {
  return platform === "ios" ? ["iphone"] : ["iphone", "android"];
}

export function iphoneCardLabel(platform: AppPlatform): string {
  return isIphoneOnboardingAvailable(platform) ? "iPhone" : "iPhone — Coming soon";
}

// The carrier-compatibility request's deviceType: always a UK mobile line
// (see the header). The route and migration 061 can also store a carrier for
// device_type "iphone", but that household shape stays blocked at payment
// while IOS_COMING_SOON is on, so the app does not send it.
export function carrierDeviceTypeFor(_deviceType: string | null | undefined): "mobile" {
  return "mobile";
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
