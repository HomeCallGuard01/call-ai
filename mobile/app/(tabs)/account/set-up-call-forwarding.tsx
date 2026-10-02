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
import { Text, View, ActivityIndicator, Linking, Pressable, StyleSheet, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Screen } from "../../../components/Screen";
import { Banner } from "../../../components/Banner";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { fetchActivationInstructions } from "../../../lib/api";
import { useAuth } from "../../../lib/AuthContext";
import { loadActivationDevice } from "../../../lib/activationDeviceStorage";
import { isLandlineComingSoon, useLandlineComingSoon } from "../../../lib/landlineFlag";
import { LandlineComingSoon } from "../../../components/LandlineComingSoon";
import { canAutoOpenDialer, buildDialerUrl, IOS_MANUAL_DIAL_HINT } from "../../../lib/dialerLink";
import { resolveForwardingNumber, formatUkPhoneForDisplay } from "../../../lib/forwardingNumber";
import { settingsForwardingNote } from "../../../lib/forwardingSettingsCopy";
import type { ActivationInstructionsResponse } from "../../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../../lib/theme";

type ScreenState = "loading" | "ready" | "no_device_on_record" | "unavailable" | "landline_coming_soon";

export default function SetUpCallForwarding() {
  const { session } = useAuth();
  // True (Coming soon) until the server explicitly says landline is open.
  const landlineComingSoon = useLandlineComingSoon();
  const [state, setState] = useState<ScreenState>("loading");
  const [instructions, setInstructions] = useState<ActivationInstructionsResponse | null>(null);
  const [deviceType, setDeviceType] = useState<string | null>(null);
  const [dialerError, setDialerError] = useState(false);
  const [numberCopied, setNumberCopied] = useState(false);

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
          // Landline is Coming soon: show that instead of landline dialling steps.
          if (isLandlineComingSoon(device.deviceType)) {
            setState("landline_coming_soon");
            return;
          }
          setDeviceType(device.deviceType);
          return fetchActivationInstructions(device.deviceType, device.provider, session?.access_token)
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
    }, [session?.access_token, landlineComingSoon])
  );

  async function handleOpenPhone() {
    // instructions.code is only ever null for a native_settings carrier
    // (2026-09-24) — the render branch that calls this never shows the
    // "Open Phone app" button in that case (see below), so this is
    // defence in depth, not the primary guard.
    if (!instructions || !instructions.code) return;
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

  if (state === "landline_coming_soon") {
    return (
      <Screen>
        <Text style={styles.title}>Set up call forwarding</Text>
        <LandlineComingSoon />
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
  // The HCG number as its own plain value (2026-09-12 physical-test
  // finding), now from the API's explicit forwardingNumber (2026-09-26);
  // extracting it from the code is only a fallback for an older backend.
  const forwardingNumber = resolveForwardingNumber(instructions);
  const isNativeSettings = instructions?.activationMethod === "native_settings";

  async function handleCopyNumber() {
    if (!forwardingNumber) return;
    await Clipboard.setStringAsync(forwardingNumber);
    setNumberCopied(true);
  }

  // Native Settings needs the customer to type the number in — without it
  // the step is impossible, so show the retryable "couldn't load" notice
  // rather than instructions that can't be followed.
  if (isNativeSettings && !forwardingNumber) {
    return (
      <Screen>
        <Text style={styles.title}>Set up call forwarding</Text>
        <Banner
          variant="notice"
          message="We couldn't load your Home Call Guard number right now. Please try again, or contact support and we'll help you turn on call forwarding."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text style={styles.title}>Set up call forwarding</Text>
      <Text style={styles.explanation}>
        Call forwarding sends your calls to Home Call Guard. Trusted contacts are put straight through, and calls from everyone else are monitored.
      </Text>

      {forwardingNumber && (
        <View style={styles.numberBox} accessibilityRole="text" accessibilityLabel={`${isNativeSettings ? "Enter this Home Call Guard number" : "Your Home Call Guard number"}: ${forwardingNumber}`}>
          <Text style={styles.numberLabel}>{isNativeSettings ? "Enter this Home Call Guard number:" : "Your Home Call Guard number"}</Text>
          <Text style={styles.numberValue} selectable>{formatUkPhoneForDisplay(forwardingNumber)}</Text>
        </View>
      )}
      {isNativeSettings && forwardingNumber && (
        <Pressable onPress={handleCopyNumber} accessibilityRole="button" style={styles.copyLink}>
          <Text style={styles.copyLinkText}>{numberCopied ? "Copied!" : "Copy number"}</Text>
        </Pressable>
      )}

      {/* Carrier-instruction correction (2026-09-24): the exact same
          unconditional-code bug as activate.tsx/turn-off-protection.tsx
          existed here too — genuinely relevant to this specific screen,
          which its own header comment says exists for exactly this kind
          of case ("carrier reset it"). */}
      {isNativeSettings && instructions ? (
        <>
          <Banner
            variant="notice"
            message={settingsForwardingNote("activate", instructions.activationNote, Platform.OS) || "Use your phone's native call forwarding settings (Phone app settings, or Settings > Phone/Calls) to turn this on — a dial code isn't reliable on this network."}
          />
          {instructions.cancelCodeMethod === "native_settings" && (
            <Text style={styles.explanation}>To turn protection off again later, use the same settings screen.</Text>
          )}
        </>
      ) : (
        <>
          <View style={styles.codeBox} accessibilityRole="text" accessibilityLabel={`Your call forwarding code is ${instructions?.code}`}>
            <Text style={styles.code} selectable adjustsFontSizeToFit numberOfLines={1}>{instructions?.code}</Text>
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
          {canAutoDial && Platform.OS === "ios" && <Text style={styles.step}>{IOS_MANUAL_DIAL_HINT}</Text>}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  copyLink: {
    alignSelf: "center",
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  copyLinkText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 14,
  },
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
  numberBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  numberLabel: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  numberValue: {
    ...typography.title,
    color: colors.text,
    fontWeight: "700",
  },
  codeBox: {
    minHeight: MIN_TOUCH_TARGET * 1.5,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: colors.accentMuted,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  code: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.accent,
    letterSpacing: 0.3,
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
