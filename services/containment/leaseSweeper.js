// leaseSweeper.js — re-authorises live calls and ends the ones HCG can no
// longer pay for (I3 in docs/finance/FINANCIAL_CONTAINMENT_P0.md).
//
// Runs in EVERY server instance; the database serialises renewals, so a
// call admitted by a crashed instance is renewed or ended by a survivor.
// For each lease due within the renew-ahead window:
//   1. ask the provider whether the call is still live (free read):
//        - provider has no such call → settle at 0 (forged/never connected)
//        - call ended               → settle with the provider's duration
//                                     (repairs a lost Dial callback)
//        - live / read failed        → renew (conservatively assume live)
//   2. renewal refused → the call is ended through the provider REST API at
//      the end of its paid lease (terminateAt), never before.
// If the DATABASE is unreachable, the instance ends the calls it admitted
// itself once their lease + grace has passed (terminateOnRenewalUnavailable).
// If everything is down, the provider's <Dial timeLimit> backstop applies.
'use strict';

function createLeaseSweeper({ containment, db, callControl, now = () => new Date(), recordEvent = async () => {}, log = () => {} }) {
  const config = containment.config;
  let running = false;
  let timer = null;
  let lastEntitledRefresh = 0;
  let lastInvariantCheck = 0;
  const locallyTerminated = new Map();   // callSid -> ms (DB-outage terminations awaiting settlement)

  const event = (level, rule, details, extra = {}) =>
    Promise.resolve().then(() => recordEvent({ level, rule, details, ...extra })).catch(() => {});

  async function terminate(sid, reason) {
    const r = await callControl.terminate(sid);
    log('containment_terminate', { callSid: sid, reason, confirmed: r.confirmed });
    if (!r.confirmed) event('critical', 'provider_termination_failed', { reason, error: r.error || null }, { callSid: sid });
    return r;
  }

  async function handleDue(item, t) {
    const sid = item.callSid;
    if (item.state === 'terminating') {
      if (item.terminateAt && Date.parse(item.terminateAt) > t.getTime()) return 'waiting';
      const r = await terminate(sid, 'lease_renewal_refused');
      await db.recordTermination({ callSid: sid, confirmed: r.confirmed, providerStatus: r.providerStatus, now: t });
      if (r.confirmed) {
        let duration = null;
        try { const c = await callControl.fetchCall(sid); duration = c ? (c.ended ? c.durationSeconds : null) : 0; } catch { /* elapsed */ }
        await containment.settleCall({ callSid: sid, durationSeconds: duration, source: 'terminated_lease_refused' });
      }
      return r.confirmed ? 'terminated' : 'termination_failed';
    }

    // active: provider truth first
    let provider;
    try { provider = await callControl.fetchCall(sid); } catch (err) { provider = undefined; }
    if (provider === null) {
      await containment.settleCall({ callSid: sid, durationSeconds: 0, source: 'provider_not_found' });
      return 'settled_not_found';
    }
    if (provider && provider.ended) {
      await containment.settleCall({ callSid: sid, durationSeconds: provider.durationSeconds, source: 'provider_status' });
      return 'settled_provider_status';
    }
    await db.noteProviderCheck({ callSid: sid, providerStatus: provider ? provider.status : 'unknown', now: t });
    const rn = await db.renewLease({ callSid: sid, now: t, overrides: config.overrides });
    if (rn.action === 'renewed') { containment.noteLease(sid, rn.leaseExpiresAt); return 'renewed'; }
    if (rn.action === 'terminate') {
      event('warning', 'call_will_end_at_lease_end', { reason: rn.reason, terminateAt: rn.terminateAt }, { callSid: sid });
      if (rn.terminateAt && Date.parse(rn.terminateAt) <= t.getTime()) {
        const r = await terminate(sid, rn.reason);
        await db.recordTermination({ callSid: sid, confirmed: r.confirmed, providerStatus: r.providerStatus, now: t });
        if (r.confirmed) await containment.settleCall({ callSid: sid, source: 'terminated_lease_refused' });
        return r.confirmed ? 'terminated' : 'termination_failed';
      }
      return 'terminate_scheduled';
    }
    return rn.action || 'noop';
  }

  // DB unreachable: end the calls this instance admitted once their paid
  // cover + grace has passed. Fail closed for HCG spend.
  async function failClosedLocally() {
    if (!config.terminateOnRenewalUnavailable) return [];
    const out = [];
    for (const l of containment.locallyExpiredLeases()) {
      if (locallyTerminated.has(l.callSid)) continue;
      const r = await terminate(l.callSid, 'authorization_unavailable');
      if (r.confirmed) { locallyTerminated.set(l.callSid, Date.now()); containment.forgetLease(l.callSid); }
      out.push({ callSid: l.callSid, confirmed: r.confirmed });
    }
    if (out.length) event('emergency', 'calls_terminated_authority_unavailable', { count: out.length });
    return out;
  }

  async function sweepOnce() {
    if (running) return { skipped: 'already_running' };
    running = true;
    const t = now();
    const summary = { due: 0, outcomes: {}, dbUnavailable: false, localTerminations: [] };
    try {
      let due;
      try {
        due = await db.dueLeases({ now: t, limit: config.sweepBatch });
        if (!Array.isArray(due)) throw new Error('malformed due-lease response');
      } catch (err) {
        summary.dbUnavailable = true;
        event('critical', 'lease_sweep_authority_unavailable', { error: String(err.message || err).slice(0, 200) });
        summary.localTerminations = await failClosedLocally();
        return summary;
      }
      await containment.adoptJournal();
      // Settle anything this instance terminated during an outage.
      for (const sid of locallyTerminated.keys()) {
        const s = await containment.settleCall({ callSid: sid, source: 'terminated_authority_unavailable' });
        if (s && (s.ok || s.reason === 'unknown_call')) locallyTerminated.delete(sid);
      }
      summary.due = due.length;
      for (const item of due) {
        let outcome;
        try { outcome = await handleDue(item, t); } catch (err) {
          outcome = 'error';
          event('critical', 'lease_sweep_item_failed', { error: String(err.message || err).slice(0, 200) }, { callSid: item.callSid });
        }
        summary.outcomes[outcome] = (summary.outcomes[outcome] || 0) + 1;
      }
      const ms = t.getTime();
      if (ms - lastEntitledRefresh > config.entitledCountRefreshMs) {
        try { await db.refreshEntitledCount({ now: t }); lastEntitledRefresh = ms; } catch { /* floors apply when stale */ }
      }
      if (ms - lastInvariantCheck > config.invariantCheckMs) {
        try {
          const inv = await db.checkInvariants();
          lastInvariantCheck = ms;
          if (!inv || inv.ok !== true) event('emergency', 'containment_invariant_mismatch', inv || null);
        } catch { /* next time */ }
      }
      return summary;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { sweepOnce().catch(() => {}); }, config.sweepIntervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { sweepOnce, start, stop, _locallyTerminated: locallyTerminated };
}

module.exports = { createLeaseSweeper };
