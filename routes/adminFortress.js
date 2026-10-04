// Admin Launch Fortress routes (integration 2026-10-03/04), all behind
// requireAuth + requireAdmin. The overview is read-only. Since 2026-10-04
// (Andrew-approved) three audited safety controls are exposed: manual reset of
// the LATCHED global breaker, the global kill switch, and the per-household
// financial hold. Budget adjustments and policy/profile changes remain
// database functions only.
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
  // ── Safety-state CHANGES (integration 2026-10-04, Andrew-approved) ──────
  // Authenticated (requireAuth), authorised (requireAdmin), JSON-only (a
  // cross-site form cannot send application/json without a CORS preflight),
  // a typed confirmation phrase, a written reason, and the ACTOR is the
  // authenticated admin's id — never request-supplied. The durable audit is in
  // the database functions themselves (fc_policy_audit for the breaker and the
  // kill switch; append-only fc_household_hold_audit for holds) plus fc_events.
  const actorOf = (req) => `admin:${req.authUserId}`;
  function validate(req, res, phrase) {
    if (!req.is("application/json")) { res.status(415).json({ error: "json_required" }); return null; }
    const { reason, confirm } = req.body || {};
    if (typeof reason !== "string" || reason.trim().length < 10) { res.status(400).json({ error: "reason_required", message: "A reason of at least 10 characters is required" }); return null; }
    if (confirm !== phrase) { res.status(400).json({ error: "confirmation_required", message: `Type exactly: ${phrase}` }); return null; }
    if (!req.authUserId) { res.status(403).json({ error: "no_admin_identity" }); return null; }
    return reason.trim();
  }
  const fail = (res, label, err) => {
    console.error(`ADMIN FORTRESS ${label} FAILED:`, err.message);
    return res.status(500).json({ error: "failed" });
  };

  // Manual reset of the LATCHED global breaker — the only way it reopens.
  router.post("/admin/api/fortress/breaker/reset", requireAuth, requireAdmin, express.json(), async (req, res) => {
    const reason = validate(req, res, "RESET GLOBAL BREAKER");
    if (!reason) return;
    try {
      const r = await financialContainmentDb.resetBreaker({ reason, actor: actorOf(req) });
      console.error("ADMIN FORTRESS: global breaker reset", { actor: actorOf(req), wasOpen: r && r.wasOpen });
      return res.json(r);
    } catch (err) { return fail(res, "BREAKER RESET", err); }
  });

  // Global kill switch (manual).
  router.post("/admin/api/fortress/kill-switch", requireAuth, requireAdmin, express.json(), async (req, res) => {
    const on = req.body && req.body.on;
    if (typeof on !== "boolean") return res.status(400).json({ error: "on_required" });
    const reason = validate(req, res, on ? "KILL SWITCH ON" : "KILL SWITCH OFF");
    if (!reason) return;
    try {
      const r = await financialContainmentDb.setKillSwitch({ on, reason, actor: actorOf(req) });
      console.error("ADMIN FORTRESS: kill switch", { on, actor: actorOf(req) });
      return res.json(r);
    } catch (err) { return fail(res, "KILL SWITCH", err); }
  });

  // Per-household financial hold (kill switch for one household).
  router.post("/admin/api/fortress/households/:id/hold", requireAuth, requireAdmin, express.json(), async (req, res) => {
    const hold = req.body && req.body.hold;
    if (typeof hold !== "boolean") return res.status(400).json({ error: "hold_required" });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "invalid_household" });
    const reason = validate(req, res, hold ? "HOLD HOUSEHOLD" : "RELEASE HOUSEHOLD");
    if (!reason) return;
    try {
      const r = await financialContainmentDb.setHouseholdHold({ householdId: req.params.id, hold, reason, actor: actorOf(req), source: "admin" });
      console.error("ADMIN FORTRESS: household hold", { householdId: req.params.id, hold, actor: actorOf(req) });
      return res.json(r);
    } catch (err) { return fail(res, "HOUSEHOLD HOLD", err); }
  });

  return router;
}

module.exports = { createAdminFortressRoutes };
