// smsBudget.js — Layer B SMS ceiling. Wraps the Twilio client handed to the
// live-monitoring pipeline so every customer SMS first claims budget
// (claim_sms_send, migration 056: household per day / per period, company
// per day). Over a ceiling the message is not sent and the intervention is
// audited.
//
// Fail-CLOSED on a 056 database error (soft-launch integration 2026-10-04,
// reversing the earlier fail-open choice on Andrew's rule "financial
// uncertainty must reject spend"; provider containment final T7): if the
// SMS ceiling cannot be checked, the SMS is NOT sent. Trade-off accepted
// and documented: a protective warning SMS can be lost while the 056
// claim is unavailable. The failure is logged and audited.
//
// Financial containment P0 (2026-10-03): when a `containment` service is
// supplied (server.js always does), EVERY send — including the paths that
// previously bypassed the budget because the stream's period was no longer
// known (limit notice / post-hang-up red line / safety stop) or because the
// stream carried no household — first needs a one-shot authorisation from
// the containment ledger. That check is FAIL-CLOSED: no authorisation, no
// SMS. Idempotent per (household, recipient, body, minute), so a retried
// send is never charged or sent twice.
'use strict';

const { resolveCostRates } = require('./costModel');
const { resolveSafetyConfig, smsLimits } = require('./safetyConfig');
const { logEvent } = require('../liveMonitoring/structuredLog');

function createSmsBudget({ client, claimSmsSend, containment = null, recordIntervention = async () => {}, env = process.env, now = () => new Date() }) {
  const rates = resolveCostRates(env);

  // period: { periodStart, periodEnd } from the stream's monitoring reservation
  function forHousehold(householdId, getPeriod) {
    return {
      messages: {
        async create(params) {
          const period = typeof getPeriod === 'function' ? getPeriod() : null;
          if (!client) throw new Error('SMS client not configured');
          if (containment) {
            const auth = await containment.authorizeSpend({
              category: 'sms', householdId: householdId || null, units: 1, period,
              key: containment.smsKey({ householdId, to: params && params.to, body: params && params.body, at: now() }),
            });
            if (auth.existing) throw new Error('SMS not sent: duplicate of a message already sent');
            if (!auth.allowed) {
              recordIntervention({ level: 'warning', rule: `containment_${auth.reason}`, action: 'customer SMS not sent (financial containment)', householdId, details: auth }).catch(() => {});
              throw new Error(`SMS not sent: ${auth.reason}`);
            }
          }
          if (!householdId || !period || !period.periodStart || !period.periodEnd) return client.messages.create(params);
          let decision;
          try {
            decision = await claimSmsSend({
              householdId, periodStart: period.periodStart, periodEnd: period.periodEnd, now: now(),
              costGbp: rates.smsPerSegment, limits: smsLimits(resolveSafetyConfig(env)),
            });
          } catch (err) {
            logEvent('sms_budget_check_failed_not_sent', { householdId, error: err.message });
            recordIntervention({ level: 'warning', rule: 'sms_budget_unavailable', action: 'customer SMS not sent (SMS ceiling could not be checked; fail closed)', householdId, details: { error: err.message } }).catch(() => {});
            throw new Error('SMS not sent: sms_budget_unavailable');
          }
          if (decision && decision.allowed === false) {
            recordIntervention({ level: 'warning', rule: decision.reason || 'sms_limit', action: 'customer SMS not sent (SMS ceiling reached)', householdId, details: decision }).catch(() => {});
            throw new Error(`SMS not sent: ${decision.reason}`);
          }
          return client.messages.create(params);
        },
      },
    };
  }

  return { forHousehold };
}

module.exports = { createSmsBudget };
