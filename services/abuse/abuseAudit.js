'use strict';

// Telephony abuse P0 — decision audit trail.
//
// Every block / hold / degrade decision produces ONE structured record:
//   reasonCode, action, provider/action kind, householdId, correlationId,
//   timestamp, and NORMALISED, MINIMISED facts. Phone numbers are never
//   written in full: callers are a keyed hash (stable for correlation,
//   useless for reversal without ABUSE_AUDIT_HASH_SECRET) plus a masked form
//   that shows only the numbering class prefix and last 3 digits.
//
// Sinks: structured console line (always) + an optional persistent writer
// port (database table proposed in the provisional migration — NOT applied)
// + a bounded in-memory ring for tests/diagnostics. A sink failure never
// changes a decision and never throws to the caller.

const crypto = require('crypto');
const { maskE164, canonicalKey } = require('./numberPolicy');

const RING_SIZE = 500;
const FORBIDDEN_FACT_KEYS = /token|secret|password|authorization|signature|transcript|body|email/i;

function newCorrelationId(prefix = 'abz') {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function numberFingerprint(raw, secret) {
  const key = canonicalKey(raw) || (typeof raw === 'string' ? raw.trim().toLowerCase() : '');
  if (!key) return null;
  return crypto.createHmac('sha256', secret || 'hcg-abuse-audit').update(key).digest('hex').slice(0, 24);
}

function sanitiseFacts(facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts || {})) {
    if (FORBIDDEN_FACT_KEYS.test(k)) continue;
    if (v === undefined) continue;
    if (typeof v === 'string' && v.length > 200) out[k] = `${v.slice(0, 200)}…`;
    else out[k] = v;
  }
  return out;
}

function createAbuseAudit({ writer = null, log = (line, rec) => console.error(line, JSON.stringify(rec)), now = () => new Date(), hashSecret = process.env.ABUSE_AUDIT_HASH_SECRET } = {}) {
  const ring = [];

  function record({ reasonCode, action, kind, householdId = null, correlationId = null, provider = 'twilio', facts = {}, severity = 'warning' }) {
    const rec = Object.freeze({
      at: now().toISOString(),
      reasonCode,
      action, // 'reject' | 'hold' | 'degrade' | 'allow_flagged' | 'suppress'
      kind,   // 'inbound_call' | 'sms' | 'number_purchase' | 'number_release' | 'webhook' | 'number_write' | 'incident'
      provider,
      severity,
      householdId,
      correlationId: correlationId || newCorrelationId(),
      facts: sanitiseFacts(facts),
    });
    ring.push(rec);
    if (ring.length > RING_SIZE) ring.shift();
    try { log('ABUSE DECISION', rec); } catch { /* logging must never break a decision */ }
    if (writer) {
      Promise.resolve()
        .then(() => writer(rec))
        .catch(() => { /* persistent sink is best effort; console line above is the floor */ });
    }
    return rec;
  }

  return {
    record,
    caller: (raw) => ({ callerHash: numberFingerprint(raw, hashSecret), callerMasked: maskE164(canonicalKey(raw)) }),
    recent: (n = 50) => ring.slice(-n),
    _ring: ring,
  };
}

module.exports = { createAbuseAudit, newCorrelationId, numberFingerprint, sanitiseFacts };
