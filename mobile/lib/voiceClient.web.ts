// Web-only stub. Metro/Expo prefer a `.web.ts` file over the plain
// `.ts` for web bundles automatically (standard React Native
// platform-specific-file resolution) — never consulted for iOS/Android
// builds, which always use the real voiceClient.ts. Exists solely
// because @twilio/voice-react-native-sdk's `new Voice()` throws on web
// (it's a native-only module), which otherwise crashes the whole
// (tabs) route group under `expo start --web` / local screenshot
// tooling. No behavioural change to the real app on any real platform.
export async function registerForIncomingCalls(_accessToken?: string): Promise<void> {
  // no-op on web
}

export function getActiveCall(): null {
  return null;
}

export function resetVoiceRegistrationState(): void {
  // no-op on web
}

export async function unregisterForIncomingCalls(): Promise<boolean> {
  // no-op on web — there is no push binding to remove
  return false;
}

// DT-1 call-screen API (web: there is never an active call).
import { IDLE_CALL, type ActiveCallState } from "./activeCallModel";
export function subscribeActiveCall(listener: (state: ActiveCallState) => void): () => void {
  listener(IDLE_CALL);
  return () => {};
}
export function getActiveCallState(): ActiveCallState {
  return IDLE_CALL;
}
export async function endActiveCall(): Promise<void> {}
export async function setActiveCallMuted(_muted: boolean): Promise<void> {}
export async function setActiveCallSpeaker(_speaker: boolean): Promise<void> {}
