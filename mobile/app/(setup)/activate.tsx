// B4 — Activation. Redesigned 2026-08-05 around the shortest honest path
// per device type, researched against real platform restrictions before
// writing any of this (see mobile/lib/dialerLink.ts for the detail):
//
// - iPhone/Android: this device's OWN line is what's being forwarded, so
//   tapping "Activate protection" opens the native Phone app with the
//   code already filled in (Linking.openURL('tel:...')) — no copying or
//   typing. Neither iOS nor Android will place the call itself; the
//   customer must press the green call button themselves, and no
//   permission or native module changes that (see dialerLink.ts). An
//   AppState listener detects the customer returning from the Phone app
//   and auto-advances to verification — no extra tap needed for the
//   "come back here" step the old copy asked for manually.
// - Landline: the code must be dialled from the physical landline
//   handset, a different device entirely from the phone this app runs
//   on. Auto-opening THIS device's dialer here would not just be
//   restricted, it would be wrong — it would silently attempt to forward
//   this device's own mobile line instead. "Activate protection" here
//   does not open a dialer; it means "I've dialled it on my landline
//   phone, check now," and the code stays visible/copyable throughout
//   since referencing it from a second device is genuinely unavoidable.
import { useEffect, useRef, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator, AppState, Linking, Pressable } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { fetchActivationInstructions, ApiError } from "../../lib/api";
import { canAutoOpenDialer, buildDialerUrl } from "../../lib/dialerLink";
import type { ActivationInstructionsResponse, DeviceType, LandlineProvider } from "../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

export default function Activate() {
  const params = useLocalSearchParams<{ deviceType: DeviceType; provider?: LandlineProvider }>();
  const [instructions, setInstructions] = useState<ActivationInstructionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notProvisioned, setNotProvisioned] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [dialerError, setDialerError] = useState(false);

  const canAutoDial = canAutoOpenDialer(params.deviceType);

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

  // Set the moment the dialer is opened, so the AppState listener below
  // knows a return-to-foreground is actually "back from dialling", not
  // just an unrelated app switch (e.g. bringing up the keyboard's app
  // switcher, or a notification banner).
  const dialerOpened = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", nextState => {
      if (nextState === "active" && dialerOpened.current) {
        dialerOpened.current = false;
        router.push("/(setup)/verify");
      }
    });
    return () => subscription.remove();
  }, []);

  function load() {
    const thisLoadId = ++loadId.current;
    setIsLoading(true);
    setError(null);
    setNotProvisioned(false);
    fetchActivationInstructions(params.deviceType, params.provider)
      .then(result => {
        if (thisLoadId !== loadId.current || !isMounted.current) return;
        setInstructions(result);
      })
      .catch(err => {
        if (thisLoadId !== loadId.current || !isMounted.current) return;
        if (err instanceof ApiError && err.code === "not_provisioned") {
          // Still setting up server-side (the household's Twilio number
          // isn't assigned yet) — not an error, just not ready yet. This
          // used to router.replace to /(setup)/welcome, which re-derives
          // its target from resumeSetupAt() — but that function has no
          // concept of "provisioning in progress" and, since activation
          // isn't verified either, always sends the customer straight
          // back to device-picker. Net effect was a silent, unexplained
          // bounce (confirmed live during RC1 staging E2E testing,
          // 2026-08-04) with the customer landing back where they
          // started and no indication anything happened. Showing this
          // state in place, with its own retry, fixes that without
          // touching resumeSetupAt's unrelated logic.
          setNotProvisioned(true);
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

  async function handleActivate() {
    if (!instructions) return;

    if (!canAutoDial) {
      // Landline: nothing to open on this device — the customer has
      // already dialled from their landline phone by the time they tap
      // this, so go straight to verification.
      router.push("/(setup)/verify");
      return;
    }

    setDialerError(false);
    const url = buildDialerUrl(instructions.code);
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        setDialerError(true);
        return;
      }
      dialerOpened.current = true;
      await Linking.openURL(url);
    } catch {
      dialerOpened.current = false;
      setDialerError(true);
    }
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

  if (notProvisioned) {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <BackLink />
        <Text style={styles.title} accessibilityRole="header">Still setting up your line</Text>
        <Text style={styles.explanation}>
          We're finishing the setup on our side before we can show you an activation code. This
          usually only takes a few minutes — please check back shortly.
        </Text>
        <PrimaryButton label="Check again" onPress={load} />
        <PrimaryButton label="Change device" variant="secondary" onPress={() => router.replace("/(setup)/device-picker")} />
      </Screen>
    );
  }

  if (error || !instructions) {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <BackLink />
        <Banner variant="error" message={error || "Something went wrong."} />
        <PrimaryButton label="Try again" onPress={load} />
        <PrimaryButton label="Change device" variant="secondary" onPress={() => router.replace("/(setup)/device-picker")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <SetupProgress currentStep={3} />
      <BackLink />
      <Text style={styles.title} accessibilityRole="header">Turn on call forwarding</Text>
      <Text style={styles.explanation}>
        {canAutoDial
          ? "Tap Activate protection to open your Phone app with the code ready — just press the call button, then come straight back here."
          : "This code needs to be dialled from your landline phone, not this device. Once you've dialled it there and heard the confirmation, come back here and tap Activate protection."}
      </Text>

      <View style={styles.codeBox} accessibilityRole="text" accessibilityLabel={`Your activation code is ${instructions.code}`}>
        <Text style={styles.code} selectable>{instructions.code}</Text>
      </View>
      <Pressable onPress={handleCopy} accessibilityRole="button" style={styles.copyLink}>
        <Text style={styles.copyLinkText}>{copied ? "Copied!" : "Copy code"}</Text>
      </Pressable>

      {instructions.requiresPreliminaryCall && instructions.preliminaryCallNote && (
        <Banner variant="notice" message={instructions.preliminaryCallNote} />
      )}

      {dialerError && (
        <Banner
          variant="error"
          message="We couldn't open your Phone app automatically. Copy the code above and dial it manually, then come back here."
        />
      )}

      {!canAutoDial && (
        <View style={styles.steps}>
          <Text style={styles.step}>1. Go to your landline phone</Text>
          <Text style={styles.step}>2. Dial the code above</Text>
          <Text style={styles.step}>
            3. You may hear a beep or a short recorded message confirming it — that's normal, you can hang up
          </Text>
          <Text style={styles.step}>4. Come back here and tap Activate protection</Text>
        </View>
      )}

      <Banner
        variant="notice"
        message="If you're on the phone with someone helping you, you may need to put them on speaker, or ask them to call you back on another phone while you dial this."
      />

      <PrimaryButton label="Activate protection" onPress={handleActivate} />
    </Screen>
  );
}

function BackLink() {
  return (
    <Pressable
      onPress={() => router.replace("/(setup)/device-picker")}
      accessibilityRole="button"
      style={styles.backLink}
    >
      <Text style={styles.backLinkText}>‹ Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backLink: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    marginLeft: -spacing.sm,
  },
  backLinkText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 15,
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
  steps: {
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  step: {
    ...typography.body,
    color: colors.text,
  },
});
