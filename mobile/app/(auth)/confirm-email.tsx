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
import { supabase } from "../../lib/supabase";
import { colors, spacing, typography } from "../../lib/theme";

export default function ConfirmEmail() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [notice, setNotice] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);

  async function handleResend() {
    setIsResending(true);
    setNotice(null);
    try {
      await supabase.auth.resend({ type: "signup", email });
      // Deliberately the same neutral message regardless of the
      // underlying result — matches the web app's hedged, non-
      // enumerating wording rather than confirming or denying delivery.
      setNotice("If this email address has a pending registration, we've sent the confirmation link again.");
    } finally {
      setIsResending(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>Check your email</Text>
      <Text style={styles.body}>We've sent a confirmation link to {email}.</Text>
      <Text style={styles.caption}>Can't find the email? Check your spam or junk folder.</Text>

      {notice && <Banner variant="notice" message={notice} />}

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
