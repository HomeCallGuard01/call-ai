// Admin finance: per-household profitability (WS2, 2026-10-10). READ-ONLY,
// GET only, every route requireAuth + requireAdmin. NOT MOUNTED — the launch
// lead mounts it with one line in server.js:
//   app.use(require("./routes/adminFinance").createAdminFinanceRouter());
// Contract: docs/launch/2026-10-10-WS2-REPORT.md §B (WS4 Financial Control Centre).
const express = require("express");
const { resolveProfitabilityConfig, resolvePeriod, computeHouseholdProfitability, buildPortfolio, publicAssumptions, FLAGS } = require("../services/finance/profitability");

const { selectAll } = require("../services/businessControl/selectAll");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Paginated (selectAll) read of unseen ops events (migration 072). Reads only.
async function loadUnseenOpsEventsDefault(supabase) {
  if (!supabase) throw new Error("database not configured");
  const res = await selectAll(() => supabase.from("ops_events").select("id, event_type, household_id, account_number, severity, payload, occurred_at, created_at, seen_at").is("seen_at", null).order("id", { ascending: true }));
  if (res.error) throw new Error(res.error.message || "ops_events unreadable");
  return res.data;
}

function createAdminFinanceRouter({
  loadProfitability = (args) => require("../database/profitability").loadProfitabilityInputs(args),
  requireAuth = require("../middleware/requireAuth").requireAuth,
  requireAdmin = require("../middleware/requireAdmin").requireAdmin,
  env = process.env,
  now = () => new Date(),
  // WS4 Control Centre (2026-10-10): protection + alerts. Both reuse
  // existing read paths (the lifecycle snapshot loader used by the admin
  // Control Centre / exception queue, and a paginated read of UNSEEN ops
  // events). Each is optional: a failure leaves protection/alerts "unknown"
  // (null), never "protected" or "no alerts", and the profitability rows
  // still render.
  loadSnapshots = () => require("../database/lifecycleSnapshot").loadLifecycleSnapshots({ supabase: require("../services/supabaseClients").supabaseAdmin }),
  loadUnseenOpsEvents = () => loadUnseenOpsEventsDefault(require("../services/supabaseClients").supabaseAdmin),
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

  // Integration 2026-10-10: the same portfolio in the Financial Control
  // Centre page's shape (WS4 contract "ws2-profitability-v1"); read-only.
  router.get("/admin/api/financial/customer-profitability", requireAuth, requireAdmin, async (req, res) => {
    const t = now();
    const period = resolvePeriod(req.query.period, t);
    if (!period) return res.status(400).json({ error: "invalid_period" });
    try {
      const config = resolveProfitabilityConfig(env);
      const inputs = (await loadProfitability({ periodStart: period.start, periodEnd: period.end })).filter(relevant);
      const rows = inputs.map((i) => computeHouseholdProfitability(i, period, config));
      const warnings = [];
      if (!Object.keys(config.stripeLivePrices).length) warnings.push("FINANCE_STRIPE_LIVE_PRICES not configured: Stripe revenue is not counted");
      const portfolio = buildPortfolio(rows, { period, config, flag: null, limit: 500, offset: 0, now: t, warnings });
      const [snap, ops] = await Promise.all([
        Promise.resolve().then(loadSnapshots).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
        Promise.resolve().then(loadUnseenOpsEvents).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      ]);
      if (!snap.ok) console.error("ADMIN FINANCIAL CONTROL: lifecycle snapshots unavailable:", snap.e && snap.e.message);
      if (!ops.ok) console.error("ADMIN FINANCIAL CONTROL: ops events unavailable:", ops.e && ops.e.message);
      const snapshots = snap.ok && snap.v && Array.isArray(snap.v.snapshots) ? snap.v.snapshots : null;
      const body = require("../services/finance/controlCentreAdapter").toControlCentreV1(portfolio, {
        now: t,
        snapshots,
        opsEvents: ops.ok && Array.isArray(ops.v) ? ops.v : null,
        topUpsEnabled: env.ALLOWANCE_TOPUPS_ENABLED === "true",
        sources: snapshots ? { lifecycleTruncated: Boolean(snap.v.truncated), ...(snap.v.sources || {}) } : undefined,
      });
      res.set("Cache-Control", "no-store");
      return res.json(body);
    } catch (err) {
      console.error("ADMIN FINANCIAL CONTROL PROFITABILITY ERROR:", err.message);
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
