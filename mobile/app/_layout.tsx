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

import { useEffect } from "react";
import { View, Text, StyleSheet, Linking } from "react-native";
import { Stack, SplashScreen, type ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../lib/AuthContext";
import { PrimaryButton } from "../components/PrimaryButton";
import { colors, spacing, typography } from "../lib/theme";

// Startup safety net (2026-10-04, after iOS 1.0.2 Build 15 stayed on the
// native splash on a real iPhone). expo-router normally hides the splash when
// navigation reports ready; if anything rendered below this layout throws,
// the ErrorBoundary below renders instead (expo-router hides the splash for
// it), and the effect in RootLayout hides the splash as soon as this layout
// has mounted, so the customer always reaches real UI. Neither can catch a
// native module missing from the binary at import time (the Build 15 cause):
// tests/mobile-native-sdk-compat.test.mjs guards that class before a build.
// Both are idempotent: hiding an already-hidden splash is a no-op.
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle} accessibilityRole="header">Something went wrong</Text>
        <Text style={styles.errorBody}>
          Home Call Guard couldn't start properly, so we couldn't confirm your protection right now. Please try again.
        </Text>
        <PrimaryButton label="Try again" onPress={() => { retry().catch(() => {}); }} />
        <PrimaryButton
          label="Contact support"
          variant="secondary"
          onPress={() => { Linking.openURL("mailto:support@homecallguard.co.uk").catch(() => {}); }}
        />
      </View>
    </SafeAreaProvider>
  );
}

// Root layout: every screen in the app renders inside this Stack. Route
// groups — (auth), (setup), (tabs) — organise screens without affecting
// the URL/path, per Expo Router convention. app/index.tsx (A1) is the
// only screen that decides where a customer actually lands.
export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

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

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  errorTitle: {
    ...typography.hero,
    color: colors.text,
  },
  errorBody: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
});
