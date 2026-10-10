// Subscription price shown on the Subscribe screen (2026-09-30).
//
// The app never contains a subscription amount of its own. Each platform
// shows the price of the system that actually charges the customer:
//   - iOS: StoreKit's own localised price for the App Store product
//     (RevenueCat PurchasesStoreProduct.priceString), so the screen always
//     matches Apple's payment sheet, including after a price change in
//     App Store Connect, with no app update.
//   - Android: NOTHING since 2026-10-10 (Option C, below: the Android app
//     takes no payment and shows no price). displayPriceFromServerOffer is
//     kept for the web/Play Billing follow-up and its tests, but no Android
//     screen calls it.
//
// Fail closed: anything that doesn't look like a single monthly price
// returns null, and the screen shows wording with no amount. A figure is
// never guessed, remembered or defaulted.
//
// Kept free of React Native imports so tests/subscription-price-display
// .test.mjs can execute it directly.

export type PriceSource = "app_store" | "stripe";

export type DisplayPrice = {
  source: PriceSource;
  amountLabel: string;
  period: "month";
  vatInclusive: boolean;
};

// Minimal shape of RevenueCat's PurchasesStoreProduct used here.
export type StoreProductLike = {
  priceString?: unknown;
  currencyCode?: unknown;
  subscriptionPeriod?: unknown;
  introPrice?: unknown;
};

// Minimal shape of GET /api/v1/billing/offer.
export type ServerOfferLike = {
  available?: unknown;
  channel?: unknown;
  interval?: unknown;
  amountLabel?: unknown;
};

const SERVER_AMOUNT_PATTERN = /^£\d{1,3}(,\d{3})*\.\d{2}$/;

export function displayPriceFromStoreProduct(product: StoreProductLike | null | undefined): DisplayPrice | null {
  if (!product) return null;
  const { priceString, currencyCode, subscriptionPeriod, introPrice } = product;
  if (typeof priceString !== "string") return null;
  const amountLabel = priceString.trim();
  if (!amountLabel || amountLabel.length > 24) return null;
  // ISO 8601 period from StoreKit: only a one-month subscription can be
  // described as "/month".
  if (subscriptionPeriod !== "P1M") return null;
  // An introductory offer changes what the first payment is. This screen
  // can't describe one yet, so it shows no amount rather than an
  // incomplete one (don't add an intro offer in App Store Connect without
  // an app update that displays it).
  if (introPrice) return null;
  return {
    source: "app_store",
    amountLabel,
    period: "month",
    // UK App Store prices include VAT; for any other storefront currency
    // the app makes no VAT statement.
    vatInclusive: currencyCode === "GBP",
  };
}

export function displayPriceFromServerOffer(offer: ServerOfferLike | null | undefined): DisplayPrice | null {
  if (!offer || offer.available !== true) return null;
  if (offer.channel !== "stripe" || offer.interval !== "month") return null;
  if (typeof offer.amountLabel !== "string" || !SERVER_AMOUNT_PATTERN.test(offer.amountLabel)) return null;
  // The backend only describes Prices Stripe treats as VAT-inclusive.
  return { source: "stripe", amountLabel: offer.amountLabel, period: "month", vatInclusive: true };
}

export function subscribePriceLine(price: DisplayPrice | null): string | null {
  if (!price) return null;
  return price.vatInclusive ? `${price.amountLabel}/month, including VAT` : `${price.amountLabel}/month`;
}

export const PRICE_PENDING_NOTE = "You'll see the monthly price, including VAT, before you pay.";

// The button always states the obligation to pay (Consumer Contracts
// Regulations 2013, reg. 14(3)) — with the amount when it is known, and
// without one otherwise. On iOS the button is also disabled until StoreKit's
// price has loaded. (Android has no pay button: Option C, below.)
export const PAY_BUTTON_WITHOUT_AMOUNT = "Subscribe & pay now";

export function subscribeButtonLabel(price: DisplayPrice | null): string {
  return price ? `Subscribe & pay ${price.amountLabel}/month now` : PAY_BUTTON_WITHOUT_AMOUNT;
}

// ---------------------------------------------------------------------------
// Android Option C: consumption-only app (WS4, 2026-10-10).
//
// Google Play Payments policy (sections 2 and 4) forbids an Android app from
// selling a subscription outside Play Billing or steering to another payment
// method: no Stripe Checkout, no Billing Portal (it can take a new card), no
// buttons, links, QR codes or prices that lead to web checkout. Until Play
// Billing via RevenueCat is built (Option A), the Android app is
// consumption-only: customers subscribe on the website, then sign in here.
// Google's own consumption-only FAQ allows plain information "without direct
// links" (its example: "Head to our website to purchase more").
// docs/launch/2026-10-09-ANDROID-COMPLIANT-PAYMENTS.md §3.
//
// iOS is unchanged: StoreKit purchase, Apple subscription settings, and the
// existing Billing Portal for a web-billed customer.
//
// Guarded by tests/android-option-c-consumption-only.test.mjs: none of the
// copy below may contain an amount, a URL scheme or "cheaper" wording, and no
// Android-reachable screen may call Stripe Checkout or the Billing Portal.
// ---------------------------------------------------------------------------

/** The only platform on which this app may take payment (StoreKit). */
export function canPurchaseInApp(platformOS: string): boolean {
  return platformOS === "ios";
}

/** Whether the Membership card may show the household's own price label. */
export function showsMembershipPriceInApp(platformOS: string): boolean {
  return platformOS === "ios";
}

export type MembershipManagement =
  | { kind: "apple_settings" } // iOS, Apple-billed: Apple's subscription settings
  | { kind: "stripe_portal" } // iOS only, web-billed: the existing Billing Portal
  | { kind: "apple_billed_text" } // Android, Apple-billed: plain text only
  | { kind: "website_text"; paymentIssue: boolean } // Android, web-billed: plain text + email support
  | { kind: "none" }; // nothing to manage (complimentary etc.)

export function membershipManagement(input: {
  platformOS: string;
  billingSource?: string | null;
  manageable?: boolean;
  status?: string | null;
}): MembershipManagement {
  const appleBilled = input.billingSource === "apple_revenuecat";
  if (input.platformOS === "ios") {
    if (appleBilled) return { kind: "apple_settings" };
    return input.manageable ? { kind: "stripe_portal" } : { kind: "none" };
  }
  // Every other platform (the shipped one is Android): never a portal.
  if (appleBilled) return { kind: "apple_billed_text" };
  if (input.manageable) return { kind: "website_text", paymentIssue: input.status === "payment_issue" };
  return { kind: "none" };
}

// Plain text only. The domain is written as words in a <Text>, never a link,
// never selectable (Android's text-selection toolbar can offer "Open" for a
// URL), and there is no price, button or QR code that leads to checkout.
export const CONSUMPTION_ONLY_COPY = Object.freeze({
  noMembershipTitle: "Membership",
  noMembershipBody: "This account doesn't have an active membership yet.",
  websiteNote: "Membership is set up on our website, homecallguard.co.uk.",
  afterWebsiteNote:
    "Once your membership is active, sign in here with the same email address and we'll continue setting up your protection.",
  checkAgainLabel: "Check my membership again",
  stillNoMembership: "We couldn't find an active membership for this account yet.",
  billedOnWebsite: "Billed through our website",
  manageOnWebsite:
    "Your membership is billed through our website. To change or cancel it, sign in to your account on our website, homecallguard.co.uk, or email support@homecallguard.co.uk and we'll do it for you.",
  paymentIssueOnWebsite:
    "There's a problem with your last payment. To update your payment details, sign in to your account on our website, homecallguard.co.uk, or email support@homecallguard.co.uk.",
  forwardingReminder:
    "Cancelling doesn't switch off call forwarding on your phone. When your protection ends, turn call forwarding off (Account → “Need to turn protection off?” shows you how).",
  appleBilledOnAndroid:
    "This membership is billed through Apple. To change or cancel it, use Settings → your name → Subscriptions on your iPhone, or email support@homecallguard.co.uk.",
  emailSupportLabel: "Email support",
});

export const SUPPORT_EMAIL_ADDRESS = "support@homecallguard.co.uk";
