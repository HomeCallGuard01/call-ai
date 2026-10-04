// Admin customer-lifecycle routes (customer lifecycle automation,
// 2026-10-04). READ-ONLY, all behind requireAuth + requireAdmin:
//
//   GET /admin/api/lifecycle/exceptions        the operational exception queue
//   GET /admin/api/lifecycle/households/:id    one household's activation state,
//                                              exceptions, due communications and
//                                              quarantine plan
//
// Nothing here changes a row, contacts a customer or calls a provider. The
// actions each item recommends are performed through the EXISTING audited
// admin routes (retry-provisioning, confirm-deactivation, fortress hold …).
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { loadLifecycleSnapshots } = require("../database/lifecycleSnapshot");
const { buildExceptionQueue, householdExceptions, setupClockStartMs } = require("../services/lifecycle/exceptionQueue");
const { planLifecycleCommunications } = require("../services/lifecycle/communicationsPlan");
const { planQuarantineActions } = require("../services/lifecycle/numberRetirement");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DECISION inputs. autoConfirmAfterDays stays null (decision D-N2: numbers
// are never auto-released). Monthly number cost (soft-launch integration
// 2026-10-04, brief §6 B9/D16): defaults to the economics register's KNOWN
// rental (Twilio Pricing API + 45 billed number-months) so billed quarantines
// always show their £ exposure; LIFECYCLE_MONTHLY_NUMBER_COST_GBP overrides.
function policyFromEnv(env) {
  const cost = Number.parseFloat(env.LIFECYCLE_MONTHLY_NUMBER_COST_GBP);
  if (Number.isFinite(cost) && cost >= 0) return { autoConfirmAfterDays: null, monthlyNumberCostGbp: cost, monthlyNumberCostSource: 'env' };
  const register = require("../services/finance/economicsRegister");
  return { autoConfirmAfterDays: null, monthlyNumberCostGbp: register.value('numberRentalGbpPerMonth'), monthlyNumberCostSource: 'register:numberRentalGbpPerMonth (KNOWN)' };
}

function createAdminLifecycleRoutes({ supabaseAdmin, getDeliveryHealth = null, env = process.env, now = () => new Date() }) {
  const router = express.Router();

  router.get("/admin/api/lifecycle/exceptions", requireAuth, requireAdmin, async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: "database not configured" });
    try {
      const at = now();
      const loaded = await loadLifecycleSnapshots({ supabase: supabaseAdmin });
      const queue = buildExceptionQueue({ snapshots: loaded.snapshots, orphanQuarantineRows: loaded.orphanQuarantineRows }, at);
      const quarantineRows = [
        ...loaded.snapshots.flatMap((s) => s.quarantineRows.map((q) => ({ ...q, entitlements: s.entitlements }))),
        ...loaded.orphanQuarantineRows,
      ];
      res.set("Cache-Control", "no-store");
      return res.json({
        label: "read-only — derived on request; resolve items through the existing admin actions",
        ...queue,
        numberRetirement: planQuarantineActions(quarantineRows, { now: at, ...policyFromEnv(env) }).summary,
        sources: loaded.sources,
        truncated: loaded.truncated,
      });
    } catch (err) {
      console.error("ADMIN LIFECYCLE EXCEPTIONS ERROR:", err.message);
      return res.status(500).json({ error: "failed" });
    }
  });

  router.get("/admin/api/lifecycle/households/:id", requireAuth, requireAdmin, async (req, res) => {
    if (!UUID_RE.test(req.params.id || "")) return res.status(400).json({ error: "invalid_household_id" });
    if (!supabaseAdmin) return res.status(503).json({ error: "database not configured" });
    try {
      const at = now();
      const loaded = await loadLifecycleSnapshots({ supabase: supabaseAdmin, householdId: req.params.id });
      const snapshot = loaded.snapshots[0];
      if (!snapshot) return res.status(404).json({ error: "not_found" });
      if (getDeliveryHealth) {
        snapshot.deliveryHealth = await Promise.resolve(getDeliveryHealth(snapshot.household)).catch(() => null);
      }
      const { activation, items } = householdExceptions(snapshot, at);
      res.set("Cache-Control", "no-store");
      return res.json({
        label: "read-only",
        householdId: snapshot.household.id,
        accountNumber: snapshot.household.account_number || null,
        activation,
        exceptions: items,
        // Planned, not sent: no lifecycle message has approved copy or a channel.
        communicationsDue: planLifecycleCommunications(snapshot, activation, { now: at, setupClockMs: setupClockStartMs(snapshot) }),
        quarantine: planQuarantineActions(snapshot.quarantineRows.map((q) => ({ ...q, entitlements: snapshot.entitlements })), { now: at, ...policyFromEnv(env) }),
        sources: { ...loaded.sources, deliveryHealth: snapshot.deliveryHealth ? "loaded" : "not_loaded" },
      });
    } catch (err) {
      console.error("ADMIN LIFECYCLE HOUSEHOLD ERROR:", err.message);
      return res.status(500).json({ error: "failed" });
    }
  });

  return router;
}

module.exports = { createAdminLifecycleRoutes, policyFromEnv };
