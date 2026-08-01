// B4 — Activation instructions. Per APP_VISUAL_SPECIFICATION.md: the
// code itself large and copyable, plain numbered steps, honest that this
// is a manual step the app cannot do for the customer, and — per the
// persona review's most important finding — an explicit acknowledgment
// for the case where someone is on the phone with a family member
// walking them through this (a single phone can't dial the code while
// also being used for that call).
import { useEffect, useRef, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { fetchActivationInstructions, ApiError } from "../../lib/api";
import type { ActivationInstructionsResponse, DeviceType, LandlineProvider } from "../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

export default function Activate() {
  const params = useLocalSearchParams<{ deviceType: DeviceType; provider?: LandlineProvider }>();
  const [instructions, setInstructions] = useState<ActivationInstructionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Retry ("Try again") re-runs load() while a previous attempt might
  // still be in flight, and the params effect below can also re-fire
  // mid-request — without this, a slow earlier response could land after
  // a newer one and silently overwrite the correct instructions (or
  // loading/error state) with stale data.
  const loadId = useRef(0);
  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  function load() {
    const thisLoadId = ++loadId.current;
    setIsLoading(true);
    setError(null);
    fetchActivationInstructions(params.deviceType, params.provider)
      .then(result => {
        if (thisLoadId !== loadId.current || !isMounted.current) return;
        setInstructions(result);
      })
      .catch(err => {
        if (thisLoadId !== loadId.current || !isMounted.current) return;
        if (err instanceof ApiError && err.code === "not_provisioned") {
          // Still setting up server-side — not an error, just not ready
          // yet. Route back to the setup welcome screen, which re-checks
          // state on arrival.
          router.replace("/(setup)/welcome");
          return;
        }
        setError("We couldn't load your activation code. Check your connection and try again.");
      })
      .finally(() => {
        if (thisLoadId !== loadId.current || !isMounted.current) return;
        setIsLoading(false);
      });
  }

  useEffect(load, [params.deviceType, params.provider]);

  async function handleCopy() {
    if (!instructions) return;
    await Clipboard.setStringAsync(instructions.code);
    if (isMounted.current) setCopied(true);
  }

  if (isLoading) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Loading your activation code" />
        </View>
      </Screen>
    );
  }

  if (error || !instructions) {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <Banner variant="error" message={error || "Something went wrong."} />
        <PrimaryButton label="Try again" onPress={load} />
        <PrimaryButton label="Change device" variant="secondary" onPress={() => router.replace("/(setup)/device-picker")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <SetupProgress currentStep={3} />
      <Text style={styles.title} accessibilityRole="header">Turn on call forwarding</Text>
      <Text style={styles.explanation}>{instructions.explanation}</Text>

      <View style={styles.codeBox} accessibilityRole="text" accessibilityLabel={`Your activation code is ${instructions.code}`}>
        <Text style={styles.code} selectable>{instructions.code}</Text>
      </View>
      <PrimaryButton
        label={copied ? "Copied!" : "Copy code"}
        onPress={handleCopy}
        variant="secondary"
      />

      {instructions.requiresPreliminaryCall && instructions.preliminaryCallNote && (
        <Banner variant="notice" message={instructions.preliminaryCallNote} />
      )}

      <View style={styles.steps}>
        <Text style={styles.step}>1. Open your Phone app</Text>
        <Text style={styles.step}>2. Dial the code above</Text>
        <Text style={styles.step}>
          3. You may hear a beep or a short recorded message confirming it — that's normal, you can hang up
        </Text>
        <Text style={styles.step}>4. Come back here</Text>
      </View>

      <Banner
        variant="notice"
        message="If you're on the phone with someone helping you, you may need to put them on speaker, or ask them to call you back on another phone while you dial this."
      />

      <PrimaryButton label="I've done this" onPress={() => router.push("/(setup)/verify")} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  explanation: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  codeBox: {
    minHeight: MIN_TOUCH_TARGET * 1.5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  code: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.accent,
    letterSpacing: 1,
  },
  steps: {
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  step: {
    ...typography.body,
    color: colors.text,
  },
});
