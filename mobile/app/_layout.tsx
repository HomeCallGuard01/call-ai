// Triggers lib/voiceClient.ts's module-level PushKit initialization as
// the very first thing this app does — before Supabase session hydration,
// before any navigation, before any component renders. See that file's
// own initializePushKitEarly() comment for why: iOS requires a VoIP push
// to be reported to CallKit in the same run loop as the native PushKit
// callback, and the native registry that receives that callback doesn't
// exist until this has run at least once. Twilio's own official React
// Native reference app does the equivalent via a top-level import in its
// own index.js (`import './src/util/voice'`) — this is the closest
// equivalent Expo Router's managed entry point allows, since there's no
// earlier JS hook available without ejecting to a custom native entry
// file. Side-effect-only import — nothing here needs any of its exports
// (Metro resolves this to lib/voiceClient.web.ts, a no-op stub, on web).
import "../lib/voiceClient";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../lib/AuthContext";

// Root layout: every screen in the app renders inside this Stack. Route
// groups — (auth), (setup), (tabs) — organise screens without affecting
// the URL/path, per Expo Router convention. app/index.tsx (A1) is the
// only screen that decides where a customer actually lands.
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="reset-password" />
          <Stack.Screen name="(setup)" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
