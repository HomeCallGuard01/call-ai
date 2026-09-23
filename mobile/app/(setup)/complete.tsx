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
// 2026-09-21 copy correction: the 30-day money-back guarantee line was
// removed from this screen (and is deliberately NOT replaced by any other
// guarantee); the price note now states that £4.99 includes VAT.
//
// Onboarding-verification UX change (2026-09-23): this is now the
// terminal screen of setup on every path (activate.tsx no longer routes
// through a mandatory verify gate first — see its own comments). Records
// the local "setup completed" timestamp (lib/setupCompletionStorage.ts)
// that resumeSetupAt and the Home tab's reminder both read, and offers
// the real activation check as a clearly secondary, optional action
// rather than a blocking step. Reusing verify.tsx for that action, not a
// new screen — same endpoint, same mechanism, just no longer mandatory.
import { useEffect, useRef, useState } from "react";
import { Text, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { fetchDashboard } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { markSetupCompleted } from "../../lib/setupCompletionStorage";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

export default function SetupComplete() {
  const { session } = useAuth();
  const [contactCount, setContactCount] = useState<number | null>(null);

  useEffect(() => {
    // Fire-and-forget, best-effort — see markSetupCompleted's own
    // comment. Runs every time this screen is reached (e.g. "Change
    // device" -> redo activation -> complete again); the function itself
    // is write-once, so this never pushes the reminder clock out for a
    // household that has genuinely been unverified since its first
    // completion.
    markSetupCompleted();

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
    <Screen brand>
      {/* 2026-09-07 correction: this screen used to unconditionally claim
          "You're protected" the moment call forwarding was verified — the
          exact false-assurance gap this change series exists to close
          (see lib/homeStatus.ts's computeHomeProtectionState, which the
          Home tab now uses instead of an unconditional claim). This
          screen has no live dashboard-derived protection state of its
          own to check (it only fetches contactCount above), so rather
          than duplicate that logic here, it now describes what's
          concretely true — forwarding is active — and points to the Home
          tab for the real, evidence-based status.
          2026-09-23: replaces the old one-line "check the Home tab" with
          the approved explicit explanation of what happens next and why
          no further action is required. */}
      <Text style={styles.title} accessibilityRole="header">Home Call Guard is set up</Text>
      <Text style={styles.body}>
        We'll confirm your protection automatically when your first forwarded call reaches Home Call Guard — you
        don't need to do anything else. Check the Home tab any time to see your current status.
      </Text>
      <Text style={styles.body}>{contactsLine}</Text>
      <Text style={styles.priceNote}>£4.99 per month including VAT, cancel anytime.</Text>
      <PrimaryButton label="Go to my dashboard" onPress={() => router.replace("/(tabs)")} />

      {/* Clearly secondary, optional — never a requirement to proceed.
          Reuses the existing activation-verification screen/endpoint. */}
      <Pressable
        onPress={() => router.push("/(setup)/verify")}
        accessibilityRole="button"
        style={styles.secondaryLink}
      >
        <Text style={styles.secondaryLinkText}>Test my protection now (optional)</Text>
      </Pressable>
      <Text style={styles.secondaryDetail}>
        This involves calling your normal mobile number from another phone — not your Home Call Guard number.
      </Text>
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
  priceNote: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  secondaryLink: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    alignSelf: "center",
    marginTop: spacing.lg,
  },
  secondaryLinkText: {
    color: colors.accent,
    fontWeight: "600",
    fontSize: 15,
    textDecorationLine: "underline",
  },
  secondaryDetail: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: spacing.xs,
  },
});
