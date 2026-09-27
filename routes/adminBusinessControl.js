// Business control dashboard (2026-09-27) — admin JSON API for the
// Subscriptions, Reconciliation, Finance and Marketing areas of
// admin-business.html. Every route requires an authenticated admin
// (requireAuth + requireAdmin, same as routes/admin.js).
//
// GET routes are read-only. The only writes are the manual-cost routes,
// which write solely to manual_cost_schedules / financial_entries and
// refuse with 503 until migrations 048 + 050 have been applied. No route
// here touches Stripe, Twilio, numbers, subscriptions or entitlements.
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { getSubscriptionOverview } = require("../services/businessControl/subscriptionOverview");
const { getNumberReconciliation } = require("../services/businessControl/numberReconciliation");
const { getFinancialOverview } = require("../services/businessControl/financialOverview");
const { getCampaignPerformance } = require("../services/businessControl/campaignPerformance");
const {
  listManualCostSchedules,
  createManualCostSchedule,
  endManualCostSchedule,
  postDueManualCostEntries,
  previewDueManualCostEntries,
} = require("../services/businessControl/manualCosts");
const { recordAdminAction } = require("../services/adminActionLog");

const router = express.Router();

function sendResult(res, result) {
  if (!result.available) return res.status(503).json({ error: "unavailable", reason: result.reason });
  res.json(result);
}

router.get("/admin/api/business-control/subscriptions", requireAuth, requireAdmin, async (req, res) => {
  sendResult(res, await getSubscriptionOverview(new Date()));
});

router.get("/admin/api/business-control/reconciliation", requireAuth, requireAdmin, async (req, res) => {
  sendResult(res, await getNumberReconciliation(new Date()));
});

router.get("/admin/api/business-control/finance", requireAuth, requireAdmin, async (req, res) => {
  try {
    sendResult(res, await getFinancialOverview(new Date()));
  } catch (err) {
    console.error("BUSINESS CONTROL FINANCE ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

router.get("/admin/api/business-control/marketing", requireAuth, requireAdmin, async (req, res) => {
  sendResult(res, await getCampaignPerformance(new Date()));
});

router.get("/admin/api/business-control/manual-costs", requireAuth, requireAdmin, async (req, res) => {
  res.json(await listManualCostSchedules());
});

// Read-only: what "Post due entries" would write, before writing it.
router.get("/admin/api/business-control/manual-costs/preview", requireAuth, requireAdmin, async (req, res) => {
  res.json(await previewDueManualCostEntries(new Date()));
});

router.post("/admin/api/business-control/manual-costs", requireAuth, requireAdmin, express.json(), async (req, res) => {
  const result = await createManualCostSchedule(req.body || {}, { createdBy: req.authUserId || null });
  if (!result.ok) return res.status(result.status).json({ error: "rejected", errors: result.errors });
  recordAdminAction({ type: "create_manual_cost", householdId: null, email: null, result: { scheduleId: result.schedule.id } });
  res.json({ ok: true, schedule: result.schedule });
});

router.post("/admin/api/business-control/manual-costs/:id/end", requireAuth, requireAdmin, express.json(), async (req, res) => {
  const { endDate } = req.body || {};
  const result = await endManualCostSchedule(req.params.id, endDate);
  if (!result.ok) return res.status(result.status).json({ error: "rejected", errors: result.errors });
  recordAdminAction({ type: "end_manual_cost", householdId: null, email: null, result: { scheduleId: req.params.id, endDate } });
  res.json({ ok: true, schedule: result.schedule });
});

router.post("/admin/api/business-control/manual-costs/post-due", requireAuth, requireAdmin, async (req, res) => {
  const result = await postDueManualCostEntries(new Date(), { createdBy: req.authUserId || null });
  if (!result.ok) return res.status(result.status).json({ error: "rejected", errors: result.errors });
  recordAdminAction({ type: "post_manual_costs", householdId: null, email: null, result: { considered: result.considered } });
  res.json(result);
});

module.exports = router;
