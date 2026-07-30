// B1 — Setup welcome. Per APP_VISUAL_SPECIFICATION.md: checks
// entitlement on arrival to skip straight to B3 if already subscribed
// (e.g. a family member completing setup on someone else's already-paid
// account), sets expectations for the short journey ahead otherwise.
import { useEffect, useState } from "react";
import { Text, View, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { fetchDashboard, NotEntitledError } from "../../lib/api";
import { colors, spacing, typography } from "../../lib/theme";

export default function SetupWelcome() {
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    fetchDashboard()
      .then(() => {
        // Already entitled — skip straight past the subscribe step.
        router.replace("/(setup)/device-picker");
      })
      .catch(err => {
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
  }, []);

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
    <Screen>
      <Text style={styles.title}>Let's get you protected — this takes about 5 minutes</Text>

      <View style={styles.steps}>
        <Text style={styles.step}>1. Membership</Text>
        <Text style={styles.step}>2. Activate</Text>
        <Text style={styles.step}>3. Trusted contacts</Text>
      </View>

      <PrimaryButton label="Let's get started" onPress={() => router.push("/(setup)/subscribe")} />
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
  steps: {
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  step: {
    ...typography.body,
    color: colors.textMuted,
  },
});
