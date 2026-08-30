// B5 — Connecting Home Call Guard. Replaces the old second-phone
// verification screen (app/(setup)/verify.tsx — deliberately left intact
// but no longer reachable from the normal flow, same rollback-path
// convention server.js's /process route already uses) per Andrew's
// 2026-08-30 product decision: a customer should never need a second
// phone, or to press "Try again" against a real inbound call, just to
// activate protection.
//
// What this screen actually proves, and what it deliberately does not:
// it confirms this device's Twilio Voice SDK client has genuinely
// registered and is currently reachable
// (services/callRouting.js's isVoiceClientReachable, call-ai backend,
// migration 030) — the same fact dialHouseholdOrFailClosed now requires
// before ever delivering an approved call to this device. It does NOT
// independently re-prove carrier-side call forwarding is active (the old
// verify.tsx's actual check, via a real inbound call within a time
// window) — that remains a separate, real fact this screen cannot
// observe. Gating the onboarding celebration on Voice SDK reachability
// specifically, rather than on a forwarded call having been proven, is a
// deliberate, informed product decision, not an oversight.
//
// The green/confirmed state is never shown for any reason other than a
// genuine, polled-and-confirmed backend signal — never on a button press,
// a timer, or simply returning to this screen. shouldShowManualRecovery
// (lib/voiceConnectionStatus.ts) is the one legitimate way out of
// "connecting" without confirmation: a real recovery option (retry,
// contact support), never a silent bypass to the green state, and never
// the second-phone test reintroduced as the normal recovery mechanism.
import { useEffect, useRef, useState } from "react";
import { Text, View, StyleSheet, Image, Animated } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { fetchDashboard } from "../../lib/api";
import { registerForIncomingCalls } from "../../lib/voiceClient";
import { useAuth } from "../../lib/AuthContext";
import { shouldShowManualRecovery, POLL_INTERVAL_MS } from "../../lib/voiceConnectionStatus";
import type { VoiceConnectionState } from "../../lib/voiceConnectionStatus";
import { colors, spacing, typography } from "../../lib/theme";

const SHIELD_SIZE = 132;
// How long the confirmed/green state is shown before auto-continuing —
// long enough to actually be perceived as a real confirmation, not an
// instant redirect that reads as nothing happened.
const CONFIRMED_PAUSE_MS = 1200;

export default function Connecting() {
  const { session } = useAuth();
  const [phase, setPhase] = useState<VoiceConnectionState>("connecting");
  const [retryKey, setRetryKey] = useState(0);

  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    // Kick off registration right here, rather than waiting for
    // (tabs)/_layout.tsx's own mount effect — that effect still exists
    // and is harmless to run again later (registerForIncomingCalls is a
    // no-op once already registered), but without this call, nothing
    // would ever make protection.voiceClientReachable become true while
    // the customer is still on this screen.
    registerForIncomingCalls(session?.access_token).catch((err) => {
      console.error("VOICE CONNECTING: registration attempt failed", err);
      // Not fatal by itself — the poll below is the actual source of
      // truth, and voiceClient.ts's own AppState/refresh handling may
      // still succeed on a subsequent internal retry.
    });

    async function poll() {
      if (cancelled) return;
      try {
        const dashboard = await fetchDashboard(session?.access_token);
        if (cancelled) return;
        consecutiveFailures = 0;
        if (dashboard.protection.voiceClientReachable) {
          if (isMounted.current) setPhase("confirmed");
          return;
        }
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
      }

      if (shouldShowManualRecovery(consecutiveFailures, Date.now() - startedAt)) {
        if (isMounted.current) setPhase("unreachable");
        return;
      }

      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session?.access_token, retryKey]);

  // Auto-continue once confirmed — never immediately, so the green state
  // is actually perceived rather than reading as an instant redirect.
  useEffect(() => {
    if (phase !== "confirmed") return;
    const timer = setTimeout(() => {
      if (isMounted.current) router.replace("/(setup)/complete");
    }, CONFIRMED_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  function handleRetry() {
    setPhase("connecting");
    setRetryKey((k) => k + 1);
  }

  if (phase === "unreachable") {
    return (
      <Screen>
        <SetupProgress currentStep={3} />
        <PulsingShield phase={phase} />
        <Text style={styles.title} accessibilityRole="header">Still connecting…</Text>
        <Text style={styles.body}>
          This is taking longer than expected. Make sure you have a working internet connection, then try again.
        </Text>
        <Banner
          variant="notice"
          message="Your call forwarding is already set up — this step just confirms Home Call Guard can reach this device."
        />
        <PrimaryButton label="Try again" onPress={handleRetry} />
        <PrimaryButton
          label="Contact support"
          variant="secondary"
          onPress={() => router.push("/(tabs)/account/support")}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      <View style={styles.centered}>
        <PulsingShield phase={phase} />
        <Text style={styles.title} accessibilityRole="header">
          {phase === "confirmed" ? "Home Call Guard is active" : "Connecting Home Call Guard…"}
        </Text>
      </View>
    </Screen>
  );
}

function PulsingShield({ phase }: { phase: VoiceConnectionState }) {
  const confirmed = phase === "confirmed";
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (confirmed) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [confirmed, pulse]);

  return (
    <View style={styles.shieldWrap}>
      <Animated.View
        style={[
          styles.shieldGlow,
          confirmed ? styles.shieldGlowActive : styles.shieldGlowConnecting,
          !confirmed && { opacity: pulse },
        ]}
      >
        <Image source={require("../../assets/shield-mark.png")} style={styles.shieldImage} resizeMode="contain" />
      </Animated.View>
    </View>
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
    textAlign: "center",
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  body: {
    ...typography.body,
    color: colors.text,
    marginBottom: spacing.md,
  },
  shieldWrap: {
    alignItems: "center",
  },
  shieldGlow: {
    width: SHIELD_SIZE + 48,
    height: SHIELD_SIZE + 48,
    borderRadius: (SHIELD_SIZE + 48) / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  shieldGlowConnecting: {
    backgroundColor: colors.card,
  },
  shieldGlowActive: {
    backgroundColor: colors.accentMuted,
  },
  shieldImage: {
    width: SHIELD_SIZE,
    height: SHIELD_SIZE,
  },
});
