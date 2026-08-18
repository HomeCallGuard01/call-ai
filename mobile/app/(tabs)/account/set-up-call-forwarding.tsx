// Help item — "Set up call forwarding". A customer who's already
// completed setup may still need a reminder of how to turn call
// forwarding on (new phone, forgot the steps, carrier reset it). Reuses
// the same real, server-computed code the one-time setup screen shows
// (app/(setup)/activate.tsx) rather than inventing a second source of
// truth — same GET /api/v1/activation/instructions endpoint, same
// persisted device lookup already established for the Account tab's
// "Need to turn protection off?" screen (turn-off-protection.tsx).
// Deliberately simpler than activate.tsx: no provisioning polling, no
// auto-advance-on-return — this is a reference/reminder screen for an
// account that's already active, not the onboarding wizard.
import { useCallback, useState } from "react";
import { Text, View, ActivityIndicator, Linking, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "../../../components/Screen";
import { Banner } from "../../../components/Banner";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { fetchActivationInstructions } from "../../../lib/api";
import { loadActivationDevice } from "../../../lib/activationDeviceStorage";
import { canAutoOpenDialer, buildDialerUrl } from "../../../lib/dialerLink";
import type { ActivationInstructionsResponse } from "../../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

type ScreenState = "loading" | "ready" | "no_device_on_record" | "unavailable";

export default function SetUpCallForwarding() {
  const [state, setState] = useState<ScreenState>("loading");
  const [instructions, setInstructions] = useState<ActivationInstructionsResponse | null>(null);
  const [deviceType, setDeviceType] = useState<string | null>(null);
  const [dialerError, setDialerError] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setState("loading");
      setDialerError(false);

      loadActivationDevice()
        .then(device => {
          if (cancelled) return;
          if (!device) {
            setState("no_device_on_record");
            return;
          }
          setDeviceType(device.deviceType);
          return fetchActivationInstructions(device.deviceType, device.provider)
            .then(result => {
              if (cancelled) return;
              setInstructions(result);
              setState("ready");
            })
            .catch(() => {
              if (!cancelled) setState("unavailable");
            });
        })
        .catch(() => {
          if (!cancelled) setState("unavailable");
        });

      return () => {
        cancelled = true;
      };
    }, [])
  );

  async function handleOpenPhone() {
    if (!instructions) return;
    setDialerError(false);
    const url = buildDialerUrl(instructions.code);
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        setDialerError(true);
        return;
      }
      await Linking.openURL(url);
    } catch {
      setDialerError(true);
    }
  }

  if (state === "loading") {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Loading your call forwarding code" />
        </View>
      </Screen>
    );
  }

  if (state === "no_device_on_record" || state === "unavailable") {
    return (
      <Screen>
        <Text style={styles.title}>Set up call forwarding</Text>
        <Banner
          variant="notice"
          message={
            state === "no_device_on_record"
              ? "We don't have a record of which phone to set this up on. Contact support and we'll help you turn on call forwarding."
              : "We couldn't load this right now. Please try again, or contact support and we'll help you turn on call forwarding."
          }
        />
      </Screen>
    );
  }

  const canAutoDial = canAutoOpenDialer(deviceType ?? "");

  return (
    <Screen>
      <Text style={styles.title}>Set up call forwarding</Text>
      <Text style={styles.explanation}>
        Call forwarding is what sends your calls to Home Call Guard to be checked, before they reach you.
      </Text>

      <View style={styles.codeBox} accessibilityRole="text" accessibilityLabel={`Your call forwarding code is ${instructions?.code}`}>
        <Text style={styles.code} selectable>{instructions?.code}</Text>
      </View>

      {canAutoDial ? (
        <View style={styles.steps}>
          <Text style={styles.step}>1. Tap the button below — it opens your Phone app with the code already filled in</Text>
          <Text style={styles.step}>2. Press the green call button to dial it</Text>
          <Text style={styles.step}>3. You may hear a beep or a short message confirming it — that's normal</Text>
          <Text style={styles.step}>4. Close the Phone app and open Home Call Guard again — you're all done, there's nothing more to do</Text>
        </View>
      ) : (
        <View style={styles.steps}>
          <Text style={styles.step}>1. Go to your landline phone</Text>
          <Text style={styles.step}>2. Dial the code above</Text>
          <Text style={styles.step}>3. You may hear a beep or a short message confirming it — that's normal, you can hang up</Text>
          <Text style={styles.step}>4. Open Home Call Guard again — you're all done, there's nothing more to do</Text>
        </View>
      )}

      {dialerError && (
        <Banner
          variant="error"
          message="We couldn't open your Phone app automatically. Dial the code above manually instead."
        />
      )}

      {canAutoDial && <PrimaryButton label="Open Phone app" onPress={handleOpenPhone} />}
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
    marginBottom: spacing.md,
  },
  code: {
    fontSize: 32,
    fontWeight: "700",
    color: colors.accent,
    letterSpacing: 1,
  },
  steps: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  step: {
    ...typography.body,
    color: colors.text,
  },
});
