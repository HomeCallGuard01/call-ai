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

// Redirects to the same real HTTPS page the web app already uses
// (public/reset-password.html, server.js's own resetPasswordForEmail
// call), NOT the app's own homecallguard:// custom scheme directly.
// A raw custom-scheme link opened anywhere other than this exact
// installed app (Mail/Safari on a Mac, a different device, the app not
// installed) produces "Safari cannot open the page because the address
// is invalid" — a real customer-facing dead end found during physical
// Android testing (docs/operations/HANDOVER_2026-08-15.md §20.7). This
// HTTPS page always opens in any browser, on any device, and itself
// attempts a silent handoff into the app on mobile — falling back to
// completing the reset directly in the browser (already fully working)
// if that handoff doesn't happen. See reset-password.html's own comment
// for the handoff mechanism.
const RESET_PASSWORD_REDIRECT_URL = `${process.env.EXPO_PUBLIC_API_BASE_URL}/reset-password.html`;

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
