'use strict';

// Telephony abuse P0 — global incident mode.
//
// One answer to "may HCG start a NEW paid action of kind X right now?",
// consulted before every paid step (number purchase, SMS, new monitoring
// stream, inbound call admission). Works with no dashboard: the inputs are
// an env var, automatic trips from the abuse layer itself, and the
// Financial Fortress breaker (Claude 1) through a port.
//
// LEVELS (effective level = the most severe of all sources):
//   normal        — everything allowed
//   contain       — no number purchases, no SMS. Monitoring + calls continue.
//                   Auto-trippable (abuse layer) — the only level automation may set.
//   suspend_paid  — additionally no NEW paid monitoring. Calls still delivered
//                   (Andrew's hard requirement: never stop delivery while a
//                   customer's forwarding points at HCG).
//   full_stop     — additionally inbound calls are <Reject>ed (unbilled).
//                   VIOLATES the delivery requirement by design; manual only
//                   (HCG_INCIDENT_MODE=full_stop), never automatic, never
//                   from the financial port unless it explicitly says so.
//
// Fail behaviour when a source cannot be read: purchases fail CLOSED (a
// number not bought costs nothing and can be bought later); calls,
// monitoring and SMS keep the last known level for `staleMs`, then fall
// back to `contain` (bounded, protection still on).

const LEVELS = ['normal', 'contain', 'suspend_paid', 'full_stop'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
const ACTIONS = Object.freeze({
  PROVISION_NUMBER: 'provision_number',
  SMS: 'sms',
  MONITORING: 'monitoring',
  INBOUND_CALL: 'inbound_call',
});
const BLOCKED_FROM = {
  [ACTIONS.PROVISION_NUMBER]: 'contain',
  [ACTIONS.SMS]: 'contain',
  [ACTIONS.MONITORING]: 'suspend_paid',
  [ACTIONS.INBOUND_CALL]: 'full_stop',
};

function normaliseLevel(v) {
  const s = String(v || '').trim().toLowerCase();
  return LEVELS.includes(s) ? s : 'normal';
}

/**
 * @param {object} deps
 * @param {object} [deps.env]
 * @param {() => Promise<{level?: string, telephonySuspended?: boolean, monitoringSuspended?: boolean}>} [deps.financialBreaker]
 *        Claude 1's Financial Fortress breaker. `level` may be any of LEVELS;
 *        the boolean form maps telephonySuspended→suspend_paid (NOT full_stop:
 *        refusing calls needs the explicit level), monitoringSuspended→suspend_paid.
 * @param {() => Promise<string>} [deps.persistentFlag]  shared DB flag (provisional migration)
 */
function createIncidentMode({ env = process.env, financialBreaker = null, persistentFlag = null, now = () => Date.now(), staleMs = 60 * 1000, cacheMs = 5 * 1000, onChange = () => {} } = {}) {
  let auto = { level: 'normal', until: 0, reason: null };
  // at = last attempt (drives the read cache); okAt = last SUCCESS (drives staleness).
  const remote = { financial: { level: 'normal', at: 0, okAt: 0, ok: true }, flag: { level: 'normal', at: 0, okAt: 0, ok: true } };
  let lastEffective = 'normal';

  async function refresh(name, fn, mapper) {
    const slot = remote[name];
    if (!fn) { slot.ok = true; slot.level = 'normal'; return; }
    if (slot.at && now() - slot.at < cacheMs) return;
    try {
      const value = await fn();
      slot.level = mapper(value);
      slot.ok = true;
      slot.okAt = now();
    } catch {
      slot.ok = false; // keep previous level; staleness handled in effective()
    }
    slot.at = now();
  }

  function mapFinancial(v) {
    if (!v) return 'normal';
    if (typeof v === 'string') return normaliseLevel(v);
    if (v.level) return normaliseLevel(v.level);
    if (v.telephonySuspended || v.monitoringSuspended) return 'suspend_paid';
    return 'normal';
  }

  async function state() {
    await Promise.all([
      refresh('financial', financialBreaker, mapFinancial),
      refresh('flag', persistentFlag, normaliseLevel),
    ]);
    const sources = [{ source: 'env', level: normaliseLevel(env.HCG_INCIDENT_MODE) }];
    if (auto.until > now()) sources.push({ source: 'auto', level: auto.level, reason: auto.reason });
    let unavailable = false;
    for (const name of ['financial', 'flag']) {
      const slot = remote[name];
      if (!slot.ok) {
        unavailable = true;
        const stale = now() - slot.okAt > staleMs;
        sources.push({ source: name, level: stale ? (rank(slot.level) > rank('contain') ? slot.level : 'contain') : slot.level, unavailable: true });
      } else {
        sources.push({ source: name, level: slot.level });
      }
    }
    const effective = sources.reduce((a, s) => (rank(s.level) > rank(a) ? s.level : a), 'normal');
    if (effective !== lastEffective) { onChange(lastEffective, effective, sources); lastEffective = effective; }
    return { level: effective, sources, unavailable };
  }

  /** @returns {Promise<{allowed: boolean, level: string, reason: string|null, unavailable: boolean}>} */
  async function check(action) {
    const s = await state();
    const blockFrom = BLOCKED_FROM[action];
    if (!blockFrom) return { allowed: false, level: s.level, reason: 'unknown_action', unavailable: s.unavailable };
    if (action === ACTIONS.PROVISION_NUMBER && s.unavailable) {
      return { allowed: false, level: s.level, reason: 'incident_state_unavailable', unavailable: true };
    }
    if (rank(s.level) >= rank(blockFrom)) {
      return { allowed: false, level: s.level, reason: `incident_mode_${s.level}`, unavailable: s.unavailable };
    }
    return { allowed: true, level: s.level, reason: null, unavailable: s.unavailable };
  }

  /** Automatic trips are capped at `contain` — automation never stops calls or monitoring. */
  function trip(reason, ms) {
    const until = now() + ms;
    if (auto.until <= now() || until > auto.until) auto = { level: 'contain', until, reason };
  }

  return { check, state, trip, LEVELS };
}

module.exports = { createIncidentMode, ACTIONS, LEVELS, normaliseLevel };
