// GET /api/v1/billing/eligibility (WS4, 2026-10-10) — may the signed-in
// account START a new paid membership right now?
//
// Why: the invite-only cohort and the stop-acquisition switch
// (services/acquisitionGate.js: NEW_SUBSCRIPTIONS_ALLOWLIST /
// NEW_SUBSCRIPTIONS_PAUSED) gate only HCG's own Stripe checkout routes. A
// store purchase (Apple StoreKit today, Google Play Billing later) never
// reaches those routes, so the app must ask first and hide its purchase UI
// unless this says `canPurchase: true`
// (docs/launch/2026-10-09-ANDROID-COMPLIANT-PAYMENTS.md §4, "Allowlist/pause
// gate"). It is advisory for the client: the server-side backstop for a
// store purchase that happens anyway is the RevenueCat webhook (grant +
// alert), unchanged here.
//
// Response (always Cache-Control: no-store; never echoes the email or the
// allowlist):
//   200 { canPurchase: true,  reason: null,                     alreadyEntitled: false }
//   200 { canPurchase: false, reason: "new_memberships_paused", alreadyEntitled: false }
//   200 { canPurchase: false, reason: "not_invited",            alreadyEntitled: false }
//   200 { canPurchase: false, reason: "already_active",         alreadyEntitled: true  }
//   503 { canPurchase: false, reason: "unavailable",            alreadyEntitled: false }  (fails closed)
// The order matches the checkout routes: the acquisition gate first, then
// "already active" (an existing member is never told they can buy again).
//
// requireAuthApi (bearer token) — the same auth as every other /api/v1 route.
// NOT MOUNTED by this change. Mount in server.js (next to the other
// /api/v1 billing routes) with:
//   app.use(require("./routes/billingEligibility").createBillingEligibilityRoutes());
"use strict";

const express = require("express");

const REASONS = Object.freeze({
  PAUSED: "new_memberships_paused",
  NOT_INVITED: "not_invited",
  ALREADY_ACTIVE: "already_active",
  UNAVAILABLE: "unavailable",
});

/** Pure: the response body for one account. */
function buildEligibility({ acquisition, activeEntitlement }) {
  if (!acquisition || acquisition.allowed !== true) {
    const reason = acquisition && (acquisition.reason === REASONS.PAUSED || acquisition.reason === REASONS.NOT_INVITED) ? acquisition.reason : REASONS.UNAVAILABLE;
    return { canPurchase: false, reason, alreadyEntitled: false };
  }
  if (activeEntitlement) return { canPurchase: false, reason: REASONS.ALREADY_ACTIVE, alreadyEntitled: true };
  return { canPurchase: true, reason: null, alreadyEntitled: false };
}

function createBillingEligibilityRoutes({
  requireAuthApi = require("../middleware/requireAuthApi").requireAuthApi,
  decideNewSubscription = require("../services/acquisitionGate").decideNewSubscription,
  getActiveEntitlement = require("../database/billing").getActiveEntitlementOrThrow,
  env = process.env,
  log = console.error,
} = {}) {
  const router = express.Router();

  router.get("/api/v1/billing/eligibility", requireAuthApi, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.household || !req.household.id) throw new Error("no household on request");
      const acquisition = decideNewSubscription({ household: req.household, env });
      // Only look up the entitlement when the gate would allow a purchase.
      const activeEntitlement = acquisition && acquisition.allowed === true ? await getActiveEntitlement(req.household.id) : null;
      return res.json(buildEligibility({ acquisition, activeEntitlement }));
    } catch (err) {
      log("BILLING ELIGIBILITY ERROR:", err && err.message);
      return res.status(503).json({ canPurchase: false, reason: REASONS.UNAVAILABLE, alreadyEntitled: false });
    }
  });

  return router;
}

module.exports = { createBillingEligibilityRoutes, buildEligibility, REASONS };
