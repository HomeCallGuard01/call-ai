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
const { updateTwilioNumberForEntitlementChange } = require("../services/twilioProvisioning");

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

// Shared Checkout Session creation params so every session this app ever
// creates — fresh or reconciled-against-later — collects a billing address
// and requires Terms of Service consent, and shows the same explicit
// recurring-billing wording. Centralized so a future second call site can't
// silently drift from this (see docs/PROJECT_STATUS.md, "payment-completion
// flow rebuild").
function buildCheckoutSessionParams({ customer, priceId, householdId, appUrl }) {
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
    success_url: `${appUrl}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/dashboard?checkout=cancelled`,
  };
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
      // for a household that's already subscribed. Explicit query param
      // (rather than a bare redirect) so the dashboard can tell the
      // customer *why* nothing happened instead of silently bouncing them
      // back to the same page — this confusing-with-no-explanation bounce
      // was one of the reported payment-completion-flow problems.
      return res.redirect("/dashboard?checkout=already_active");
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
      return res.redirect("/dashboard?checkout=already_active");
    }

    // Catches what the subscription check above cannot: a Checkout Session
    // already opened but not yet paid or abandoned. Filtered server-side by
    // Stripe (status: "open") as well as by findReusableOpenCheckoutSession
    // itself, so a completed or expired session never blocks a new attempt.
    const openCheckoutSessions = await stripe.checkout.sessions.list({
      customer: stripeCustomerId,
      status: "open",
      limit: 10,
    });

    const reusableSession = findReusableOpenCheckoutSession(openCheckoutSessions.data);
    if (reusableSession) {
      // Send the customer back to the same session rather than starting a
      // new one — a session's url can be absent once it's no longer usable
      // for redirect (Stripe's docs note this can be null after the session
      // is no longer in a state to be visited), so fall back to a clear
      // dashboard message rather than risk redirecting to `undefined`.
      if (reusableSession.url) {
        return res.redirect(303, reusableSession.url);
      }
      return res.redirect("/dashboard?checkout=pending");
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
      buildCheckoutSessionParams({
        customer: stripeCustomerId,
        priceId: process.env.STRIPE_PRICE_ID,
        householdId: req.household.id,
        appUrl: process.env.APP_URL,
      }),
      { idempotencyKey }
    );

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("CHECKOUT SESSION ERROR:", err.message);
    return res.redirect("/dashboard?checkout=error");
  }
});

// RECONCILE (requires auth): bounded fallback for when the webhook is
// delayed or was never delivered — see docs/PROJECT_STATUS.md, "payment-
// completion flow rebuild" for the incident this closes (no webhook
// endpoint was ever registered against production, so the dashboard never
// updated after a real successful payment). The frontend polls this after
// returning from Checkout with a session_id, using the exact same
// claim/process pair the real webhook uses (see the WEBHOOK route below) —
// so if the webhook does eventually arrive too, both paths converge on the
// same idempotent DB writes rather than double-applying anything.
router.get("/billing/reconcile-session", requireAuth, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ status: "error", message: "Stripe not configured" });
  }

  const sessionId = req.query.session_id;
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_")) {
    return res.status(400).json({ status: "error", message: "invalid session_id" });
  }

  try {
    // Already reconciled — by this endpoint on an earlier poll, or by the
    // real webhook arriving in the meantime. Check first so a repeatedly
    // polling client doesn't do redundant Stripe lookups once it's done.
    const alreadyEntitled = await getActiveEntitlement(req.household.id);
    if (alreadyEntitled) {
      // A household can be entitled but still missing a Twilio number if
      // an earlier provisioning attempt failed — this route is polled
      // repeatedly right after checkout (and the dashboard keeps polling
      // afterwards), so it doubles as a natural, no-new-infrastructure
      // retry point rather than requiring a separate scheduled job. Also
      // cancels any pending release, in case this reactivation landed
      // just before an earlier cancellation's grace-period deadline.
      await updateTwilioNumberForEntitlementChange(req.household, true);
      return res.json({ status: "active" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // A household may only reconcile its own Checkout Session — never
    // trust a client-supplied session_id to belong to the caller without
    // checking it against the household's own resolved Stripe customer.
    if (!req.household.stripe_customer_id || session.customer !== req.household.stripe_customer_id) {
      return res.status(403).json({ status: "error", message: "forbidden" });
    }

    if (!isSessionPaidWithSubscription(session)) {
      return res.json({ status: "pending" });
    }

    const subscription = await stripe.subscriptions.retrieve(session.subscription);

    const claimed = await claimWebhookEvent({
      stripeEventId: `reconcile:${subscription.id}`,
      eventType: "checkout.session.reconciled",
      stripeCustomerId: subscription.customer,
      householdId: req.household.id,
      payload: { reconciledFromSession: sessionId, subscription },
    });

    if (claimed) {
      await processWebhookEvent({
        stripeEventId: `reconcile:${subscription.id}`,
        householdId: req.household.id,
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        stripePriceId: subscription.items?.data?.[0]?.price?.id || null,
        subscriptionStatus: subscription.status,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
        cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      });
    }

    const nowEntitled = await getActiveEntitlement(req.household.id);
    if (nowEntitled) {
      await updateTwilioNumberForEntitlementChange(req.household, true);
    }
    return res.json({ status: nowEntitled ? "active" : "pending" });
  } catch (err) {
    console.error("RECONCILE SESSION ERROR:", err.message);
    return res.status(500).json({ status: "error" });
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
        // Provisioning/release failure must never affect the webhook's
        // own success — updateTwilioNumberForEntitlementChange never
        // throws and always resolves, recording its own failure/retry
        // state independently of the subscription/entitlement this event
        // just changed. Covers both directions: activation (provision a
        // number, or cancel a pending release if reactivating before its
        // deadline) and genuine termination (start the grace-period
        // clock on an existing number) — see migrations/017's header for
        // why cancellation gets a grace period rather than an immediate
        // release.
        if (householdId) {
          const entitlement = await getActiveEntitlement(householdId);
          const household = await getHouseholdByStripeCustomerId(stripeCustomerId);
          if (household) {
            await updateTwilioNumberForEntitlementChange(household, !!entitlement);
          }
        }
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
router.findReusableOpenCheckoutSession = findReusableOpenCheckoutSession;
router.isSessionPaidWithSubscription = isSessionPaidWithSubscription;
router.buildCheckoutSessionParams = buildCheckoutSessionParams;

module.exports = router;
