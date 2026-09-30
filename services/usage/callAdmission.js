// callAdmission.js — Layer B call admission: decides, at /voice and BEFORE
// any billable TwiML, whether HCG carries this call at all. A refused call
// is answered with <Reject> as the first verb, which the provider does not
// bill. This is the only control that stops INBOUND PSTN cost; everything
// else (monitoring gates, SMS budget) only stops the extras.
//
// Never refuses because of the customer's monitored allowance — only for
// simultaneous-call volume, bursts/loops/floods, and £ exposure far beyond
// any genuine single-line use (safetyConfig.js). Trusted callers are
// refused only by the hard ceilings, the loop/flood rules or the kill switch.
//
// Authority and fail-safe:
//   - the database (admit_call, migration 056) decides, atomically and
//     idempotently per CallSid;
//   - if it can't answer within budgetCheckTimeoutMs, the in-memory tracker
//     applies the call/burst/caller limits and a CRITICAL alert is raised
//     (the £ ceilings are then unavailable — never assumed to be £0 headroom
//     or £0 spend; the per-call timeLimit still bounds every call);
//   - only Twilio-SIGNED requests are counted (admissionRequiresSignature),
//     so forged /voice POSTs can't exhaust a household's limits. An unsigned
//     request is answered normally but not counted, and alerted.
'use strict';

const crypto = require('crypto');
const { resolveSafetyConfig, admissionLimits } = require('./safetyConfig');
const { resolveCostRates } = require('./costModel');
const { resolveEntitlementPeriod } = require('./billingPeriod');

// Reason → audit level. 'critical'/'emergency' also page (safetyEvents.js).
const REASON_LEVEL = {
  household_call_limit: 'warning',
  caller_flood: 'warning',
  household_burst: 'critical',
  forwarding_loop: 'critical',
  household_daily_hard: 'critical',
  household_period_unknown_block: 'critical',
  household_period_hard: 'emergency',
  company_emergency_abnormal: 'emergency',
  company_hard_unknown_block: 'emergency',
  telephony_kill_switch: 'emergency',
};

const WITHHELD = new Set(['', 'anonymous', 'restricted', 'unavailable', 'unknown', 'private', 'withheld', '+266696687', '266696687']);

// Salted hash of the caller's number: lets the database count repeat
// callers without storing phone numbers. null for withheld numbers, so they
// are never lumped together as one "flooding caller" (the burst rule still
// covers a withheld-number flood).
function callerKey(from, secret) {
  const raw = String(from || '').trim().toLowerCase();
  if (WITHHELD.has(raw)) return null;
  // One key per real number however it is presented: +44 7700…, 0044…, 07700… → 447700…
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = `44${digits.slice(1)}`;
  if (digits.length < 6) return null;
  return crypto.createHash('sha256').update(`${secret || 'hcg-caller-key'}:${digits}`).digest('hex').slice(0, 32);
}

const normalise = (n) => String(n || '').replace(/[^\d]/g, '').replace(/^44/, '0');

// A call arriving FROM an HCG number (or from the dialled number itself) can
// only be HCG's own traffic coming back round: a forwarding loop.
async function isLoopCall({ from, to, isHcgNumber }) {
  if (!from) return false;
  if (to && normalise(from) === normalise(to)) return true;
  if (typeof isHcgNumber !== 'function') return false;
  try { return Boolean(await isHcgNumber(from)); } catch { return false; }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`admission check timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} deps
 * @param {(params: object) => Promise<object>} deps.admitCallDb   database/financialSafety.admitCall
 * @param {(params: object) => Promise<object>} deps.endCallDb     database/financialSafety.endCall
 * @param {object} deps.memory       createCallConcurrencyTracker(...) fallback
 * @param {(event: object) => Promise<void>} [deps.recordIntervention]
 * @param {(number: string) => Promise<boolean>} [deps.isHcgNumber]
 * @param {() => Promise<number>} [deps.countEntitledHouseholds]
 * @param {object} [deps.env]
 * @param {() => Date} [deps.now]
 */
function createCallAdmission(deps) {
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());
  const record = deps.recordIntervention || (async () => {});
  const rates = resolveCostRates(env);
  let entitled = { value: 0, at: 0 };
  const lastAudit = new Map(); // `${household}|${reason}` -> ms (one audit per 10 min in a flood)

  async function entitledHouseholds() {
    if (typeof deps.countEntitledHouseholds !== 'function') return 0;
    if (Date.now() - entitled.at < 10 * 60 * 1000) return entitled.value;
    try { entitled = { value: await deps.countEntitledHouseholds(), at: Date.now() }; } catch { /* keep last; floors apply at 0 */ }
    return entitled.value;
  }

  function audit(level, rule, action, householdId, callSid, details) {
    const key = `${householdId}|${rule}`;
    const t = Date.now();
    if (lastAudit.has(key) && t - lastAudit.get(key) < 10 * 60 * 1000) return;
    lastAudit.set(key, t);
    record({ level, rule, action, householdId, callSid, details }).catch(() => {});
  }

  /**
   * @returns {Promise<{allowed: boolean, reason: string|null, level: string|null, source: 'database'|'memory_fallback'|'not_counted', maxCallSeconds: number, snapshot?: object}>}
   */
  async function admit({ household, callSid, from, to, isKnown, entitlement = null, subscription = null, signatureValid }) {
    const config = resolveSafetyConfig(env, { entitledHouseholds: await entitledHouseholds() });
    const maxCallSeconds = config.maxCallMinutes * 60;
    if (!household || !household.id || !callSid) {
      return { allowed: true, reason: null, level: null, source: 'not_counted', maxCallSeconds };
    }
    if (config.admissionRequiresSignature && !signatureValid) {
      audit('critical', 'voice_signature_unverified', 'call answered normally but NOT counted by financial safety (unsigned request)', household.id, callSid, null);
      return { allowed: true, reason: 'unsigned_request_not_counted', level: 'critical', source: 'not_counted', maxCallSeconds };
    }

    const key = callerKey(from, env.SAFETY_CALLER_KEY_SECRET);
    const isLoop = await isLoopCall({ from, to, isHcgNumber: deps.isHcgNumber });
    const t = now();
    const period = resolveEntitlementPeriod({ entitlement, subscription, now: t });

    let decision;
    let source = 'database';
    try {
      const snapshot = await withTimeout(Promise.resolve(deps.admitCallDb({
        householdId: household.id, callSid, callerKey: key, isKnown, isLoop,
        periodStart: period.periodStart, periodEnd: period.periodEnd, now: t, limits: admissionLimits(config, rates),
      })), config.budgetCheckTimeoutMs);
      if (!snapshot || typeof snapshot.allowed !== 'boolean') throw new Error('malformed admission response');
      decision = { allowed: snapshot.allowed, reason: snapshot.reason || null, snapshot };
      await deps.memory.tryRegister(household.id, callSid, { callerKey: key, authoritative: decision });
    } catch (err) {
      source = 'memory_fallback';
      if (isLoop) {
        decision = { allowed: false, reason: 'forwarding_loop' };
        await deps.memory.tryRegister(household.id, callSid, { callerKey: key, authoritative: decision });
      } else {
        const m = await deps.memory.tryRegister(household.id, callSid, { callerKey: key });
        decision = { allowed: m.allowed, reason: m.reason };
      }
      audit('critical', 'admission_database_unavailable', `admission decided in memory (${decision.allowed ? 'admitted' : 'refused: ' + decision.reason}); £ ceilings not evaluated`, household.id, callSid, { error: String(err.message || err).slice(0, 200) });
    }

    const level = decision.reason ? (REASON_LEVEL[decision.reason] || null) : null;
    if (!decision.allowed) {
      audit(level || 'warning', decision.reason, 'call refused with <Reject> (unbilled)', household.id, callSid, decision.snapshot || null);
    }
    return { allowed: decision.allowed, reason: decision.reason, level, source, maxCallSeconds, snapshot: decision.snapshot };
  }

  // The call's <Dial> has ended (or it never had one). Never throws.
  async function end({ callSid, source }) {
    deps.memory.release(callSid);
    try {
      return await deps.endCallDb({ callSid, endedAt: now(), source });
    } catch (err) {
      // Not fatal: admit_call closes a never-ended session conservatively
      // at its full maximum, so a lost end is over-counted, never £0.
      return { ok: false, error: err.message };
    }
  }

  return { admit, end };
}

module.exports = { createCallAdmission, callerKey, isLoopCall, REASON_LEVEL };
