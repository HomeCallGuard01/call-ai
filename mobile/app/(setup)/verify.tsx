// B5 — Activation verification. Per APP_VISUAL_SPECIFICATION.md/
// APP_DECISION_003/007: the single highest-value screen in the whole
// activation flow — replaces "did I do this right?" with a real,
// server-checked answer instead of a static help page. Polls once on
// arrival (a customer just came back from dialling the code — no
// "keep checking forever" spinner needed), with a manual retry and a
// troubleshooting panel on failure rather than a dead end.
//
// Routes to B9 (setup complete) on success, not B6-B8 (the native
// contact picker) — those are explicitly deferred post-launch per the
// approved Launch Feature Matrix. V1's trusted-contact flow is manual
// entry only (C2/C3), added from the Contacts tab after setup, same as
// the spec's own "Skip for now" path already describes.
import { useState, useEffect, useRef } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { verifyActivation } from "../../lib/api";
import { colors, spacing, typography } from "../../lib/theme";

type CheckState = "checking" | "verified" | "not_yet";

export default function Verify() {
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
      const result = await verifyActivation();
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
        <PrimaryButton label="Continue" onPress={() => router.push("/(setup)/complete")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <SetupProgress currentStep={3} />
      <Text style={styles.title} accessibilityRole="header">Still checking...</Text>
      <Text style={styles.body}>
        We haven't detected a forwarded call yet. This is normal if it's only been a moment —
        try calling your own number from another phone to test it, then check again.
      </Text>

      {hasCheckedOnce && (
        <Banner
          variant="notice"
          message="Not working? The most common causes are: the code was mistyped, or — for Sky and Virgin Media — the Call Divert add-on hasn't been added to your account yet."
        />
      )}

      <PrimaryButton label="Try again" onPress={runCheck} />
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
