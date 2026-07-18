const express = require("express");
const { version: APP_VERSION } = require("../package.json");
const { requireAuth } = require("../middleware/requireAuth");
const { stripe } = require("../services/stripeClient");
const { getHouseholdByAuthUserId } = require("../database/households");
const {
  setHouseholdStripeCustomerId,
  getHouseholdByStripeCustomerId,
  claimWebhookEvent,
  processWebhookEvent,
  getActiveEntitlement,
} = require("../database/billing");

const router = express.Router();

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

// SUBSCRIBE (exception-list route: requires auth, deliberately NOT
// requireEntitlement — an unsubscribed household must be able to reach
// this to ever become subscribed).
router.post("/billing/create-checkout-session", requireAuth, async (req, res) => {
  if (!stripe) {
    console.error("CHECKOUT SESSION ERROR: STRIPE_SECRET_KEY not configured");
    return res.redirect("/dashboard?checkout=error");
  }

  // Fail clearly before ever calling Stripe, rather than letting an
  // undefined/empty price fall through to the API and surface as a
  // generic error from the catch-all below. buildStripeMetadata()'s own
  // "unknown" fallback is for descriptive metadata only — it must never
  // be read as license to let Checkout itself proceed without a real price.
  if (!process.env.STRIPE_PRICE_ID) {
    console.error("CHECKOUT SESSION ERROR: STRIPE_PRICE_ID not configured");
    return res.redirect("/dashboard?checkout=error");
  }

  try {
    const existingEntitlement = await getActiveEntitlement(req.household.id);
    if (existingEntitlement) {
      // Already protected — don't let a second Checkout Session be started
      // for a household that's already subscribed.
      return res.redirect("/dashboard");
    }

    const stripeCustomerId = await resolveStripeCustomerId(req.household, req.authUserId);

    // Catches what getActiveEntitlement() above cannot: a Checkout Session
    // already completed and paid, but whose webhook hasn't been processed
    // yet (delayed, or dropped entirely — see
    // docs/releases/2026-07-18_RC1.md for the incident this closes).
    // Queries Stripe directly rather than our own webhook-populated DB,
    // since that DB state is exactly what's unreliable in this window.
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
    });

    if (hasQualifyingStripeSubscription(existingSubscriptions.data)) {
      return res.redirect("/dashboard");
    }

    // This idempotency key protects against the client retrying this exact
    // request (e.g. a network timeout firing the same submission twice)
    // within the same 5-minute window — it is NOT a defense against a
    // deliberate second checkout attempt minutes apart (that's what the
    // existing-subscription check above exists to catch; it's what missed
    // this in the 2026-07-18 incident, since both attempts fell in
    // different 5-minute buckets despite being under 4 minutes apart).
    const fiveMinuteBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const idempotencyKey = `checkout:${req.household.id}:${fiveMinuteBucket}`;

    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        client_reference_id: req.household.id,
        metadata: buildStripeMetadata(req.household.id),
        subscription_data: {
          metadata: buildStripeMetadata(req.household.id),
        },
        success_url: `${process.env.APP_URL}/dashboard?checkout=success`,
        cancel_url: `${process.env.APP_URL}/dashboard?checkout=cancelled`,
      },
      { idempotencyKey }
    );

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("CHECKOUT SESSION ERROR:", err.message);
    return res.redirect("/dashboard?checkout=error");
  }
});

// WEBHOOK (exception-list route: no requireAuth at all — Stripe has no
// household session. Signature verification is the entire security
// boundary here, which is why the raw body parser below is scoped to only
// this one path rather than applied globally.)
router.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      console.error("WEBHOOK ERROR: STRIPE_SECRET_KEY not configured");
      return res.status(500).send("Stripe not configured");
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("WEBHOOK SIGNATURE VERIFICATION FAILED:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const HANDLED_TYPES = new Set([
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]);

    if (!HANDLED_TYPES.has(event.type)) {
      // Nothing to do — acknowledge quickly rather than let Stripe retry
      // an event type this app doesn't act on.
      return res.sendStatus(200);
    }

    const subscription = event.data.object;
    const stripeCustomerId = subscription.customer;

    let householdId = subscription.metadata?.household_id || null;
    if (!householdId) {
      const household = await getHouseholdByStripeCustomerId(stripeCustomerId);
      householdId = household?.id || null;
    }

    try {
      const claimed = await claimWebhookEvent({
        stripeEventId: event.id,
        eventType: event.type,
        stripeCustomerId,
        householdId,
        payload: event,
      });

      if (!claimed) {
        // Already processed/ignored (done), or another attempt currently
        // owns it — either way, nothing further to do right now.
        return res.sendStatus(200);
      }

      const result = await processWebhookEvent({
        stripeEventId: event.id,
        householdId,
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
        stripePriceId: subscription.items?.data?.[0]?.price?.id || null,
        subscriptionStatus: subscription.status,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
        cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      });

      if (result === "processed") {
        return res.sendStatus(200);
      }

      // 'failed' is already durably recorded on the event row by the RPC
      // itself — a non-2xx here just lets Stripe's own retry schedule (in
      // addition to this table's own stale-claim recovery) try again.
      console.error("WEBHOOK EVENT PROCESSING FAILED:", event.id, event.type);
      return res.status(500).send("processing failed");
    } catch (err) {
      console.error("WEBHOOK HANDLER ERROR:", err.message);
      return res.status(500).send("internal error");
    }
  }
);

// Attached to the router (not a separate export) so server.js's existing
// `require("./routes/billing")` usage — mounting the router directly — is
// unaffected; tests reach it as `require("../routes/billing").hasQualifyingStripeSubscription`.
router.hasQualifyingStripeSubscription = hasQualifyingStripeSubscription;

module.exports = router;
