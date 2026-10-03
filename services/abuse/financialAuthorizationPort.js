'use strict';

// Telephony abuse P0 — the boundary with Claude 1's Financial Fortress.
//
// Claude 1 owns money: reservations, allowance, £ ceilings, the ledger and
// the financial circuit breaker. This layer owns fraud/abuse semantics and
// NEVER keeps its own £ ledger. The two meet only here:
//
//   authorize(request) -> Promise<{
//     telephony:  'allow' | 'reject',   // may HCG answer/bridge this call at all
//     monitoring: 'allow' | 'deny',     // may HCG start NEW paid monitoring for it
//     reason:     string | null,        // Claude 1's reason code (audited verbatim)
//     reservationId?: string            // opaque; passed back on release()
//   }>
//   release({ callSid, reservationId, reason }) -> Promise<void>
//
//   request = { householdId, callSid, callerKey, trustedMatched, abuseFlags,
//               correlationId, receivedAt }
//
// Contract obligations on Claude 1 (from Andrew's hard requirement, see
// docs/security/TELEPHONY_ABUSE_THREAT_MODEL.md §Integration):
//   - `telephony: 'reject'` only for states Andrew has approved as allowed
//     to stop delivery (today: an explicit telephony kill switch). £
//     ceilings degrade MONITORING, not delivery.
//   - Must be idempotent per callSid (a duplicate webhook must not reserve twice).
//
// Abuse checks run BEFORE this call, so a call refused as abuse never
// creates a financial reservation and a trusted contact can never reach
// it without passing them.

const UNAVAILABLE = Object.freeze({ telephony: 'allow', monitoring: 'allow', reason: 'financial_authorization_unavailable', unavailable: true });

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('financial authorization timed out')), ms); }),
  ]).finally(() => clearTimeout(t));
}

function normalise(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('malformed financial authorization response');
  const telephony = raw.telephony === 'reject' ? 'reject' : raw.telephony === 'allow' ? 'allow' : null;
  const monitoring = raw.monitoring === 'deny' ? 'deny' : raw.monitoring === 'allow' ? 'allow' : null;
  if (!telephony || !monitoring) throw new Error('malformed financial authorization response');
  return { telephony, monitoring, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 80) : null, reservationId: raw.reservationId || null, unavailable: false };
}

/**
 * @param {object|null} impl  { authorize, release } from Claude 1, or null when not integrated yet
 */
function createFinancialAuthorizationPort(impl, { timeoutMs = 1500 } = {}) {
  if (!impl || typeof impl.authorize !== 'function') {
    return {
      integrated: false,
      async authorize() { return { telephony: 'allow', monitoring: 'allow', reason: 'financial_authorization_not_integrated', unavailable: true, notIntegrated: true }; },
      async release() {},
    };
  }
  return {
    integrated: true,
    async authorize(request) {
      try {
        return normalise(await withTimeout(Promise.resolve(impl.authorize(request)), timeoutMs));
      } catch (err) {
        return { ...UNAVAILABLE, error: String((err && err.message) || err).slice(0, 120) };
      }
    },
    async release(args) {
      if (typeof impl.release !== 'function') return;
      try { await withTimeout(Promise.resolve(impl.release(args)), timeoutMs); } catch { /* best effort */ }
    },
  };
}

module.exports = { createFinancialAuthorizationPort };
