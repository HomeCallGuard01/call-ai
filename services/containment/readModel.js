// readModel.js — READ-ONLY views of the containment ledger.
//
//   getAdminHouseholdView(householdId)  — full figures for the Admin Control
//                                         Centre (server-side, admin-only).
//   getAdminGlobalView()                — breaker, kill switch, global exposure,
//                                         rolling windows, caps.
//   getCustomerAllowanceView(household) — the CONTRACT for the customer-facing
//                                         allowance/billing work (Claude 3).
//
// Nothing here writes. There is deliberately no customer-callable way to
// change a budget: top-ups/upgrades are credited server-side from verified
// payment webhooks via fc_admin_adjust(source='topup'|'plan_change'), keyed
// by the payment's own id, so a replayed webhook credits once.
//
// Never reports £0 or "protected" for missing data: unavailable is explicit.
'use strict';

const r2 = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

function createContainmentReadModel({ db, now = () => new Date(), timeoutMs = 2000 }) {
  const timed = (p) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('read model timed out')), timeoutMs); })]).finally(() => clearTimeout(t));
  };

  async function getAdminHouseholdView(householdId) {
    try { return { available: true, ...(await timed(db.householdStatus({ householdId, now: now() }))) }; }
    catch (err) { return { available: false, householdId, error: String(err.message || err) }; }
  }

  async function getAdminGlobalView() {
    try { return { available: true, ...(await timed(db.globalStatus({ now: now() }))) }; }
    catch (err) { return { available: false, error: String(err.message || err) }; }
  }

  /**
   * Customer-safe view. States:
   *   ok           — monitored calls available
   *   low          — < 25% of the budget left
   *   reserve      — budget spent; calls still delivered (unmonitored) from the delivery reserve
   *   exhausted    — nothing left this period; new calls are not connected until the period resets
   *   unavailable  — couldn't be read (never shown as "protected")
   * Money is shown only as a fraction; the £ figures are HCG's cost, not a
   * customer price, and are not exposed.
   */
  async function getCustomerAllowanceView(household) {
    const householdId = household && household.id;
    if (!householdId) return { state: 'unavailable', monitoringAvailable: null, callsDelivered: null };
    let s;
    try { s = await timed(db.householdStatus({ householdId, now: now() })); }
    catch { return { state: 'unavailable', monitoringAvailable: null, callsDelivered: null }; }
    if (!s || !s.hasAccount) {
      return { state: 'ok', monitoringAvailable: s && s.profile !== 'unentitled', callsDelivered: true, usedFraction: 0, periodEnd: null };
    }
    const budget = Number(s.budgetGbp) + Number(s.adjustmentsGbp);
    const remaining = Number(s.remainingBudgetGbp);
    const withReserve = Number(s.remainingWithReserveGbp);
    const usedFraction = budget > 0 ? Math.min(1, Math.max(0, 1 - remaining / budget)) : 1;
    let state = 'ok';
    if (withReserve <= 0) state = 'exhausted';
    else if (remaining <= 0) state = 'reserve';
    else if (budget > 0 && remaining / budget < 0.25) state = 'low';
    return {
      state,
      monitoringAvailable: state === 'ok' || state === 'low',
      callsDelivered: state !== 'exhausted',
      usedFraction: r2(usedFraction),
      periodStart: s.periodStart || null,
      periodEnd: s.periodEnd || null,
      lastRefusal: s.lastDenialReason ? { reason: s.lastDenialReason, at: s.lastDenialAt } : null,
    };
  }

  return { getAdminHouseholdView, getAdminGlobalView, getCustomerAllowanceView };
}

module.exports = { createContainmentReadModel };
