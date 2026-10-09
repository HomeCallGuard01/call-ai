// Support-verified forwarding proof (migration 075, launch blocker B3,
// Andrew-approved 2026-10-09). The only way a household becomes Protected
// until the automatic verification call exists.
//
// Same safety shape as the Fortress controls (routes/adminFortress.js):
// requireAuth + requireAdmin, JSON only (a cross-site form cannot send
// application/json without a CORS preflight), a typed confirmation phrase, a
// written reason, and the audited ACTOR is the authenticated admin — never
// request-supplied. The evidence rules themselves are enforced inside the
// database function, so this layer cannot weaken them. The durable audit is
// public.forwarding_proof_audit (append-only).
//
// Off unless HCG_SUPPORT_VERIFICATION_CALLERS names at least one designated
// support phone (E.164, comma separated).
const path = require("path");
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { createForwardingProofDb, parseSupportCallers } = require("../database/forwardingProof");

const RECORD_PHRASE = "RECORD FORWARDING PROOF";
const CLEAR_PHRASE = "CLEAR FORWARDING PROOF";
const DEFAULT_MAX_AGE_MINUTES = 60;

function maxAgeFrom(env) {
  const n = Number.parseInt(env.HCG_SUPPORT_VERIFICATION_MAX_AGE_MINUTES || "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 240 ? n : DEFAULT_MAX_AGE_MINUTES;
}

function createAdminForwardingProofRoutes({ supabaseAdmin, forwardingProofDb, env = process.env }) {
  const router = express.Router();
  const db = forwardingProofDb || (supabaseAdmin ? createForwardingProofDb(supabaseAdmin) : null);
  const actorOf = (req) => `admin:${req.authUserId}`;
  const validHousehold = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const config = () => ({ supportCallers: parseSupportCallers(env.HCG_SUPPORT_VERIFICATION_CALLERS), maxAgeMinutes: maxAgeFrom(env) });

  function validate(req, res, phrase) {
    if (!req.is("application/json")) { res.status(415).json({ error: "json_required" }); return null; }
    if (!validHousehold(req.params.id)) { res.status(400).json({ error: "invalid_household" }); return null; }
    const { reason, confirm } = req.body || {};
    if (typeof reason !== "string" || reason.trim().length < 10) { res.status(400).json({ error: "reason_required", message: "A reason of at least 10 characters is required" }); return null; }
    if (confirm !== phrase) { res.status(400).json({ error: "confirmation_required", message: `Type exactly: ${phrase}` }); return null; }
    if (!req.authUserId) { res.status(403).json({ error: "no_admin_identity" }); return null; }
    return reason.trim();
  }
  const refusedOrFailed = (res, label, err) => {
    if (err && err.refusal) {
      console.error(`ADMIN FORWARDING PROOF ${label} REFUSED:`, err.refusal);
      return res.status(409).json({ error: "refused", message: err.refusal });
    }
    console.error(`ADMIN FORWARDING PROOF ${label} FAILED:`, err && err.message);
    return res.status(500).json({ error: "failed" });
  };

  router.get("/admin/forwarding-proof", requireAuth, requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "admin-forwarding-proof.html"));
  });

  router.get("/admin/api/households/:id/forwarding-proof", requireAuth, requireAdmin, async (req, res) => {
    if (!validHousehold(req.params.id)) return res.status(400).json({ error: "invalid_household" });
    if (!db) return res.status(503).json({ error: "database not configured" });
    try {
      const { supportCallers, maxAgeMinutes } = config();
      const state = await db.getState({ householdId: req.params.id, supportCallers, maxAgeMinutes });
      if (!state) return res.status(404).json({ error: "not_found" });
      res.set("Cache-Control", "no-store");
      return res.json(state);
    } catch (err) { return refusedOrFailed(res, "READ", err); }
  });

  router.post("/admin/api/households/:id/forwarding-proof", requireAuth, requireAdmin, express.json(), async (req, res) => {
    const reason = validate(req, res, RECORD_PHRASE);
    if (!reason) return;
    const { evidenceCallSid, dialledLast4 } = req.body || {};
    if (typeof evidenceCallSid !== "string" || !/^CA[0-9a-f]{32}$/i.test(evidenceCallSid.trim())) {
      return res.status(400).json({ error: "evidence_call_required", message: "Choose the evidence call (a Twilio Call SID)" });
    }
    if (typeof dialledLast4 !== "string" || !/^\d{4}$/.test(dialledLast4)) {
      return res.status(400).json({ error: "dialled_last4_required", message: "Enter the last 4 digits of the customer's own mobile number you dialled" });
    }
    const { supportCallers, maxAgeMinutes } = config();
    if (supportCallers.length === 0) {
      return res.status(503).json({ error: "not_configured", message: "No designated support phone (HCG_SUPPORT_VERIFICATION_CALLERS)" });
    }
    if (!db) return res.status(503).json({ error: "database not configured" });
    try {
      const r = await db.recordSupportProof({
        householdId: req.params.id, evidenceCallSid: evidenceCallSid.trim(), dialledLast4,
        supportCallers, reason, actor: actorOf(req), maxAgeMinutes,
      });
      console.error("ADMIN FORWARDING PROOF: recorded", { householdId: req.params.id, evidenceCallSid: evidenceCallSid.trim(), actor: actorOf(req) });
      return res.json(r);
    } catch (err) { return refusedOrFailed(res, "RECORD", err); }
  });

  router.post("/admin/api/households/:id/forwarding-proof/clear", requireAuth, requireAdmin, express.json(), async (req, res) => {
    const reason = validate(req, res, CLEAR_PHRASE);
    if (!reason) return;
    if (!db) return res.status(503).json({ error: "database not configured" });
    try {
      const r = await db.clearProof({ householdId: req.params.id, reason, actor: actorOf(req) });
      console.error("ADMIN FORWARDING PROOF: cleared", { householdId: req.params.id, actor: actorOf(req), cleared: r && r.cleared });
      return res.json(r);
    } catch (err) { return refusedOrFailed(res, "CLEAR", err); }
  });

  return router;
}

module.exports = { createAdminForwardingProofRoutes, RECORD_PHRASE, CLEAR_PHRASE };
