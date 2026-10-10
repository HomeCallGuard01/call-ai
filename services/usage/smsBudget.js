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

// SMS segments actually billed (2026-10-10, duration-evidence finding): a
// message was authorised as ONE segment whatever its length, so a 2-segment
// warning was ~4p under-estimated. GSM-7 basic set: 160 chars, or 153 per
// part when split; the GSM extension chars count double; anything else forces
// UCS-2: 70, or 67 per part. Errs high (never under-counts).
const GSM7_BASIC = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const GSM7_EXT = new Set(Array.from('^{}\\[~]|€\f'));
function smsSegments(body) {
  const chars = Array.from(String(body == null ? '' : body));
  let gsmLen = 0;
  let gsm = true;
  for (const c of chars) {
    if (GSM7_BASIC.has(c)) gsmLen += 1;
    else if (GSM7_EXT.has(c)) gsmLen += 2;
    else { gsm = false; break; }
  }
  if (gsm) return gsmLen <= 160 ? 1 : Math.ceil(gsmLen / 153);
  const units = chars.reduce((n, c) => n + (c.codePointAt(0) > 0xffff ? 2 : 1), 0);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

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
            let auth;
            try {
              auth = await containment.authorizeSpend({
                category: 'sms', householdId: householdId || null, units: smsSegments(params && params.body), period,
                key: containment.smsKey({ householdId, to: params && params.to, body: params && params.body, at: now() }),
              });
            } catch (err) {
              auth = { allowed: false, reason: 'authorization_unavailable', error: err.message };
            }
            if (auth && auth.existing) throw new Error('SMS not sent: duplicate of a message already sent');
            // Explicit permission only: anything but allowed === true
            // (malformed, missing, unavailable) is a refusal.
            if (!auth || auth.allowed !== true) {
              auth = auth || { allowed: false, reason: 'authorization_malformed' };
              recordIntervention({ level: 'warning', rule: `containment_${auth.reason}`, action: 'customer SMS not sent (financial containment)', householdId, details: auth }).catch(() => {});
              throw new Error(`SMS not sent: ${auth.reason}`);
            }
          }
          if (!householdId || !period || !period.periodStart || !period.periodEnd) {
            // No 056 ceiling applies. Sent only if the Fortress (the
            // applicable authority) explicitly authorised it above; with no
            // authority at all, spend is refused (2026-10-04 rule).
            if (containment) return client.messages.create(params);
            recordIntervention({ level: 'warning', rule: 'sms_no_financial_authority', action: 'customer SMS not sent (no applicable financial authority)', householdId: householdId || null, details: {} }).catch(() => {});
            throw new Error('SMS not sent: no_financial_authority');
          }
          let decision;
          try {
            if (typeof claimSmsSend !== 'function') throw new Error('SMS ceiling (claim_sms_send) not configured');
            const timeoutMs = resolveSafetyConfig(env).budgetCheckTimeoutMs;
            let timer;
            decision = await Promise.race([
              claimSmsSend({
                householdId, periodStart: period.periodStart, periodEnd: period.periodEnd, now: now(),
                costGbp: rates.smsPerSegment * smsSegments(params && params.body), limits: smsLimits(resolveSafetyConfig(env)),
              }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`claim_sms_send timed out after ${timeoutMs}ms`)), timeoutMs); }),
            ]).finally(() => clearTimeout(timer));
            if (!decision || typeof decision.allowed !== 'boolean') throw new Error('malformed SMS ceiling response');
          } catch (err) {
            logEvent('sms_budget_check_failed_not_sent', { householdId, error: err.message });
            recordIntervention({ level: 'warning', rule: 'sms_budget_unavailable', action: 'customer SMS not sent (SMS ceiling could not be checked; fail closed)', householdId, details: { error: err.message } }).catch(() => {});
            throw new Error('SMS not sent: sms_budget_unavailable');
          }
          if (decision.allowed !== true) {
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

module.exports = { createSmsBudget, smsSegments };
