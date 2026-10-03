// Runner for services/numberLifecycleSweep.js's proposed actions — the
// ONLY place those actions turn into real writes, and every write here
// goes through an existing, already-guarded RPC. This file never touches
// households.twilio_number, never calls Twilio directly, and never
// contains its own release logic — see numberLifecycleSweep.js's own
// header for why that boundary is deliberate and load-bearing.
//
// DECISION REQUIRED (flagged per the explicit autonomy rule, not
// resolved here): how a test/reviewer/internal account holder is
// actually notified of their 14-day pre-expiry warning (SMS? email?
// nothing customer-facing, ops-only?) is not established anywhere in
// this codebase today, and account_classifications' own migration
// comment gives no guidance either. Implemented here as an ops-facing
// critical alert only (via sendAlert) — never invents a new customer-
// communication channel. `notifyExpiryWarning` is injectable so a real
// customer-facing notification can be substituted once that decision is
// made, without touching this runner's control flow.
//
// Every RPC call is wrapped so one household's failure never aborts the
// sweep for every other household — matches this codebase's established
// "one bad row must never take down a whole batch job" discipline (e.g.
// the existing Twilio number-release daily runner in server.js).

'use strict';

const { computeLifecycleSweepActions } = require('./numberLifecycleSweep');
const { logEvent } = require('./liveMonitoring/structuredLog');
const { sendCriticalAlert } = require('./alerting');
const { markTwilioNumberPendingRelease } = require('../database/households');
const {
  expireLapsedEntitlement,
  recordEntitlementExpiryWarningSent,
  getWarnedEntitlementIds,
} = require('../database/numberLifecycleSweepData');

/**
 * @param {object} deps
 * @param {Array<object>} deps.households
 * @param {Map<string, object[]>} deps.entitlementsByHousehold
 * @param {Map<string, string>} deps.classificationByHousehold
 * @param {Array<object>} deps.quarantineRows
 * @param {() => Date} [deps.now]
 * @param {(householdId: string, gracePeriodDays?: number) => Promise<boolean>} [deps.scheduleRelease]
 * @param {(entitlementId: string) => Promise<boolean>} [deps.expireEntitlement]
 * @param {(entitlementId: string, householdId: string) => Promise<boolean>} [deps.recordWarningSent]
 * @param {() => Promise<Set<string>>} [deps.loadWarnedIds]
 * @param {(type: string, message: string, context?: object) => Promise<boolean>} [deps.sendAlert]
 * @param {(household: object, entitlement: object) => Promise<void>} [deps.notifyExpiryWarning]
 *   - see this file's own DECISION REQUIRED note above. Defaults to an
 *   ops-facing critical alert, never a customer-facing message.
 */
async function runNumberLifecycleSweep({
  households,
  entitlementsByHousehold,
  classificationByHousehold,
  quarantineRows,
  now = () => new Date(),
  scheduleRelease = markTwilioNumberPendingRelease,
  expireEntitlement = expireLapsedEntitlement,
  recordWarningSent = recordEntitlementExpiryWarningSent,
  loadWarnedIds = getWarnedEntitlementIds,
  sendAlert = sendCriticalAlert,
  notifyExpiryWarning,
}) {
  const warnedIds = await loadWarnedIds().catch(err => {
    logEvent('lifecycle_sweep_warned_ids_load_failed', { error: err.message });
    // Fail closed here means: if we can't tell what's already been
    // warned, don't guess — treat nothing as warned yet is the WRONG
    // direction (would risk re-sending), so instead we skip the whole
    // warning category this run rather than risk a duplicate. The
    // release/alert/expiry categories below are unaffected and still run.
    return null;
  });

  const actions = computeLifecycleSweepActions(
    households,
    entitlementsByHousehold,
    classificationByHousehold,
    quarantineRows,
    warnedIds || new Set(),
    now()
  );

  const results = { scheduled: 0, expired: 0, warned: 0, alerted: 0, errors: [] };

  const skipWarnings = warnedIds === null;
  if (skipWarnings && actions.some(a => a.type === 'send_test_expiry_warning')) {
    logEvent('lifecycle_sweep_warnings_skipped', { reason: 'could_not_load_warned_ids' });
  }

  for (const action of actions) {
    try {
      if (action.type === 'schedule_release') {
        const scheduled = await scheduleRelease(action.householdId);
        if (scheduled) results.scheduled++;
        logEvent('lifecycle_sweep_schedule_release', { householdId: action.householdId, scheduled, reason: action.reason });
      } else if (action.type === 'expire_lapsed_entitlement') {
        const expired = await expireEntitlement(action.entitlementId);
        if (expired) results.expired++;
        logEvent('lifecycle_sweep_expire_entitlement', { householdId: action.householdId, entitlementId: action.entitlementId, expired });
      } else if (action.type === 'send_test_expiry_warning') {
        if (skipWarnings) continue;
        if (typeof notifyExpiryWarning === 'function') {
          await notifyExpiryWarning({ id: action.householdId }, { id: action.entitlementId, ends_at: action.expiresAt });
        } else {
          await sendAlert(
            'test_membership_expiring_soon',
            `A ${action.classification} membership expires within 14 days — no customer-facing notification channel is established yet (see numberLifecycleSweepRunner.js's own DECISION REQUIRED note)`,
            { householdId: action.householdId, entitlementId: action.entitlementId, expiresAt: action.expiresAt, classification: action.classification }
          ).catch(() => {});
        }
        const recorded = await recordWarningSent(action.entitlementId, action.householdId);
        if (recorded) results.warned++;
        logEvent('lifecycle_sweep_expiry_warning', { householdId: action.householdId, entitlementId: action.entitlementId, recorded });
      } else if (action.type === 'alert_inconsistency') {
        await sendAlert(
          `lifecycle_sweep_${action.reason}`,
          action.detail,
          { householdId: action.householdId, reason: action.reason }
        ).catch(() => {});
        results.alerted++;
        logEvent('lifecycle_sweep_alert', { householdId: action.householdId, reason: action.reason });
      }
    } catch (err) {
      // One household's failure must never abort the sweep for every
      // other household — logged and collected, the loop continues.
      results.errors.push({ householdId: action.householdId, actionType: action.type, error: err.message });
      logEvent('lifecycle_sweep_action_failed', { householdId: action.householdId, actionType: action.type, error: err.message });
    }
  }

  logEvent('lifecycle_sweep_completed', { ...results, totalActions: actions.length, errorCount: results.errors.length });

  return { ...results, totalActions: actions.length };
}

module.exports = { runNumberLifecycleSweep };
