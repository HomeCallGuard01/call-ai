// Admin accounting status (feature/accounting-automation, 2026-10-04).
// READ-ONLY, behind requireAuth + requireAdmin. Nothing here posts to Xero,
// resolves exceptions or changes billing. Until migration 071 is applied the
// endpoints answer 503 "unavailable" with the reason.
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { createRpcAccountingStore } = require("../services/accounting/rpcStore");
const { buildAccountingStatus } = require("../services/accounting/status");
const { loadAccountingPolicy } = require("../services/accounting/accountingPolicy");
const { loadXeroConfig, xeroConnectionStatus } = require("../services/accounting/xero/xeroClient");

const NOT_APPLIED = /does not exist|could not find the function|schema cache/i;
const EXCEPTION_STATUSES = new Set(["open", "resolved", "auto_resolved", "dismissed"]);

function createAdminAccountingRoutes({ supabaseAdmin, store: injectedStore = null, env = process.env }) {
  const router = express.Router();
  const storeOf = () => injectedStore || (supabaseAdmin ? createRpcAccountingStore(supabaseAdmin) : null);
  const unavailable = (res, err) => {
    if (err && NOT_APPLIED.test(err.message)) {
      return res.status(503).json({ error: "unavailable", reason: "accounting tables not present (migration 071 not applied)" });
    }
    console.error("ADMIN ACCOUNTING ERROR:", err && err.message);
    return res.status(500).json({ error: "failed" });
  };

  router.get("/admin/api/accounting/status", requireAuth, requireAdmin, async (req, res) => {
    const store = storeOf();
    if (!store) return res.status(503).json({ error: "unavailable", reason: "database not configured" });
    try {
      const status = await buildAccountingStatus({
        store, policy: loadAccountingPolicy(env), xeroStatus: xeroConnectionStatus(loadXeroConfig(env)), now: new Date(),
      });
      res.set("Cache-Control", "no-store");
      return res.json({ ...status, capture_enabled: env.ACCOUNTING_CAPTURE_ENABLED === "true" });
    } catch (err) { return unavailable(res, err); }
  });

  router.get("/admin/api/accounting/exceptions", requireAuth, requireAdmin, async (req, res) => {
    const store = storeOf();
    if (!store) return res.status(503).json({ error: "unavailable", reason: "database not configured" });
    const status = typeof req.query.status === "string" && EXCEPTION_STATUSES.has(req.query.status) ? req.query.status : "open";
    try {
      const list = await store.listExceptions({ status });
      res.set("Cache-Control", "no-store");
      return res.json({ status, count: list.length, exceptions: list.slice(0, 500) });
    } catch (err) { return unavailable(res, err); }
  });

  return router;
}

module.exports = { createAdminAccountingRoutes };
