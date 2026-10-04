// Setup steps — the same five steps Home shows while a phone is not yet
// protected, reachable from Home in every state (including once protected).
//
// 1.0.2 terminology reconciliation (2026-10-04): this screen used to render
// a second, differently-worded step list (GET /api/v1/me/dashboard's
// protection.steps — "HCG number active", "Protection Active", …) next to
// Home's canonical checklist ("Membership active", "Call forwarding on", …).
// Two lists for one truth. It now renders exactly Home's list:
// lib/protectionView.ts buildSetupChecklist over the server's canonical
// gates (protectionBlockers), via the shared ProtectionChecklist component.
// Every tick is a server gate; nothing here decides protection. The server's
// protection.steps/guidance stay in the response unchanged for shipped
// 1.0.1 builds.
//
// The one-line summary under the list is describeProtection's server-only
// view (device permissions are checked on Home, as on the setup-complete
// screen), so the wording matches Home's headline.
import { useEffect, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { ProtectionChecklist } from "../../components/ProtectionChecklist";
import { fetchDashboard } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { buildSetupChecklist, describeProtection, type ChecklistStep, type ProtectionHeadline } from "../../lib/protectionView";
import { colors, spacing, typography } from "../../lib/theme";

export default function ProtectionStatus() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(true);
  const [steps, setSteps] = useState<ChecklistStep[] | null>(null);
  const [verdict, setVerdict] = useState<ProtectionHeadline | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  async function load() {
    setLoading(true);
    setLoadFailed(false);
    try {
      const data = await fetchDashboard(session?.access_token);
      const input = {
        protection: data.protection,
        membership: data.membership,
        testPurchase: data.customerAllowance?.membership?.testPurchase === true,
        allowance: data.customerAllowance ?? null,
      };
      setSteps(buildSetupChecklist(input));
      setVerdict(describeProtection(input, { canPresentCalls: true }));
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
          <ActivityIndicator color={colors.accent} size="large" accessibilityLabel="Loading your setup steps" />
        </View>
      </Screen>
    );
  }

  if (loadFailed || !steps) {
    return (
      <Screen>
        <Text style={styles.title} accessibilityRole="header">Setup steps</Text>
        <Banner variant="notice" message="We couldn't check your setup right now. Check your connection and try again." />
        <PrimaryButton label="Try again" onPress={load} />
        <PrimaryButton label="Back to Home" variant="secondary" onPress={() => router.replace("/(tabs)")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text style={styles.title} accessibilityRole="header">Setup steps</Text>
      <ProtectionChecklist steps={steps} />
      {verdict && <Text style={styles.summary}>{verdict.isProtected ? "Every step is done. Your phone is protected." : verdict.body}</Text>}
      <PrimaryButton label="Check again" variant="secondary" onPress={load} />
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
    marginBottom: spacing.lg,
  },
  summary: {
    ...typography.body,
    color: colors.textMuted,
    marginVertical: spacing.lg,
  },
});
