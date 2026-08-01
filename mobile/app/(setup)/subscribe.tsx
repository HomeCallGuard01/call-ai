// B2 — Membership / Subscribe. Opens Stripe Checkout in an in-app
// browser, then checks real subscription state on return rather than
// trusting the browser's own success/cancel signal alone (a webhook can
// genuinely be delayed past the moment Checkout itself completes).
//
// Reflects the approved launch model: paid from day one, no free trial,
// a 30-day money-back guarantee as the risk-reversal mechanism, and a
// time-limited Founding Member framing. The Stripe price/checkout
// mechanics themselves are unchanged — this is presentation only.
//
// The "start immediately" consent checkbox exists because of the
// Consumer Contracts Regulations 2013: a trader shouldn't begin
// providing a service during the statutory 14-day cancellation window
// unless the customer explicitly requests it — which, for a protection
// product whose entire point is starting now, is the whole premise. The
// checkbox and its copy are a reasonable working draft, not a legal
// sign-off; flagged in this session's report as needing a real legal
// review pass before launch, same as the exact guarantee/founding-member
// terms text.
import { useState, useRef, useEffect } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { createCheckoutSession, fetchDashboard, ApiError } from "../../lib/api";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

const RETURN_URL = "homecallguard://setup/subscribe";

export default function Subscribe() {
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [startImmediately, setStartImmediately] = useState(false);

  // openAuthSessionAsync can stay open for minutes (Stripe Checkout is a
  // real payment form, not a quick redirect) — long enough that the
  // screen underneath could in principle be gone by the time control
  // returns (e.g. an auth-state change elsewhere redirects away). Every
  // setState below checks this first.
  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  async function handleSubscribe() {
    setError(null);

    if (!startImmediately) {
      setError("Please confirm you'd like your protection to start right away before continuing.");
      return;
    }

    setIsProcessing(true);

    try {
      const { url } = await createCheckoutSession();
      await WebBrowser.openAuthSessionAsync(url, RETURN_URL);
      if (!isMounted.current) return;

      // Regardless of exactly how the browser session ended (Stripe's
      // own success/cancel redirect, or the customer just closing it),
      // check the real, server-derived state next — never trust the
      // browser event alone, since a webhook can land after Checkout
      // itself completes.
      try {
        await fetchDashboard();
        if (!isMounted.current) return;
        router.replace("/(setup)/confirmation");
      } catch {
        // Still not entitled — either genuinely cancelled, or the
        // webhook hasn't landed yet. Stay on this screen so the
        // customer can simply try again; not an error state.
      }
    } catch (err) {
      if (!isMounted.current) return;
      if (err instanceof ApiError && err.code === "already_active") {
        router.replace("/(setup)/confirmation");
        return;
      }
      setError("We couldn't start checkout. Please check your connection and try again.");
    } finally {
      if (isMounted.current) setIsProcessing(false);
    }
  }

  return (
    <Screen>
      <SetupProgress currentStep={1} />

      <View style={styles.foundingBadge}>
        <Text style={styles.foundingBadgeText}>FOUNDING MEMBER OFFER — FIRST 500 CUSTOMERS</Text>
      </View>

      <Text style={styles.title} accessibilityRole="header">Home Call Guard Standard</Text>
      <Text style={styles.price}>£4.99 per month</Text>
      <Text style={styles.body}>
        AI call screening and unlimited trusted contacts. As a founding member, your price is locked
        for 12 months — cancel any time.
      </Text>

      <View style={styles.guaranteeBox}>
        <Text style={styles.guaranteeTitle}>30-day money-back guarantee</Text>
        <Text style={styles.guaranteeBody}>
          Not right for you, for any reason? Get a full refund within your first 30 days — just ask,
          no forms to fill in.
        </Text>
      </View>

      {error && <Banner variant="error" message={error} />}

      <Pressable
        onPress={() => setStartImmediately(v => !v)}
        style={styles.consentRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: startImmediately }}
        accessibilityLabel="I'd like my protection to start right away"
      >
        <View style={[styles.checkbox, startImmediately && styles.checkboxChecked]}>
          {startImmediately && <Text style={styles.checkboxTick}>✓</Text>}
        </View>
        <Text style={styles.consentText}>
          I'd like my protection to start right away. I understand I still have 30 days to change my
          mind either way.
        </Text>
      </Pressable>

      <PrimaryButton label="Subscribe — £4.99/month" onPress={handleSubscribe} loading={isProcessing} />

      <Text style={styles.smallprint}>Secure payment via Stripe. You can cancel any time from Account.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  foundingBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.accentMuted,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.md,
  },
  foundingBadgeText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
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
  guaranteeBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  guaranteeTitle: {
    ...typography.body,
    color: colors.text,
    fontWeight: "700",
    marginBottom: spacing.xs,
  },
  guaranteeBody: {
    ...typography.caption,
    color: colors.textMuted,
    lineHeight: 18,
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginBottom: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: spacing.xs,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
    flexShrink: 0,
  },
  checkboxChecked: {
    borderColor: colors.accent,
    backgroundColor: colors.accentMuted,
  },
  checkboxTick: {
    color: colors.accent,
    fontWeight: "800",
    fontSize: 14,
  },
  consentText: {
    ...typography.caption,
    color: colors.text,
    flex: 1,
    lineHeight: 18,
  },
  smallprint: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.md,
    textAlign: "center",
  },
});
