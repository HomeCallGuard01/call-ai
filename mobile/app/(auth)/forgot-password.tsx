// A6 — Forgot password. Per APP_VISUAL_SPECIFICATION.md: inline
// confirmation on the same screen, deliberately hedged wording (never
// reveals whether the email exists).
import { useState } from "react";
import { Text, StyleSheet, View } from "react-native";
import { Link, router } from "expo-router";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { supabase } from "../../lib/supabase";
import { colors, spacing, typography } from "../../lib/theme";

// Must match app.json's "scheme" — this is the deep link Supabase will
// redirect to after the customer taps the emailed recovery link,
// landing on app/reset-password.tsx (A7).
const RESET_PASSWORD_REDIRECT_URL = "homecallguard://reset-password";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    setIsSubmitting(true);
    try {
      await supabase.auth.resetPasswordForEmail(email, { redirectTo: RESET_PASSWORD_REDIRECT_URL });
      setNotice("If that email is registered, we've sent a reset link.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>Reset your password</Text>

      {notice && <Banner variant="notice" message={notice} />}

      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
      />

      <PrimaryButton label="Send reset link" onPress={handleSubmit} loading={isSubmitting} />

      <View style={styles.footer}>
        <Link href="/(auth)/login" onPress={() => router.back()}>
          <Text style={styles.footerText}>Back to login</Text>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  footer: {
    marginTop: spacing.lg,
    alignItems: "center",
  },
  footerText: {
    color: colors.accent,
    fontWeight: "600",
  },
});
