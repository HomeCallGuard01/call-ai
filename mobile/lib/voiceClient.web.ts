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
