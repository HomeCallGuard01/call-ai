// smsWarning.js — sends the one customer warning SMS. Deliberately the
// simplest possible mechanism: fully decoupled from the live call's
// TwiML/bridge, so a failure here can never disrupt or drop the call.

'use strict';

const { logEvent } = require('./structuredLog');

const WARNING_BODY = 'Home Call Guard: this call is showing signs of a possible scam. Stay cautious and avoid sharing personal or financial information.';

// Distinct wording for a red-line termination (2026-08-15) — deliberately
// different from WARNING_BODY: this is a confirmed, acted-on event (the
// call has already been ended), not a caution about ongoing risk.
const RED_LINE_WARNING_BODY = 'Home Call Guard: this call showed clear signs of fraud and was ended automatically. If you shared any details, contact your bank directly using the number on your card.';

// Red line detected only AFTER the call had already ended (2026-09-26
// hang-up flush — mediaStreamHandler.js transcribes the audio still
// buffered at hang-up, and any chunk still in flight when the call
// ended). Deliberately NOT RED_LINE_WARNING_BODY: nothing was "ended
// automatically" — the caller hung up first — so the customer is told
// the truth and what to do now. Wording approved by Andrew 2026-09-26.
const POST_CALL_RED_LINE_WARNING_BODY = "Home Call Guard: the call that just ended showed clear signs of fraud. Don't act on anything the caller asked. If you shared details, contact your bank using the number on your card.";

// Sent once when the per-call monitoring safety limit is reached
// (services/liveMonitoring/monitoringLimit.js) — the customer must never
// be left believing live scam-monitoring is still active on this call
// once it silently isn't. Deliberately simple and non-alarming: this
// call itself has not been flagged as risky, monitoring has simply
// reached its maximum duration and stopped. The underlying phone call
// is never affected by this — see mediaStreamHandler.js's own comment.
const MONITORING_LIMIT_ENDED_BODY =
  'Home Call Guard: This call has exceeded the maximum monitoring time, so active scam monitoring has now ended for this call. If you are unsure about the caller, hang up and contact the organisation using a trusted number.';

/**
 * @param {object} deps
 * @param {{messages: {create: Function}}} deps.client - real or fake Twilio client
 * @param {string} deps.to - household's own phone number to warn
 * @param {string} deps.from - the household's protected Twilio number
 * @param {string} [deps.callSid] - for logging only
 * @param {string} [deps.body] - defaults to the progressive WARNING_BODY
 * @returns {Promise<{sent: boolean, error?: string}>}
 */
async function sendWarningSms({ client, to, from, callSid, body = WARNING_BODY }) {
  try {
    await client.messages.create({ to, from, body });
    logEvent('sms_warning_sent', { callSid, to, redLine: body === RED_LINE_WARNING_BODY || body === POST_CALL_RED_LINE_WARNING_BODY, postCall: body === POST_CALL_RED_LINE_WARNING_BODY });
    return { sent: true };
  } catch (err) {
    logEvent('sms_warning_failed', { callSid, to, error: err.message });
    return { sent: false, error: err.message };
  }
}

module.exports = { sendWarningSms, WARNING_BODY, RED_LINE_WARNING_BODY, POST_CALL_RED_LINE_WARNING_BODY, MONITORING_LIMIT_ENDED_BODY };
