// B5 — Activation verification. Per APP_VISUAL_SPECIFICATION.md/
// APP_DECISION_003/007: the single highest-value screen in the whole
// activation flow — replaces "did I do this right?" with a real,
// server-checked answer instead of a static help page. Polls once on
// arrival, with a manual re-check and a troubleshooting panel on failure
// rather than a dead end.
//
// Onboarding-verification UX change (2026-09-23): NO LONGER a mandatory
// gate in the setup flow — B9 (complete.tsx) is reached directly from
// activate.tsx now, before this screen ever runs. This screen is reached
// two ways instead: (1) complete.tsx's clearly secondary "Test my
// protection now (optional)" action, usually moments after activation,
// and (2) the Home tab's "unverified setup" reminder, potentially days
// later, when the customer likely hasn't made a test call yet at all.
// Copy below is written for both: it explains what to do before it
// reports a result, and never blocks navigation — "Continue"/back always
// work. Same endpoint (verifyActivation, POST /api/v1/activation/verify)
// and same passive backend stamp (services/activationVerification.js)
// as before — nothing about the verification mechanism itself changed,
// only when/whether the customer is made to look at it.
import { useState, useEffect, useRef } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { verifyActivation } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { colors, spacing, typography } from "../../lib/theme";

type CheckState = "checking" | "verified" | "not_yet";

export default function Verify() {
  const { session } = useAuth();
  const [state, setState] = useState<CheckState>("checking");
  const [hasCheckedOnce, setHasCheckedOnce] = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  async function runCheck() {
    setState("checking");
    try {
      const result = await verifyActivation(session?.access_token);
      if (!isMounted.current) return;
      setState(result.verified ? "verified" : "not_yet");
    } catch {
      if (!isMounted.current) return;
      setState("not_yet");
    } finally {
      if (isMounted.current) setHasCheckedOnce(true);
    }
  }

  // Run once automatically on arrival.
  useEffect(() => {
    runCheck();
  }, []);

  if (state === "checking") {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Checking your activation" />
          <Text style={styles.checkingText}>Checking...</Text>
        </View>
      </Screen>
    );
  }

  if (state === "verified") {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <Text style={styles.title} accessibilityRole="header">Verified!</Text>
        <Text style={styles.body}>Your calls are now forwarding correctly.</Text>
        {/* 2026-09-23: goes to Home, not back to complete.tsx — this
            screen is reachable from two different places now (see file
            header), and Home is always a correct destination from
            either. */}
        <PrimaryButton label="Continue" onPress={() => router.replace("/(tabs)")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <SetupProgress currentStep={3} />
      <Text style={styles.title} accessibilityRole="header">Not detected yet</Text>
      <Text style={styles.body}>
        Use another phone to call your normal mobile number. We'll confirm when Home Call Guard receives the
        forwarded call.
      </Text>

      {hasCheckedOnce && (
        <Banner
          variant="notice"
          message="Not working? The most common cause is that the code was mistyped. Check it and try again."
        />
      )}

      <PrimaryButton label="Check again" onPress={runCheck} />
      {/* 2026-09-23: always available to leave without blocking, on top
          of the existing troubleshooting options below — this screen was
          already reachable via "Continue"/back before this change, but
          is now explicitly optional rather than a gate, so a direct way
          back to Home is added alongside them. */}
      <PrimaryButton label="Back to Home" variant="secondary" onPress={() => router.replace("/(tabs)")} />
      <PrimaryButton
        label="Change device or provider"
        variant="secondary"
        onPress={() => router.replace("/(setup)/device-picker")}
      />
      <PrimaryButton
        label="Contact support"
        variant="secondary"
        onPress={() => router.push("/(tabs)/account/support")}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  checkingText: {
    ...typography.body,
    color: colors.textMuted,
  },
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.md,
  },
  body: {
    ...typography.body,
    color: colors.text,
    marginBottom: spacing.md,
  },
});
