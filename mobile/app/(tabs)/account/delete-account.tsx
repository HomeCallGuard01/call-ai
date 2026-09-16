// D5 — Delete Account. Apple Guideline 5.1.1(v): an app that supports
// account creation must let the customer initiate deletion from inside
// the app itself — directing them to email support or visit a website
// is not sufficient (the website's own delete-account.html is exactly
// that "email us" flow, so it doesn't satisfy this on its own).
//
// Two-layer confirmation, matching this app's own existing precedent
// (account/index.tsx's handleLogout): navigating here from Account is
// the first deliberate step, then a native Alert.alert/window.confirm
// (the same dual-path already used for Log out, including the RN-Web
// Alert bug workaround noted there) is the explicit "are you sure"
// step, naming the irreversible effect before anything happens.
//
// DELETE /api/v1/me/account (services/accountDeletion.js, call-ai repo)
// does the real work server-side: stops any real recurring billing,
// releases the Twilio number, anonymises the household, deletes the
// Supabase Auth user. This screen never touches Stripe/RevenueCat/Twilio
// itself — it only calls that one endpoint and reflects what it reports.
import { useCallback, useState } from "react";
import { Text, View, Alert, Platform, ActivityIndicator, StyleSheet } from "react-native";
import { useFocusEffect } from "expo-router";
import { Screen } from "../../../components/Screen";
import { PrimaryButton } from "../../../components/PrimaryButton";
import { Banner } from "../../../components/Banner";
import { supabase } from "../../../lib/supabase";
import { useAuth } from "../../../lib/AuthContext";
import { deleteAccount, fetchDashboard, ApiError } from "../../../lib/api";
import { resetVoiceRegistrationState } from "../../../lib/voiceClient";
import { colors, spacing, typography } from "../../../lib/theme";

// Whether the account currently has an active Apple/RevenueCat
// subscription is only knowable from the real dashboard response — not
// guessed from Platform.OS, since a customer can be on iOS while
// genuinely billed via Stripe (subscribed on the web first). "unknown"
// (fetch failed) shows the more conservative combined caveat below
// rather than silently omitting the Apple-specific warning.
type BillingSourceState = "loading" | "apple_revenuecat" | "other" | "unknown";

export default function DeleteAccount() {
  const { session } = useAuth();
  const [billingSourceState, setBillingSourceState] = useState<BillingSourceState>("loading");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setBillingSourceState("loading");

      fetchDashboard(session?.access_token)
        .then(result => {
          if (cancelled) return;
          setBillingSourceState(result.membership.billingSource === "apple_revenuecat" ? "apple_revenuecat" : "other");
        })
        .catch(() => {
          // Covers both a real fetch failure and the 402 "not entitled"
          // case (NotEntitledError) — either way there's no way to know
          // the billing source, so the more conservative combined
          // caveat below is shown rather than silently omitting it.
          if (!cancelled) setBillingSourceState("unknown");
        });

      return () => {
        cancelled = true;
      };
    }, [session?.access_token])
  );

  async function performDeletion() {
    setError(null);
    setIsDeleting(true);
    try {
      await deleteAccount(session?.access_token);
      // The real work (billing/Twilio/household/auth) already happened
      // server-side by the time this resolves — everything from here is
      // local-device cleanup only. Resets voiceClient.ts's module-level
      // registration state first (2026-09-07 fix, see
      // account/index.tsx's own signOutAndResetVoiceRegistration) —
      // otherwise a different household signing into this same device
      // next would hit registerForIncomingCalls()'s `if (registered)
      // return` guard and silently never register under its own
      // identity. Signing out here only clears this device's own local
      // session; AuthContext's existing onAuthStateChange(SIGNED_OUT)
      // listener handles navigating away — this screen never navigates
      // itself.
      resetVoiceRegistrationState();
      await supabase.auth.signOut();
    } catch (err) {
      setIsDeleting(false);
      if (err instanceof ApiError) {
        // stripe_cancel_failed (services/accountDeletion.js, call-ai
        // repo): the backend deliberately refused to delete — nothing
        // was touched, the account is untouched and safe to log back
        // into — because it couldn't confirm the real Stripe
        // subscription was cancelled. A generic "try again" message
        // would leave the customer guessing whether billing already
        // stopped; naming the real cause and the fallback path is more
        // honest and more actionable.
        setError(
          err.code === "stripe_cancel_failed"
            ? "We couldn't cancel your subscription just now, so we haven't deleted your account — nothing has changed. " +
              "Please try again, or cancel it yourself from Account > Membership > Manage Membership, then delete your account."
            : "We couldn't delete your account right now. Please try again, or contact support if this keeps happening."
        );
      } else {
        throw err;
      }
    }
  }

  function confirmAndDelete() {
    const title = "Delete your account?";
    const message =
      "This permanently deletes your Home Call Guard account and personal data — your email, phone number, " +
      "trusted contacts, and call history. This cannot be undone.";

    if (Platform.OS === "web") {
      if (window.confirm(`${title}\n\n${message}`)) {
        performDeletion();
      }
      return;
    }

    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete Account", style: "destructive", onPress: performDeletion },
    ]);
  }

  return (
    <Screen>
      <Text style={styles.title} accessibilityRole="header">Delete your account</Text>

      <Text style={styles.body}>
        Deleting your account permanently removes your Home Call Guard access and personal data — your email
        address, phone number, trusted contacts, and call history. This cannot be undone.
      </Text>

      {(billingSourceState === "apple_revenuecat" || billingSourceState === "unknown") && (
        <Banner
          variant="notice"
          message={
            "If you subscribed through the App Store, deleting your account here does not cancel that Apple " +
            "subscription — Apple, not Home Call Guard, controls it. To stop being charged, cancel it yourself " +
            "from your iPhone: Settings > your name > Subscriptions."
          }
        />
      )}

      {error && <Banner variant="error" message={error} />}

      {billingSourceState === "loading" ? (
        <ActivityIndicator color={colors.textMuted} style={styles.spinner} />
      ) : (
        <PrimaryButton
          label="Delete My Account"
          onPress={confirmAndDelete}
          loading={isDeleting}
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
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  spinner: {
    marginTop: spacing.lg,
  },
});
