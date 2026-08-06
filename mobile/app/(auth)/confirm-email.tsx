// A4 — Registration outcome. Shown after every registration attempt,
// rendering one of two states depending on what the backend actually
// found (services/registrationRequest.js via lib/api.ts's
// registerAccount/resendConfirmationEmail):
//
// - pending_confirmation (a genuinely new signup, or a resend to an
//   existing unconfirmed email — deliberately identical, anti-
//   enumeration): "Check your email or sign in". Every path off this
//   screen (Sign in, Forgotten password?, Resend) is visible immediately
//   — nobody is left here indefinitely waiting for an email that may
//   never come.
// - already_registered (an existing, CONFIRMED account): "This email may
//   already be registered" — the one outcome where nothing was, or ever
//   will be, sent, so this never claims otherwise.
//
// The "Resend confirmation email" button can itself transition the
// screen from pending_confirmation to already_registered in place (if
// the account turns out to already be confirmed) — it never shows a
// success notice unless Supabase actually accepted a real resend.
import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Link, router, useLocalSearchParams } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { resendConfirmationEmail } from "../../lib/api";
import { outcomeContent, planResendEffect, type RegisterStatus } from "../../lib/registrationOutcome";
import { colors, spacing, typography } from "../../lib/theme";

export default function ConfirmEmail() {
  const { email, status: initialStatus } = useLocalSearchParams<{ email: string; status?: RegisterStatus }>();
  const [status, setStatus] = useState<RegisterStatus>(initialStatus === "already_registered" ? "already_registered" : "pending_confirmation");
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);

  const content = outcomeContent(status);
  const isPending = status === "pending_confirmation";

  async function handleResend() {
    setIsResending(true);
    setNotice(null);
    setResendError(null);
    try {
      const { status: resendStatus } = await resendConfirmationEmail(email);
      const effect = planResendEffect(resendStatus);
      if (effect.kind === "switch_to_already_registered") {
        setStatus("already_registered");
      } else {
        setNotice(effect.message);
      }
    } catch {
      setResendError("We couldn't process that just now. Please try again.");
    } finally {
      setIsResending(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title} accessibilityRole="header">{content.title}</Text>
      {content.paragraphs.map((paragraph, i) => (
        <Text key={i} style={styles.body}>{paragraph}</Text>
      ))}
      {isPending && (
        <Text style={styles.caption}>Can't find the email? Check your spam or junk folder.</Text>
      )}

      {notice && <Banner variant="notice" message={notice} />}
      {resendError && <Banner variant="error" message={resendError} />}

      <PrimaryButton label="Sign in" onPress={() => router.push("/(auth)/login")} />

      {isPending ? (
        <>
          <PrimaryButton
            label="Resend confirmation email"
            onPress={handleResend}
            loading={isResending}
            variant="secondary"
          />
          <View style={styles.footer}>
            <Link href="/(auth)/forgot-password">
              <Text style={styles.footerText}>Forgotten password?</Text>
            </Link>
          </View>
        </>
      ) : (
        <PrimaryButton
          label="Reset password"
          onPress={() => router.push("/(auth)/forgot-password")}
          variant="secondary"
        />
      )}
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
    marginTop: spacing.xs,
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
