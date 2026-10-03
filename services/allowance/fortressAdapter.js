// fortressAdapter.js — maps Financial Fortress's household budget status
// (security/financial-containment-p0, fc_household_status; PROVISIONAL and
// unmerged on 2026-10-03) onto the shape the customer read model consumes,
// so the customer UI can switch source without changing. Pure.
//
// Fortress authorises in £ (budget + adjustments − consumed − reserved),
// not minutes. The customer is never shown £ or minutes from it — only a
// percentage, a reset date and a status — so internal costs stay internal.
//
// Reservations count as USED here (conservative): a live call's reserved
// lease is money Fortress has already set aside, so "remaining" never
// overstates what the customer can still use.
//
// Selected by ALLOWANCE_SOURCE=fortress (default: 056 minutes). Until
// Fortress merges, the default path is used everywhere.
'use strict';

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {object|null} status fc_household_status() result
 * @param {object} args
 * @param {object} args.plan       resolvePlan() result (code + warning points)
 * @param {boolean} [args.monitoringAllowed] profile monitoring flag (default true)
 */
function fromFortressHouseholdStatus(status, { plan, monitoringAllowed = true }) {
  const warningPoints = [...plan.warningPoints.map((p) => Math.round(p * 100)), 100];
  const base = {
    version: 1, planCode: plan.code, allowanceMinutes: null, enforced: true, warningPoints,
    periodStartsAt: null, resetsAt: null, callsContinue: true, source: 'fortress',
  };
  if (!status || !status.hasAccount) {
    // No account yet this period = nothing used yet; Fortress creates it on
    // the first authorised call. Shown as full, not unknown.
    return status && status.hasAccount === false
      ? { ...base, usedMinutes: null, remainingMinutes: null, usedPercent: 0, remainingPercent: 100, reservedPercent: 0, overAllowance: false, state: 'available', monitoringActive: monitoringAllowed, lastWarningPoint: null, liveCalls: Array.isArray(status.live) ? status.live.length : 0 }
      : { ...base, usedMinutes: null, remainingMinutes: null, usedPercent: null, remainingPercent: null, reservedPercent: null, overAllowance: null, state: 'unavailable', monitoringActive: null, lastWarningPoint: null, liveCalls: null };
  }
  const total = n(status.budgetGbp) + n(status.adjustmentsGbp);
  const consumed = n(status.estimatedConsumedGbp);
  const reserved = n(status.reservedGbp);
  const fraction = total > 0 ? (consumed + reserved) / total : 1;
  const usedPercent = Math.min(100, Math.max(0, Math.floor(fraction * 100)));
  const exhausted = n(status.remainingBudgetGbp) <= 0;
  // Budget gone but Fortress's delivery reserve still funds unmonitored
  // delivery. Integration 2026-10-03: the reserve may fund only TRUSTED
  // callers (profile scope 'trusted_only', the paid default), so:
  //   callsContinue          — every caller still connects
  //   trustedCallersContinue — the household's trusted callers still connect
  // Both gone: Fortress refuses new calls.
  const reserveLeft = n(status.remainingWithReserveGbp) > 0;
  const scope = status.deliveryReserveScope || 'all';
  const callsContinue = !exhausted || (reserveLeft && scope === 'all');
  const trustedCallersContinue = !exhausted || (reserveLeft && scope !== 'none');
  const crossed = warningPoints.filter((p) => p < 100 && usedPercent >= p);
  return {
    ...base,
    periodStartsAt: status.periodStart ? new Date(status.periodStart).toISOString() : null,
    resetsAt: status.periodEnd ? new Date(status.periodEnd).toISOString() : null,
    callsContinue,
    trustedCallersContinue,
    usedMinutes: null,
    remainingMinutes: null,
    usedPercent,
    remainingPercent: exhausted ? 0 : 100 - usedPercent,
    reservedPercent: total > 0 ? Math.min(100, Math.round((reserved / total) * 100)) : 0,
    overAllowance: exhausted,
    state: exhausted ? 'exhausted' : crossed.length ? 'low' : 'available',
    monitoringActive: !exhausted && monitoringAllowed,
    lastWarningPoint: exhausted ? 100 : crossed.length ? crossed[crossed.length - 1] : null,
    liveCalls: Array.isArray(status.live) ? status.live.length : 0,
  };
}

module.exports = { fromFortressHouseholdStatus };
