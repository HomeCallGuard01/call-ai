// Subscription price display — one source of truth per billing channel
// (2026-09-30, iOS 1.0.2 preparation).
//
// Nothing in this file decides or hard-codes what Home Call Guard costs.
// It only DESCRIBES a price that already exists in the system that actually
// charges the customer:
//
//   - Stripe (web + Android today): the Stripe Price object. New customers
//     see the Price that STRIPE_PRICE_ID points at; an existing customer
//     sees the Price on THEIR OWN subscription row (subscriptions.
//     stripe_price_id), so a customer kept on an earlier price is never
//     shown a newer one.
//   - Apple (iOS): the app reads the price from StoreKit itself
//     (mobile/lib/subscriptionPrice.ts). The backend does not store what an
//     Apple subscriber pays, so it never states an amount for them; it
//     points them to their Apple subscription settings instead.
//   - Complimentary / trial / staff access: no amount is shown, because
//     none is charged.
//
// Fail-closed rule: if a price can't be read, or doesn't look like a
// VAT-inclusive monthly GBP price, the functions here return null and the
// caller shows wording with NO amount. A wrong amount is never shown, and
// nothing falls back to a remembered figure.

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

function formatGbpMinor(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return null;
  const pounds = Math.floor(amountMinor / 100);
  const pence = String(amountMinor % 100).padStart(2, "0");
  return `£${pounds.toLocaleString("en-GB")}.${pence}`;
}

// Stripe Price object -> display description, or null when it isn't a
// price this app can describe truthfully as "£X per month including VAT".
function describeStripePrice(price) {
  if (!price || typeof price !== "object") return null;
  if (price.currency !== "gbp") return null;
  const recurring = price.recurring;
  if (!recurring || recurring.interval !== "month") return null;
  if ((recurring.interval_count ?? 1) !== 1) return null;
  // UK consumer prices must be shown VAT-inclusive. Only a Price Stripe
  // itself treats as tax-inclusive can be labelled "including VAT".
  if (price.tax_behavior !== "inclusive") return null;
  const amountLabel = formatGbpMinor(price.unit_amount);
  if (!amountLabel) return null;

  return {
    channel: "stripe",
    priceId: price.id || null,
    amountMinor: price.unit_amount,
    currency: "gbp",
    interval: "month",
    amountLabel,
    priceLabel: `${amountLabel} per month including VAT`,
  };
}

// Cached Stripe Price reader. Successful reads are cached per Price ID
// (Prices are immutable in Stripe, so a cached amount can't go stale; a
// deploy that switches STRIPE_PRICE_ID simply reads a different ID).
// Failures are not cached, so a transient Stripe error recovers on the
// next request.
function createStripePriceLookup({ stripe, ttlMs = DEFAULT_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map();

  return async function lookupStripePrice(priceId) {
    if (!stripe || typeof priceId !== "string" || !priceId) return null;

    const hit = cache.get(priceId);
    if (hit && now() - hit.at < ttlMs) return hit.value;

    try {
      const price = await stripe.prices.retrieve(priceId);
      const value = describeStripePrice(price);
      if (!value) {
        console.error(`SUBSCRIPTION PRICING: Stripe price ${priceId} is not a VAT-inclusive monthly GBP price; not displayed`);
        return null;
      }
      cache.set(priceId, { at: now(), value });
      return value;
    } catch (err) {
      console.error("SUBSCRIPTION PRICING: STRIPE PRICE FETCH ERROR:", err && err.message);
      return null;
    }
  };
}

// The price a NEW Stripe customer would pay right now.
async function getCurrentStripeOffer(lookupStripePrice, priceId = process.env.STRIPE_PRICE_ID) {
  return lookupStripePrice(priceId);
}

// API payload for GET /api/v1/billing/offer and GET /billing/offer.
function buildOfferResponse(offer) {
  if (!offer) return { available: false, channel: "stripe" };
  return {
    available: true,
    channel: "stripe",
    amountMinor: offer.amountMinor,
    currency: offer.currency,
    interval: offer.interval,
    amountLabel: offer.amountLabel,
    priceLabel: offer.priceLabel,
  };
}

const MEMBERSHIP_LABELS = Object.freeze({
  appleBilled: "Billed monthly by Apple. Your price is shown in your Apple subscription settings.",
  stripeUnknown: "Billed monthly. Your price is shown under Manage membership.",
  otherPaid: "Monthly membership",
  freeTrial: "No charge during your free trial",
  noCharge: "No charge for your current membership",
});

// Membership card label for THIS household's own subscription — never a
// global list price. `subscriptionPrice` is describeStripePrice() of the
// household's own subscriptions.stripe_price_id (or null).
function buildMembershipPriceLabel({ entitlement, subscriptionPrice }) {
  const type = entitlement && entitlement.entitlement_type;
  const source = entitlement && entitlement.source;

  if (type === "free_trial") return MEMBERSHIP_LABELS.freeTrial;
  if (type !== "paid_subscription") return MEMBERSHIP_LABELS.noCharge;
  if (source === "apple_revenuecat") return MEMBERSHIP_LABELS.appleBilled;
  if (source === "stripe") {
    return subscriptionPrice ? subscriptionPrice.priceLabel : MEMBERSHIP_LABELS.stripeUnknown;
  }
  return MEMBERSHIP_LABELS.otherPaid;
}

// Convenience used by both dashboard routes: looks up the household's own
// Stripe price only when its membership is actually Stripe-billed.
async function resolveMembershipPriceLabel({ entitlement, subscription, lookupStripePrice }) {
  let subscriptionPrice = null;
  if (
    entitlement &&
    entitlement.entitlement_type === "paid_subscription" &&
    entitlement.source === "stripe" &&
    subscription &&
    subscription.stripe_price_id
  ) {
    subscriptionPrice = await lookupStripePrice(subscription.stripe_price_id);
  }
  return buildMembershipPriceLabel({ entitlement, subscriptionPrice });
}

// Price-agnostic Stripe Checkout disclosure. Stripe Checkout itself shows
// the real amount of the Price being charged on the same page, so this text
// never needs to repeat a figure (and so can never contradict it).
const CHECKOUT_SUBMIT_MESSAGE =
  "You'll be charged the amount shown on this page today, then the same amount every month until you cancel. " +
  "By continuing, you agree to Home Call Guard's Terms and Conditions and Privacy Policy.";

// Express handler shared by the web (cookie session) and app (bearer token)
// routes. Auth is applied by the route; this handler only reads a public
// price. Always 200: `available: false` tells the client to show wording
// with no amount (it must never substitute a figure of its own).
function createOfferHandler(getLookup = getSharedStripePriceLookup) {
  return async function offerHandler(req, res) {
    const offer = await getCurrentStripeOffer(getLookup());
    res.set("Cache-Control", "no-store");
    return res.json(buildOfferResponse(offer));
  };
}

// Shared process-wide lookup for the real routes.
let sharedLookup = null;
function getSharedStripePriceLookup() {
  if (!sharedLookup) {
    const { stripe } = require("./stripeClient");
    sharedLookup = createStripePriceLookup({ stripe });
  }
  return sharedLookup;
}

module.exports = {
  formatGbpMinor,
  describeStripePrice,
  createStripePriceLookup,
  getCurrentStripeOffer,
  buildOfferResponse,
  buildMembershipPriceLabel,
  resolveMembershipPriceLabel,
  getSharedStripePriceLookup,
  createOfferHandler,
  MEMBERSHIP_LABELS,
  CHECKOUT_SUBMIT_MESSAGE,
};
