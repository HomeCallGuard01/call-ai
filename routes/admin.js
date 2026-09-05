const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { getSystemHealth } = require("../services/healthChecks");
const {
  getRecentCustomerActivity,
  getRecentCustomers,
  getRecentCallsAcrossHouseholds,
  getAlerts,
  searchCustomers,
  getBusinessOverview,
  getProtectionActivityToday,
  getSubscriptionStatusBreakdown,
  getProvisioningStatusBreakdown,
  computeReadinessSummary,
} = require("../database/adminMetrics");
const { getLaunchReadinessItems } = require("../services/launchReadiness");
const { supabaseAdmin } = require("../services/supabaseClients");
const { ensureTwilioNumberProvisioned, updateTwilioNumberForEntitlementChange } = require("../services/twilioProvisioning");
const { grantComplimentaryEntitlement, revokeComplimentaryEntitlement } = require("../database/billing");
const { recordAdminAction, getRecentAdminActions } = require("../services/adminActionLog");
const { createInvite, listInvites, revokeInvite, ALLOWED_DURATIONS_DAYS } = require("../services/complimentaryInvites");

const router = express.Router();

// Dashboard consolidation (2026-09) — the separate Operations page
// (admin.html) is retired: /admin/business is now the single admin
// destination, with Business/Customers/Operations/System Health as
// sections of one page rather than two pages cross-linking each other
// (the source of the "confusing, overlapping views" this consolidation
// fixes). This route becomes a plain redirect so any existing
// bookmark/link to /admin still lands somewhere valid, rather than
// 404ing. Every /admin/api/* JSON route below is completely unchanged —
// the consolidated page's Operations tab calls these exact same
// endpoints; no route, no query, no business logic here was touched.
router.get("/admin", requireAuth, requireAdmin, (req, res) => {
  res.redirect("/admin/business");
});

router.get("/admin/api/overview", requireAuth, requireAdmin, async (req, res) => {
  const [
    health,
    businessOverview,
    protectionActivity,
    recentActivity,
    recentCustomers,
    recentCalls,
    alerts,
    subscriptionStatusBreakdown,
    provisioningStatusBreakdown,
  ] = await Promise.all([
    getSystemHealth(),
    getBusinessOverview(),
    getProtectionActivityToday(),
    getRecentCustomerActivity(15),
    getRecentCustomers(20),
    getRecentCallsAcrossHouseholds(20),
    getAlerts(20),
    getSubscriptionStatusBreakdown(),
    getProvisioningStatusBreakdown(),
  ]);

  const launchReadinessItems = getLaunchReadinessItems();
  const recentSignups = recentActivity.filter(e => e.type === "signup");

  res.json({
    generatedAt: new Date().toISOString(),
    health,
    businessOverview,
    protectionActivity,
    customerOperations: {
      recentRegistrations: recentSignups,
      recentCustomers,
      subscriptionStatusBreakdown,
      provisioningStatusBreakdown,
      provisioningFailuresCount: alerts.filter(a => a.type === "provisioning_failed").length,
    },
    launchReadiness: {
      items: launchReadinessItems,
      summary: computeReadinessSummary(launchReadinessItems),
    },
    recentActivityFeed: {
      recentCalls,
      recentSignups,
      recentErrors: alerts,
      adminActions: getRecentAdminActions(),
    },
  });
});

router.get("/admin/api/search", requireAuth, requireAdmin, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const results = await searchCustomers(q);
  res.json({ results });
});

// Quick action: retry Twilio provisioning for one household. Reuses the
// exact same bounded-retry orchestration the checkout/webhook flow uses —
// an admin click is not a way around the max-attempts safety cap, just a
// manually-triggered attempt within it. Logged to the in-memory admin
// action feed (services/adminActionLog.js) regardless of outcome.
router.post("/admin/api/households/:id/retry-provisioning", requireAuth, requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "not_configured" });
  }

  const { data: household, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error || !household) {
    return res.status(404).json({ error: "household_not_found" });
  }

  const result = await ensureTwilioNumberProvisioned(household);

  recordAdminAction({
    type: "retry_provisioning",
    householdId: household.id,
    email: household.email,
    result,
  });

  res.json(result);
});

// Admin-granted complimentary access (2026-09) — for an existing,
// already-registered household only (this does not register anyone).
// No Stripe or RevenueCat object is created or implied
// (database/billing.js's grantComplimentaryEntitlement sets
// source='admin_manual', external_reference=null). After the
// entitlement is written, calls the exact same
// updateTwilioNumberForEntitlementChange(household, true) hook every
// other entitlement-activation path (Stripe checkout, RevenueCat
// purchase) already uses — no separate/duplicate provisioning logic.
router.post("/admin/api/households/:id/grant-complimentary", requireAuth, requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "not_configured" });
  }

  const { notes, endsAt } = req.body || {};

  const { data: household, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error || !household) {
    return res.status(404).json({ error: "household_not_found" });
  }

  try {
    const grantResult = await grantComplimentaryEntitlement(household.id, {
      grantedByAuthUserId: req.authUserId,
      notes,
      endsAt,
    });

    // Only trigger provisioning when a grant genuinely happened — a
    // refused grant (an active real Stripe/RevenueCat entitlement
    // already exists) must never touch this household's Twilio number.
    if (grantResult.granted) {
      await updateTwilioNumberForEntitlementChange(household, true);
    }

    recordAdminAction({
      type: "grant_complimentary",
      householdId: household.id,
      email: household.email,
      result: grantResult,
    });

    res.json({ ok: true, ...grantResult });
  } catch (err) {
    console.error("ADMIN GRANT COMPLIMENTARY ERROR:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Revokes complimentary access only — grantComplimentaryEntitlement's
// counterpart. database/billing.js's revokeComplimentaryEntitlement
// verifies the household's active entitlement is genuinely
// source='admin_manual'/entitlement_type='complimentary' before touching
// anything, so this can never revoke a real paid Stripe/RevenueCat
// entitlement; { revoked: false } is a normal, non-error outcome (e.g.
// the household is actually a paying customer), and the Twilio
// mark-for-release hook is deliberately only called when a revoke
// genuinely happened.
router.post("/admin/api/households/:id/revoke-complimentary", requireAuth, requireAdmin, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "not_configured" });
  }

  const { data: household, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error || !household) {
    return res.status(404).json({ error: "household_not_found" });
  }

  try {
    const revokeResult = await revokeComplimentaryEntitlement(household.id);

    if (revokeResult.revoked) {
      await updateTwilioNumberForEntitlementChange(household, false);
    }

    recordAdminAction({
      type: "revoke_complimentary",
      householdId: household.id,
      email: household.email,
      result: revokeResult,
    });

    res.json({ ok: true, ...revokeResult });
  } catch (err) {
    console.error("ADMIN REVOKE COMPLIMENTARY ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

// Friends & Family complimentary invite links (2026-09) — a
// self-service alternative to the household-ID grant above, for a
// recipient who doesn't have a household yet at all. Creates only an
// invite-lifecycle row (services/complimentaryInvites.js); the actual
// entitlement is granted later, at redemption time, via the exact same
// grantComplimentaryEntitlement() used by the manual grant route above —
// no second entitlement mechanism.
router.post("/admin/api/complimentary-invites", requireAuth, requireAdmin, async (req, res) => {
  const { durationDays, note } = req.body || {};
  const parsedDuration = Number(durationDays);

  if (!ALLOWED_DURATIONS_DAYS.includes(parsedDuration)) {
    return res.status(400).json({ error: `durationDays must be one of ${ALLOWED_DURATIONS_DAYS.join(", ")}` });
  }

  try {
    const { invite, token } = await createInvite({
      durationDays: parsedDuration,
      note,
      createdByAuthUserId: req.authUserId,
    });

    recordAdminAction({
      type: "create_complimentary_invite",
      householdId: null,
      email: null,
      result: { inviteId: invite.id, durationDays: invite.duration_days },
    });

    // The raw token/URL is returned exactly once, in this response only —
    // never logged, never persisted (only its hash is stored).
    res.json({ ok: true, invite, url: `${process.env.APP_URL}/register.html?invite=${token}` });
  } catch (err) {
    console.error("ADMIN CREATE COMPLIMENTARY INVITE ERROR:", err.message);
    res.status(400).json({ error: err.message });
  }
});

router.get("/admin/api/complimentary-invites", requireAuth, requireAdmin, async (req, res) => {
  const result = await listInvites();
  if (!result.available) {
    return res.status(503).json({ error: result.reason });
  }
  res.json(result);
});

router.post("/admin/api/complimentary-invites/:id/revoke", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await revokeInvite(req.params.id);
    recordAdminAction({
      type: "revoke_complimentary_invite",
      householdId: null,
      email: null,
      result,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("ADMIN REVOKE COMPLIMENTARY INVITE ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
