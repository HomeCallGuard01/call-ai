const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { stripe } = require("../services/stripeClient");
const { getHouseholdByAuthUserId } = require("../database/households");
const {
  getHouseholdByStripeCustomerId,
  claimWebhookEvent,
  processWebhookEvent,
  getActiveEntitlement,
} = require("../database/billing");
const {
  updateTwilioNumberForEntitlementChange,
  handleProcessedWebhookEvent,
} = require("../services/twilioProvisioning");
const {
  hasQualifyingStripeSubscription,
  findReusableOpenCheckoutSession,
  isSessionPaidWithSubscription,
  buildCheckoutSessionParams,
  resolveStripeCustomerId,
} = require("../services/checkoutSession");

const router = express.Router();

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
        successUrl: `${process.env.APP_URL}/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${process.env.APP_URL}/dashboard?checkout=cancelled`,
      }),
      { idempotencyKey }
    );

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("CHECKOUT SESSION ERROR:", err.message);
    return res.redirect("/dashboard?checkout=error");
  }
});

// MANAGE MEMBERSHIP (requires auth): the customer's Stripe Customer ID
// comes only from req.household.stripe_customer_id, resolved server-side
// from the verified session (requireAuth) — never from anything
// client-supplied, so a request can only ever open the portal for the
// caller's own household. No billing logic (cancel/update payment method/
// invoices) lives in this app at all; the Billing Portal is entirely
// Stripe's own hosted UI, and Stripe's webhook remains the only thing
// that ever writes subscription/entitlement state back into this app.
router.post("/billing/manage-membership", requireAuth, async (req, res) => {
  if (!stripe) {
    console.error("PORTAL SESSION ERROR: STRIPE_SECRET_KEY not configured");
    return res.redirect("/dashboard?membership=error");
  }

  if (!req.household.stripe_customer_id) {
    // Complimentary/founding/promotional/staff access has no real Stripe
    // subscription behind it to manage — nothing to redirect to.
    return res.redirect("/dashboard?membership=not_manageable");
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.household.stripe_customer_id,
      return_url: `${process.env.APP_URL}/dashboard`,
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("PORTAL SESSION ERROR:", err.message);
    return res.redirect("/dashboard?membership=error");
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
        // A live GET straight from Stripe's API right now is always at
        // least as fresh as any past webhook event for this subscription,
        // so "now" is the correct ordering value here — this path has no
        // real Stripe Event object to take a timestamp from at all.
        stripeEventCreated: new Date().toISOString(),
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
        // The real Stripe Event's own creation time (Unix seconds) —
        // Stripe includes this on every event, always; this is what lets
        // the RPC tell an out-of-order delivery apart from a genuinely
        // newer state change for the same subscription.
        stripeEventCreated: new Date(event.created * 1000).toISOString(),
      });

      if (result === "processed" || result === "ignored_stale") {
        // Provisioning/release failure must never affect the webhook's
        // own success — handleProcessedWebhookEvent never throws and
        // always resolves, recording its own failure/retry state
        // independently of the subscription/entitlement this event just
        // changed. Covers both directions: activation (provision a
        // number, or cancel a pending release if reactivating before its
        // deadline) and genuine termination (start the grace-period
        // clock on an existing number) — see migrations/017's header for
        // why cancellation gets a grace period rather than an immediate
        // release.
        //
        // Deliberately derives intent from THIS event's own
        // subscription.status (2026-08-22 fix) rather than a fresh
        // getActiveEntitlement() re-read — see
        // services/twilioProvisioning.js's handleWebhookProvisioningDecision
        // for the full race-condition history this replaces (confirmed
        // live: household 816b3f10-217a-43f2-b242-e3f8ba44fd95's
        // subscription/entitlement synced correctly on 2026-08-22 but
        // twilio_number stayed null, attempts stayed 0, with no error
        // anywhere).
        //
        // 'ignored_stale' (migrations/027) is passed through deliberately,
        // not filtered out here — handleProcessedWebhookEvent is the one
        // place that decides a stale/out-of-order event must not act on
        // its own subscription.status at all, so a late-arriving older
        // event can never override the state an already-accepted newer
        // event just established.
        await handleProcessedWebhookEvent(
          result,
          {
            householdId,
            eventType: event.type,
            subscriptionStatus: subscription.status,
            stripeCustomerId,
          },
          { getHouseholdByStripeCustomerId }
        );
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


module.exports = router;
