// A4 — Confirm your email. Per APP_VISUAL_SPECIFICATION.md: no forward
// navigation, waits for the customer to confirm via the emailed link
// (which deep-links back into the app — see app/reset-password.tsx for
// the equivalent recovery-link pattern; confirmation uses Supabase's own
// signup-verification redirect, resolved by onAuthStateChange in
// AuthContext once the customer taps it, which then routes them forward
// automatically via app/index.tsx the next time the app is foregrounded).
import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { resendConfirmationEmail } from "../../lib/api";
import { planResendOutcome, type ResendOutcome } from "../../lib/registrationOutcome";
import { colors, spacing, typography } from "../../lib/theme";

export default function ConfirmEmail() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [outcome, setOutcome] = useState<ResendOutcome | null>(null);
  const [isResending, setIsResending] = useState(false);

  async function handleResend() {
    setIsResending(true);
    setOutcome(null);
    try {
      // The decision of whether there's actually anything to resend (an
      // existing, unconfirmed account) is made server-side — see
      // services/mobileRegistration.js. This used to call
      // supabase.auth.resend() directly and show the same "sent again"
      // notice unconditionally, even when the account was already
      // confirmed and nothing was sent at all.
      const { status } = await resendConfirmationEmail(email);
      setOutcome(planResendOutcome(status));
    } catch {
      setOutcome({
        variant: "error",
        message: "We couldn't process that just now. Please try again.",
        showLoginGuidance: false,
      });
    } finally {
      setIsResending(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>Check your email</Text>
      <Text style={styles.body}>We've sent a confirmation link to {email}.</Text>
      <Text style={styles.caption}>Can't find the email? Check your spam or junk folder.</Text>
      <Text style={styles.caption}>
        If you've already registered this email before, please use the password you originally chose.
      </Text>

      {outcome && <Banner variant={outcome.variant} message={outcome.message} />}

      <PrimaryButton
        label="Resend confirmation email"
        onPress={handleResend}
        loading={isResending}
        variant="secondary"
      />

      <View style={styles.footer}>
        <Link href="/(auth)/login">
          <Text style={styles.footerText}>Already confirmed? Log in</Text>
        </Link>
        <Link href="/(auth)/forgot-password">
          <Text style={styles.footerText}>Forgot your password?</Text>
        </Link>
        <Link href="/(auth)/register">
          <Text style={styles.footerText}>Wrong email address? Start again</Text>
        </Link>
      </View>
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
    marginBottom: spacing.xs,
  },
  caption: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  footer: {
    marginTop: spacing.lg,
    gap: spacing.md,
    alignItems: "center",
  },
  footerText: {
    color: colors.accent,
    fontWeight: "600",
  },
});
