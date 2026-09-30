// iOS microphone permission (2026-09-30, iOS technical parity).
//
// The Twilio iOS Voice SDK never asks for microphone access, and nothing else
// in the app did, so the first answered protected call would trigger the
// system prompt in the middle of the call (possibly from the lock screen) and
// the caller would hear nothing from the customer until it was granted.
//
// expo-audio provides the permission API. It is linked on iOS ONLY
// (mobile/package.json "expo.autolinking.android.exclude"): its Android
// manifest would add FOREGROUND_SERVICE_MEDIA_PLAYBACK / MODIFY_AUDIO_SETTINGS
// and a media-playback foreground service, a new Play declaration for no
// Android benefit (Android's microphone permission is requested by the Twilio
// SDK itself). It is therefore required lazily, and only on iOS — importing it
// at module scope would throw on Android where the native module is absent.
import { Platform } from "react-native";

export type MicrophoneStatus = "granted" | "denied" | "undetermined" | "unavailable";

type PermissionResponse = { status?: string; granted?: boolean; canAskAgain?: boolean };
type AudioModule = {
  getRecordingPermissionsAsync: () => Promise<PermissionResponse>;
  requestRecordingPermissionsAsync: () => Promise<PermissionResponse>;
};

function loadAudioModule(): AudioModule | null {
  if (Platform.OS !== "ios") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("expo-audio") as AudioModule;
  } catch {
    return null;
  }
}

export function toMicrophoneStatus(response: PermissionResponse | null | undefined): MicrophoneStatus {
  if (!response) return "unavailable";
  if (response.granted === true || response.status === "granted") return "granted";
  if (response.status === "denied") return "denied";
  if (response.status === "undetermined") return "undetermined";
  return "unavailable";
}

export async function getIosMicrophoneStatus(): Promise<MicrophoneStatus> {
  const audio = loadAudioModule();
  if (!audio) return "unavailable";
  try {
    return toMicrophoneStatus(await audio.getRecordingPermissionsAsync());
  } catch {
    return "unavailable";
  }
}

// Shows the system prompt. Only ever call from a direct customer action on a
// neutral explainer ("Continue"), per App Review guideline 5.1.1(iv).
export async function requestIosMicrophonePermission(): Promise<MicrophoneStatus> {
  const audio = loadAudioModule();
  if (!audio) return "unavailable";
  try {
    return toMicrophoneStatus(await audio.requestRecordingPermissionsAsync());
  } catch {
    return "unavailable";
  }
}
