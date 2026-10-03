// Production entry point for the daily number-lifecycle sweep (Priority
// 4, 2026-09-27) — the piece that was missing before tonight:
// numberLifecycleSweepRunner.js (migration 052) had every RPC wired to
// its real default, but nothing ever loaded households/entitlements/
// classifications/quarantine rows and actually called it. This file is
// that caller, plus the durable run-evidence writes migration 054 adds.
//
// Deliberately thin: all decision logic stays in numberLifecycleSweep.js
// (pure), all execution logic stays in numberLifecycleSweepRunner.js
// (guarded RPCs only) — this file's only job is data assembly + calling
// the runner + recording that it ran. It NEVER calls a release/expiry/
// warning RPC directly itself, so it can never become a second path that
// bypasses 047 — the same structural guarantee numberLifecycleSweepRunner.js
// itself already documents.
//
// Idempotency (a stated requirement): every RPC the runner calls is
// already idempotent by construction (schedule_release only ever fires
// through the runner's own default, already-guarded/idempotent
// pending-release path — same one every other caller uses; the expiry
// RPC is a conditional no-op via its own WHERE clause; the warning-sent
// RPC is ON CONFLICT DO NOTHING). Two overlapping runs of THIS
// scheduler (e.g. a slow run still in flight when the next scheduled
// tick fires, or two server instances both running it) therefore produce
// the same end state as one run — each just does a (possibly) redundant,
// harmless re-check. Not enforced by a lock here on purpose: this
// codebase has no existing distributed-lock primitive, and inventing one
// for a job whose actions are already safely idempotent would add
// complexity without closing a real gap.

'use strict';

const { runNumberLifecycleSweep } = require('./numberLifecycleSweepRunner');
const { getClassificationMap } = require('./businessMetrics/accountClassification');
const { sendCriticalAlert } = require('./alerting');
const {
  getAllHouseholdsForSweep,
  getEntitlementsGroupedByHousehold,
  getQuarantineRowsForSweep,
  recordLifecycleSweepRunStart,
  recordLifecycleSweepRunCompletion,
} = require('../database/numberLifecycleSweepData');

/**
 * @param {object} [deps] - all overridable for tests; production callers
 *   (server.js) use every default.
 */
async function runNumberLifecycleSweepScheduled(deps = {}) {
  const {
    now = () => new Date(),
    loadHouseholds = getAllHouseholdsForSweep,
    loadEntitlements = getEntitlementsGroupedByHousehold,
    loadClassifications = getClassificationMap,
    loadQuarantineRows = getQuarantineRowsForSweep,
    recordRunStart = recordLifecycleSweepRunStart,
    recordRunCompletion = recordLifecycleSweepRunCompletion,
    runSweep = runNumberLifecycleSweep,
    sendAlert = sendCriticalAlert,
  } = deps;

  const startedAt = now();

  // Durable "a run started" evidence is written FIRST, before any data
  // loading that could itself throw — a run that crashes while loading
  // its own inputs still leaves a row (completed_at null), rather than
  // no evidence at all that anything was even attempted. A failure to
  // even write this start row is itself alert-worthy (the evidence
  // mechanism itself is broken) but must never prevent the real sweep
  // from attempting to run — households' actual protection must never
  // depend on this bookkeeping table being healthy.
  let runId = null;
  try {
    runId = await recordRunStart(startedAt);
  } catch (err) {
    console.error('LIFECYCLE SWEEP SCHEDULER: failed to record run start:', err.message);
    await sendAlert(
      'lifecycle_sweep_run_evidence_write_failed',
      `Could not write the sweep's own start-of-run evidence row: ${err.message}`,
      {}
    ).catch(() => {});
  }

  let result;
  try {
    const [households, entitlementsByHousehold, classificationResult, quarantineRows] = await Promise.all([
      loadHouseholds(),
      loadEntitlements(),
      loadClassifications(),
      loadQuarantineRows(),
    ]);

    if (!classificationResult.available) {
      // Fail-closed in the SAME direction numberLifecycleSweepRunner.js's
      // own loadWarnedIds failure already takes: don't guess. An
      // unavailable classification map means every household reads as
      // UNCLASSIFIED (classificationByHousehold.get returns undefined),
      // which is the existing safe default already — but this is loud
      // and alerted rather than silent, since it also means the 14-day
      // test-membership warning category is effectively disabled this
      // run (no household will match TEST_CLASSIFICATIONS).
      console.error('LIFECYCLE SWEEP SCHEDULER: account classification map unavailable:', classificationResult.reason);
      await sendAlert(
        'lifecycle_sweep_classification_map_unavailable',
        `Account classification data could not be loaded this run (${classificationResult.reason}) — the 14-day test-membership warning category is effectively skipped, though release/expiry/inconsistency actions are unaffected`,
        {}
      ).catch(() => {});
    }

    result = await runSweep({
      households,
      entitlementsByHousehold,
      classificationByHousehold: classificationResult.map,
      quarantineRows,
      now,
    });

    const completedAt = now();
    if (runId) {
      await recordRunCompletion(runId, {
        completedAt,
        householdsEvaluated: households.length,
        scheduled: result.scheduled,
        expired: result.expired,
        warned: result.warned,
        alerted: result.alerted,
        errorCount: result.errors.length,
        fatalError: null,
      }).catch(err => {
        console.error('LIFECYCLE SWEEP SCHEDULER: failed to record run completion:', err.message);
      });
    }

    if (result.errors.length > 0) {
      await sendAlert(
        'lifecycle_sweep_household_errors',
        `${result.errors.length} household(s) failed during the daily lifecycle sweep`,
        { errors: result.errors }
      ).catch(() => {});
    }

    return result;
  } catch (err) {
    // A FATAL failure — data loading itself failed, or the runner threw
    // outright (it shouldn't, given its own per-household try/catch, but
    // this is the outermost safety net). Matches runTwilioNumberReleaseCheck's
    // own top-level catch in server.js exactly.
    console.error('LIFECYCLE SWEEP SCHEDULER FAILED:', err.message);
    if (runId) {
      await recordRunCompletion(runId, {
        completedAt: now(),
        householdsEvaluated: 0,
        scheduled: 0,
        expired: 0,
        warned: 0,
        alerted: 0,
        errorCount: 0,
        fatalError: err.message,
      }).catch(() => {});
    }
    await sendAlert(
      'lifecycle_sweep_scheduler_failed',
      `Daily number-lifecycle sweep failed entirely: ${err.message}`,
      {}
    ).catch(() => {});
    throw err;
  }
}

module.exports = { runNumberLifecycleSweepScheduled };
