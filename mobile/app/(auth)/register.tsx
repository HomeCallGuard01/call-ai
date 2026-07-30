// A3 — Register. Per APP_VISUAL_SPECIFICATION.md: same field set as the
// web form (email, password, confirm), same client-side validation copy,
// footer link to login always visible (never conditional — the
// anti-enumeration design this engagement fixed on web must not be
// silently reintroduced on a second client).
import { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Link, router } from "expo-router";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { supabase } from "../../lib/supabase";
import { colors, spacing, typography } from "../../lib/theme";

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);

    if (!email || !password) {
      setError("Please enter a valid email and password.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match. Please try again.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Supabase's own signUp() behaviour (documented, not a bug in this
      // app — see the web fix, services/registrationFlow.js) already
      // handles the repeat-registration case safely: calling this again
      // for an unconfirmed email resends confirmation without
      // overwriting the original password, and never reveals whether an
      // account already existed. No extra logic needed here to match
      // that — it's inherent to calling the same Supabase API the fixed
      // web flow relies on.
      const { error: signUpError } = await supabase.auth.signUp({ email, password });

      if (signUpError) {
        setError("We couldn't create your account. Please check your details and try again.");
        return;
      }

      router.push({ pathname: "/(auth)/confirm-email", params: { email } });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>Create your account</Text>

      {error && <Banner variant="error" message={error} />}

      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        isPassword
        textContentType="newPassword"
        autoComplete="new-password"
      />
      <TextField
        label="Confirm password"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        isPassword
        textContentType="newPassword"
        autoComplete="new-password"
      />

      <PrimaryButton label="Create account" onPress={handleSubmit} loading={isSubmitting} />

      <View style={styles.footer}>
        <Link href="/(auth)/login">
          <Text style={styles.footerText}>Already have an account? Log in</Text>
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
