'use strict';

// fortressOverview.js — admin VISIBILITY of the Launch Fortress controls
// (integration 2026-10-03, §15). READ-ONLY. It changes no safety state.
//
// DASHBOARD ≠ ENFORCEMENT. Every figure here is read from the database the
// enforcing functions use (067 fc_*), so it shows what Fortress believes —
// it does not prove a control works. A control is proven only by its tests
// and the staging validation plan. Money figures are HCG's ESTIMATED cost
// (`actual` stays 0 until a provider billing feed is wired — it is not).
//
// Safety-state CHANGES (kill switch, breaker reset, budget adjustments,
// profile changes) remain database functions only (fc_set_kill_switch,
// fc_reset_breaker, fc_admin_adjust, fc_set_budget_profile), each audited with
// an actor and a reason. No HTTP route can change them.

const STATEMENT = 'Visibility only. These figures come from the same database the Financial Fortress enforces with; they do not prove enforcement. Costs are estimates — no provider billing feed is connected, so "actual" is not known.';

function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
const r4 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 1e4) / 1e4 : null);

/**
 * @param {object} deps
 * @param {object} deps.supabase           service-role client (reads only)
 * @param {Function} deps.globalStatus     () => fc_global_status payload
 * @param {Function} [deps.incidentState]  () => abuse incident state (process-local)
 * @param {Function} [deps.validateCommercial] ({profiles}) => validation report
 */
async function getFortressOverview(deps, now = new Date()) {
  const out = { statement: STATEMENT, generatedAt: now.toISOString() };

  try {
    const g = await deps.globalStatus();
    out.global = {
      available: true,
      killSwitch: Boolean(g.killSwitch), killReason: g.killReason || null,
      breakerOpen: Boolean(g.breakerOpen), breakerReason: g.breakerReason || null, breakerOpenedAt: g.breakerOpenedAt || null,
      enforcementMode: g.enforcementMode || null,
      activeCalls: g.activeCount, activeReservedGbp: r4(g.activeReservedGbp), activeWorstCaseGbp: r4(g.activeWorstCaseGbp),
      entitledHouseholds: g.entitledHouseholds, caps: g.caps || null, window: g.window || null,
    };
  } catch (err) {
    out.global = { available: false, error: String(err.message || err).slice(0, 200) };
  }

  if (typeof deps.incidentState === 'function') {
    try {
      const s = await deps.incidentState();
      out.incident = { level: s.level, unavailable: Boolean(s.unavailable), sources: (s.sources || []).map((x) => ({ source: x.source, level: x.level })), scope: 'this server instance (abuse counters are process-local until migration 066 adapters exist)' };
    } catch (err) {
      out.incident = { available: false, error: String(err.message || err).slice(0, 200) };
    }
  }

  // Highest exposure / usage this period, with the permanent account number.
  try {
    const { data: accounts, error } = await deps.supabase
      .from('fc_budget_accounts')
      .select('household_id, profile, period_start, period_end, base_budget_gbp, adjustments_gbp, delivery_reserve_gbp, consumed_gbp, reserved_gbp, last_denial_reason, last_denial_at')
      .lte('period_start', now.toISOString())
      .gt('period_end', now.toISOString())
      .order('consumed_gbp', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const ids = (accounts || []).map((a) => a.household_id);
    let byId = new Map();
    if (ids.length) {
      const { data: hh, error: hhErr } = await deps.supabase.from('households').select('id, account_number, email').in('id', ids);
      if (hhErr) throw new Error(hhErr.message);
      byId = new Map((hh || []).map((h) => [h.id, h]));
    }
    out.households = (accounts || []).map((a) => {
      const capacity = Number(a.base_budget_gbp) + Number(a.adjustments_gbp);
      const used = Number(a.consumed_gbp) + Number(a.reserved_gbp);
      const h = byId.get(a.household_id) || {};
      return {
        accountNumber: h.account_number || null,
        householdId: a.household_id,
        email: maskEmail(h.email),
        profile: a.profile,
        periodEnd: a.period_end,
        usedPercent: capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : null,
        estimatedCommittedGbp: r4(a.consumed_gbp),
        reservedGbp: r4(a.reserved_gbp),
        budgetGbp: r4(capacity),
        deliveryReserveGbp: r4(a.delivery_reserve_gbp),
        lastRefusal: a.last_denial_reason ? { reason: a.last_denial_reason, at: a.last_denial_at } : null,
      };
    }).sort((x, y) => (Number(y.estimatedCommittedGbp) + Number(y.reservedGbp)) - (Number(x.estimatedCommittedGbp) + Number(x.reservedGbp))).slice(0, 20);
  } catch (err) {
    out.households = { available: false, error: String(err.message || err).slice(0, 200) };
  }

  try {
    const { data, error } = await deps.supabase.from('fc_events').select('created_at, level, rule, household_id, call_sid').order('created_at', { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    out.recentEvents = data || [];
  } catch (err) {
    out.recentEvents = { available: false, error: String(err.message || err).slice(0, 200) };
  }

  if (typeof deps.validateCommercial === 'function') {
    let profiles = null;
    try {
      const { data, error } = await deps.supabase.from('fc_budget_profiles').select('profile, period_budget_gbp, delivery_reserve_gbp, delivery_reserve_scope, essential_reserve_gbp, monitoring_allowed');
      if (!error) profiles = data;
    } catch { profiles = null; }
    out.commercial = deps.validateCommercial({ profiles });
  }
  return out;
}

module.exports = { getFortressOverview, maskEmail, STATEMENT };
