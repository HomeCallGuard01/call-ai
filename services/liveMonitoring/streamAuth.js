// streamAuth.js — binds every /media-stream connection to a legitimate,
// Twilio-signed /voice request (P0 remediation, 2026-10-01).
//
// /media-stream is a WebSocket Twilio connects to; its handshake signature
// cannot yet be enforced safely (which URL form Twilio signs is unverified
// — see twilioWebhookAuth.js describeMediaStreamSignatureCheck). Instead,
// the signed /voice response issues a random, single-use token, held
// server-side, bound to that call's CallSid and the household's
// server-derived details (destination mobile, protected number). The token
// travels to Twilio inside the TwiML <Stream><Parameter> and comes back in
// the stream's "start" event. Without a valid, unused, unexpired token for
// the same CallSid, a stream never gets a monitor, transcription or SMS
// path — and the household/destination always come from here, never from
// anything the WebSocket client sends.
//
// In-process store: /voice and /media-stream run in the same Node process
// (attachMediaStreamServer shares app's http.Server). With more than one
// instance, a stream landing on a different instance fails CLOSED (call
// connects, unmonitored) until a shared store replaces this map.
'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // <Start><Stream> runs before <Dial>, so seconds in practice
const DEFAULT_MAX_ENTRIES = 5000;

function createStreamAuthRegistry({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const tokens = new Map(); // token -> { callSid, householdId, toNumber, fromNumber, expiresAt }

  function prune() {
    const t = now();
    for (const [k, v] of tokens) if (v.expiresAt <= t) tokens.delete(k);
    while (tokens.size >= maxEntries) tokens.delete(tokens.keys().next().value); // oldest first
  }

  // Called only from a Twilio-signed /voice (or /process) request.
  function issue({ callSid, householdId, toNumber = null, fromNumber = null }) {
    if (!callSid || !householdId) return null;
    prune();
    const token = crypto.randomBytes(32).toString('base64url');
    tokens.set(token, { callSid, householdId, toNumber, fromNumber, expiresAt: now() + ttlMs });
    return token;
  }

  // Single use: a valid token is consumed on first presentation.
  function authorize({ callSid, streamToken }) {
    if (typeof streamToken !== 'string' || typeof callSid !== 'string' || !streamToken || !callSid) return null;
    const entry = tokens.get(streamToken);
    if (!entry) return null;
    if (entry.expiresAt <= now() || entry.callSid !== callSid) {
      if (entry.expiresAt <= now()) tokens.delete(streamToken);
      return null;
    }
    tokens.delete(streamToken);
    return { householdId: entry.householdId, toNumber: entry.toNumber, fromNumber: entry.fromNumber };
  }

  return { issue, authorize, _size: () => tokens.size };
}

module.exports = { createStreamAuthRegistry, DEFAULT_TTL_MS };
