// A5 — Login. Per APP_VISUAL_SPECIFICATION.md: on success, routing to
// the setup flow (B1) vs. straight into the app ((tabs)) is decided by
// whether a household/subscription already exists — app/(tabs)/index.tsx
// (C1) itself checks this via GET /api/v1/me/dashboard and redirects
// into (setup) if needed, so login only needs to succeed and hand off;
// it doesn't need to know setup state itself.
import { useState } from "react";
import { Text, StyleSheet, View } from "react-native";
import { Link, router } from "expo-router";
import { Screen } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { supabase } from "../../lib/supabase";
import { colors, spacing, typography } from "../../lib/theme";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);

    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }

    setIsSubmitting(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        if (signInError.message.toLowerCase().includes("email not confirmed")) {
          setError("Please confirm your email before logging in.");
        } else {
          setError("Incorrect email or password. Please try again.");
        }
        return;
      }

      router.replace("/(tabs)");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>Log in</Text>

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
        textContentType="password"
        autoComplete="password"
      />

      <PrimaryButton label="Log in" onPress={handleSubmit} loading={isSubmitting} />

      <View style={styles.footer}>
        <Link href="/(auth)/forgot-password">
          <Text style={styles.footerText}>Forgot password?</Text>
        </Link>
        <Link href="/(auth)/register">
          <Text style={styles.footerText}>New here? Create an account</Text>
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
    gap: spacing.md,
    alignItems: "center",
  },
  footerText: {
    color: colors.accent,
    fontWeight: "600",
  },
});
