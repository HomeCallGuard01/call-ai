// Admin Launch Fortress overview (integration 2026-10-03). READ-ONLY, behind
// requireAuth + requireAdmin like every admin route. No route here changes
// safety state: kill switch, breaker reset, budget adjustments and profile
// changes stay audited database functions (services/businessControl/fortressOverview.js).
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { getFortressOverview } = require("../services/businessControl/fortressOverview");
const { validateCommercialConfiguration } = require("../services/finance/commercialConfigValidation");

function createAdminFortressRoutes({ supabaseAdmin, financialContainmentDb, telephonyAbuse }) {
  const router = express.Router();
  router.get("/admin/api/fortress/overview", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!supabaseAdmin) return res.status(503).json({ error: "database not configured" });
      const overview = await getFortressOverview({
        supabase: supabaseAdmin,
        globalStatus: () => financialContainmentDb.globalStatus({ now: new Date() }),
        incidentState: telephonyAbuse && telephonyAbuse.incident ? () => telephonyAbuse.incident.state() : null,
        validateCommercial: ({ profiles }) => validateCommercialConfiguration({ env: process.env, profiles }),
      });
      res.set("Cache-Control", "no-store");
      return res.json(overview);
    } catch (err) {
      console.error("ADMIN FORTRESS OVERVIEW ERROR:", err.message);
      return res.status(500).json({ error: "failed" });
    }
  });
  return router;
}

module.exports = { createAdminFortressRoutes };
