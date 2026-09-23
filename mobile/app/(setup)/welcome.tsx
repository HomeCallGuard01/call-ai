// B1 — Setup welcome. Checks real account state on arrival and skips
// straight to wherever setup actually left off — not just "already
// subscribed", but the exact next step (lib/setupFlow.ts's
// resumeSetupAt), so a family member finishing setup on someone else's
// already-paid, already-has-contacts account lands on activation
// directly, not back at the start.
import { useEffect, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { resumeSetupAt } from "../../lib/setupFlow";
import { hasProvenActivation } from "../../lib/homeStatus";
import { loadSetupCompletedAt } from "../../lib/setupCompletionStorage";
import { colors, radius, spacing, typography } from "../../lib/theme";

const RESUME_ROUTE: Record<string, string> = {
  subscribe: "/(setup)/subscribe",
  contacts: "/(setup)/contacts",
  "device-picker": "/(setup)/device-picker",
  complete: "/(setup)/complete",
};

export default function SetupWelcome() {
  const { session } = useAuth();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    let isMounted = true;

    // Onboarding-verification UX change (2026-09-23): also load the
    // local "setup completed" flag alongside the dashboard fetch, so a
    // customer who has completed activation but isn't verified yet
    // resumes at "complete", not back at device-picker — see
    // resumeSetupAt's own comment for the bug this fixes.
    Promise.all([fetchDashboard(session?.access_token), loadSetupCompletedAt()])
      .then(([data, setupCompletedAt]) => {
        if (!isMounted) return;
        const target = resumeSetupAt({
          isEntitled: true,
          contactCount: data.contacts.length,
          isActivationProven: hasProvenActivation(data),
          hasCompletedActivationStep: !!setupCompletedAt,
        });
        if (target.screen === "subscribe") {
          // Shouldn't happen (fetchDashboard succeeded, so entitlement
          // exists) — fall through to showing this screen normally.
          setIsChecking(false);
          return;
        }
        router.replace(RESUME_ROUTE[target.screen] as any);
      })
      .catch(err => {
        if (!isMounted) return;
        if (err instanceof NotEntitledError) {
          setIsChecking(false);
          return;
        }
        // Any other error: still let the customer proceed to the
        // subscribe screen rather than stranding them on a spinner —
        // B2 itself will surface a real error if something is
        // genuinely wrong with the account.
        setIsChecking(false);
      });

    return () => {
      isMounted = false;
    };
  }, [session?.access_token]);

  if (isChecking) {
    return (
      <Screen scroll={false}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      </Screen>
    );
  }

  return (
    <Screen brand>
      <Text style={styles.title} accessibilityRole="header">Let's get you protected — in just a few clicks</Text>
      <Text style={styles.subtitle}>Three quick steps:</Text>

      <View style={styles.steps}>
        <Step number={1} label="Membership" detail="£4.99/month including VAT" />
        <Step number={2} label="Trusted contacts" detail="So family and friends always ring straight through" />
        <Step number={3} label="Activate" detail="Turn on call forwarding — we'll confirm it's working" />
      </View>

      {/* device-picker (device + carrier/tariff check) now runs before
          Subscribe, not after — carrier compatibility must be established
          before payment. A NotEntitledError above means this customer has
          no active subscription yet, so their carrier hasn't been
          captured either; start there rather than at Subscribe. */}
      <PrimaryButton label="Let's get started" onPress={() => router.push("/(setup)/device-picker")} />
    </Screen>
  );
}

function Step({ number, label, detail }: { number: number; label: string; detail: string }) {
  return (
    <View style={styles.step} accessibilityRole="text" accessibilityLabel={`Step ${number}: ${label}. ${detail}`}>
      <View style={styles.stepNumber}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <View style={styles.stepText}>
        <Text style={styles.stepLabel}>{label}</Text>
        <Text style={styles.stepDetail}>{detail}</Text>
      </View>
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
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  steps: {
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  step: {
    flexDirection: "row",
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentDeep,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepNumberText: {
    color: colors.accent,
    fontWeight: "700",
    fontSize: 14,
  },
  stepText: {
    flex: 1,
  },
  stepLabel: {
    ...typography.body,
    color: colors.text,
    fontWeight: "700",
  },
  stepDetail: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
});
