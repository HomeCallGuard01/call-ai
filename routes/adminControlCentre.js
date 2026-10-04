// Admin Control Centre summary route (admin redesign, 2026-10-04).
//
//   GET /admin/api/control-centre/summary
//
// READ-ONLY, requireAuth + requireAdmin. One lifecycle snapshot load
// (database/lifecycleSnapshot.js, the same loader as the exception queue),
// composed by services/adminControlCentre/summary.js from the canonical
// definitions. Nothing here writes a row, contacts a customer or calls a
// provider. Fails closed: if the snapshot cannot be loaded the dashboard
// shows "unavailable", never zero customers.
"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { loadLifecycleSnapshots } = require("../database/lifecycleSnapshot");
const { buildControlCentreSummary } = require("../services/adminControlCentre/summary");

function createAdminControlCentreRoutes({ supabaseAdmin, loadSnapshots = loadLifecycleSnapshots, now = () => new Date() }) {
  const router = express.Router();

  router.get("/admin/api/control-centre/summary", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: "unavailable", reason: "database not configured" });
    try {
      const loaded = await loadSnapshots({ supabase: supabaseAdmin });
      const summary = buildControlCentreSummary({ snapshots: loaded.snapshots, orphanQuarantineRows: loaded.orphanQuarantineRows }, now());
      res.set("Cache-Control", "no-store");
      return res.json({ ...summary, sources: loaded.sources, truncated: loaded.truncated });
    } catch (err) {
      console.error("ADMIN CONTROL CENTRE SUMMARY ERROR:", err.message);
      return res.status(503).json({ error: "unavailable", reason: "customer lifecycle data could not be loaded" });
    }
  });

  return router;
}

module.exports = { createAdminControlCentreRoutes };
