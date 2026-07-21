const express = require("express");
const path = require("path");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { getSystemHealth } = require("../services/healthChecks");
const {
  getRecentCustomerActivity,
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
const { ensureTwilioNumberProvisioned } = require("../services/twilioProvisioning");
const { recordAdminAction, getRecentAdminActions } = require("../services/adminActionLog");

const router = express.Router();

router.get("/admin", requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "admin.html"));
});

router.get("/admin/api/overview", requireAuth, requireAdmin, async (req, res) => {
  const [
    health,
    businessOverview,
    protectionActivity,
    recentActivity,
    recentCalls,
    alerts,
    subscriptionStatusBreakdown,
    provisioningStatusBreakdown,
  ] = await Promise.all([
    getSystemHealth(),
    getBusinessOverview(),
    getProtectionActivityToday(),
    getRecentCustomerActivity(15),
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

module.exports = router;
