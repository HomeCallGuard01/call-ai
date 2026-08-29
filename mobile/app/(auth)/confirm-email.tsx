// A4 — Registration outcome. Reached two different ways:
//
// 1. Immediately after submitting the registration form (router.push
//    from register.tsx with {email, status}, no tokens) — renders one of
//    two states depending on what the backend found (see
//    services/registrationRequest.js via lib/api.ts's
//    registerAccount/resendConfirmationEmail):
//    - pending_confirmation (a genuinely new signup, or a resend to an
//      existing unconfirmed email — deliberately identical, anti-
//      enumeration): "Check your email or sign in". Every path off this
//      screen (Sign in, Forgotten password?, Resend) is visible
//      immediately — nobody is left here indefinitely waiting for an
//      email that may never come.
//    - already_registered (an existing, CONFIRMED account): "This email
//      may already be registered" — the one outcome where nothing was,
//      or ever will be, sent, so this never claims otherwise.
//
// 2. Via the emailed confirmation link itself
//    (homecallguard://confirm-email#access_token=...&refresh_token=...),
//    once routes/mobileApi.js's /api/v1/register passes this as
//    emailRedirectTo (2026-08-29 fix — found via real iOS device
//    testing: the app previously didn't set emailRedirectTo at all, so
//    Supabase fell back to the public marketing homepage, and tapping
//    the link left the customer stranded there with no way back into
//    the app and no session, forcing a full re-registration). Mirrors
//    app/reset-password.tsx's already-proven pattern exactly: Expo
//    Router surfaces the fragment as local search params, and
//    supabase.auth.setSession() exchanges them for a real session —
//    which fires AuthContext's onAuthStateChange (SIGNED_IN), which
//    already triggers household bootstrap automatically, so this screen
//    only needs to establish the session and hand off to /(tabs) — the
//    same place login.tsx hands off to, which already redirects into
//    (setup) if onboarding isn't complete yet. The customer never
//    re-enters their email or password.
//
// The "Resend confirmation email" button can itself transition the
// screen from pending_confirmation to already_registered in place (if
// the account turns out to already be confirmed) — it never shows a
// success notice unless Supabase actually accepted a real resend.
import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Link, router, useLocalSearchParams } from "expo-router";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { supabase } from "../../lib/supabase";
import { resendConfirmationEmail } from "../../lib/api";
import { outcomeContent, planResendEffect, type RegisterStatus } from "../../lib/registrationOutcome";
import { colors, spacing, typography } from "../../lib/theme";

export default function ConfirmEmail() {
  const { email, status: initialStatus, access_token, refresh_token } = useLocalSearchParams<{
    email: string;
    status?: RegisterStatus;
    access_token?: string;
    refresh_token?: string;
  }>();
  const [status, setStatus] = useState<RegisterStatus>(initialStatus === "already_registered" ? "already_registered" : "pending_confirmation");
  const [notice, setNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);

  const hasConfirmationLink = !!access_token && !!refresh_token;
  const [linkState, setLinkState] = useState<"verifying" | "failed" | "idle">(hasConfirmationLink ? "verifying" : "idle");

  useEffect(() => {
    if (!hasConfirmationLink) return;

    let cancelled = false;
    supabase.auth.setSession({ access_token: access_token!, refresh_token: refresh_token! }).then(({ error }) => {
      if (cancelled) return;
      if (error) {
        setLinkState("failed");
        return;
      }
      // AuthContext's onAuthStateChange (SIGNED_IN) has already fired by
      // this point and kicked off household bootstrap — same handoff
      // point login.tsx uses on a normal sign-in, so this doesn't
      // duplicate or race that logic, just reaches the same destination.
      router.replace("/(tabs)");
    });

    return () => {
      cancelled = true;
    };
    // access_token/refresh_token are only ever read once, on the initial
    // mount this screen is reached via a deep link with — re-running this
    // if they somehow changed identity is not a real scenario for a
    // one-shot confirmation link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasConfirmationLink]);

  if (hasConfirmationLink) {
    if (linkState === "verifying") {
      return (
        <Screen scroll={false}>
          <View style={styles.centered}>
            <ActivityIndicator color={colors.accent} size="large" />
          </View>
        </Screen>
      );
    }

    return (
      <Screen>
        <Text style={styles.title} accessibilityRole="header">Link invalid</Text>
        <Banner variant="error" message="This confirmation link is invalid or has expired. Please sign in, or request a new one below." />
        <PrimaryButton label="Sign in" onPress={() => router.replace("/(auth)/login")} />
      </Screen>
    );
  }

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
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
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
