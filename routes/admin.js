const express = require("express");
const path = require("path");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { getSystemHealth } = require("../services/healthChecks");
const {
  getKpiSummary,
  getRecentCustomerActivity,
  getRecentCallsAcrossHouseholds,
  getAlerts,
  searchCustomers,
} = require("../database/adminMetrics");
const { getLaunchReadinessItems } = require("../services/launchReadiness");
const { supabaseAdmin } = require("../services/supabaseClients");
const { ensureTwilioNumberProvisioned } = require("../services/twilioProvisioning");

const router = express.Router();

router.get("/admin", requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "admin.html"));
});

router.get("/admin/api/overview", requireAuth, requireAdmin, async (req, res) => {
  const [health, kpis, recentActivity, recentCalls, alerts] = await Promise.all([
    getSystemHealth(),
    getKpiSummary(),
    getRecentCustomerActivity(15),
    getRecentCallsAcrossHouseholds(20),
    getAlerts(20),
  ]);

  res.json({
    health,
    kpis,
    recentActivity,
    recentCalls,
    alerts,
    launchReadiness: getLaunchReadinessItems(),
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
// manually-triggered attempt within it.
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
  res.json(result);
});

module.exports = router;
