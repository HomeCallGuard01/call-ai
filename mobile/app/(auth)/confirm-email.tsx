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
//    app/reset-password.tsx's pattern for reading the fragment via Expo
//    Router's local search params, then supabase.auth.setSession()
//    exchanges them for a real session. Unlike reset-password.tsx (whose
//    household always already exists from an earlier session), this is
//    the one place a session can be established for a household that
//    doesn't exist yet — so this screen explicitly awaits
//    bootstrapHousehold() itself before navigating, rather than trusting
//    AuthContext's own fire-and-forget bootstrap trigger to have
//    finished in time (2026-08-29 fix — found via real iOS device
//    testing: navigating immediately raced the Home screen's own
//    dashboard fetch against that un-awaited call, landing on a
//    confusing "check your connection" error for a brand-new account
//    whose household simply hadn't been created yet). Hands off to
//    /(tabs) — the same place login.tsx hands off to, which already
//    redirects into (setup) if onboarding isn't complete yet. The
//    customer never re-enters their email or password.
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
import { resendConfirmationEmail, bootstrapHousehold } from "../../lib/api";
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
    supabase.auth.setSession({ access_token: access_token!, refresh_token: refresh_token! }).then(async ({ error, data }) => {
      if (cancelled) return;
      if (error) {
        setLinkState("failed");
        return;
      }

      // Found 2026-08-29 via real iOS device testing: AuthContext's own
      // onAuthStateChange-triggered bootstrap (lib/AuthContext.tsx) is
      // deliberately fire-and-forget — fine for login.tsx, whose
      // household already exists from an earlier session, but this is
      // the ONE place a session can be established for a household that
      // does not exist yet. Navigating to /(tabs) immediately raced the
      // Home screen's own dashboard fetch (fired the instant it mounts,
      // via useFocusEffect) against that un-awaited bootstrap call — the
      // household row often didn't exist yet, so the backend's
      // requireAuthApi returned 401 "no_household" instead of the 402
      // "not_entitled" the client knows how to interpret, landing on a
      // confusing "check your connection" error for a brand-new,
      // perfectly healthy account. Awaiting bootstrap directly here,
      // before navigating, closes the race — AuthContext's own bootstrap
      // trigger still fires too (from the SIGNED_IN event this
      // setSession call produces) but bootstrapHousehold is idempotent
      // (services/householdBootstrap.js checks for an existing household
      // before creating one), so the redundant second call is harmless.
      try {
        await bootstrapHousehold(data.session!.access_token, data.session!.refresh_token);
      } catch (err) {
        // Fail open, matching AuthContext's own convention: a transient
        // bootstrap failure here must never strand the customer on this
        // screen forever. The Home screen's own dashboard fetch will
        // surface a real, visible error if the household is still
        // genuinely missing, and AuthContext's own bootstrap trigger
        // (INITIAL_SESSION on next launch, or this same SIGNED_IN event)
        // gets another chance to self-heal it.
        console.error("CONFIRM-EMAIL BOOTSTRAP FAILED:", err);
      }

      if (cancelled) return;
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
