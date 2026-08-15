// callTermination.js — the bounded, deterministic red-line termination
// sequence (2026-08-15). Exactly three attempts, no loop, no polling,
// no unbounded retry:
//
//   1. Redirect the live call to a TwiML endpoint that plays a brief,
//      generic caller-facing announcement, then hangs up. Redirecting the
//      parent call away from its <Dial> also tears down the connected
//      child leg automatically — no separate action needed for the
//      destination side.
//   2. If that REST call fails, retry the SAME redirect exactly once —
//      covers a single transient network/API blip, nothing more.
//   3. If the retry also fails, fall back to a different, blunter control
//      primitive: force the call to `completed` directly via the REST
//      API, skipping the caller announcement. This is a distinct failure
//      mode from (1)/(2) failing (the redirect/TwiML-fetch path itself),
//      not a repeat of the same request.
//
// If all three attempts fail, this returns { terminated: false, ... }.
// The caller (riskMonitor.js) is responsible for sending the customer SMS
// warning regardless — it is not gated on termination succeeding — and
// for the failure being logged clearly enough to be operationally
// visible. This function itself never retries beyond these three
// attempts and never loops.

'use strict';

const { logEvent } = require('./structuredLog');

/**
 * @param {object} opts
 * @param {{calls: (sid: string) => {update: Function}}} opts.client - real or fake Twilio REST client
 * @param {string} opts.callSid
 * @param {string} opts.redirectUrl - TwiML endpoint for the graceful announcement+hangup
 * @param {string} opts.reason - critical signal ID(s), for logging only
 * @returns {Promise<{terminated: boolean, method: string|null, attempts: number, error?: string}>}
 */
async function terminateCall({ client, callSid, redirectUrl, reason }) {
  // Attempt 1: graceful redirect.
  try {
    await client.calls(callSid).update({ url: redirectUrl, method: 'POST' });
    logEvent('red_line_call_terminated', { callSid, reason, method: 'redirect', attempt: 1 });
    return { terminated: true, method: 'redirect', attempts: 1 };
  } catch (err1) {
    logEvent('red_line_termination_attempt_failed', { callSid, reason, method: 'redirect', attempt: 1, error: err1.message });
  }

  // Attempt 2: retry the same redirect exactly once.
  try {
    await client.calls(callSid).update({ url: redirectUrl, method: 'POST' });
    logEvent('red_line_call_terminated', { callSid, reason, method: 'redirect', attempt: 2 });
    return { terminated: true, method: 'redirect', attempts: 2 };
  } catch (err2) {
    logEvent('red_line_termination_attempt_failed', { callSid, reason, method: 'redirect', attempt: 2, error: err2.message });
  }

  // Attempt 3: different primitive — force completed directly, no
  // announcement, in case the redirect/TwiML-fetch path itself is what's
  // failing rather than a one-off blip.
  try {
    await client.calls(callSid).update({ status: 'completed' });
    logEvent('red_line_call_terminated', { callSid, reason, method: 'forced_complete', attempt: 3 });
    return { terminated: true, method: 'forced_complete', attempts: 3 };
  } catch (err3) {
    logEvent('red_line_termination_all_attempts_failed', { callSid, reason, error: err3.message });
    return { terminated: false, method: null, attempts: 3, error: err3.message };
  }
}

module.exports = { terminateCall };
