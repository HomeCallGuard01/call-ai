// Admin operational events (soft-launch integration 2026-10-04): the
// dashboard view of NEW_GENUINE_CUSTOMER / CUSTOMER_PROTECTED /
// CUSTOMER_NEEDS_ATTENTION and their notification deliveries.
// requireAuth + requireAdmin. 503 until migration 072 is applied.
// Unseen events and failed/retrying deliveries are counted up front so the
// dashboard can make them obvious.
"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { isMissingRelation } = require("../database/lifecycleSnapshot");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createAdminOpsEventRoutes({ supabaseAdmin }) {
  const router = express.Router();

  router.get("/admin/api/ops-events", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: "database not configured" });
    const [events, unseen, problem] = await Promise.all([
      supabaseAdmin.from("ops_events").select("id, event_type, account_number, severity, payload, occurred_at, created_at, seen_at, seen_by").order("created_at", { ascending: false }).limit(200),
      supabaseAdmin.from("ops_events").select("id", { count: "exact", head: true }).is("seen_at", null),
      supabaseAdmin.from("ops_event_deliveries").select("id, event_id, channel, recipient_role, status, attempts, last_error, next_attempt_at").in("status", ["failed", "retry"]).limit(200),
    ]);
    const err = events.error || unseen.error || problem.error;
    if (err) return res.status(isMissingRelation(err) ? 503 : 500).json({ error: isMissingRelation(err) ? "operational events not deployed (migration 072)" : "unreadable" });
    return res.json({ unseenCount: unseen.count || 0, deliveryProblems: problem.data || [], events: events.data || [] });
  });

  router.post("/admin/api/ops-events/:id/seen", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: "database not configured" });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid id" });
    const { data, error } = await supabaseAdmin.rpc("ops_mark_event_seen", { p_event_id: req.params.id, p_actor: `admin:${req.authUserId || "unknown"}` });
    if (error) return res.status(isMissingRelation(error) ? 503 : 500).json({ error: "could not mark seen" });
    return res.json({ ok: true, seenAt: data && data.seen_at });
  });

  return router;
}

module.exports = { createAdminOpsEventRoutes };
