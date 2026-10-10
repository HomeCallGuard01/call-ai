// index.js — process-wide containment singleton (lazy), so server.js,
// number provisioning and anything else share one instance (one degraded
// envelope, one lease memory per process).
'use strict';

const { createContainment } = require('./containment');

let instance = null;

function getContainment() {
  if (!instance) {
    const db = require('../../database/financialContainment');
    const { sendCriticalAlert } = require('../alerting');
    instance = createContainment({
      db,
      recordEvent: async (e) => {
        console.error('FINANCIAL CONTAINMENT:', e.level, e.rule, e.householdId || '', e.callSid || '');
        if (e.level === 'critical' || e.level === 'emergency') {
          await sendCriticalAlert(`containment_${e.rule}`, `Financial containment: ${e.rule}`, { householdId: e.householdId || null, callSid: e.callSid || null, details: e.details || null });
        }
      },
      // WS2 2026-10-10: allowance state transitions (migration 076). Event
      // emission only — the database already wrote the fc_events row. Push /
      // ops-event delivery attaches here (WS3 / lead); no SMS is ever sent.
      onAllowanceStateChange: async (t) => {
        console.log('ALLOWANCE STATE:', t.householdId, `${t.from || '-'} -> ${t.to}`);
      },
    });
  }
  return instance;
}

// Number purchase guard for the REAL Twilio client: one global one-shot
// authorisation per purchase attempt (company-wide daily cap + breaker).
// Fail-closed: no authorisation → no purchase.
async function authorizeNumberPurchase({ householdId, attemptKey }) {
  return getContainment().authorizeSpend({ category: 'number_purchase', householdId: null, units: 1, key: `${householdId || 'none'}:${attemptKey}` });
}

module.exports = { getContainment, authorizeNumberPurchase };
