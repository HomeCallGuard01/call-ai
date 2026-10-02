// Subscription price shown on the Subscribe screen (2026-09-30).
//
// The app never contains a subscription amount of its own. Each platform
// shows the price of the system that actually charges the customer:
//   - iOS: StoreKit's own localised price for the App Store product
//     (RevenueCat PurchasesStoreProduct.priceString), so the screen always
//     matches Apple's payment sheet, including after a price change in
//     App Store Connect, with no app update.
//   - Android: the backend's description of the current Stripe Price
//     (GET /api/v1/billing/offer, services/subscriptionPricing.js).
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
// price has loaded; on Android, Stripe Checkout shows the amount before
// payment.
export const PAY_BUTTON_WITHOUT_AMOUNT = "Subscribe & pay now";

export function subscribeButtonLabel(price: DisplayPrice | null): string {
  return price ? `Subscribe & pay ${price.amountLabel}/month now` : PAY_BUTTON_WITHOUT_AMOUNT;
}
