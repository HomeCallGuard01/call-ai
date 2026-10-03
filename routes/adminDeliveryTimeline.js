const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { supabaseAdmin } = require("../services/supabaseClients");
const { getHouseholdDeliveryEvents, buildDeliveryTimeline } = require("../services/callDeliveryEvents");
const { getHouseholdDeliveryHealth } = require("../database/deliveryEvidence");

// Admin call-delivery diagnostic (2026-09-30, release readiness P3).
//
// GET /admin/api/households/:id/call-delivery-timeline?since=ISO
//
// Answers "why didn't the phone ring?" for one household: every recorded
// stage of each recent call (migration 064, services/callDeliveryEvents.js),
// a plain-English diagnosis naming the stage where delivery stopped, the
// latest device-readiness reports and the household's delivery health.
// Read-only. Content-free by construction (the table holds no caller
// numbers, names or transcripts). Kept in its own router so it doesn't
// collide with the admin control-centre work in routes/admin.js; the UI
// spec is docs/launch/CALL_DELIVERY_TELEMETRY.md.

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_WINDOW_MS = 14 * 24 * 3600 * 1000;

router.get("/admin/api/households/:id/call-delivery-timeline", requireAuth, requireAdmin, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: "household_not_found" });
  if (!supabaseAdmin) return res.status(503).json({ error: "unavailable" });

  const since = req.query.since && !Number.isNaN(new Date(req.query.since).getTime())
    ? new Date(req.query.since)
    : new Date(Date.now() - DEFAULT_WINDOW_MS);

  try {
    const { data: household, error } = await supabaseAdmin
      .from("households")
      .select("id, voice_client_registered_at, delivery_verified_at")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return res.status(503).json({ error: "unavailable" });
    if (!household) return res.status(404).json({ error: "household_not_found" });

    const [events, health] = await Promise.all([
      getHouseholdDeliveryEvents({ supabase: supabaseAdmin, householdId: household.id, since }),
      getHouseholdDeliveryHealth({ supabase: supabaseAdmin, household }),
    ]);
    const timeline = buildDeliveryTimeline(events);
    res.json({
      householdId: household.id,
      since: since.toISOString(),
      telemetryAvailable: events.length > 0,
      health,
      deviceReadiness: timeline.deviceReadiness,
      calls: timeline.calls,
    });
  } catch (err) {
    console.error("ADMIN DELIVERY TIMELINE ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
