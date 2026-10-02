// Account classification — admin only (2026-09-29). Reporting label with
// an append-only audit trail (migration 055). No effect on entitlement,
// billing, call routing or telephony: see services/accountClassificationChanges.js.
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { setAccountClassification, getClassificationHistory } = require("../services/accountClassificationChanges");

const router = express.Router();

router.get("/admin/api/households/:id/classification", requireAuth, requireAdmin, async (req, res) => {
  const result = await getClassificationHistory(req.params.id);
  if (!result.available) return res.status(result.status || 503).json({ error: "unavailable", reason: result.reason });
  res.json(result);
});

router.post("/admin/api/households/:id/classification", requireAuth, requireAdmin, express.json({ limit: "4kb" }), async (req, res) => {
  const body = req.body || {};
  const result = await setAccountClassification({
    householdId: req.params.id,
    classification: body.classification,
    note: body.note,
    expectedPrevious: body.expectedPrevious,
    actorUserId: req.authUserId,
    actorEmail: req.household && req.household.email ? req.household.email : null,
  });
  if (!result.ok) return res.status(result.status).json({ error: "refused", reason: result.reason });
  console.log("ACCOUNT CLASSIFICATION CHANGED:", req.params.id, result.result && result.result.previous, "→", body.classification, "by", req.authUserId);
  res.json({ ok: true, ...result.result });
});

module.exports = router;
