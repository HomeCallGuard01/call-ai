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
    logEvent('sms_warning_sent', { callSid, to, redLine: body === RED_LINE_WARNING_BODY });
    return { sent: true };
  } catch (err) {
    logEvent('sms_warning_failed', { callSid, to, error: err.message });
    return { sent: false, error: err.message };
  }
}

module.exports = { sendWarningSms, WARNING_BODY, RED_LINE_WARNING_BODY };
