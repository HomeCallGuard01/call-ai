// Phone-Settings call forwarding wording per platform (2026-10-02,
// release/ios-1.0.2). Pure — no React Native imports — so it is unit tested
// directly (tests/forwarding-settings-copy.test.mjs).
//
// For native-Settings carriers (giffgaff, Three; Sky's cancellation) the
// backend's activationNote / cancelCodeNote describe BOTH platforms ("On
// Android: … On iPhone: …"), because the same text serves the website and
// the Android app. Inside the iOS app that would name Android, which App
// Review rejects under guideline 2.3.10 (Build 11). So on iOS the app shows
// iPhone-only steps; everywhere else the server's text is used unchanged.
// Only the native-Settings branches call this — dial-code (MMI) wording is
// platform-neutral already.

// iOS 18 moved app settings under Settings > Apps; earlier versions have
// Phone at the top level of Settings.
export const IOS_SETTINGS_ACTIVATION_NOTE =
  "Open Settings > Apps > Phone > Call Forwarding (on older iPhones: Settings > Phone > Call Forwarding). Turn Call Forwarding on, tap Forward To and enter your Home Call Guard number.";
export const IOS_SETTINGS_DEACTIVATION_NOTE =
  "To turn call forwarding off, open Settings > Apps > Phone > Call Forwarding (on older iPhones: Settings > Phone > Call Forwarding) and turn Call Forwarding off.";

export function settingsForwardingNote(
  kind: "activate" | "deactivate",
  serverNote: string | null | undefined,
  platform: string
): string | null {
  if (platform === "ios") return kind === "activate" ? IOS_SETTINGS_ACTIVATION_NOTE : IOS_SETTINGS_DEACTIVATION_NOTE;
  return serverNote || null;
}
