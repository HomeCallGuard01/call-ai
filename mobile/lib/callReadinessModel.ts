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

export function readinessMessage(problem: ReadinessProblem): string | null {
  if (problem === "microphone") {
    return "Protected calls can't ring on this phone because Home Call Guard doesn't have microphone access. Turn on Microphone for Home Call Guard in Settings.";
  }
  if (problem === "notifications") {
    return "Protected calls can't ring on this phone because notifications are turned off for Home Call Guard. Turn on Notifications in Settings.";
  }
  return null;
}

// Stable key so a foreground check only reports when something changed.
export function readinessKey(r: DeviceCallReadiness | null | undefined): string {
  return r ? `${r.platform}|${r.microphone}|${r.notifications}` : "none";
}
