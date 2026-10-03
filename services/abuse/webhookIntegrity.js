'use strict';

// Telephony abuse P0 — Twilio webhook integrity, layered AFTER the Security
// P0 signature guard (services/twilioWebhookGuard.js), never instead of it.
//
// The signature proves "Twilio sent these exact params to this URL". It does
// NOT prove freshness or uniqueness — Twilio's X-Twilio-Signature covers no
// timestamp or nonce — so a captured signed request can be replayed
// forever. This layer adds what can be checked without a provider round
// trip:
//   - AccountSid must be HCG's own account (a request signed for another
//     account cannot validate anyway; this catches mis-pointed numbers and
//     makes the "unexpected provider" case explicit and audited)
//   - no parameter pollution on the fields decisions are made from
//     (express's urlencoded parser turns `?From=a&From=b` into an array)
//   - bounded payload shape (key count / value length)
//   - duplicate/replay detection per (route, CallSid, signature):
//       * /voice: the FIRST response for a CallSid is cached and an exact
//         duplicate gets the identical TwiML back (idempotent — a genuine
//         Twilio retry still connects with the same single-use stream
//         token; a replay gains nothing new: no second token, no second
//         velocity count, no second lease)
//       * callbacks: a duplicate's side effects are skipped (req.twilioDuplicate)
//
// LIMITATION: entries live for webhookReplayWindowMs in process memory.
// A replay after the window (or after a restart) is indistinguishable from
// a new request without asking Twilio whether the CallSid is still live —
// documented as PROVIDER DEPENDENCY in the threat model.

const crypto = require('crypto');

const DECISION_FIELDS = ['AccountSid', 'CallSid', 'From', 'To', 'Caller', 'Called', 'Direction', 'CallStatus', 'DialCallStatus', 'DialCallDuration', 'ForwardedFrom', 'ParentCallSid', 'StirVerstat'];
const MAX_KEYS = 200;
const MAX_VALUE_LENGTH = 2048;
const MAX_ENTRIES = 20000;

function createTwilioWebhookIntegrity({ config, audit, now = () => Date.now() }) {
  const seen = new Map(); // key -> { at, twiml|null }

  function prune() {
    const cutoff = now() - config.webhookReplayWindowMs;
    for (const [k, v] of seen) { if (v.at > cutoff) break; seen.delete(k); }
    while (seen.size > MAX_ENTRIES) seen.delete(seen.keys().next().value);
  }

  function replayKey(req) {
    const sig = String(req.get('X-Twilio-Signature') || '');
    const sigHash = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
    return `${req.path}|${req.body.CallSid}|${sigHash}`;
  }

  function refuse(res, req, status, reasonCode, facts) {
    audit.record({ reasonCode, action: 'reject', kind: 'webhook', facts: { path: req.path, ...facts }, severity: 'critical' });
    return res.status(status).end();
  }

  function middleware(req, res, next) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const keys = Object.keys(body);
    if (keys.length > MAX_KEYS) return refuse(res, req, 413, 'webhook_too_many_params', { keyCount: keys.length });
    for (const k of keys) {
      const v = body[k];
      if (typeof v === 'string' && v.length > MAX_VALUE_LENGTH) return refuse(res, req, 413, 'webhook_value_too_long', { field: k.slice(0, 40) });
    }
    for (const f of DECISION_FIELDS) {
      if (Array.isArray(body[f]) || (body[f] !== undefined && typeof body[f] !== 'string')) {
        return refuse(res, req, 400, 'webhook_parameter_pollution', { field: f });
      }
    }
    if (config.twilioAccountSid && body.AccountSid !== config.twilioAccountSid) {
      return refuse(res, req, 403, 'webhook_unexpected_account', { hasAccountSid: Boolean(body.AccountSid) });
    }
    if (typeof body.CallSid !== 'string' || !/^CA[0-9a-f]{32}$/i.test(body.CallSid)) {
      return refuse(res, req, 400, 'webhook_malformed_call_sid', {});
    }

    prune();
    const key = replayKey(req);
    const prior = seen.get(key);
    if (prior) {
      req.twilioDuplicate = true;
      audit.record({ reasonCode: 'webhook_duplicate', action: 'suppress', kind: 'webhook', facts: { path: req.path, ageMs: now() - prior.at, cachedResponse: Boolean(prior.twiml) }, severity: 'warning' });
      if (prior.twiml) return res.type('text/xml').send(prior.twiml);
      return next();
    }
    const entry = { at: now(), twiml: null };
    seen.set(key, entry);
    // Let the route register its TwiML as THE response for this delivery.
    req.rememberTwimlResponse = (xml) => { entry.twiml = xml; };
    return next();
  }

  return { middleware, _size: () => seen.size };
}

module.exports = { createTwilioWebhookIntegrity, DECISION_FIELDS };
