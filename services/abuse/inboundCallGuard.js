'use strict';

// Telephony abuse P0 — inbound call screening.
//
// Runs inside POST /voice AFTER the Security P0 signature guard and the
// webhook integrity layer, and BEFORE any TwiML that can cost money. It
// returns one decision; server.js only translates it into TwiML.
//
// THE ORDER IS THE CONTROL (docs/security/TELEPHONY_ABUSE_THREAT_MODEL.md §3):
//   1  client-origin             From=client:*  → reject
//   2  global incident mode      full_stop → reject; suspend_paid → no new monitoring
//   3  household resolution      dialled number owned by no household → reject (unbilled)
//   4  account status            household under an abuse hold → reject
//   5  loop / lineage            From is an HCG number, From==To, ForwardedFrom is HCG,
//                                ParentCallSid present → reject
//   6  caller velocity           caller→household burst, caller→many households fan-out
//                                (cooldowns, per caller only) → reject
//   7  household velocity        many callers → one household: FLAG ONLY (never reject:
//                                that would let an attacker switch a victim's protection off)
//   8  concurrency               household / caller (provider-verified before refusing)
//                                → reject (engaged-line equivalent); global → degrade
//   9  financial authorisation   Claude 1 port (reject only on approved kill states)
//  10  trusted-contact bypass    LAST, and only a monitoring decision: it can never
//                                skip steps 1–9, never selects a destination, and is
//                                suspended under spoofing indicators.
//
// Trusted contacts are matched against the CALLER (From) of an INBOUND
// call. HCG never dials a trusted contact: delivery is <Dial><Client> to the
// household's own app identity (services/callRouting.js), and the TwiML
// egress guard refuses any PSTN leg. A premium-rate or international
// "trusted contact" therefore has no outbound path to be billed on.
//
// PSTN caller ID is NOT authenticated in the UK today (no STIR/SHAKEN
// deployment); a trusted match proves only that the presented CLI equals a
// stored number. Twilio's StirVerstat is honoured when present (a failed
// verification suspends the bypass) but its absence proves nothing.

const { parsePhoneNumber, sameNumber, CLASSES, PURPOSES } = require('./numberPolicy');
const { ACTIONS } = require('./incidentMode');

const STIR_FAILED = /^TN-Validation-Failed/i;

// Integration 2026-10-04: the AUTHORITATIVE hold is the Financial Fortress
// per-household financial hold (fc_household_holds, migration 067), enforced
// inside every Fortress authorisation. This store reads it (5 s cache) so a
// held household is refused early at abuse step 4, and writes automatic
// FRAUD holds to it. ABUSE_HELD_HOUSEHOLD_IDS remains an operator env hold.
// A read failure here only flags (Fortress, fail-closed under D3, still decides).
function createHoldStore({ env = process.env, readHold = null, writeHold = null, now = () => Date.now(), cacheMs = 5000 } = {}) {
  const held = new Map();
  for (const id of String(env.ABUSE_HELD_HOUSEHOLD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    held.set(id, 'env_operator_hold');
  }
  const cache = new Map(); // householdId -> { at, value }
  return {
    async isHeld(householdId) {
      if (!householdId) return null;
      if (held.has(householdId)) return held.get(householdId);
      if (typeof readHold !== 'function') return null;
      const c = cache.get(householdId);
      if (c && now() - c.at < cacheMs) return c.value;
      const h = await readHold(householdId);
      const value = h ? `fortress_hold:${h.source}` : null;
      cache.set(householdId, { at: now(), value });
      if (cache.size > 5000) cache.clear();
      return value;
    },
    async hold(householdId, reason, source = 'fraud') {
      cache.delete(householdId);
      if (typeof writeHold === 'function') return writeHold({ householdId, reason, source });
      held.set(householdId, reason);
      return null;
    },
  };
}

function createAlertThrottle(sendAlert, { windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const last = new Map();
  return (type, message, context) => {
    const t = now();
    if (last.has(type) && t - last.get(type) < windowMs) return;
    last.set(type, t);
    if (last.size > 1000) last.clear();
    Promise.resolve().then(() => sendAlert(type, message, context)).catch(() => {});
  };
}

/**
 * @param {object} deps
 * @param {object} deps.config            resolveAbuseConfig()
 * @param {object} deps.velocity          createVelocityStore()
 * @param {object} deps.incident          createIncidentMode()
 * @param {object} deps.audit             createAbuseAudit()
 * @param {object} deps.financial         createFinancialAuthorizationPort()
 * @param {object} deps.holds             createHoldStore()
 * @param {(e164: string) => Promise<boolean>} deps.isHcgNumber
 * @param {(q: {to?: string, from?: string}) => Promise<number>} [deps.countLiveCalls]  provider truth for concurrency
 * @param {(type, message, ctx) => void} [deps.alert]
 */
function createInboundCallGuard(deps) {
  const { config, velocity, incident, audit, financial, holds } = deps;
  const rawIsHcgNumber = deps.isHcgNumber || (async () => false);
  // A failing directory must never turn into a failed genuine call: the
  // loop check fails OPEN (audited); loops are additionally bounded by
  // caller velocity and concurrency below.
  async function isHcgNumber(e164, ctx) {
    try { return Boolean(await rawIsHcgNumber(e164)); } catch {
      if (!ctx.flags.includes('loop_check_unavailable')) ctx.flags.push('loop_check_unavailable');
      return false;
    }
  }
  const alert = deps.alert || (() => {});
  const reservations = new Map(); // callSid -> { leaseIds, reservationId }

  function reject(reasonCode, ctx, facts = {}, severity = 'warning') {
    audit.record({ reasonCode, action: 'reject', kind: 'inbound_call', householdId: ctx.householdId, correlationId: ctx.correlationId, facts: { ...ctx.callerFacts, ...facts }, severity });
    return { action: 'reject', reasonCode, monitor: false, trusted: false, trustedMatched: false, flags: ctx.flags, correlationId: ctx.correlationId };
  }

  async function verifiedOverLimit(query, counted, limit, leaseKey) {
    if (counted < limit) return false;
    if (typeof deps.countLiveCalls !== 'function') return true;
    try {
      const live = await deps.countLiveCalls(query);
      if (typeof live === 'number' && live < limit) {
        velocity.clearLeases(leaseKey); // our count leaked (calls we never saw end)
        return false;
      }
      return true;
    } catch {
      // Provider unavailable: prefer delivery over an unproven refusal.
      return false;
    }
  }

  /**
   * @param {object} input
   * @param {object} input.params            Twilio webhook params (already integrity-checked)
   * @param {object|null} input.household
   * @param {Array} input.contacts
   * @param {boolean} input.duplicate        req.twilioDuplicate
   * @param {string} input.correlationId
   */
  async function screen({ params, household, contacts = [], duplicate = false, correlationId }) {
    const flags = [];
    const from = parsePhoneNumber(params.From);
    const callerKey = from.e164 || null; // withheld / malformed → no per-caller key
    const ctx = {
      householdId: household ? household.id : null,
      correlationId,
      flags,
      callerFacts: { ...audit.caller(params.From), callerClass: from.class },
    };

    // 1. client-origin
    if (typeof params.From === 'string' && params.From.toLowerCase().startsWith('client:')) {
      return reject('client_originated_call', ctx, {}, 'critical');
    }

    // 2. global incident mode
    const inbound = await incident.check(ACTIONS.INBOUND_CALL);
    if (!inbound.allowed) return reject(inbound.reason, ctx, { level: inbound.level }, 'critical');
    const monitoringIncident = await incident.check(ACTIONS.MONITORING);
    if (!monitoringIncident.allowed) flags.push(monitoringIncident.reason);

    // 3. household resolution
    if (!household) return reject('no_household_for_dialled_number', ctx, { toMasked: audit.caller(params.To).callerMasked });

    // 4. account status
    let hold = null;
    try { hold = await holds.isHeld(household.id); } catch { flags.push('hold_check_unavailable'); }
    if (hold) return reject('household_abuse_hold', ctx, { hold }, 'critical');

    // 5. loop / lineage
    const to = parsePhoneNumber(params.To);
    if (from.e164 && to.e164 && from.e164 === to.e164) return reject('loop_self_call', ctx, {}, 'critical');
    if (from.e164 && await isHcgNumber(from.e164, ctx)) return reject('loop_hcg_number_as_caller', ctx, {}, 'critical');
    const forwardedFrom = parsePhoneNumber(params.ForwardedFrom);
    if (forwardedFrom.e164 && forwardedFrom.e164 !== to.e164 && await isHcgNumber(forwardedFrom.e164, ctx)) {
      return reject('loop_forwarded_from_hcg_number', ctx, {}, 'critical');
    }
    if (typeof params.ParentCallSid === 'string' && params.ParentCallSid) {
      return reject('loop_parent_call_present', ctx, {}, 'critical');
    }

    // 6. caller velocity (only callers with a real number; withheld callers
    //    are bounded by household concurrency + elevated-household handling)
    const now = Date.now();
    if (callerKey) {
      const fanoutCd = velocity.getCooldown(`fanout:${callerKey}`);
      if (fanoutCd) return reject('caller_fanout_cooldown', ctx, { cooldownRemainingMs: fanoutCd.until - now });
      const pairCd = velocity.getCooldown(`pair:${callerKey}|${household.id}`);
      if (pairCd) return reject('caller_household_cooldown', ctx, { cooldownRemainingMs: pairCd.until - now });
    }

    let householdCalls = 0;
    let pairCalls = 0;
    if (!duplicate) {
      const globalPerMin = velocity.hit('global:calls', 60 * 1000);
      if (globalPerMin > config.globalCallsPerMinuteTrip) {
        incident.trip('global_call_rate', config.incidentAutoTripMs);
        flags.push('global_call_rate_trip');
        alert('abuse_global_call_rate', `Inbound call rate ${globalPerMin}/min exceeded ${config.globalCallsPerMinuteTrip}/min — contain mode (no number purchases, no SMS) for ${Math.round(config.incidentAutoTripMs / 60000)} min`, { globalPerMin });
      }
      householdCalls = velocity.hit(`hh:${household.id}`, config.householdElevatedWindowMs);
      if (callerKey) {
        pairCalls = velocity.hit(`pair:${callerKey}|${household.id}`, config.callerHouseholdWindowMs);
        if (pairCalls > config.callerHouseholdBurst) {
          velocity.setCooldown(`pair:${callerKey}|${household.id}`, config.callerHouseholdCooldownMs, 'burst');
          alert('abuse_caller_household_burst', 'One caller exceeded the per-household call burst limit; that caller is refused for the cooldown (other callers unaffected)', { householdId: household.id, pairCalls });
          return reject('caller_household_burst', ctx, { pairCalls, windowMs: config.callerHouseholdWindowMs });
        }
        const fanout = velocity.distinct(`fanout:${callerKey}`, household.id, config.callerFanoutWindowMs);
        if (fanout > config.callerFanoutHouseholds) {
          velocity.setCooldown(`fanout:${callerKey}`, config.callerFanoutCooldownMs, 'fanout');
          alert('abuse_caller_fanout', 'One caller reached more households than the fan-out limit; refused across all households for the cooldown', { distinctHouseholds: fanout });
          return reject('caller_fanout', ctx, { distinctHouseholds: fanout, windowMs: config.callerFanoutWindowMs }, 'critical');
        }
      }
    } else {
      flags.push('duplicate_webhook_not_recounted');
    }

    // 7. household velocity — flag, never refuse
    const elevated = householdCalls > config.householdElevatedCalls;
    if (elevated) {
      flags.push('household_elevated');
      audit.record({ reasonCode: 'household_elevated_volume', action: 'allow_flagged', kind: 'inbound_call', householdId: household.id, correlationId, facts: { householdCalls, windowMs: config.householdElevatedWindowMs } });
      alert('abuse_household_elevated', 'A household is receiving abnormal call volume from many callers — calls still delivered and monitored; trusted bypass suspended', { householdId: household.id, householdCalls });
    }

    // 8. concurrency
    //
    // Integration 2026-10-03 — check-and-claim is ATOMIC within the process:
    // the counts are read and the leases claimed with no `await` in between
    // (JS is single-threaded), THEN an over-limit decision is verified against
    // the provider and the claim released if refused. Previously the count was
    // read, the verification awaited, and the lease claimed afterwards — ten
    // simultaneous calls from one caller all read the same count and all
    // passed (found by tests/launch-fortress-integration.test.mjs, S2).
    const callSid = params.CallSid;
    if (!duplicate) {
      const hhKey = `conc:hh:${household.id}`;
      const cKey = callerKey ? `conc:caller:${callerKey}` : null;
      const hhCount = velocity.activeLeases(hhKey);
      const cCount = cKey ? velocity.activeLeases(cKey) : 0;
      const globalCount = velocity.activeLeases('conc:global');
      const leaseIds = [`${callSid}|hh`, `${callSid}|g`];
      velocity.acquireLease(hhKey, leaseIds[0], config.leaseTtlMs);
      velocity.acquireLease('conc:global', leaseIds[1], config.leaseTtlMs);
      if (cKey) { leaseIds.push(`${callSid}|c`); velocity.acquireLease(cKey, leaseIds[2], config.leaseTtlMs); }
      reservations.set(callSid, { leaseIds, reservationId: null });
      if (reservations.size > 20000) reservations.delete(reservations.keys().next().value);

      if (await verifiedOverLimit({ to: to.e164 || params.To }, hhCount, config.maxConcurrentPerHousehold, hhKey)) {
        release(callSid);
        return reject('household_concurrency', ctx, { limit: config.maxConcurrentPerHousehold });
      }
      if (cKey && await verifiedOverLimit({ from: callerKey }, cCount, config.maxConcurrentPerCaller, cKey)) {
        release(callSid);
        return reject('caller_concurrency', ctx, { limit: config.maxConcurrentPerCaller });
      }
      if (globalCount >= config.maxConcurrentGlobal) {
        flags.push('global_concurrency_degraded');
        incident.trip('global_concurrency', config.incidentAutoTripMs);
        alert('abuse_global_concurrency', 'Global concurrent inbound calls at limit — new calls delivered without new paid monitoring; contain mode', {});
      }
    }

    // 9. financial authorisation (Claude 1)
    const trustedMatched = from.e164 ? contacts.some((c) => c && c.number && sameNumber(c.number, from.e164)) : false;
    const fin = await financial.authorize({
      householdId: household.id, callSid, callerKey: ctx.callerFacts.callerHash, trustedMatched, abuseFlags: [...flags], correlationId, receivedAt: new Date().toISOString(),
    });
    if (fin.unavailable && !fin.notIntegrated) {
      flags.push('financial_authorization_unavailable');
      audit.record({ reasonCode: 'financial_authorization_unavailable', action: 'allow_flagged', kind: 'inbound_call', householdId: household.id, correlationId, facts: { policy: config.financialUnavailablePolicy }, severity: 'critical' });
      alert('abuse_financial_authorization_unavailable', `Financial authorisation unavailable — calls delivered under policy '${config.financialUnavailablePolicy}'`, {});
    }
    if (fin.telephony === 'reject') {
      release(callSid);
      return reject(`financial:${fin.reason || 'rejected'}`, ctx, {}, 'critical');
    }
    if (reservations.has(callSid)) reservations.get(callSid).reservationId = fin.reservationId || null;
    const financialMonitoringOk = fin.monitoring === 'allow' && !(fin.unavailable && !fin.notIntegrated && config.financialUnavailablePolicy === 'unmonitored');
    if (!financialMonitoringOk) flags.push(`financial_monitoring_denied:${fin.reason || 'unavailable'}`);

    // 10. trusted-contact bypass — last, monitoring-only
    //
    // Integration 2026-10-03: two different questions, answered separately.
    //   trusted            — may this call SKIP monitoring? (suspended by any
    //                        spoofing indicator, incl. flood/burst context)
    //   deliveryTrusted    — may this call draw on the household's
    //                        trusted-only DELIVERY RESERVE (Financial Fortress)?
    //                        Lost only to identity defects (withheld/malformed,
    //                        untrustable class, failed STIR) — NOT to flood or
    //                        burst context. Otherwise a spoofed many-caller
    //                        flood would suspend trust and lock the victim's
    //                        family out of the reserve kept for them (found by
    //                        tests/launch-fortress-integration.test.mjs, S4).
    //                        Such a call is still MONITORED; the reserve is
    //                        small and bounded; per-caller limits still apply.
    let trusted = false;
    let deliveryTrusted = false;
    if (trustedMatched) {
      const suspendReasons = [];
      const identityDefects = [];
      if (from.class === CLASSES.WITHHELD || from.class === CLASSES.MALFORMED) identityDefects.push('caller_not_a_number');
      // Premium / 070 / paging / revenue-share / satellite CLIs never get the
      // bypass, whatever the contact list says (they do not originate
      // ordinary personal calls; presenting one is itself a spoofing signal).
      else if (!PURPOSES.TRUSTED_CONTACT.allow.includes(from.class)) identityDefects.push(`caller_class_not_trustable:${from.class}`);
      if (typeof params.StirVerstat === 'string' && STIR_FAILED.test(params.StirVerstat)) identityDefects.push('stir_verification_failed');
      suspendReasons.push(...identityDefects);
      deliveryTrusted = identityDefects.length === 0;
      if (elevated) suspendReasons.push('household_elevated');
      if (pairCalls > config.trustedBypassBurst) suspendReasons.push('trusted_caller_burst');
      if (suspendReasons.length) {
        flags.push('trusted_bypass_suspended');
        audit.record({ reasonCode: 'trusted_bypass_suspended', action: 'degrade', kind: 'inbound_call', householdId: household.id, correlationId, facts: { ...ctx.callerFacts, reasons: suspendReasons.join(',') } });
      } else {
        trusted = true;
      }
    }

    const monitor = !trusted
      && monitoringIncident.allowed
      && financialMonitoringOk
      && !flags.includes('global_concurrency_degraded');

    return { action: 'connect', reasonCode: null, monitor, trusted, trustedMatched, deliveryTrusted, flags, correlationId };
  }

  /** Call ended (dial action / status callback / stream stop). Idempotent. */
  function release(callSid) {
    const r = reservations.get(callSid);
    if (!r) return false;
    reservations.delete(callSid);
    for (const id of r.leaseIds) velocity.releaseLease(id);
    if (r.reservationId) financial.release({ callSid, reservationId: r.reservationId, reason: 'call_ended' }).catch(() => {});
    return true;
  }

  return { screen, release, _reservations: reservations };
}

module.exports = { createInboundCallGuard, createHoldStore, createAlertThrottle };
