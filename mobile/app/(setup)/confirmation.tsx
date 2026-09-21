// NEW — post-payment confirmation. Sits between B2 (Subscribe) and the
// trusted-contacts step. Payment on a mobile app, on its own, is an
// abrupt moment — the browser closes and you're just... back in the
// app. This screen exists specifically to answer "did that actually
// work, and what happens now" before handing off to the next task,
// rather than silently continuing straight into contact-picking with no
// acknowledgement that the signup just succeeded.
//
// Founding Member / 12-month price-lock framing removed 2026-08-29 (App
// Store release, matches subscribe.tsx) — this screen must not reintroduce
// a claim just removed one screen earlier.
// 2026-09-21: the "30-day money-back guarantee" sentence (and its Apple-refund
// platform branch) was REMOVED and is deliberately not replaced by any other
// refund or guarantee promise (see subscribe.tsx).
import { Text, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { colors, spacing, typography } from "../../lib/theme";

export default function Confirmation() {
  return (
    <Screen scroll={false} brand>
      <View style={styles.container}>
        <View style={styles.badge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={styles.badgeIcon}>✓</Text>
        </View>

        <Text style={styles.title} accessibilityRole="header">You're covered</Text>
        <Text style={styles.body}>Welcome to Home Call Guard — your protection starts now.</Text>

        <View style={styles.nextBox}>
          <Text style={styles.nextLabel}>Next</Text>
          <Text style={styles.nextText}>
            Add the people who should always ring straight through — takes about 10 seconds.
          </Text>
        </View>

        <PrimaryButton label="Continue" onPress={() => router.replace("/(setup)/contacts")} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accentMuted,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: spacing.lg,
  },
  badgeIcon: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: "800",
  },
  title: {
    ...typography.hero,
    color: colors.text,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
    marginBottom: spacing.xl,
  },
  nextBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: spacing.md,
    marginBottom: spacing.xl,
  },
  nextLabel: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: "700",
    marginBottom: spacing.xs,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  nextText: {
    ...typography.body,
    color: colors.text,
  },
});
