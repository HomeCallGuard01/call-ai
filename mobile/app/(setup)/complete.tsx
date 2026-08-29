// B9 — Setup complete. The emotional payoff of onboarding, deliberately
// unhurried. Reflects the real state reached by this point: contacts are
// now added earlier in the flow (not deferred to "any time from the
// Contacts tab" as the previous copy assumed), so this screen celebrates
// the actual count rather than describing a step that hasn't happened
// yet. Falls back gracefully to generic copy if the dashboard fetch
// fails here — this is a celebration screen, not somewhere that should
// ever show an error state.
//
// Founding Member / 12-month price-lock framing removed 2026-08-29 (App
// Store release, matches subscribe.tsx/confirmation.tsx) — same reason:
// must not reintroduce a claim already removed earlier in the same flow.
// The guarantee line is platform-aware because Apple, not Home Call
// Guard, issues App Store refunds.
import { useEffect, useRef, useState } from "react";
import { Text, StyleSheet, Platform } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { fetchDashboard } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { colors, spacing, typography } from "../../lib/theme";

export default function SetupComplete() {
  const { session } = useAuth();
  const [contactCount, setContactCount] = useState<number | null>(null);

  useEffect(() => {
    let isMounted = true;
    fetchDashboard(session?.access_token)
      .then(data => {
        if (isMounted) setContactCount(data.contacts.length);
      })
      .catch(() => {
        if (isMounted) setContactCount(null);
      });
    return () => {
      isMounted = false;
    };
  }, [session?.access_token]);

  const contactsLine =
    contactCount === null
      ? "Add trusted contacts any time from the Contacts tab — family and friends on that list always ring straight through."
      : contactCount === 0
        ? "You haven't added a trusted contact yet — do it any time from the Contacts tab, so family and friends always ring straight through."
        : `${contactCount} trusted contact${contactCount === 1 ? "" : "s"} added — they'll always ring straight through, never screened.`;

  return (
    <Screen>
      <Text style={styles.title} accessibilityRole="header">You're protected</Text>
      <Text style={styles.body}>Home Call Guard is now screening unknown callers.</Text>
      <Text style={styles.body}>{contactsLine}</Text>
      <Text style={styles.guaranteeNote}>
        {Platform.OS === "ios"
          ? "£4.99 per month, cancel anytime. Covered by our 30-day money-back guarantee — Apple handles " +
            "App Store refund requests directly."
          : "£4.99 per month, cancel anytime. Covered by our 30-day money-back guarantee."}
      </Text>
      <PrimaryButton label="Go to my dashboard" onPress={() => router.replace("/(tabs)")} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.md,
  },
  body: {
    ...typography.body,
    color: colors.text,
    marginBottom: spacing.md,
  },
  guaranteeNote: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
});
