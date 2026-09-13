// B2 — Membership / Subscribe. Opens Stripe Checkout in an in-app
// browser, then checks real subscription state on return rather than
// trusting the browser's own success/cancel signal alone (a webhook can
// genuinely be delayed past the moment Checkout itself completes).
//
// Reflects the approved launch model: paid from day one, no free trial,
// a 30-day money-back guarantee as the risk-reversal mechanism. The
// Founding Member / "first 500 customers" framing and 12-month price-lock
// claim were removed 2026-08-29 for the App Store release — Apple's
// review guidance is to keep subscription screens plain and accurate,
// and the guarantee's own wording needs to be honest about who actually
// issues a refund on each platform (see the guaranteeBody text below).
// The Stripe price/checkout mechanics themselves are unchanged for
// Android/web — this is presentation only.
//
// The "start immediately" consent checkbox exists because of the
// Consumer Contracts Regulations 2013: a trader shouldn't begin
// providing a service during the statutory 14-day cancellation window
// unless the customer explicitly requests it — which, for a protection
// product whose entire point is starting now, is the whole premise. The
// checkbox and its copy are a reasonable working draft, not a legal
// sign-off; flagged in this session's report as needing a real legal
// review pass before launch, same as the exact guarantee terms text.
import { useState, useRef, useEffect } from "react";
import { Text, View, Pressable, StyleSheet, Platform } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { createCheckoutSession, fetchDashboard, ApiError } from "../../lib/api";
import { fetchHcgPackage, purchaseHcgPackage, isEntitled, PurchasesNotConfiguredError } from "../../lib/purchases";
import { useAuth } from "../../lib/AuthContext";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

const RETURN_URL = "homecallguard://setup/subscribe";

// Apple Guideline 3.1.2: an auto-renewable subscription screen must link
// Terms of Use (EULA) and Privacy Policy directly, not just somewhere
// else in the app — same URLs already used by account/legal.tsx (D4),
// no content duplicated here.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export default function Subscribe() {
  const { session } = useAuth();
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

  // Android/web: unchanged from before this session's Apple IAP work —
  // Stripe Checkout in an in-app browser, real server-derived state
  // checked on return. iOS never calls this function; see
  // handleSubscribeIOS below for why iOS needs a structurally different
  // flow (Guideline 3.1.1 — no external purchase mechanism on iOS).
  async function handleSubscribeStripe() {
    try {
      const { url } = await createCheckoutSession(session?.access_token);
      await WebBrowser.openAuthSessionAsync(url, RETURN_URL);
      if (!isMounted.current) return;

      // Regardless of exactly how the browser session ended (Stripe's
      // own success/cancel redirect, or the customer just closing it),
      // check the real, server-derived state next — never trust the
      // browser event alone, since a webhook can land after Checkout
      // itself completes.
      try {
        await fetchDashboard(session?.access_token);
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
      throw err;
    }
  }

  // iOS: Apple StoreKit via RevenueCat — no Stripe/external checkout
  // mechanism anywhere in this path (Guideline 3.1.1). RevenueCat/
  // StoreKit itself is the purchase UI (Apple's native payment sheet);
  // this just triggers it and then waits for our own backend's
  // entitlement state to catch up, exactly the same "never trust the
  // client's own success signal alone" discipline handleSubscribeStripe
  // already applies to Stripe — the real grant happens server-side, off
  // RevenueCat's webhook (routes/mobileApi.js), not from purchaseHcgPackage
  // resolving here.
  async function handleSubscribeIOS() {
    try {
      const pkg = await fetchHcgPackage();
      const customerInfo = await purchaseHcgPackage(pkg);
      if (!isMounted.current) return;

      if (!isEntitled(customerInfo)) {
        // StoreKit's own purchase sheet was cancelled or failed before
        // ever reaching Apple/RevenueCat — not an error state, the
        // customer simply didn't complete it.
        return;
      }

      // RevenueCat's webhook to our backend is typically near-instant,
      // but is a separate, genuinely asynchronous server-to-server call
      // — never assumed to have already landed just because the client-
      // side purchase resolved. A couple of short, bounded retries here
      // covers that ordinary race without ever trusting the client's own
      // purchase result as the entitlement source of truth.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fetchDashboard(session?.access_token);
          if (!isMounted.current) return;
          router.replace("/(setup)/confirmation");
          return;
        } catch {
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      // Entitlement confirmed by StoreKit/RevenueCat but our own webhook
      // hasn't landed after ~4.5s of retrying — let the customer proceed
      // to Confirmation manually rather than stranding them here; the
      // Home screen's own dashboard fetch will pick up the real state
      // moments later regardless.
      if (isMounted.current) router.replace("/(setup)/confirmation");
    } catch (err) {
      if (!isMounted.current) return;
      if (err instanceof PurchasesNotConfiguredError) {
        setError("Subscriptions aren't available right now. Please try again shortly.");
        return;
      }
      // react-native-iap/StoreKit user-cancellation is a normal outcome,
      // not an error — RevenueCat's PurchasesError carries userCancelled;
      // anything else is treated as a genuine failure.
      const userCancelled = (err as { userCancelled?: boolean })?.userCancelled;
      if (!userCancelled) {
        throw err;
      }
    }
  }

  async function handleSubscribe() {
    setError(null);

    if (!startImmediately) {
      setError("Please confirm you'd like your protection to start right away before continuing.");
      return;
    }

    setIsProcessing(true);
    try {
      if (Platform.OS === "ios") {
        await handleSubscribeIOS();
      } else {
        await handleSubscribeStripe();
      }
    } catch {
      if (isMounted.current) {
        setError("We couldn't start checkout. Please check your connection and try again.");
      }
    } finally {
      if (isMounted.current) setIsProcessing(false);
    }
  }

  return (
    <Screen>
      <SetupProgress currentStep={1} />

      <Text style={styles.title} accessibilityRole="header">Home Call Guard Standard</Text>
      <Text style={styles.price}>£4.99 per month</Text>
      <Text style={styles.body}>
        AI-powered call protection and unlimited trusted contacts. Simple monthly membership — cancel
        anytime.
      </Text>

      <View style={styles.guaranteeBox}>
        <Text style={styles.guaranteeTitle}>30-day money-back guarantee</Text>
        <Text style={styles.guaranteeBody}>
          {Platform.OS === "ios"
            ? // Apple, not Home Call Guard, controls and issues App Store
              // refunds — "just ask [us]" would misrepresent who actually
              // grants it for an Apple-billed purchase. This still honours
              // the guarantee (we support the request) without claiming a
              // capability only Apple has.
              "Not right for you, for any reason? Apple handles all App Store refunds directly — " +
              "request one any time within your first 30 days from Settings on your iPhone " +
              "(your name → Subscriptions) or at reportaproblem.apple.com. Contact us any time if you'd " +
              "like help with your request."
            : "Not right for you, for any reason? Get a full refund within your first 30 days — just ask, " +
              "no forms to fill in."}
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

      <Text style={styles.smallprint}>
        {Platform.OS === "ios"
          ? "Secure payment via the App Store. You can cancel any time from Account."
          : "Secure payment via Stripe. You can cancel any time from Account."}
      </Text>

      <View style={styles.legalLinks}>
        <Pressable onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}/terms.html`)}>
          <Text style={styles.legalLinkText}>Terms of Use</Text>
        </Pressable>
        <Text style={styles.legalLinkSeparator}>·</Text>
        <Pressable onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}/privacy.html`)}>
          <Text style={styles.legalLinkText}>Privacy Policy</Text>
        </Pressable>
      </View>
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
  legalLinks: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  legalLinkText: {
    ...typography.caption,
    color: colors.accent,
    textDecorationLine: "underline",
  },
  legalLinkSeparator: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
