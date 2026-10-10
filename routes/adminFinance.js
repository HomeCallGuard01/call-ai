// Admin finance: per-household profitability (WS2, 2026-10-10). READ-ONLY,
// GET only, every route requireAuth + requireAdmin. NOT MOUNTED — the launch
// lead mounts it with one line in server.js:
//   app.use(require("./routes/adminFinance").createAdminFinanceRouter());
// Contract: docs/launch/2026-10-10-WS2-REPORT.md §B (WS4 Financial Control Centre).
const express = require("express");
const { resolveProfitabilityConfig, resolvePeriod, computeHouseholdProfitability, buildPortfolio, publicAssumptions, FLAGS } = require("../services/finance/profitability");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createAdminFinanceRouter({
  loadProfitability = (args) => require("../database/profitability").loadProfitabilityInputs(args),
  requireAuth = require("../middleware/requireAuth").requireAuth,
  requireAdmin = require("../middleware/requireAdmin").requireAdmin,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const router = express.Router();
  const relevant = (i) => Boolean(i.entitlement || (i.accounts && i.accounts.length) || (i.credits && i.credits.length));

  router.get("/admin/api/finance/profitability", requireAuth, requireAdmin, async (req, res) => {
    const t = now();
    const period = resolvePeriod(req.query.period, t);
    if (!period) return res.status(400).json({ error: "invalid_period" });
    const flag = req.query.flag ? String(req.query.flag) : null;
    if (flag && !FLAGS.includes(flag)) return res.status(400).json({ error: "invalid_flag" });
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: "invalid_page" });
    try {
      const config = resolveProfitabilityConfig(env);
      const inputs = (await loadProfitability({ periodStart: period.start, periodEnd: period.end })).filter(relevant);
      const rows = inputs.map((i) => computeHouseholdProfitability(i, period, config));
      const warnings = [];
      if (!Object.keys(config.stripeLivePrices).length) warnings.push("FINANCE_STRIPE_LIVE_PRICES not configured: Stripe revenue is not counted");
      res.set("Cache-Control", "no-store");
      return res.json(buildPortfolio(rows, { period, config, flag, limit, offset, now: t, warnings }));
    } catch (err) {
      console.error("ADMIN FINANCE PROFITABILITY ERROR:", err.message);
      return res.status(500).json({ error: "failed" });
    }
  });

  router.get("/admin/api/finance/profitability/:householdId", requireAuth, requireAdmin, async (req, res) => {
    const t = now();
    if (!UUID.test(req.params.householdId)) return res.status(400).json({ error: "invalid_household" });
    const period = resolvePeriod(req.query.period, t);
    if (!period) return res.status(400).json({ error: "invalid_period" });
    try {
      const config = resolveProfitabilityConfig(env);
      const inputs = await loadProfitability({ periodStart: period.start, periodEnd: period.end, householdId: req.params.householdId });
      const input = inputs.find((i) => i.household.id === req.params.householdId);
      if (!input) return res.status(404).json({ error: "not_found" });
      res.set("Cache-Control", "no-store");
      return res.json({ version: 1, generatedAt: t.toISOString(), period, assumptions: publicAssumptions(config), household: computeHouseholdProfitability(input, period, config) });
    } catch (err) {
      console.error("ADMIN FINANCE PROFITABILITY ERROR:", err.message);
      return res.status(500).json({ error: "failed" });
    }
  });

  return router;
}

module.exports = { createAdminFinanceRouter };
