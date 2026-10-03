// containment.js — financial containment service (P0, 2026-10-03).
//
// The one place the app asks "may HCG spend money on this?". The database
// (provisional fc_* functions) is the authority; this module adds:
//   - a hard timeout on every authorisation,
//   - FAIL-CLOSED behaviour for HCG spend when the authority can't answer:
//       * monitoring / SMS / AI / number purchase: refused;
//       * calls: the small, per-instance DEGRADED ENVELOPE (or refusal when
//         FC_DEGRADED_MODE=reject, or after degradedMaxOutageSeconds),
//   - a local memory of the leases this instance admitted, so the sweeper
//     can end calls itself if the database stays unreachable,
//   - a journal of degraded admissions, adopted into the ledger when the
//     database returns.
// It never throws from authorize*/settle*/mark*: callers get a decision.
// Design: docs/finance/FINANCIAL_CONTAINMENT_P0.md.
'use strict';

const crypto = require('crypto');
const { resolveContainmentConfig, isEssentialCaller } = require('./policy');

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const isObj = (v) => v && typeof v === 'object';

// Errors that mean "the database answered and said no" rather than "the
// database could not be reached": the fc_* functions' own raise messages,
// constraint and input-syntax violations.
const REJECTED = /fc_[a-z_]+: |violates (foreign key|check|not-null|unique) constraint|invalid input syntax/i;
const isRejectedByAuthority = (err) => REJECTED.test(String((err && err.message) || err));

function createContainment({ db, env = process.env, now = () => new Date(), recordEvent = async () => {} } = {}) {
  if (!db) throw new Error('createContainment: db is required');
  const config = resolveContainmentConfig(env);
  const leases = new Map();        // callSid -> { householdId, leaseExpiresAt (ms), timeLimitSeconds, admittedAt, degraded }
  const degraded = {
    outageSince: null,             // ms of the first consecutive failure
    active: new Map(),             // callSid -> { householdId, startedAt, timeLimitSeconds, period }
    admissions: [],                // ms timestamps (rolling hour)
    journal: new Map(),            // callSid -> entry awaiting adoption
  };
  const lastEvent = new Map();

  function event(level, rule, details, { householdId = null, callSid = null, dedupeMs = 5 * 60 * 1000 } = {}) {
    const key = `${rule}|${householdId || ''}`;
    const t = Date.now();
    if (dedupeMs && lastEvent.has(key) && t - lastEvent.get(key) < dedupeMs) return;
    lastEvent.set(key, t);
    Promise.resolve().then(() => recordEvent({ level, rule, householdId, callSid, details })).catch(() => {});
  }

  for (const w of config.warnings) event('warning', 'containment_config_invalid_value', { warning: w }, { dedupeMs: 0 });

  function dbOk() { degraded.outageSince = null; }
  function dbFailed(err, label) {
    const t = now().getTime();
    if (!degraded.outageSince) degraded.outageSince = t;
    event('critical', 'containment_authority_unavailable', { op: label, error: String((err && err.message) || err).slice(0, 200) });
  }

  function pruneDegraded(t) {
    degraded.admissions = degraded.admissions.filter((x) => t - x < 3600 * 1000);
    for (const [sid, e] of degraded.active) {
      if (t - e.startedAt > (e.timeLimitSeconds + 120) * 1000) degraded.active.delete(sid);
    }
  }

  function degradedDecision({ household, callSid, period }) {
    const t = now().getTime();
    pruneDegraded(t);
    if (config.degradedMode === 'reject') return { allowed: false, reason: 'authorization_unavailable' };
    if (degraded.outageSince && t - degraded.outageSince > config.degradedMaxOutageSeconds * 1000) {
      return { allowed: false, reason: 'authorization_unavailable_extended' };
    }
    if (degraded.active.has(callSid)) {
      return { allowed: true, timeLimitSeconds: degraded.active.get(callSid).timeLimitSeconds, existing: true };
    }
    if (degraded.active.size >= config.degradedMaxConcurrent) return { allowed: false, reason: 'degraded_concurrency_limit' };
    if (degraded.admissions.length >= config.degradedMaxCallsPerHour) return { allowed: false, reason: 'degraded_hourly_limit' };
    const entry = { householdId: household ? household.id : null, startedAt: t, timeLimitSeconds: config.degradedMaxCallSeconds, period };
    degraded.active.set(callSid, entry);
    degraded.admissions.push(t);
    degraded.journal.set(callSid, entry);
    return { allowed: true, timeLimitSeconds: config.degradedMaxCallSeconds };
  }

  /**
   * Authorise a call BEFORE any billable TwiML.
   * @returns {Promise<{allowed:boolean, reason:string|null, monitoring:boolean, monitoringDeniedReason?:string|null,
   *   timeLimitSeconds:number|null, funding?:string, source:'database'|'degraded'|'policy'}>}
   */
  async function authorizeCall({ household, callSid, from, isKnown, wantsMonitoring, signatureValid, period }) {
    if (!callSid || typeof callSid !== 'string') return { allowed: false, reason: 'invalid_request', monitoring: false, timeLimitSeconds: null, source: 'policy' };
    if (config.requireSignedVoice && !signatureValid) {
      event('critical', 'unsigned_voice_refused', null, { householdId: household && household.id, callSid });
      return { allowed: false, reason: 'unsigned_request', monitoring: false, timeLimitSeconds: null, source: 'policy' };
    }
    const essential = isEssentialCaller(config, from);
    try {
      const r = await withTimeout(db.authorizeCall({
        householdId: household ? household.id : null, callSid, isKnown, wantsMonitoring, isEssential: essential,
        periodStart: period && period.periodStart, periodEnd: period && period.periodEnd, now: now(), overrides: config.overrides,
      }), config.rpcTimeoutMs, 'fc_authorize_call');
      if (!isObj(r) || typeof r.allowed !== 'boolean') throw new Error('malformed authorisation response');
      if (r.allowed && !(Number.isInteger(r.timeLimitSeconds) && r.timeLimitSeconds > 0)) throw new Error('authorisation without a valid time limit');
      dbOk();
      if (r.allowed) {
        leases.set(callSid, {
          householdId: household ? household.id : null, leaseExpiresAt: Date.parse(r.leaseExpiresAt) || (now().getTime() + 60000),
          timeLimitSeconds: r.timeLimitSeconds, admittedAt: now().getTime(), degraded: false,
        });
      } else {
        event(r.reason === 'household_budget_exhausted' ? 'warning' : 'critical', `call_refused_${r.reason}`, { funding: r.funding || null },
          { householdId: household && household.id, callSid });
      }
      return {
        allowed: r.allowed, reason: r.reason || null, monitoring: Boolean(r.allowed && r.monitoring),
        monitoringDeniedReason: r.monitoringDeniedReason || null, timeLimitSeconds: r.allowed ? r.timeLimitSeconds : null,
        funding: r.funding || null, profile: r.profile || null, existing: Boolean(r.existing), source: 'database',
      };
    } catch (err) {
      // The authority ANSWERED but rejected the request (its own validation,
      // a constraint, a missing household): that is a refusal, never a
      // reason to fall back to the degraded envelope.
      if (isRejectedByAuthority(err)) {
        event('critical', 'call_refused_invalid_request', { error: String(err.message || err).slice(0, 200) }, { householdId: household && household.id, callSid });
        return { allowed: false, reason: 'invalid_request', monitoring: false, timeLimitSeconds: null, source: 'database' };
      }
      dbFailed(err, 'authorize_call');
      const d = degradedDecision({ household, callSid, period });
      event('critical', d.allowed ? 'call_admitted_degraded' : `call_refused_${d.reason}`, { error: String(err.message || err).slice(0, 200) },
        { householdId: household && household.id, callSid });
      if (d.allowed) {
        leases.set(callSid, { householdId: household ? household.id : null, leaseExpiresAt: now().getTime() + d.timeLimitSeconds * 1000,
          timeLimitSeconds: d.timeLimitSeconds, admittedAt: now().getTime(), degraded: true });
      }
      return { allowed: d.allowed, reason: d.allowed ? 'degraded_envelope' : d.reason, monitoring: false,
        timeLimitSeconds: d.allowed ? d.timeLimitSeconds : null, source: 'degraded' };
    }
  }

  // The media stream actually started (monitoring cost is committed only if
  // it did). Returns whether monitoring is AUTHORISED for this call; the
  // stream must not transcribe if false.
  async function markMonitoringStarted(callSid) {
    try {
      const r = await withTimeout(db.markMonitoringStarted({ callSid }), config.rpcTimeoutMs, 'fc_mark_monitoring_started');
      dbOk();
      return Boolean(r && r.ok);
    } catch (err) {
      dbFailed(err, 'mark_monitoring_started');
      return false;     // fail closed: no authorised monitoring without the authority
    }
  }

  async function adoptJournal() {
    let adopted = 0;
    for (const [sid, e] of degraded.journal) {
      try {
        await withTimeout(db.adoptDegradedCall({ householdId: e.householdId, callSid: sid, startedAt: new Date(e.startedAt),
          timeLimitSeconds: e.timeLimitSeconds, periodStart: e.period && e.period.periodStart, periodEnd: e.period && e.period.periodEnd, now: now() }),
        config.rpcTimeoutMs, 'fc_adopt_degraded_call');
        degraded.journal.delete(sid);
        adopted++;
      } catch (err) {
        dbFailed(err, 'adopt_degraded_call');
        break;
      }
    }
    if (adopted) dbOk();
    return adopted;
  }

  // Settle a call (Dial action callback, provider status, sweeper). Never
  // throws; a failure is repaired by the sweeper's provider-status check.
  async function settleCall({ callSid, durationSeconds = null, monitoredSeconds = null, source }) {
    if (!callSid) return { ok: false, reason: 'invalid_request' };
    if (degraded.journal.has(callSid)) await adoptJournal();
    try {
      const r = await withTimeout(db.settleCall({ callSid, durationSeconds, monitoredSeconds, source, now: now() }), config.rpcTimeoutMs, 'fc_settle_call');
      dbOk();
      leases.delete(callSid);
      degraded.active.delete(callSid);
      return r;
    } catch (err) {
      dbFailed(err, 'settle_call');
      return { ok: false, error: String(err.message || err) };
    }
  }

  /**
   * One-shot spend (SMS, AI request, number purchase). FAIL-CLOSED.
   * @param {{category:'sms'|'ai'|'number_purchase', key:string, householdId?:string|null, units?:number, period?:object}} p
   */
  async function authorizeSpend({ category, key, householdId = null, units = 1, period = null }) {
    if (!key || !category) return { allowed: false, reason: 'invalid_request' };
    try {
      const r = await withTimeout(db.authorizeSpend({ idempotencyKey: String(key).slice(0, 180), householdId, category, units,
        periodStart: period && period.periodStart, periodEnd: period && period.periodEnd, now: now(), overrides: config.overrides }),
      config.rpcTimeoutMs, 'fc_authorize_spend');
      if (!isObj(r) || typeof r.allowed !== 'boolean') throw new Error('malformed spend authorisation response');
      dbOk();
      if (!r.allowed) event(r.reason === 'household_budget_exhausted' ? 'warning' : 'critical', `${category}_refused_${r.reason}`, null, { householdId });
      return { allowed: r.allowed, reason: r.reason || null, existing: Boolean(r.existing) };
    } catch (err) {
      dbFailed(err, `authorize_spend_${category}`);
      return { allowed: false, reason: 'authorization_unavailable' };
    }
  }

  // Leases this instance knows about whose paid cover has run out by more
  // than the grace — the sweeper ends these itself if the DB is down.
  function locallyExpiredLeases() {
    const t = now().getTime();
    const out = [];
    for (const [sid, l] of leases) {
      if (t > l.leaseExpiresAt + config.renewalUnavailableGraceSeconds * 1000) out.push({ callSid: sid, ...l });
      if (t > l.admittedAt + (l.timeLimitSeconds + 600) * 1000) leases.delete(sid);   // provider backstop has certainly ended it
    }
    return out;
  }

  function noteLease(callSid, leaseExpiresAt) {
    const l = leases.get(callSid);
    if (l && leaseExpiresAt) l.leaseExpiresAt = Date.parse(leaseExpiresAt) || l.leaseExpiresAt;
  }
  function forgetLease(callSid) { leases.delete(callSid); degraded.active.delete(callSid); }

  // Stable idempotency key for a message: same household, recipient, body
  // within the same minute = the same send (a retry), never charged twice.
  function smsKey({ householdId, to, body, at = now() }) {
    const minute = Math.floor(new Date(at).getTime() / 60000);
    return crypto.createHash('sha256').update(`${householdId || '-'}|${to || '-'}|${body || ''}|${minute}`).digest('hex').slice(0, 40);
  }

  return {
    config,
    authorizeCall,
    markMonitoringStarted,
    settleCall,
    authorizeSpend,
    adoptJournal,
    locallyExpiredLeases,
    noteLease,
    forgetLease,
    smsKey,
    _state: { leases, degraded },
  };
}

module.exports = { createContainment };
