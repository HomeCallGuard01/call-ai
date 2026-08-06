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
import { registerAccount, ApiError } from "../../lib/api";
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
      // The decision of whether this is a genuinely new signup, a resend
      // to an existing unconfirmed email, or an existing confirmed
      // account is made server-side (routes/mobileApi.js,
      // services/registrationRequest.js), reusing the exact same logic
      // the web app's /register route already uses. This used to call
      // supabase.auth.signUp() directly here and only check for an
      // error — but Supabase's signUp() returns success with no error
      // and sends no email at all when called for an already-registered,
      // already-confirmed account (deliberate anti-enumeration
      // behaviour), so that left the customer pushed to "check your
      // email" waiting for something that was never sent.
      //
      // Both possible outcomes (pending_confirmation / already_registered)
      // land on the same confirm-email screen, which renders the right
      // content for whichever status it's given — see
      // lib/registrationOutcome.ts.
      const { status } = await registerAccount(email, password);
      router.push({ pathname: "/(auth)/confirm-email", params: { email, status } });
    } catch (err) {
      if (err instanceof ApiError && err.code === "invalid_input") {
        setError("Please enter a valid email and password.");
      } else {
        setError("We couldn't create your account. Please check your details and try again.");
      }
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
