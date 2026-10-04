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
// guarantee). 2026-09-30: the price note no longer states an amount (the
// customer has just seen the real one on Subscribe / the payment sheet).
//
// Onboarding-verification UX change (2026-09-23): this is now the
// terminal screen of setup on every path (activate.tsx no longer routes
// through a mandatory verify gate first — see its own comments). Records
// the local "setup completed" timestamp (lib/setupCompletionStorage.ts)
// that resumeSetupAt and the Home tab's reminder both read.
//
// Manual-test-call UX removed (2026-09-25): this screen used to also
// offer a clearly-secondary optional link to verify.tsx, inviting the
// customer to place a real test call and then re-check manually. A
// physical Build 18 walkthrough found that even as an optional link,
// its presence and wording ("calling your normal mobile number from
// another phone") reads as something the customer is meant to do —
// contradicting the product's actual, already-built passive model:
// activation_verified_at/delivery_verified_at are both stamped
// automatically, with zero customer action, by the first genuine
// forwarded call reaching /voice (services/activationVerification.js's
// stampActivationVerifiedOnRealCall, and the equivalent delivery-verified
// stamping) — nothing here needs a customer-initiated test call at all.
// verify.tsx itself is preserved (POST /api/v1/activation/verify is
// unchanged and still real), just no longer linked from the normal
// customer journey. See mobile/app/(tabs)/index.tsx for the same removal
// on the Home tab's own optional links.
import { useEffect, useState } from "react";
import { Text, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { fetchDashboard } from "../../lib/api";
import { useAuth } from "../../lib/AuthContext";
import { markSetupCompleted } from "../../lib/setupCompletionStorage";
import { buildSetupChecklist, describeProtection, type ChecklistStep, type ProtectionHeadline } from "../../lib/protectionView";
import { ProtectionChecklist } from "../../components/ProtectionChecklist";
import { colors, spacing, typography } from "../../lib/theme";

export default function SetupComplete() {
  const { session } = useAuth();
  const [contactCount, setContactCount] = useState<number | null>(null);
  // 1.0.2: the server's verdict and setup gates, read once here so the end of
  // setup shows what is actually confirmed — never "nothing else to do"
  // unless the server agrees (the September incident ended exactly here:
  // forwarding done, app never registered, customer told all was well).
  const [steps, setSteps] = useState<ChecklistStep[] | null>(null);
  const [verdict, setVerdict] = useState<ProtectionHeadline | null>(null);
  const [loaded, setLoaded] = useState(false);

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
        if (!isMounted) return;
        setContactCount(data.contacts.length);
        const input = {
          protection: data.protection,
          membership: data.membership,
          testPurchase: data.customerAllowance?.membership?.testPurchase === true,
          allowance: data.customerAllowance ?? null,
        };
        setSteps(buildSetupChecklist(input));
        // Device permissions are checked on Home; here only the server's view.
        setVerdict(describeProtection(input, { canPresentCalls: true }));
      })
      .catch(() => {
        if (isMounted) setContactCount(null);
      })
      .finally(() => {
        if (isMounted) setLoaded(true);
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
      <Text style={styles.title} accessibilityRole="header">
        {verdict?.isProtected ? "Your phone is protected" : "Your setup steps are done"}
      </Text>
      <Text style={styles.body}>
        {verdict?.isProtected
          ? "Home Call Guard has confirmed every step. Your Home screen shows your status any time."
          : verdict?.tone === "attention"
            ? verdict.body
            : "Home Call Guard confirms each step as it happens. Your Home screen shows what's confirmed, and tells you straight away if anything needs your attention."}
      </Text>
      {!loaded ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} accessibilityLabel="Checking your setup" />
      ) : (
        steps && !verdict?.isProtected && verdict?.tone !== "unknown" && <ProtectionChecklist steps={steps} />
      )}
      <Text style={styles.body}>{contactsLine}</Text>
      <Text style={styles.priceNote}>Your membership renews monthly. You can cancel anytime.</Text>
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
  loading: {
    marginBottom: spacing.lg,
  },
  priceNote: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
});
