// monitoringGate.js — decides, BEFORE any paid monitoring starts, whether
// an unknown call may be monitored (Layer A allowance + Layer B monitoring
// ceilings). Called from /voice before <Start><Stream> is attached; if the
// answer is no, the call still connects exactly as before, just with no
// Media Stream, no transcription and no "monitored and protected" greeting.
//
// Fail-safe: if the budget can't be established — database error, timeout,
// malformed answer — the answer is "don't monitor"
// ('safety_check_unavailable'), never "monitor anyway". The phone call is
// never affected by this module.
'use strict';

const { resolvePlanForEntitlement } = require('./plans');
const { resolveEntitlementPeriod } = require('./billingPeriod');
const { resolveSafetyConfig, monitoringLimits } = require('./safetyConfig');

// calls.monitoring_status values (migration 056).
const MONITORING_STATUS = {
  MONITORED: 'monitored',
  ALLOWANCE_EXHAUSTED: 'not_monitored_allowance_exhausted',
  SAFETY_LIMIT: 'not_monitored_safety_limit',
  UNAVAILABLE: 'not_monitored_unavailable',
  NO_ENTITLEMENT: 'not_monitored_no_entitlement',
  STOPPED_ALLOWANCE: 'monitoring_stopped_allowance_exhausted',
  STOPPED_SAFETY: 'monitoring_stopped_safety_limit',
};

// allowance_exhausted is advertised plan behaviour, not a safety event.
const DENIAL_LEVEL = {
  household_stream_limit: 'warning',
  global_stream_limit: 'critical',
  daily_cost_limit: 'critical',
  period_cost_limit: 'critical',
  global_hourly_cost_limit: 'emergency',
  global_daily_cost_limit: 'emergency',
  global_kill_switch: 'emergency',
  emergency_disabled: 'emergency',
  safety_check_unavailable: 'critical',
  unsigned_request: 'critical',
};

function monitoringStatusForReason(reason) {
  if (!reason) return MONITORING_STATUS.MONITORED;
  if (reason === 'allowance_exhausted') return MONITORING_STATUS.ALLOWANCE_EXHAUSTED;
  if (reason === 'safety_check_unavailable' || reason === 'unsigned_request') return MONITORING_STATUS.UNAVAILABLE;
  return MONITORING_STATUS.SAFETY_LIMIT;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`budget check timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} args
 * @param {object} args.household
 * @param {string} args.callSid
 * @param {object|null} args.entitlement   active entitlement (already fetched by /voice)
 * @param {object|null} [args.subscription] Stripe subscription row, when known
 * @param {boolean} [args.countable=true]  false for unsigned requests
 * @param {object} args.deps { beginMonitoringSession, recordIntervention?, now?, env?, entitledHouseholds? }
 */
async function requestMonitoring({ household, callSid, entitlement, subscription = null, countable = true, deps }) {
  const env = deps.env || process.env;
  const config = resolveSafetyConfig(env, { entitledHouseholds: deps.entitledHouseholds || 0 });
  const now = deps.now ? deps.now() : new Date();
  const record = deps.recordIntervention || (async () => {});
  const plan = resolvePlanForEntitlement(entitlement, env);
  const period = resolveEntitlementPeriod({ entitlement, subscription, now });

  const deny = async (reason, extra = {}) => {
    const level = DENIAL_LEVEL[reason];
    if (level) {
      await record({
        level, rule: `monitoring_${reason}`,
        action: 'unknown call connected without paid monitoring',
        householdId: household && household.id, callSid,
        usageSecondsBefore: extra.snapshot ? Number(extra.snapshot.periodSeconds) : undefined,
        estimatedCostBeforeGbp: extra.snapshot ? Number(extra.snapshot.periodCostGbp) : undefined,
        details: extra.snapshot || (extra.error ? { error: extra.error } : null),
      }).catch(() => {});
    }
    return { monitor: false, reason, monitoringStatus: monitoringStatusForReason(reason), plan, period, ...extra };
  };

  if (!household || !household.id || !callSid) return deny('safety_check_unavailable', { error: 'missing household or call sid' });
  if (!countable) return deny('unsigned_request');
  if (config.emergencyDisabled) return deny('emergency_disabled');

  try {
    const snapshot = await withTimeout(Promise.resolve(deps.beginMonitoringSession({
      householdId: household.id, callSid,
      periodStart: period.periodStart, periodEnd: period.periodEnd, now,
      allowanceSeconds: plan.allowanceSeconds, enforceAllowance: plan.enforced,
      limits: monitoringLimits(config),
    })), config.budgetCheckTimeoutMs);
    if (!snapshot || typeof snapshot.allowed !== 'boolean') return deny('safety_check_unavailable', { error: 'malformed budget response' });
    if (!snapshot.allowed) return deny(snapshot.reason || 'safety_check_unavailable', { snapshot });
    return { monitor: true, reason: null, monitoringStatus: MONITORING_STATUS.MONITORED, plan, period, snapshot };
  } catch (err) {
    return deny('safety_check_unavailable', { error: err.message });
  }
}

module.exports = { requestMonitoring, monitoringStatusForReason, MONITORING_STATUS, DENIAL_LEVEL };
