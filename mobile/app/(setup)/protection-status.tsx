// Protection status — the 5-step checklist explaining, in plain
// language, how far HCG protection has actually got for this household:
// HCG number active -> Call forwarding detected -> Home Call Guard app
// ready -> Call delivery confirmed -> Protection Active. Reachable from
// Home (and, for a not-yet-fully-protected household, from the setup
// flow) whenever someone wants more detail than the single Home-tab
// headline gives.
//
// Every step and the one guidance message below it come directly from
// GET /api/v1/me/dashboard's protection.steps/protection.guidance
// (services/customerProtectionSteps.js) — a pure presentation layer over
// the exact same deliveryReady/endToEndDeliveryVerified/fullyProtected
// fields the Home tab already uses for "You're protected". This screen
// introduces no new verification logic and no new backend call: it reads
// the same dashboard response Home already fetches.
//
// Critical rule (2026-09-27, explicit instruction): "Protection Active"
// can only ever show as done when protection.fullyProtected is true —
// never merely because a forwarded call reached the HCG backend. This
// screen enforces nothing itself; it simply renders exactly what the
// server already computed, so the guarantee lives in
// services/customerProtectionSteps.js, not duplicated here.
//
// Deliberately no jargon anywhere on this screen: every label is the
// server-supplied customer-safe copy (protection.steps[].label), and the
// guidance message is the same wording already reviewed and shipped on
// the Home tab's confirming_delivery/reconnect_needed states — nothing
// invented here.
import { useEffect, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { fetchDashboard } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { colors, spacing, typography, radius } from "../../lib/theme";
import type { ProtectionStep, ProtectionGuidance } from "../../lib/types";

export default function ProtectionStatus() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [steps, setSteps] = useState<ProtectionStep[] | null>(null);
  const [guidance, setGuidance] = useState<ProtectionGuidance | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  async function load() {
    setLoading(true);
    setLoadFailed(false);
    try {
      const data = await fetchDashboard(session?.access_token);
      setSteps(data.protection.steps);
      setGuidance(data.protection.guidance);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Loading your protection status" />
        </View>
      </Screen>
    );
  }

  if (loadFailed || !steps) {
    return (
      <Screen>
        <Text style={styles.title} accessibilityRole="header">Protection status</Text>
        <Banner variant="notice" message="We couldn't load your protection status right now. Check your connection and try again." />
        <PrimaryButton label="Try again" onPress={load} />
        <PrimaryButton label="Back to Home" variant="secondary" onPress={() => router.replace("/(tabs)")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text style={styles.title} accessibilityRole="header">Protection status</Text>
      <Text style={styles.intro}>Here's exactly how your protection is set up, step by step.</Text>

      <View style={styles.list}>
        {steps.map((step, index) => (
          <View key={step.key} style={styles.row}>
            <View style={[styles.badge, step.done ? styles.badgeDone : styles.badgePending]}>
              {step.done ? (
                <Ionicons name="checkmark" size={18} color={colors.accent} accessibilityElementsHidden importantForAccessibility="no" />
              ) : (
                <Text style={styles.badgeNumber}>{index + 1}</Text>
              )}
            </View>
            <Text style={[styles.stepLabel, step.done ? styles.stepLabelDone : styles.stepLabelPending]}>{step.label}</Text>
          </View>
        ))}
      </View>

      {guidance && (
        <Banner variant="notice" message={guidance.message} />
      )}

      <PrimaryButton label="Refresh" variant="secondary" onPress={load} />
      <PrimaryButton label="Back to Home" variant="secondary" onPress={() => router.replace("/(tabs)")} />
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
  intro: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  list: {
    marginBottom: spacing.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  badge: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeDone: {
    backgroundColor: colors.accentSoft,
  },
  badgePending: {
    backgroundColor: colors.neutralSoft,
  },
  badgeNumber: {
    ...typography.body,
    fontWeight: "600",
    color: colors.textMuted,
  },
  stepLabel: {
    ...typography.body,
    flex: 1,
  },
  stepLabelDone: {
    color: colors.text,
    fontWeight: "600",
  },
  stepLabelPending: {
    color: colors.textMuted,
  },
});
