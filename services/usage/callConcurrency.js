// callConcurrency.js — in-memory FALLBACK for Layer B call admission
// (services/usage/callAdmission.js). The database (admit_call, migration
// 056) is authoritative; this tracker mirrors every admitted call so that,
// if the database can't answer in time, the per-household limits that
// don't need money figures still apply:
//   - simultaneous calls per household
//   - burst: call attempts per household in a short window
//   - caller flood: attempts from one caller in a window
// The £ ceilings can't be evaluated without the database; callAdmission
// raises a CRITICAL alert whenever this fallback decides.
//
// Single-threaded JS makes each tryRegister's check-and-set atomic within
// the process. Entries expire after maxCallAgeMs (the per-call maximum +
// margin), so a missed release can only ever hold a slot that long.
// A household AT the call limit is re-checked against the provider
// (verifyActive) before refusing; if that check can't complete, the call is
// ADMITTED (a missed release must never refuse a genuine call) — up to a
// hard ceiling of twice the limit, so an unverifiable flood is still bounded.
'use strict';

function createCallConcurrencyTracker({
  maxCallsPerHousehold,
  burstMaxAttempts = Infinity,
  burstWindowMs = 120000,
  callerMaxAttempts = Infinity,
  callerWindowMs = 600000,
  maxCallAgeMs = (4 * 60 + 5) * 60 * 1000,
  verifyActive = null,
  verifyTimeoutMs = 1500,
  now = () => Date.now(),
}) {
  const calls = new Map();    // callSid -> { householdId, startedAt }
  const attempts = new Map(); // householdId -> [{ at, callerKey, callSid }]
  const decided = new Map();  // callSid -> decision (idempotent retries)

  function prune() {
    const t = now();
    for (const [sid, c] of calls) if (c.startedAt < t - maxCallAgeMs) calls.delete(sid);
    const horizon = t - Math.max(burstWindowMs, callerWindowMs);
    for (const [h, list] of attempts) {
      const kept = list.filter((a) => a.at > horizon);
      if (kept.length) attempts.set(h, kept); else attempts.delete(h);
    }
    for (const [sid, d] of decided) if (d.at < t - maxCallAgeMs) decided.delete(sid);
  }

  const sidsFor = (householdId) => [...calls].filter(([, c]) => c.householdId === householdId).map(([sid]) => sid);
  const activeFor = (householdId) => sidsFor(householdId).length;

  async function reconcile(householdId) {
    if (typeof verifyActive !== 'function') return false;
    let timer;
    try {
      const checks = sidsFor(householdId).map(async (sid) => { if ((await verifyActive(sid)) === false) calls.delete(sid); });
      await Promise.race([Promise.all(checks), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('verify timed out')), verifyTimeoutMs); })]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function recordAttempt(householdId, callSid, callerKey, decision) {
    const list = attempts.get(householdId) || [];
    list.push({ at: now(), callerKey, callSid });
    attempts.set(householdId, list);
    decided.set(callSid, { ...decision, at: now() });
    return decision;
  }

  /**
   * Idempotent per CallSid. Mirrors an already-made database decision when
   * `authoritative` is given; otherwise decides itself (fallback).
   * @returns {Promise<{allowed: boolean, reason: string|null, active: number}>}
   */
  async function tryRegister(householdId, callSid, { callerKey = null, authoritative = null } = {}) {
    prune();
    if (decided.has(callSid)) { const d = decided.get(callSid); return { allowed: d.allowed, reason: d.reason, active: activeFor(householdId), existing: true }; }

    if (authoritative) {
      if (authoritative.allowed) calls.set(callSid, { householdId, startedAt: now() });
      return recordAttempt(householdId, callSid, callerKey, { allowed: authoritative.allowed, reason: authoritative.reason || null, active: activeFor(householdId) });
    }

    const t = now();
    const recent = attempts.get(householdId) || [];
    if (recent.filter((a) => a.at > t - burstWindowMs).length >= burstMaxAttempts) {
      return recordAttempt(householdId, callSid, callerKey, { allowed: false, reason: 'household_burst', active: activeFor(householdId) });
    }
    if (callerKey && recent.filter((a) => a.callerKey === callerKey && a.at > t - callerWindowMs).length >= callerMaxAttempts) {
      return recordAttempt(householdId, callSid, callerKey, { allowed: false, reason: 'caller_flood', active: activeFor(householdId) });
    }
    if (activeFor(householdId) >= maxCallsPerHousehold) {
      const verified = await reconcile(householdId);
      if (verified && activeFor(householdId) >= maxCallsPerHousehold) {
        return recordAttempt(householdId, callSid, callerKey, { allowed: false, reason: 'household_call_limit', active: activeFor(householdId) });
      }
      if (!verified) {
        // Can't confirm the counted calls are real (a missed release?):
        // admit — but only up to twice the limit, never unboundedly.
        if (activeFor(householdId) >= 2 * maxCallsPerHousehold) {
          return recordAttempt(householdId, callSid, callerKey, { allowed: false, reason: 'household_call_limit', active: activeFor(householdId) });
        }
        calls.set(callSid, { householdId, startedAt: now() });
        return recordAttempt(householdId, callSid, callerKey, { allowed: true, reason: 'limit_unverified_admitted', active: activeFor(householdId) });
      }
    }
    calls.set(callSid, { householdId, startedAt: now() });
    return recordAttempt(householdId, callSid, callerKey, { allowed: true, reason: null, active: activeFor(householdId) });
  }

  function release(callSid) {
    if (callSid) calls.delete(callSid);
  }

  return { tryRegister, release, activeFor, _size: () => calls.size };
}

module.exports = { createCallConcurrencyTracker };
