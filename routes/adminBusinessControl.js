// Business control dashboard (2026-09-27) — admin JSON API for the
// Subscriptions, Reconciliation, Finance and Marketing areas of
// admin-business.html. Every route requires an authenticated admin
// (requireAuth + requireAdmin, same as routes/admin.js).
//
// STRICTLY OBSERVATIONAL: this deployable version has GET routes only.
// Nothing here writes to the database, and nothing touches Stripe,
// Twilio numbers, subscriptions or entitlements beyond read-only reads.
// The manual-cost write routes (which need the ledger, migration 048,
// and manual_cost_schedules, draft migration 050) are deliberately NOT
// part of this deployable — they live on feature/admin-business-control
// until those migrations exist.
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { getSubscriptionOverview } = require("../services/businessControl/subscriptionOverview");
const { getNumberReconciliation } = require("../services/businessControl/numberReconciliation");
const { getFinancialOverview } = require("../services/businessControl/financialOverview");
const { getCampaignPerformance } = require("../services/businessControl/campaignPerformance");
const { getControlOverview } = require("../services/businessControl/controlOverview");

const router = express.Router();

function sendResult(res, result) {
  if (!result.available) return res.status(503).json({ error: "unavailable", reason: result.reason });
  res.json(result);
}

// Overview: the loose-ends cards + Twilio number inventory. Read-only
// (database reads, Twilio number list + last-month usage records, Stripe
// subscriptions/charges lists).
router.get("/admin/api/business-control/overview", requireAuth, requireAdmin, async (req, res) => {
  try {
    sendResult(res, await getControlOverview(new Date()));
  } catch (err) {
    console.error("BUSINESS CONTROL OVERVIEW ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

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

// Monthly due-diligence snapshot (read-only; aggregates only, no personal
// data — refused if any slips in). ?month=YYYY-MM&format=json|md
router.get("/admin/api/business-control/snapshot", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getDueDiligenceSnapshot } = require("../services/businessControl/dueDiligenceSnapshot");
    const result = await getDueDiligenceSnapshot({ month: req.query.month, now: new Date() });
    if (!result.available) return res.status(result.status || 503).json({ error: "unavailable", reason: result.reason });
    const name = `hcg-operational-snapshot-${result.snapshot.period}`;
    if (req.query.format === "md") {
      res.set("Content-Disposition", `attachment; filename="${name}.md"`);
      return res.type("text/markdown").send(result.markdown);
    }
    if (req.query.download === "1") res.set("Content-Disposition", `attachment; filename="${name}.json"`);
    res.json(result.snapshot);
  } catch (err) {
    console.error("BUSINESS CONTROL SNAPSHOT ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
