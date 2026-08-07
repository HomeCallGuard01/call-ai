// Extracted from routes/billing.js (mobile app Phase 2) so the web
// /billing/create-checkout-session route and the new mobile
// /api/v1/billing/create-checkout-session route share exactly one
// implementation of the checkout-session creation/reuse logic, rather
// than risking the two silently drifting apart. Logic is unchanged from
// the original inline functions except for one deliberate generalisation
// (see buildCheckoutSessionParams below) required to serve both a web
// redirect flow and a mobile deep-link flow.
const { version: APP_VERSION } = require("../package.json");
const { stripe } = require("./stripeClient");
const { setHouseholdStripeCustomerId } = require("../database/billing");
const { getHouseholdByAuthUserId } = require("../database/households");

const QUALIFYING_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

// Pure so it's directly unit-testable without mocking Stripe or Express —
// see tests/checkout-existing-subscription.test.mjs.
//
// past_due blocks a new Checkout Session here for a different reason than
// it grants an entitlement in process_stripe_webhook_event (013/015): that
// RPC's qualifying set is about whether app access continues during a
// payment retry, a decision already made and untouched by this function.
// This set is purely about not creating a second real Stripe subscription
// while dunning/retries are still live on the first one — a past_due
// subscription is still a real, active billing relationship, and starting
// a second one alongside it risks a genuine double charge if both later
// succeed. Normally getActiveEntitlement() above already redirects before
// this runs (the entitlement created when the subscription first went
// active isn't touched by a later past_due transition) — this exists for
// the narrow window where that webhook hasn't been processed yet, exactly
// the class of gap this whole check was added to close.
//
// unpaid remains deliberately excluded: it's Stripe's terminal
// dunning-exhausted state, not an active retry in progress, and whether a
// lapsed household should be allowed to start completely fresh is a product
// decision this function does not make silently.
function hasQualifyingStripeSubscription(subscriptions) {
  return subscriptions.some((s) => QUALIFYING_SUBSCRIPTION_STATUSES.has(s.status));
}

// Pure so it's directly unit-testable without mocking Stripe — see
// tests/checkout-existing-subscription.test.mjs.
//
// Closes the abandoned/still-open-checkout gap: a Checkout Session that's
// been created but never paid has no Subscription object at all (Stripe
// only creates one on successful payment), so hasQualifyingStripeSubscription
// above cannot see it. Without this, a household that opened Checkout and
// didn't finish — got distracted, closed the tab, thought it failed — then
// tried again later would sail through both existing checks and get a
// second, independent Checkout Session, the same shape of duplicate as the
// 2026-07-18 incident, just relocated to before payment instead of after it.
//
// Only Stripe's own "open" status is treated as reusable — "complete" and
// "expired" are both terminal and must never block a fresh attempt.
function findReusableOpenCheckoutSession(sessions) {
  return sessions.find((s) => s.status === "open") || null;
}

// Pure — see tests/checkout-existing-subscription.test.mjs. A session can be
// "complete" (Checkout itself finished) without yet having a usable
// subscription record on it (Stripe attaches the subscription synchronously
// on payment, but this still guards the shape rather than assuming it).
function isSessionPaidWithSubscription(session) {
  return !!session && session.payment_status === "paid" && !!session.subscription;
}

// Shared identifying metadata, applied consistently to the Customer, the
// Checkout Session, and (via subscription_data.metadata) the Subscription —
// Stripe does not propagate metadata between these automatically, and each
// is inspectable independently in the dashboard / on its own webhook event
// object, so each needs its own copy rather than relying on one to carry
// the others. All values are strings, as Stripe metadata requires.
// Deliberately no acquisition-source/marketing attribution fields yet —
// that belongs to the future website/marketing attribution work, not here.
function buildStripeMetadata(householdId) {
  return {
    household_id: String(householdId),
    environment: process.env.NODE_ENV || "development",
    app_version: APP_VERSION,
    stripe_price_id: process.env.STRIPE_PRICE_ID || "unknown",
  };
}

// Shared Checkout Session creation params so every session this app ever
// creates — fresh or reconciled-against-later — collects a billing address
// and requires Terms of Service consent, and shows the same explicit
// recurring-billing wording. Centralized so a future second call site can't
// silently drift from this (see docs/PROJECT_STATUS.md, "payment-completion
// flow rebuild").
//
// Takes successUrl/cancelUrl directly (generalised from an earlier version
// that built `${appUrl}/dashboard?...` internally) specifically so this one
// function can serve both the web route (a real page URL) and the mobile
// route (a homecallguard:// deep link the app's in-app browser session
// detects to close itself) — see routes/billing.js and routes/mobileApi.js
// for each caller's own URL construction. Every other param, and every
// other value in this object, is unchanged from the original.
function buildCheckoutSessionParams({ customer, priceId, householdId, successUrl, cancelUrl }) {
  return {
    mode: "subscription",
    customer,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: householdId,
    metadata: buildStripeMetadata(householdId),
    subscription_data: {
      metadata: buildStripeMetadata(householdId),
    },
    billing_address_collection: "required",
    // consent_collection: { terms_of_service: "required" } is NOT enabled
    // yet — Stripe rejects it outright ("You cannot collect consent to
    // your terms of service unless a URL is set in the Stripe Dashboard"),
    // confirmed by attempting a real session creation. Requires setting a
    // Terms of Service URL under Settings → Public business details in the
    // Stripe Dashboard first (not settable via the API) — see
    // docs/PROJECT_STATUS.md. Until then, the custom_text.submit message
    // below is the only ToS/recurring-billing disclosure shown.
    custom_text: {
      submit: {
        message:
          "You'll be charged £4.99 today, then £4.99 every month until you cancel. By continuing, you agree to Home Call Guard's Terms and Conditions and Privacy Policy.",
      },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
}

// A stripe_customer_id write lost the race in setHouseholdStripeCustomerId
// (see below) if the RPC's specific "already has a different value" message
// comes back — distinct from its "household does not exist" message, which
// should surface as a real error instead of being silently recovered from.
function isCustomerIdRaceRejection(err) {
  return typeof err?.message === "string" && err.message.includes("already has stripe_customer_id");
}

// Resolves (creating if necessary) the Stripe Customer for a household,
// handling the concurrent-first-checkout race: if two requests both see a
// null stripe_customer_id and both create a Stripe Customer, only one write
// can win the RPC's row lock (see set_household_stripe_customer_id's own
// comment in supabase/migrations/013_stripe_billing_rpc_functions.sql).
// The loser re-reads the now-set value and reuses it instead of failing —
// the Stripe Customer it created is simply never used again.
async function resolveStripeCustomerId(household, authUserId) {
  if (household.stripe_customer_id) {
    return household.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: household.email,
    metadata: buildStripeMetadata(household.id),
  });

  try {
    await setHouseholdStripeCustomerId(household.id, customer.id);
    return customer.id;
  } catch (err) {
    if (isCustomerIdRaceRejection(err)) {
      const fresh = await getHouseholdByAuthUserId(authUserId);
      if (fresh?.stripe_customer_id) {
        return fresh.stripe_customer_id;
      }
    }
    throw err;
  }
}

module.exports = {
  hasQualifyingStripeSubscription,
  findReusableOpenCheckoutSession,
  isSessionPaidWithSubscription,
  buildStripeMetadata,
  buildCheckoutSessionParams,
  isCustomerIdRaceRejection,
  resolveStripeCustomerId,
};
