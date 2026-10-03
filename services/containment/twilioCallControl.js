// twilioCallControl.js — the two provider operations the lease sweeper
// needs, behind a small interface so tests (and a future provider) can
// substitute them.
//
//   fetchCall(sid)  → { status, durationSeconds, live } | null (provider has no such call)
//   terminate(sid)  → { confirmed, providerStatus }
//
// terminate() ends the PARENT inbound call: that stops the inbound PSTN leg,
// the <Dial><Client> leg and the Media Stream together. (Stopping only the
// stream/AI would leave the PSTN leg billing.)
'use strict';

const LIVE = new Set(['queued', 'ringing', 'in-progress']);
const ENDED = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

const isNotFound = (err) => err && (err.status === 404 || err.code === 20404);
// 21220: "Call is not in-progress. Cannot redirect." — already over.
const isAlreadyOver = (err) => err && (err.code === 21220 || err.code === 21626);

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function createTwilioCallControl({ client, mode = 'hangup', announcement = null } = {}) {
  async function fetchCall(sid) {
    if (!client) throw new Error('Twilio client not configured');
    try {
      const c = await client.calls(sid).fetch();
      const status = String(c.status || '');
      const d = Number(c.duration);
      return { status, durationSeconds: Number.isFinite(d) && d >= 0 ? Math.round(d) : null, live: LIVE.has(status), ended: ENDED.has(status) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async function terminate(sid) {
    if (!client) throw new Error('Twilio client not configured');
    const params = mode === 'announce' && announcement
      ? { twiml: `<Response><Say voice="Polly.Amy" language="en-GB">${escapeXml(announcement)}</Say><Hangup/></Response>` }
      : { status: 'completed' };
    try {
      const c = await client.calls(sid).update(params);
      return { confirmed: true, providerStatus: (c && c.status) || 'completed' };
    } catch (err) {
      if (isNotFound(err) || isAlreadyOver(err)) return { confirmed: true, providerStatus: 'not_live' };
      return { confirmed: false, providerStatus: null, error: String(err.message || err) };
    }
  }

  return { fetchCall, terminate };
}

module.exports = { createTwilioCallControl, LIVE, ENDED };
