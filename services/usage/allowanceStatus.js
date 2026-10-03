// allowanceStatus.js — the customer-facing view of a household's monitored
// allowance: the data contract Build 20 consumes (docs/finance/
// BUILD20_MONITORING_ALLOWANCE_API.md). Pure. Used by the mobile API
// (/api/v1/me/dashboard) and the web dashboard (/dashboard-data), so every
// surface shows the same numbers and the same honest monitoring state.
//
// Rounding is always in the customer's favour: minutes USED round down, so
// remaining rounds up. Internally every limit is enforced on exact seconds.
//
// state (what the app must say):
//   available    — under the first warning point; new unknown calls monitored
//   low          — at/over a warning point (75%, 90%); still monitored
//   exhausted    — allowance used (enforced plans only): new unknown calls
//                  connect WITHOUT monitoring — callsContinue: true
//   paused       — a safety limit or kill switch has stopped monitoring;
//                  calls still connect, unmonitored
//   unavailable  — usage couldn't be read; the app must not claim active
//                  monitoring (monitoringActive: null, never true)
// When the allowance is NOT enforced (MONITORING_ALLOWANCE_ENFORCED unset),
// usage past 100% is reported (overAllowance: true) but the state stays
// monitored — the app must not tell the customer monitoring has stopped
// when it hasn't.
'use strict';

function computeAllowanceStatus({ plan, usedSeconds, bonusSeconds = 0, periodStart = null, periodEnd, safetyPaused = false, readFailed = false, lastWarningPoint = null }) {
  const allowanceSeconds = plan.allowanceSeconds + Math.max(0, Number(bonusSeconds) || 0);
  const allowanceMinutes = Math.floor(allowanceSeconds / 60);
  const base = {
    version: 1,
    planCode: plan.code,
    allowanceMinutes,
    enforced: Boolean(plan.enforced),
    warningPoints: [...plan.warningPoints.map((p) => Math.round(p * 100)), 100],
    periodStartsAt: periodStart ? new Date(periodStart).toISOString() : null,
    resetsAt: periodEnd ? new Date(periodEnd).toISOString() : null,
    callsContinue: true, // calls are never blocked by the allowance
  };

  if (readFailed) {
    return { ...base, usedMinutes: null, remainingMinutes: null, usedPercent: null, remainingPercent: null, overAllowance: null, state: 'unavailable', monitoringActive: null, lastWarningPoint: null };
  }

  const used = Math.max(0, Math.floor(Number(usedSeconds) || 0));
  const fraction = allowanceSeconds > 0 ? used / allowanceSeconds : 1;
  const usedMinutes = Math.min(allowanceMinutes, Math.floor(used / 60));
  const remainingMinutes = Math.max(0, allowanceMinutes - usedMinutes);
  const usedPercent = Math.min(100, Math.floor(fraction * 100));
  const exhausted = used >= allowanceSeconds;

  let state;
  if (exhausted && plan.enforced) state = 'exhausted';
  else if (safetyPaused) state = 'paused';
  else if (plan.warningPoints.some((p) => fraction >= p) || exhausted) state = 'low';
  else state = 'available';

  return {
    ...base,
    usedMinutes,
    remainingMinutes,
    usedPercent,
    remainingPercent: exhausted ? 0 : 100 - usedPercent,
    overAllowance: exhausted,
    state,
    monitoringActive: state === 'available' || state === 'low',
    lastWarningPoint,
  };
}

module.exports = { computeAllowanceStatus };
