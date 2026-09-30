// iPhone signup availability in the app (2026-09-30, iOS 1.0.2 preparation).
//
// The iOS app is itself distributed only through the App Store, so when it
// runs on an iPhone, the iPhone IS the supported path: it buys through
// Apple in-app purchase and registers the household as a UK mobile line
// (checkCarrierCompatibility sends deviceType "mobile"), exactly like
// Android. Showing "iPhone — Coming soon" inside an approved iPhone app
// would be a dead end (App Review guideline 2.1).
//
// On Android nothing changes: choosing "iPhone" still goes to the existing
// Coming-soon step and waiting list, and the backend IOS_COMING_SOON flag
// (services/featureFlags.js) still blocks Stripe checkout for households
// explicitly recorded as device_type "iphone" (website and Android app).
// This module deliberately does NOT read or change that flag.
//
// Kept free of React Native imports so it can be tested directly.

export function iphoneSignupOpenOnThisDevice(platformOS: string): boolean {
  return platformOS === "ios";
}

export function deviceOptionLabel(type: string, defaultLabel: string, platformOS: string): string {
  return type === "iphone" && iphoneSignupOpenOnThisDevice(platformOS) ? "iPhone" : defaultLabel;
}
