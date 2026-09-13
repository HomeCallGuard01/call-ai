// A7 — Reset password. Reached via the emailed recovery deep link
// (homecallguard://reset-password#access_token=...&refresh_token=...),
// which Supabase's PKCE/recovery flow attaches as a URL fragment — Expo
// Router surfaces this as local search params once the OS hands the
// link to the app. On success, calling AuthContext's onAuthStateChange
// (PASSWORD_RECOVERY event) already triggers household bootstrap
// automatically (see lib/AuthContext.tsx) — this screen only needs to
// set the new password and then navigate on, matching the corrected,
// now-accurate web copy from this engagement's own fix: the customer
// really is signed in at this point, so routing straight into the app
// is honest, not presumptive.
import { useState } from "react";
import { Text, StyleSheet } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Screen } from "../components/Screen";
import { TextField } from "../components/TextField";
import { PrimaryButton } from "../components/PrimaryButton";
import { Banner } from "../components/Banner";
import { supabase } from "../lib/supabase";
import { colors, spacing, typography } from "../lib/theme";

export default function ResetPassword() {
  const params = useLocalSearchParams<{ access_token?: string; refresh_token?: string }>();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);

  const hasValidLink = !!params.access_token && !!params.refresh_token;

  async function handleSubmit() {
    setError(null);

    if (newPassword.length < 8) {
      setError("Your new password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match. Please try again.");
      return;
    }

    setIsSubmitting(true);
    try {
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: params.access_token!,
        refresh_token: params.refresh_token!,
      });

      if (sessionError) {
        setError("This reset link is invalid or has expired.");
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });

      if (updateError) {
        if (updateError.message.toLowerCase().includes("same")) {
          setError("You have used this password already. Please choose a different password.");
        } else {
          setError("We couldn't reset your password. Please try again.");
        }
        return;
      }

      setIsDone(true);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!hasValidLink) {
    return (
      <Screen>
        <Text style={styles.title}>Link invalid</Text>
        <Banner variant="error" message="This reset link is missing or invalid. Please request a new one." />
        <PrimaryButton label="Back to login" onPress={() => router.replace("/(auth)/login")} />
      </Screen>
    );
  }

  if (isDone) {
    return (
      <Screen>
        <Text style={styles.title}>Password updated successfully</Text>
        <Text style={styles.body}>Your password has been changed and you're now signed in.</Text>
        <PrimaryButton label="Continue to Dashboard" onPress={() => router.replace("/(tabs)")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Text style={styles.title}>Set a new password</Text>

      {error && <Banner variant="error" message={error} />}

      <TextField
        label="New password"
        value={newPassword}
        onChangeText={setNewPassword}
        isPassword
        textContentType="newPassword"
        autoComplete="new-password"
      />
      <TextField
        label="Confirm new password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        isPassword
        textContentType="newPassword"
        autoComplete="new-password"
      />

      <PrimaryButton label="Set new password" onPress={handleSubmit} loading={isSubmitting} />
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
    marginBottom: spacing.lg,
  },
});
