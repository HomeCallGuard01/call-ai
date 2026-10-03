// Reads the real permission state behind lib/callReadinessModel.ts
// (2026-09-30, release readiness). Android only uses React Native's own
// PermissionsAndroid (no new native dependency). iOS: CallKit incoming calls
// need no notification permission; microphone state isn't readable without
// an extra native module, so it is reported as "unknown", never as denied.
import { Platform, PermissionsAndroid } from "react-native";
import {
  ANDROID_NOTIFICATION_PERMISSION_API,
  buildAndroidReadiness,
  buildIosReadiness,
  type DeviceCallReadiness,
} from "./callReadinessModel";
import { getIosMicrophoneStatus } from "./microphonePermission";

async function check(permission: string): Promise<boolean | null> {
  try {
    return await PermissionsAndroid.check(permission as any);
  } catch {
    return null;
  }
}

export async function getCallReadiness(): Promise<DeviceCallReadiness | null> {
  if (Platform.OS === "android") {
    const api = typeof Platform.Version === "number" ? Platform.Version : parseInt(String(Platform.Version), 10);
    const mic = await check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    const notifications = api >= ANDROID_NOTIFICATION_PERMISSION_API
      ? await check("android.permission.POST_NOTIFICATIONS")
      : true;
    return buildAndroidReadiness(api, mic, notifications);
  }
  if (Platform.OS === "ios") {
    const major = parseInt(String(Platform.Version), 10);
    return buildIosReadiness(Number.isInteger(major) ? major : null, await getIosMicrophoneStatus());
  }
  return null;
}
