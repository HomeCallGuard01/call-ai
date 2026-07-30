// B2 — Membership / Subscribe. Per APP_VISUAL_SPECIFICATION.md: opens
// Stripe Checkout in an in-app browser (kept deliberately boring/familiar
// — Stripe's own hosted UI, not a custom native payment form), then
// checks real subscription state on return rather than trusting the
// browser's own success/cancel signal alone (mirrors the web app's
// reconcile-on-return pattern, since a webhook can genuinely be delayed
// past the moment Checkout itself completes).
import { useState } from "react";
import { Text, StyleSheet } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { createCheckoutSession, fetchDashboard, ApiError } from "../../lib/api";
import { colors, spacing, typography } from "../../lib/theme";

const RETURN_URL = "homecallguard://setup/subscribe";

export default function Subscribe() {
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  async function handleSubscribe() {
    setError(null);
    setIsProcessing(true);

    try {
      const { url } = await createCheckoutSession();
      await WebBrowser.openAuthSessionAsync(url, RETURN_URL);

      // Regardless of exactly how the browser session ended (Stripe's
      // own success/cancel redirect, or the customer just closing it),
      // check the real, server-derived state next — never trust the
      // browser event alone, since a webhook can land after Checkout
      // itself completes.
      try {
        await fetchDashboard();
        router.replace("/(setup)/device-picker");
      } catch {
        // Still not entitled — either genuinely cancelled, or the
        // webhook hasn't landed yet. Stay on this screen so the
        // customer can simply try again; not an error state, matching
        // the spec's "return to B2, button available to try again."
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "already_active") {
        router.replace("/(setup)/device-picker");
        return;
      }
      setError("We couldn't start checkout. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>Home Call Guard Standard</Text>
      <Text style={styles.price}>£4.99 per month</Text>
      <Text style={styles.body}>AI call screening, unlimited trusted contacts, cancel anytime.</Text>

      {error && <Banner variant="error" message={error} />}

      <PrimaryButton label="Subscribe — £4.99/month" onPress={handleSubscribe} loading={isProcessing} />

      <Text style={styles.smallprint}>Secure payment via Stripe. No long-term commitment.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.hero,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  price: {
    ...typography.title,
    color: colors.accent,
    marginBottom: spacing.md,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  smallprint: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.md,
    textAlign: "center",
  },
});
