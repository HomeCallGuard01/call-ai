// A1 — Splash. Auto-advances based on session state, per
// APP_VISUAL_SPECIFICATION.md: no session -> A2 (Welcome carousel),
// valid session -> straight into the app (the (tabs) group handles
// deciding Home vs a setup-incomplete prompt itself, so this screen's
// only job is "authenticated or not").
import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "../lib/AuthContext";
import { colors, spacing, typography } from "../lib/theme";

// Startup safety net (2026-10-04): restoring the saved sign-in can need the
// network (an expired session is refreshed). If that takes longer than
// STARTUP_STALL_MS the customer sees a plain "couldn't confirm" message instead
// of an endless spinner. Nothing is decided here: the normal redirect still
// happens the moment the session restore finishes.
const STARTUP_STALL_MS = 10000;

export default function Splash() {
  const { session, isLoading } = useAuth();
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (!isLoading) return;
    const timer = setTimeout(() => setStalled(true), STARTUP_STALL_MS);
    return () => clearTimeout(timer);
  }, [isLoading]);

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.accent} size="large" />
        {stalled && (
          <Text style={styles.stalledText}>
            We couldn't confirm your protection right now. Check your internet connection. We'll keep trying.
          </Text>
        )}
      </View>
    );
  }

  if (session) {
    return <Redirect href="/(tabs)" />;
  }

  return <Redirect href="/(auth)/welcome" />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  stalledText: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: spacing.lg,
  },
});
