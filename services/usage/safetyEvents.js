// safetyEvents.js — records a financial-safety intervention in the audit
// log (financial_safety_events, migration 056) and raises the matching
// operational alert. Never throws: a failure to audit/alert is logged,
// but can never affect a call or turn a "stop" decision into a "go".
//
// Levels:
//   info      — logged + audit row (e.g. allowance reached mid-call)
//   warning   — logged + audit row, no page (e.g. household stream limit)
//   critical  — audit + alert (a household limit, or the safety system
//               unable to establish budget)
//   emergency — audit + alert (platform-wide limit or kill switch)
'use strict';

const { logEvent } = require('../liveMonitoring/structuredLog');

function createSafetyEventRecorder({ recordSafetyEvent, sendAlert }) {
  return async function recordIntervention(event) {
    logEvent('financial_safety_intervention', {
      level: event.level,
      rule: event.rule,
      action: event.action,
      householdId: event.householdId || null,
      callSid: event.callSid || null,
      usageSecondsBefore: event.usageSecondsBefore ?? null,
      estimatedCostBeforeGbp: event.estimatedCostBeforeGbp ?? null,
    });

    if (typeof recordSafetyEvent === 'function') {
      await Promise.resolve()
        .then(() => recordSafetyEvent(event))
        .catch(err => logEvent('financial_safety_audit_failed', { rule: event.rule, error: err.message }));
    }

    if ((event.level === 'critical' || event.level === 'emergency') && typeof sendAlert === 'function') {
      const message =
        `[${event.level.toUpperCase()}] ${event.rule}: ${event.action}` +
        (event.householdId ? ` — household ${event.householdId}` : '') +
        (Number.isFinite(event.usageSecondsBefore) ? `, ${Math.round(event.usageSecondsBefore / 60)} monitored min this period` : '') +
        (Number.isFinite(event.estimatedCostBeforeGbp) ? `, est. £${event.estimatedCostBeforeGbp.toFixed(2)}` : '');
      await Promise.resolve()
        .then(() => sendAlert(`financial_safety_${event.rule}`, message, {
          householdId: event.householdId || null,
          callSid: event.callSid || null,
          level: event.level,
          action: event.action,
          notification: event.notification || null,
          details: event.details || null,
        }))
        .catch(err => logEvent('financial_safety_alert_failed', { rule: event.rule, error: err.message }));
    }
  };
}

module.exports = { createSafetyEventRecorder };
