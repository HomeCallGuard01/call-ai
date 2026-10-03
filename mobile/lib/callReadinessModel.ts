// Pure call-readiness model (2026-09-30, release readiness). Dependency-free
// so it is unit tested directly (tests/mobile-call-readiness.test.mjs);
// lib/callReadiness.ts reads the real permission state.
//
// Why: the Twilio Voice SDK on Android drops an incoming call BEFORE posting
// any notification or ringtone when the microphone permission is not
// granted (VoiceService.incomingCall, Android 11+), and on Android 13+ posts
// no answerable notification without POST_NOTIFICATIONS. In both cases the
// app is "registered", Twilio just records no-answer, and the customer never
// knows. The SDK asks for these permissions once at launch; if they were
// declined, nothing ever asked again.

export type PermissionState = "granted" | "denied" | "not_required" | "unknown";

export interface DeviceCallReadiness {
  platform: "android" | "ios";
  osVersion?: number;
  microphone: PermissionState;
  notifications: PermissionState;
}

export type ReadinessProblem = "microphone" | "notifications" | null;

// Android 13 (API 33) introduced the runtime notification permission.
export const ANDROID_NOTIFICATION_PERMISSION_API = 33;

export function permissionState(granted: boolean | null | undefined, required = true): PermissionState {
  if (!required) return "not_required";
  if (granted === true) return "granted";
  if (granted === false) return "denied";
  return "unknown";
}

export function buildAndroidReadiness(apiLevel: number, micGranted: boolean | null, notificationsGranted: boolean | null): DeviceCallReadiness {
  return {
    platform: "android",
    osVersion: Number.isInteger(apiLevel) ? apiLevel : undefined,
    microphone: permissionState(micGranted),
    notifications: permissionState(notificationsGranted, apiLevel >= ANDROID_NOTIFICATION_PERMISSION_API),
  };
}

// iOS (2026-09-30): CallKit needs no notification permission. Microphone
// state comes from expo-audio (lib/microphonePermission.ts); "undetermined"
// is reported as "unknown" — never blocked — and prompted for separately.
export function buildIosReadiness(osMajor: number | null, micStatus: "granted" | "denied" | "undetermined" | "unavailable"): DeviceCallReadiness {
  return {
    platform: "ios",
    osVersion: Number.isInteger(osMajor) ? (osMajor as number) : undefined,
    microphone: micStatus === "granted" ? "granted" : micStatus === "denied" ? "denied" : "unknown",
    notifications: "not_required",
  };
}

export function readinessProblem(r: DeviceCallReadiness | null | undefined): ReadinessProblem {
  if (!r) return null;
  if (r.microphone === "denied") return "microphone";
  if (r.notifications === "denied") return "notifications";
  return null;
}

// "Presented" = the incoming-call UI can be shown and ring (only a
// definite denial counts against it; unknown is not treated as blocked).
export function canPresentCalls(r: DeviceCallReadiness | null | undefined): boolean {
  return readinessProblem(r) === null;
}

export function readinessMessage(problem: ReadinessProblem, platform: "android" | "ios" = "android"): string | null {
  if (problem === "microphone" && platform === "ios") {
    // On iPhone the call still rings (CallKit), but the caller can't hear you.
    return "Protected calls will ring, but callers won't be able to hear you because Home Call Guard doesn't have microphone access. Turn on Microphone for Home Call Guard in Settings.";
  }
  if (problem === "microphone") {
    return "Protected calls can't ring on this phone because Home Call Guard doesn't have microphone access. Turn on Microphone for Home Call Guard in Settings.";
  }
  if (problem === "notifications") {
    return "Protected calls can't ring on this phone because notifications are turned off for Home Call Guard. Turn on Notifications in Settings.";
  }
  return null;
}

// Neutral explainer shown before the iOS system microphone prompt (App Review
// 5.1.1(iv): explain, then a neutral "Continue" that always shows the prompt).
export const IOS_MICROPHONE_EXPLAINER =
  "Home Call Guard needs microphone access so you can talk on protected calls, the same as a normal phone call. Tap Continue and your iPhone will ask for permission.";

// Stable key so a foreground check only reports when something changed.
export function readinessKey(r: DeviceCallReadiness | null | undefined): string {
  return r ? `${r.platform}|${r.microphone}|${r.notifications}` : "none";
}
