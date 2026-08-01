// Mobile app API surface (Phase 0/2 backend work, docs/mobile-app/
// APP_DECISION_005). Namespaced under /api/v1 so mobile traffic is
// trivially distinguishable from the web app's page/route traffic in
// logs and metrics (a gap explicitly flagged in CODEBASE_AUDIT.md).
//
// Deliberately thin: every route here calls the exact same
// database/*.js functions the web app already uses. No new business
// logic is introduced — only a bearer-token-authenticated, JSON-native
// route layer suited to a mobile client, per APP_DECISION_005's stated
// scope ("existing query logic... fully reusable; only the route layer
// wrapping them needs a mobile-appropriate variant").
const express = require("express");
const { requireAuthApi, verifyBearerToken } = require("../middleware/requireAuthApi");
const { requireEntitlement } = require("../middleware/requireEntitlement");
const { getContacts, insertContacts, updateContact, deleteContact } = require("../database/contacts");
const { getSubscriptionByHouseholdId, getActiveEntitlement } = require("../database/billing");
const { getCallsToday, getRecentCalls, toClientCall } = require("../database/calls");
const { markActivationVerified } = require("../database/households");
const { ensureHouseholdAndRole } = require("../services/householdBootstrap");
const { buildUserScopedClient } = require("../services/supabaseClients");
const { normaliseNumber } = require("../services/phone");
const { isCallWithinVerificationWindow } = require("../services/activationVerification");
const { stripe } = require("../services/stripeClient");
const {
  hasQualifyingStripeSubscription,
  findReusableOpenCheckoutSession,
  buildCheckoutSessionParams,
  resolveStripeCustomerId,
} = require("../services/checkoutSession");
const {
  DEVICE_TYPES,
  LANDLINE_PROVIDERS,
  buildActivationInstructions,
} = require("../services/activationInstructions");

const router = express.Router();

// Must match app.json's "scheme" in mobile/ — the in-app browser session
// (Expo WebBrowser.openAuthSessionAsync) detects a redirect to this
// custom scheme and closes itself, returning control to the app; the web
// route's equivalent redirects to a real page (routes/billing.js).
const MOBILE_CHECKOUT_SUCCESS_URL = "homecallguard://setup/subscribe?checkout=success";
const MOBILE_CHECKOUT_CANCEL_URL = "homecallguard://setup/subscribe?checkout=cancelled";
const MOBILE_PORTAL_RETURN_URL = "homecallguard://account/membership";

// Scoped to this router only, never applied globally — routes/billing.js's
// /billing/webhook route deliberately parses its own raw body for Stripe
// signature verification (also application/json content-type); a global
// JSON parser mounted ahead of it would silently consume that raw body
// and break signature verification. Scoping here means mount order
// elsewhere in server.js can never introduce that hazard.
router.use(express.json());

// A real native iOS/Android app is never subject to CORS at all — it's a
// browser-only enforcement mechanism — so this was never required for
// the app itself to work. It's added anyway because it's the standard,
// widely-used Expo development workflow (`expo start --web`) to visually
// iterate on a React Native app in a browser before testing on a real
// device/simulator, and every route on this router already requires a
// real bearer token (verified server-side, never a browser-supplied
// cookie) — permissive CORS doesn't introduce CSRF exposure here the way
// it would on a cookie-authenticated API, since a cross-origin page has
// no way to read or forge another site's bearer token just because CORS
// allows the request through.
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Every response on this router carries per-user entitlement/subscription
// state — without this, nothing stops a browser's HTTP cache (or, just as
// real on native, iOS URLSession's default response caching) from serving
// a stale GET response after the underlying entitlement genuinely
// changes. Found live during this session's onboarding-redesign testing:
// a lapsed/nonexistent entitlement was masked by a cached
// GET /api/v1/me/dashboard response, letting the client believe checkout
// had succeeded when it hadn't. Applies to every method, not just GET —
// no response from this router should ever be reused across requests.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// POST /api/v1/billing/create-checkout-session
//
// Mobile equivalent of routes/billing.js's /billing/create-checkout-session
// — same exception-list gating (requireAuthApi only, deliberately NOT
// requireEntitlement, since an unsubscribed household must be able to
// reach this to ever become subscribed), same duplicate-subscription
// guards (services/checkoutSession.js, shared with the web route so
// neither can silently drift from the 2026-07-18-incident fix), same
// idempotency-key protection. Differs only in: JSON response shape
// ({ url } or a structured error) instead of a redirect, and deep-link
// success/cancel URLs instead of web dashboard URLs — the app opens the
// returned url in an in-app browser session (Expo WebBrowser) and
// detects the redirect back to homecallguard:// to close it.
router.post("/api/v1/billing/create-checkout-session", requireAuthApi, async (req, res) => {
  if (!stripe) {
    console.error("MOBILE CHECKOUT SESSION ERROR: STRIPE_SECRET_KEY not configured");
    return res.status(500).json({ error: "not_configured" });
  }

  if (!process.env.STRIPE_PRICE_ID) {
    console.error("MOBILE CHECKOUT SESSION ERROR: STRIPE_PRICE_ID not configured");
    return res.status(500).json({ error: "not_configured" });
  }

  try {
    const existingEntitlement = await getActiveEntitlement(req.household.id);
    if (existingEntitlement) {
      return res.status(409).json({ error: "already_active" });
    }

    const stripeCustomerId = await resolveStripeCustomerId(req.household, req.authUserId);

    const existingSubscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
    });

    if (hasQualifyingStripeSubscription(existingSubscriptions.data)) {
      return res.status(409).json({ error: "already_active" });
    }

    const openCheckoutSessions = await stripe.checkout.sessions.list({
      customer: stripeCustomerId,
      status: "open",
      limit: 10,
    });

    const reusableSession = findReusableOpenCheckoutSession(openCheckoutSessions.data);
    if (reusableSession) {
      if (reusableSession.url) {
        return res.json({ url: reusableSession.url });
      }
      return res.status(409).json({ error: "pending" });
    }

    const fiveMinuteBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const idempotencyKey = `mobile-checkout:${req.household.id}:${fiveMinuteBucket}`;

    const session = await stripe.checkout.sessions.create(
      buildCheckoutSessionParams({
        customer: stripeCustomerId,
        priceId: process.env.STRIPE_PRICE_ID,
        householdId: req.household.id,
        successUrl: MOBILE_CHECKOUT_SUCCESS_URL,
        cancelUrl: MOBILE_CHECKOUT_CANCEL_URL,
      }),
      { idempotencyKey }
    );

    res.json({ url: session.url });
  } catch (err) {
    console.error("MOBILE CHECKOUT SESSION ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/v1/billing/manage-membership
//
// Mobile equivalent of routes/billing.js's /billing/manage-membership —
// same "no Stripe customer means nothing to manage" guard (complimentary/
// founding/promotional/staff access), same Stripe Billing Portal session
// creation. Differs only in: JSON { url } response instead of a
// redirect, and a homecallguard:// return_url instead of the web
// dashboard, matching D1's in-app-browser handoff
// (APP_VISUAL_SPECIFICATION.md).
router.post("/api/v1/billing/manage-membership", requireAuthApi, async (req, res) => {
  if (!stripe) {
    console.error("MOBILE PORTAL SESSION ERROR: STRIPE_SECRET_KEY not configured");
    return res.status(500).json({ error: "not_configured" });
  }

  if (!req.household.stripe_customer_id) {
    return res.status(409).json({ error: "not_manageable" });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.household.stripe_customer_id,
      return_url: MOBILE_PORTAL_RETURN_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("MOBILE PORTAL SESSION ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/v1/me/bootstrap
//
// The mobile app authenticates directly against Supabase (signUp/
// signInWithPassword/updateUser after a recovery flow — see
// docs/mobile-app/APP_DECISION_005), never through the web app's own
// /register, /login, or /reset-password-complete Express routes. Those
// three web routes are the ONLY places ensureHouseholdAndRole() has ever
// run — a mobile client bypassing them entirely would leave every new
// customer with a genuinely valid Supabase session but no households/
// user_roles row at all, and every other /api/v1 route (gated by
// requireAuthApi, which requires a household to already exist) would
// 401 with no_household forever. This route exists specifically to
// close that gap: call it once, right after the app establishes a
// session (post-registration-confirmation, post-login, post-password-
// reset), before calling anything else.
//
// Deliberately NOT gated by requireAuthApi — that middleware requires a
// household to already exist, which is exactly the chicken-and-egg
// problem this route solves. Uses verifyBearerToken (token validity
// only) instead, then builds a user-scoped client from the access +
// refresh token pair the app sends, exactly mirroring how server.js's
// /login and /reset-password-complete already do this
// (buildUserScopedClient + setSession + ensureHouseholdAndRole).
// Idempotent — a no-op for a customer who already has a household.
router.post("/api/v1/me/bootstrap", async (req, res) => {
  const verified = await verifyBearerToken(req);

  if (!verified) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: "invalid_input", message: "refresh_token is required" });
  }

  try {
    const userClient = buildUserScopedClient();
    const { error: sessionError } = await userClient.auth.setSession({
      access_token: verified.token,
      refresh_token,
    });

    if (sessionError) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    await ensureHouseholdAndRole(userClient, verified.userId, verified.email, "[MOBILE BOOTSTRAP]");
    res.json({ ok: true });
  } catch (err) {
    console.error("MOBILE BOOTSTRAP ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// GET /api/v1/me/dashboard
//
// requireEntitlement (not requireAuthApi alone) deliberately mirrors
// /dashboard-data's existing gating exactly — a 402 { error: "not_entitled" }
// is how the web app already signals "show the subscribe flow instead,"
// and the mobile app's B1/B2 screens are designed against that same
// contract (APP_VISUAL_SPECIFICATION.md) rather than inventing a new one.
router.get("/api/v1/me/dashboard", requireAuthApi, requireEntitlement, async (req, res) => {
  try {
    const [callsToday, recentCalls, contacts, subscription] = await Promise.all([
      getCallsToday(req.household.id),
      getRecentCalls(req.household.id, 30),
      getContacts(req.household.id),
      getSubscriptionByHouseholdId(req.household.id),
    ]);

    // Same membership-status derivation as /dashboard-data (server.js) —
    // always from the real subscriptions/entitlements rows the webhook
    // wrote, never client-supplied. Kept in sync deliberately rather than
    // extracted, since the two call sites' surrounding context differs
    // enough (req.entitlement shape, response shape) that a shared
    // function would need as much branching as just repeating the small
    // derivation itself — revisit if a third call site ever needs this.
    let membershipStatus = "active";
    if (req.entitlement.entitlement_type === "free_trial") {
      membershipStatus = "trial";
    } else if (subscription && subscription.status === "past_due") {
      membershipStatus = "payment_issue";
    } else if (subscription && subscription.cancel_at_period_end) {
      membershipStatus = "cancelled";
    }

    const activationRecentlyConfirmedByACall = isCallWithinVerificationWindow(recentCalls[0]);

    res.json({
      protection: {
        twilioProvisioningStatus: req.household.twilio_provisioning_status || "pending",
        activationVerifiedAt: req.household.activation_verified_at || null,
        // Surfaced so the app can offer "check now" even if the customer
        // hasn't hit /api/v1/activation/verify yet themselves — see that
        // route below for what actually persists this.
        recentUnconfirmedCallSeen: activationRecentlyConfirmedByACall && !req.household.activation_verified_at,
      },
      membership: {
        planName: "Home Call Guard Standard",
        priceLabel: "£4.99 per month",
        status: membershipStatus,
        nextBillingDate: subscription && !subscription.cancel_at_period_end ? subscription.current_period_end : null,
        accessUntil: subscription ? subscription.current_period_end : null,
        trialEndDate: req.entitlement.entitlement_type === "free_trial" ? req.entitlement.ends_at : null,
        manageable: !!(req.household.stripe_customer_id && subscription),
      },
      contacts: contacts.map(c => ({ id: c.id, name: c.name, number: c.number })),
      activity: recentCalls.map(toClientCall),
      stats: {
        callsScreened: callsToday.filter(call => call.status === "Unknown").length,
        suspectedScamsBlocked: callsToday.filter(call => call.result === "SCAM").length,
        trustedCallsRecognised: callsToday.filter(call => call.status === "Known").length,
      },
    });
  } catch (err) {
    console.error("MOBILE DASHBOARD ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// GET /api/v1/activation/instructions?deviceType=iphone|android|landline&provider=bt|sky|virgin|talktalk|plusnet|other
//
// The one deliberate, narrow exception to "the Twilio number is never
// sent to any client" — added because B4 (activation instructions)
// cannot function without the customer learning their forwarding
// destination somehow, and no automated channel for that exists
// anywhere else in this codebase (confirmed by investigation: no
// welcome email, no SMS, nothing — see the conversation record this
// endpoint was approved in). GET /api/v1/me/dashboard and the existing
// web /dashboard-data route are both completely unchanged by this;
// this route's response never includes a bare `twilioNumber` field —
// only the fully-formed, ready-to-dial code and plain-language framing
// (services/activationInstructions.js generates it server-side so
// per-provider formatting/caveats — Virgin's extra zero, Sky/Virgin's
// preliminary 150 call — live in exactly one place, never duplicated in
// client code).
router.get("/api/v1/activation/instructions", requireAuthApi, requireEntitlement, async (req, res) => {
  const { deviceType, provider } = req.query;

  if (typeof deviceType !== "string" || !DEVICE_TYPES.has(deviceType)) {
    return res.status(400).json({
      error: "invalid_input",
      message: `deviceType must be one of: ${[...DEVICE_TYPES].join(", ")}`,
    });
  }

  if (deviceType === "landline" && (typeof provider !== "string" || !LANDLINE_PROVIDERS.has(provider))) {
    return res.status(400).json({
      error: "invalid_input",
      message: `provider is required for landline and must be one of: ${[...LANDLINE_PROVIDERS].join(", ")}`,
    });
  }

  if (!req.household.twilio_number) {
    // Provisioning hasn't completed yet (or failed) — a real, honest
    // state the app should show as "still setting up," never a bare
    // error. Matches twilio_provisioning_status already surfaced on
    // GET /api/v1/me/dashboard, which the app checks before ever
    // reaching this screen in the normal flow.
    return res.status(409).json({ error: "not_provisioned" });
  }

  try {
    const instructions = buildActivationInstructions({
      twilioNumber: req.household.twilio_number,
      deviceType,
      provider,
    });

    res.json({
      code: instructions.code,
      cancelCode: instructions.cancelCode,
      requiresPreliminaryCall: instructions.requiresPreliminaryCall,
      preliminaryCallNumber: instructions.preliminaryCallNumber,
      preliminaryCallNote: instructions.preliminaryCallNote,
      explanation: "This is Home Call Guard's protection number — you'll forward your calls to it now.",
    });
  } catch (err) {
    console.error("MOBILE ACTIVATION INSTRUCTIONS ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/v1/activation/verify
//
// Checks for a real routed call within the verification window and, if
// found, persists activation_verified_at (idempotent — see migration 021
// and markActivationVerified's own comment). Does not require an active
// entitlement — a customer should be able to verify activation as part
// of setup even in the narrow window before/around their subscription
// taking effect, and the check itself reveals nothing entitlement-gated.
router.post("/api/v1/activation/verify", requireAuthApi, async (req, res) => {
  try {
    const recentCalls = await getRecentCalls(req.household.id, 1);
    const verified = isCallWithinVerificationWindow(recentCalls[0]);

    if (!verified) {
      return res.json({ verified: false });
    }

    const verifiedAt = await markActivationVerified(req.household.id);
    res.json({ verified: true, verifiedAt });
  } catch (err) {
    console.error("MOBILE ACTIVATION VERIFY ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/v1/contacts, PUT/DELETE /api/v1/contacts/:id
//
// Same validation and database/contacts.js calls as the existing web
// /contacts routes (server.js) — deliberately not extracted into a
// shared handler, since the two Express apps' surrounding
// request/response shapes already match closely enough that a shared
// function would mostly just be indirection; the actual data operations
// (getContacts/insertContacts/updateContact/deleteContact) are the real
// reused logic, and that reuse is already complete.
router.post("/api/v1/contacts", requireAuthApi, requireEntitlement, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const number = normaliseNumber(req.body.number);

    if (!name || number.length !== 10) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const existing = await getContacts(req.household.id);
    if (existing.some(c => normaliseNumber(c.number) === number)) {
      return res.status(409).json({ error: "duplicate", message: "This number is already in your trusted contacts." });
    }

    const [saved] = await insertContacts(req.household.id, [{ name, number, customer_id: null }]);
    res.status(201).json({ id: saved.id, name: saved.name, number: saved.number });
  } catch (err) {
    console.error("MOBILE ADD CONTACT ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

router.put("/api/v1/contacts/:id", requireAuthApi, requireEntitlement, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const number = normaliseNumber(req.body.number);

    if (!name || number.length !== 10) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const existing = await getContacts(req.household.id);
    if (existing.some(c => c.id !== req.params.id && normaliseNumber(c.number) === number)) {
      return res.status(409).json({ error: "duplicate", message: "This number is already in your trusted contacts." });
    }

    const updated = await updateContact(req.household.id, req.params.id, { name, number });
    if (updated.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    res.json({ id: updated[0].id, name: updated[0].name, number: updated[0].number });
  } catch (err) {
    console.error("MOBILE UPDATE CONTACT ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

router.delete("/api/v1/contacts/:id", requireAuthApi, requireEntitlement, async (req, res) => {
  try {
    const deleted = await deleteContact(req.household.id, req.params.id);
    if (deleted.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("MOBILE DELETE CONTACT ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
