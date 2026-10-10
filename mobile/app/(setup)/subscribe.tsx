// B2 — Membership / Subscribe.
//
// 2026-10-10 (WS4, Android Option C — Google Play Payments policy): this
// screen takes payment on iOS ONLY (Apple StoreKit via RevenueCat). The
// Android app is consumption-only: it never opens Stripe Checkout, shows no
// price and has no button, link or QR code to web checkout. An Android
// account without a membership sees plain text ("Membership is set up on our
// website, homecallguard.co.uk" — not a link, not selectable) and can re-check
// its membership; a customer who paid on the website signs in and continues
// exactly as before (setup welcome resumes past this screen once entitled).
// Copy and platform rules: lib/subscriptionPrice.ts (canPurchaseInApp,
// CONSUMPTION_ONLY_COPY). Guarded by
// tests/android-option-c-consumption-only.test.mjs. Play Billing (Option A)
// replaces this before Android is offered publicly
// (docs/launch/2026-10-09-ANDROID-COMPLIANT-PAYMENTS.md).
//
// Before 2026-10-10 Android opened Stripe Checkout in an in-app browser
// here (removed: non-compliant on Google Play).
//
// Reflects the approved launch model: paid from day one, no free trial.
// The Founding Member / "first 500 customers" framing and 12-month price-lock
// claim were removed 2026-08-29 for the App Store release — Apple's
// review guidance is to keep subscription screens plain and accurate.
// 2026-09-21: the "30-day money-back guarantee" box and the "I still have 30
// days to change my mind" wording were REMOVED from this screen. No
// replacement refund, guarantee or cooling-off promise is made here — do not
// reintroduce one without explicit approval (tests/release-copy-corrections
// .test.mjs guards this).
// 2026-09-30: this screen contains NO subscription amount. iOS shows
// StoreKit's own price for the exact package it will buy (lib/subscriptionPrice.ts).
// If the price can't be read, no amount is shown and iOS can't purchase
// until it loads. Android shows no price at all (Option C, above). Guarded
// by tests/subscription-price-display.test.mjs.
//
// The "start immediately" consent checkbox exists because of the
// Consumer Contracts Regulations 2013: a trader shouldn't begin
// providing a service during the statutory 14-day cancellation window
// unless the customer explicitly requests it — which, for a protection
// product whose entire point is starting now, is the whole premise. The
// checkbox and its copy are a reasonable working draft, not a legal
// sign-off; flagged as needing a real legal review pass before launch.
//
// A SEPARATE Terms & Conditions / Privacy Policy agreement checkbox was
// added 2026-09-13 (carrier-onboarding-gate audit finding: this screen
// linked Terms/Privacy but recorded no evidence anyone had actually
// agreed to them, and had no dedicated agreement control at all — the
// existing checkbox above is about starting the service immediately, not
// Terms acceptance, and deliberately stays separate rather than being merged
// into one tickbox covering two different legal facts). Unticked by
// default; acceptTerms() (POST /api/v1/onboarding/terms-acceptance)
// writes a durable, append-only evidence row (migration 039) the moment
// before either purchase path is triggered — never earlier, so no
// acceptance record exists for a purchase the customer never attempted.
import { useState, useRef, useEffect } from "react";
import { Text, View, Pressable, StyleSheet, Platform } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Screen } from "../../components/Screen";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Banner } from "../../components/Banner";
import { SetupProgress } from "../../components/SetupProgress";
import { fetchDashboard, fetchCarrierCompatibility, acceptTerms, ApiError, NotEntitledError } from "../../lib/api";
import { fetchHcgPackage, purchaseHcgPackage, isEntitled, PurchasesNotConfiguredError } from "../../lib/purchases";
import type { PurchasesPackage } from "react-native-purchases";
import {
  displayPriceFromStoreProduct,
  canPurchaseInApp,
  CONSUMPTION_ONLY_COPY,
  subscribePriceLine,
  subscribeButtonLabel,
  PRICE_PENDING_NOTE,
  type DisplayPrice,
} from "../../lib/subscriptionPrice";
import { useAuth } from "../../lib/AuthContext";
import { loadActivationDevice } from "../../lib/activationDeviceStorage";
import { isLandlineComingSoon, useLandlineComingSoon } from "../../lib/landlineFlag";
import { LandlineComingSoon } from "../../components/LandlineComingSoon";
import { colors, spacing, typography, MIN_TOUCH_TARGET } from "../../lib/theme";

// Apple Guideline 3.1.2: an auto-renewable subscription screen must link
// Terms of Use (EULA) and Privacy Policy directly, not just somewhere
// else in the app — same URLs already used by account/legal.tsx (D4),
// no content duplicated here. Android opens the navigation-free copies
// (public/legal/*-app.html, generated from /terms.html and /privacy.html by
// tests/app-legal-pages.test.mjs), which have no route to web checkout.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
const IN_APP_PURCHASE = canPurchaseInApp(Platform.OS);
const TERMS_PATH = Platform.OS === "ios" ? "/terms.html" : "/legal/terms-app.html";
const PRIVACY_PATH = Platform.OS === "ios" ? "/privacy.html" : "/legal/privacy-app.html";

export default function Subscribe() {
  const { session } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [startImmediately, setStartImmediately] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  // Landline is Coming soon (server flag, lib/landlineFlag.ts): a stale stored
  // "landline" device (e.g. picked in an older app version) must never reach
  // payment from here. Local storage only — no network call, nothing changes
  // for Android/iPhone customers, who never have "landline" stored.
  const landlineComingSoon = useLandlineComingSoon();
  const [storedDeviceType, setStoredDeviceType] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadActivationDevice().then(device => {
      if (!cancelled) setStoredDeviceType(device?.deviceType ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const landlineBlocked = landlineComingSoon && storedDeviceType === "landline";

  // Price of the system that will actually charge this customer. iOS keeps
  // the StoreKit package it priced, so the package bought is the package
  // whose price was shown.
  const [displayPrice, setDisplayPrice] = useState<DisplayPrice | null>(null);
  const [priceState, setPriceState] = useState<"loading" | "ready" | "unavailable">("loading");
  const iosPackage = useRef<PurchasesPackage | null>(null);
  const [priceAttempt, setPriceAttempt] = useState(0);
  useEffect(() => {
    // Option C: Android never fetches or shows a price.
    if (!IN_APP_PURCHASE) return;
    let cancelled = false;
    setPriceState("loading");
    const load = fetchHcgPackage().then(pkg => {
      const price = displayPriceFromStoreProduct(pkg.product);
      iosPackage.current = price ? pkg : null;
      return price;
    });
    load
      .then(price => {
        if (cancelled) return;
        setDisplayPrice(price);
        setPriceState(price ? "ready" : "unavailable");
      })
      .catch(() => {
        if (cancelled) return;
        iosPackage.current = null;
        setDisplayPrice(null);
        setPriceState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, priceAttempt]);
  const iosPriceMissing = Platform.OS === "ios" && priceState !== "ready";

  // A purchase sheet can stay open for a while — long enough that the
  // screen underneath could in principle be gone by the time control
  // returns. Every setState below checks this first.
  const isMounted = useRef(true);
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Option C (Android): re-check the server's membership state after the
  // customer has subscribed on the website. Setup welcome decides where to
  // resume, exactly as for any entitled account.
  const [isCheckingMembership, setIsCheckingMembership] = useState(false);
  async function handleCheckMembershipAgain() {
    setError(null);
    setIsCheckingMembership(true);
    try {
      await fetchDashboard(session?.access_token);
      if (!isMounted.current) return;
      router.replace("/(setup)/welcome");
    } catch (err) {
      if (!isMounted.current) return;
      setError(
        err instanceof NotEntitledError
          ? CONSUMPTION_ONLY_COPY.stillNoMembership
          : "We couldn't check your membership. Please check your connection and try again."
      );
    } finally {
      if (isMounted.current) setIsCheckingMembership(false);
    }
  }

  // iOS: Apple StoreKit via RevenueCat — no Stripe/external checkout
  // mechanism anywhere in this path (Guideline 3.1.1). RevenueCat/
  // StoreKit itself is the purchase UI (Apple's native payment sheet);
  // this just triggers it and then waits for our own backend's
  // entitlement state to catch up, exactly the same "never trust the
  // client's own success signal alone" discipline the web Stripe path
  // applies — the real grant happens server-side, off
  // RevenueCat's webhook (routes/mobileApi.js), not from purchaseHcgPackage
  // resolving here.
  async function handleSubscribeIOS() {
    try {
      // Only ever buys the package whose StoreKit price is on screen.
      const pkg = iosPackage.current;
      if (!pkg) {
        setError("We couldn't load the subscription price from the App Store. Please try again.");
        return;
      }
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
    // Option C: no purchase path exists outside iOS.
    if (!IN_APP_PURCHASE) return;

    if (!agreedToTerms) {
      setError("Please agree to the Terms & Conditions and Privacy Policy before continuing.");
      return;
    }

    if (!startImmediately) {
      setError("Please confirm you'd like your protection to start right away before continuing.");
      return;
    }

    setIsProcessing(true);
    try {
      // Authoritative landline guard at the moment of purchase (the effect
      // above may not have resolved yet if the customer taps very quickly).
      const storedDevice = await loadActivationDevice();
      if (isLandlineComingSoon(storedDevice?.deviceType)) {
        if (isMounted.current) setStoredDeviceType(storedDevice?.deviceType ?? null);
        return;
      }

      // Defense-in-depth carrier-compatibility check, applied identically
      // to both purchase paths, right here at the actual moment of
      // purchase — not just relying on device-picker.tsx running earlier
      // in the flow (real app-navigation edge cases, e.g. the app being
      // killed and resumed mid-flow, don't reliably guarantee that).
      // The web Stripe checkout also has a genuine server-side block inside
      // create-checkout-session itself; iOS has none (Apple's StoreKit
      // purchase can't be intercepted server-side beforehand), which is
      // exactly why this check has to live here, before the purchase.
      const eligibility = await fetchCarrierCompatibility(session?.access_token);
      if (!eligibility.canProceedToPayment) {
        if (isMounted.current) {
          // 2026-09-16 fix: never shows eligibility.reason (the
          // backend's own internal policy string) directly — fixed,
          // non-technical copy only, matching device-picker.tsx's own
          // "blocked" step wording.
          setError(
            eligibility.customerState === "needs_confirmation"
              ? "We're still confirming Home Call Guard works with your network. Please contact support for help."
              : "We can't take payment yet — your network hasn't been confirmed as compatible. Please go back and check your network."
          );
        }
        return;
      }

      // Durable evidence write — see migration 039. Written once both
      // consent checkboxes are confirmed ticked and carrier eligibility
      // is confirmed, immediately before the purchase actually starts.
      await acceptTerms(session?.access_token);

      await handleSubscribeIOS();
    } catch (err) {
      if (isMounted.current) {
        if (err instanceof ApiError && err.code === "carrier_incompatible") {
          setError("Your network isn't supported yet. Please go back and check your network in setup.");
        } else {
          setError("We couldn't start checkout. Please check your connection and try again.");
        }
      }
    } finally {
      if (isMounted.current) setIsProcessing(false);
    }
  }

  if (landlineBlocked) {
    return (
      <Screen>
        <LandlineComingSoon actionLabel="Choose a different option" onAction={() => router.replace("/(setup)/device-picker")} />
      </Screen>
    );
  }

  if (!IN_APP_PURCHASE) {
    // Option C: plain text only. No price, no purchase button, no link or
    // QR code to web checkout; the website name is NOT selectable (Android's
    // selection toolbar can offer to open a URL).
    return (
      <Screen>
        <SetupProgress currentStep={1} />
        <Text style={styles.title} accessibilityRole="header">{CONSUMPTION_ONLY_COPY.noMembershipTitle}</Text>
        <Text style={styles.body}>{CONSUMPTION_ONLY_COPY.noMembershipBody}</Text>
        <Text style={styles.body} selectable={false}>{CONSUMPTION_ONLY_COPY.websiteNote}</Text>
        <Text style={styles.body}>{CONSUMPTION_ONLY_COPY.afterWebsiteNote}</Text>
        {error && <Banner variant="error" message={error} />}
        <PrimaryButton label={CONSUMPTION_ONLY_COPY.checkAgainLabel} onPress={handleCheckMembershipAgain} loading={isCheckingMembership} />
        <View style={styles.legalLinks}>
          <Pressable onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}${TERMS_PATH}`)}>
            <Text style={styles.legalLinkText}>Terms & Conditions</Text>
          </Pressable>
          <Text style={styles.legalLinkSeparator}>·</Text>
          <Pressable onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}${PRIVACY_PATH}`)}>
            <Text style={styles.legalLinkText}>Privacy Policy</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <SetupProgress currentStep={1} />

      <Text style={styles.title} accessibilityRole="header">Home Call Guard Standard</Text>
      {displayPrice ? (
        <Text style={styles.price}>{subscribePriceLine(displayPrice)}</Text>
      ) : priceState === "loading" ? (
        <Text style={styles.body}>Loading price…</Text>
      ) : Platform.OS === "ios" ? (
        <View>
          <Text style={styles.body}>We couldn't load the subscription price from the App Store.</Text>
          <Pressable onPress={() => setPriceAttempt(n => n + 1)} accessibilityRole="button">
            <Text style={styles.legalLinkText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.body}>{PRICE_PENDING_NOTE}</Text>
      )}
      <Text style={styles.body}>
        Scam call protection and unlimited trusted contacts. This is a recurring monthly
        subscription that renews automatically every month until you cancel — cancel anytime.
      </Text>

      {error && <Banner variant="error" message={error} />}

      <View style={styles.legalLinks}>
        <Pressable onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}${TERMS_PATH}`)}>
          <Text style={styles.legalLinkText}>Terms & Conditions</Text>
        </Pressable>
        <Text style={styles.legalLinkSeparator}>·</Text>
        <Pressable onPress={() => WebBrowser.openBrowserAsync(`${API_BASE_URL}${PRIVACY_PATH}`)}>
          <Text style={styles.legalLinkText}>Privacy Policy</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => setAgreedToTerms(v => !v)}
        style={styles.consentRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: agreedToTerms }}
        accessibilityLabel="I agree to the Terms and Conditions and acknowledge the Privacy Policy"
      >
        <View style={[styles.checkbox, agreedToTerms && styles.checkboxChecked]}>
          {agreedToTerms && <Text style={styles.checkboxTick}>✓</Text>}
        </View>
        <Text style={styles.consentText}>I agree to the Terms & Conditions and acknowledge the Privacy Policy.</Text>
      </Pressable>

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
          I'd like my protection to start right away.
        </Text>
      </Pressable>

      <PrimaryButton
        label={subscribeButtonLabel(displayPrice)}
        onPress={handleSubscribe}
        loading={isProcessing}
        disabled={iosPriceMissing}
      />

      <Text style={styles.smallprint}>Secure payment via the App Store. You can cancel any time from Account.</Text>
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
