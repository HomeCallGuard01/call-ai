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
import { Text, View, StyleSheet, ActivityIndicator, AppState, Linking, Pressable, Animated } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { fetchActivationInstructions, fetchDashboard, ApiError } from "../../lib/api";
import { canAutoOpenDialer, buildDialerUrl } from "../../lib/dialerLink";
import {
  computeProvisioningStages,
  shouldAutoAdvance,
  shouldShowManualRetry,
  provisioningExplanation,
} from "../../lib/provisioningStages";
import type { ActivationInstructionsResponse, DeviceType, LandlineProvider, TwilioProvisioningStatus } from "../../lib/types";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

export default function Activate() {
  const params = useLocalSearchParams<{ deviceType: DeviceType; provider?: LandlineProvider }>();
  const [instructions, setInstructions] = useState<ActivationInstructionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notProvisioned, setNotProvisioned] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [dialerError, setDialerError] = useState(false);
  const [provisioningStatus, setProvisioningStatus] = useState<TwilioProvisioningStatus | null>(null);
  const [pollFailures, setPollFailures] = useState(0);

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

  // Real iPhone testing (2026-08-08) found the old "Still setting up your
  // line" / "Check again" state a dead end — the customer had to manually
  // retry with no real progress shown. While waiting on Twilio number
  // provisioning, poll the dashboard (a genuinely separate, already-
  // existing signal — protection.twilioProvisioningStatus — from the
  // activation-instructions endpoint itself) so the stage list reflects
  // real backend state, and re-run load() the moment the number is ready
  // so the customer advances automatically, with no tap required.
  useEffect(() => {
    if (!notProvisioned) return;

    let cancelled = false;
    let consecutiveFailures = 0;

    async function poll() {
      try {
        const dashboard = await fetchDashboard();
        if (cancelled) return;
        consecutiveFailures = 0;
        setPollFailures(0);
        setProvisioningStatus(dashboard.protection.twilioProvisioningStatus);
        if (shouldAutoAdvance(dashboard.protection.twilioProvisioningStatus)) {
          load();
        }
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        setPollFailures(consecutiveFailures);
      }
    }

    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [notProvisioned]);

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
          <BackToDashboardLink />
        </View>
      </Screen>
    );
  }

  if (notProvisioned) {
    // provisioningStatus is null only for the brief instant before the
    // first poll resolves — treated the same as "pending" (in progress),
    // never as done, so the stage list never shows false confidence.
    // One screen for both waiting and failed/slow (2026-08-08 fix): a
    // real iPhone test found that routing "failed" to a separate screen
    // — stage list gone, only "Change device" left — was itself a dead
    // end, with no path back to the dashboard and no sense of whether to
    // keep waiting. The stage list itself doesn't change for a failed
    // status (computeProvisioningStages never marks the blocked stage
    // "done" either way) — only the headline explanation adapts.
    const stages = computeProvisioningStages(provisioningStatus ?? "pending");
    const pollingBroken = shouldShowManualRetry(pollFailures);

    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <BackLink />
        <BackToDashboardLink />
        <Text style={styles.title} accessibilityRole="header">Setting up your Home Call Guard protection</Text>
        <Text style={styles.explanation}>{provisioningExplanation(provisioningStatus)}</Text>

        <View style={styles.stageList}>
          {stages.map(stage => (
            <ProvisioningStageRow key={stage.key} label={stage.label} state={stage.state} />
          ))}
        </View>

        {pollingBroken && (
          <>
            <Banner
              variant="error"
              message="We're having trouble checking your setup progress. Check your connection and try again."
            />
            <PrimaryButton label="Check again" onPress={load} />
          </>
        )}

        <PrimaryButton label="Change device" variant="secondary" onPress={() => router.replace("/(setup)/device-picker")} />
      </Screen>
    );
  }

  if (error || !instructions) {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <BackLink />
        <BackToDashboardLink />
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
      <BackToDashboardLink />
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

// A real iPhone test (2026-08-08) found no way off this screen back to
// the dashboard at all — "Change device" only returns to the device
// picker, still mid-setup. Shown on every state of this screen (loading,
// waiting/failed, error, ready) so the customer is never stuck here.
function BackToDashboardLink() {
  return (
    <Pressable
      onPress={() => router.replace("/(tabs)")}
      accessibilityRole="button"
      style={styles.dashboardLink}
    >
      <Text style={styles.dashboardLinkText}>Back to dashboard</Text>
    </Pressable>
  );
}

const STAGE_ICON: Record<string, string> = { done: "✓", in_progress: "⏳", pending: "○" };

function ProvisioningStageRow({ label, state }: { label: string; state: "done" | "in_progress" | "pending" }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (state !== "in_progress") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [state, pulse]);

  return (
    <View style={styles.stageRow}>
      <Animated.Text
        style={[
          styles.stageIcon,
          state === "done" && styles.stageIconDone,
          state === "in_progress" && { opacity: pulse },
        ]}
        accessibilityElementsHidden
      >
        {STAGE_ICON[state]}
      </Animated.Text>
      <Text style={[styles.stageLabel, state === "pending" && styles.stageLabelPending]}>{label}</Text>
    </View>
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
  dashboardLink: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  dashboardLinkText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 15,
    textDecorationLine: "underline",
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
  stageList: {
    marginBottom: spacing.lg,
  },
  stageRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  stageIcon: {
    width: 28,
    fontSize: 17,
    color: colors.textMuted,
  },
  stageIconDone: {
    color: colors.accent,
  },
  stageLabel: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  stageLabelPending: {
    color: colors.textMuted,
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
