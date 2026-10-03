// Coverage for services/numberLifecycleSweepScheduler.js — the
// production entry point that loads real data and calls
// numberLifecycleSweepRunner.js (already covered by its own test file).
// All dependencies injected/mocked here — no real database, matching
// this codebase's established convention for testing orchestration.
//
// Run with: node tests/number-lifecycle-sweep-scheduler.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { runNumberLifecycleSweepScheduled } = require('../services/numberLifecycleSweepScheduler');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function baseDeps(overrides = {}) {
  return {
    now: () => new Date('2026-09-27T12:00:00Z'),
    loadHouseholds: async () => [],
    loadEntitlements: async () => new Map(),
    loadClassifications: async () => ({ available: true, map: new Map() }),
    loadQuarantineRows: async () => [],
    recordRunStart: async () => 'run-1',
    recordRunCompletion: async () => {},
    runSweep: async () => ({ scheduled: 0, expired: 0, warned: 0, alerted: 0, errors: [], totalActions: 0 }),
    sendAlert: async () => true,
    ...overrides,
  };
}

async function main() {
  // --- happy path: run start recorded, sweep called with assembled
  // data, run completion recorded with the real counts, no alert. ---
  {
    const calls = { start: 0, completion: null, sweepArgs: null };
    const result = await runNumberLifecycleSweepScheduled(baseDeps({
      loadHouseholds: async () => [{ id: 'h1', twilio_number: '+441000000001' }],
      loadEntitlements: async () => new Map([['h1', [{ id: 'e1', status: 'expired' }]]]),
      loadClassifications: async () => ({ available: true, map: new Map([['h1', 'genuine_customer']]) }),
      loadQuarantineRows: async () => [{ household_id: 'h1', deactivation_confirmed: false }],
      recordRunStart: async () => { calls.start++; return 'run-happy'; },
      recordRunCompletion: async (runId, data) => { calls.completion = { runId, data }; },
      runSweep: async (args) => { calls.sweepArgs = args; return { scheduled: 1, expired: 1, warned: 0, alerted: 0, errors: [], totalActions: 2 }; },
    }));

    check(calls.start === 1, 'happy path: run start is recorded exactly once');
    check(calls.sweepArgs.households.length === 1 && calls.sweepArgs.households[0].id === 'h1', 'happy path: the loaded households array is passed straight through to the runner');
    check(calls.sweepArgs.entitlementsByHousehold.get('h1')[0].id === 'e1', 'happy path: the loaded entitlements map is passed straight through');
    check(calls.sweepArgs.classificationByHousehold.get('h1') === 'genuine_customer', 'happy path: the classification map (unwrapped from getClassificationMap\'s {available, map} shape) is passed straight through');
    check(calls.sweepArgs.quarantineRows.length === 1, 'happy path: the loaded quarantine rows are passed straight through');
    check(calls.completion.runId === 'run-happy', 'happy path: run completion is recorded against the SAME run id returned by run start');
    check(calls.completion.data.householdsEvaluated === 1 && calls.completion.data.scheduled === 1 && calls.completion.data.expired === 1 && calls.completion.data.fatalError === null, 'happy path: run completion carries the real counts from the sweep result, fatalError null');
    check(result.scheduled === 1, 'happy path: the scheduler returns the runner\'s own result');
  }

  // --- household-level errors from the runner trigger an alert, but do
  // NOT count as a fatal scheduler failure — run completion is still
  // recorded normally. ---
  {
    const alerts = [];
    let completionRecorded = false;
    await runNumberLifecycleSweepScheduled(baseDeps({
      runSweep: async () => ({ scheduled: 0, expired: 0, warned: 0, alerted: 0, errors: [{ householdId: 'h9', actionType: 'schedule_release', error: 'boom' }], totalActions: 1 }),
      recordRunCompletion: async () => { completionRecorded = true; },
      sendAlert: async (type, message, context) => { alerts.push({ type, message, context }); return true; },
    }));
    check(alerts.some(a => a.type === 'lifecycle_sweep_household_errors'), 'household-level errors from the runner are alerted with the specific type, not swallowed');
    check(completionRecorded === true, 'a household-level error does not prevent normal run-completion evidence from being recorded');
  }

  // --- FATAL: data loading itself throws — run completion is still
  // recorded (with fatalError set, zero counts), a distinct alert type
  // fires, and the error propagates to the caller (server.js's own
  // top-level catch, matching the existing runTwilioNumberReleaseCheck
  // pattern). ---
  {
    const alerts = [];
    let completionData = null;
    let threw = false;
    try {
      await runNumberLifecycleSweepScheduled(baseDeps({
        loadHouseholds: async () => { throw new Error('simulated DB outage'); },
        recordRunCompletion: async (runId, data) => { completionData = data; },
        sendAlert: async (type, message, context) => { alerts.push({ type, message, context }); return true; },
      }));
    } catch (err) {
      threw = true;
      check(err.message === 'simulated DB outage', 'FATAL: the original error propagates to the caller unmodified');
    }
    check(threw === true, 'FATAL: a data-loading failure propagates rather than being silently swallowed');
    check(alerts.some(a => a.type === 'lifecycle_sweep_scheduler_failed'), 'FATAL: a distinct, unambiguous alert type fires for a total scheduler failure');
    check(completionData && completionData.fatalError === 'simulated DB outage', 'FATAL: the run-evidence row is still completed, with fatalError recording exactly what went wrong — never left as a silent started-but-never-finished row when the failure is known');
    check(completionData.householdsEvaluated === 0 && completionData.scheduled === 0, 'FATAL: counts are zeroed, not guessed, when the run never got far enough to know them');
  }

  // --- run-start evidence write itself failing must NOT prevent the
  // real sweep from running — households' actual protection never
  // depends on this bookkeeping table being healthy. ---
  {
    const alerts = [];
    let sweepRan = false;
    const result = await runNumberLifecycleSweepScheduled(baseDeps({
      recordRunStart: async () => { throw new Error('evidence table unavailable'); },
      runSweep: async () => { sweepRan = true; return { scheduled: 2, expired: 0, warned: 0, alerted: 0, errors: [], totalActions: 2 }; },
      sendAlert: async (type, message, context) => { alerts.push({ type, message, context }); return true; },
    }));
    check(sweepRan === true, 'a broken run-start evidence write does not prevent the real sweep from running');
    check(result.scheduled === 2, 'the real sweep result is still returned correctly despite the evidence-write failure');
    check(alerts.some(a => a.type === 'lifecycle_sweep_run_evidence_write_failed'), 'the broken evidence write is itself alerted, not silently ignored');
  }

  // --- an unavailable classification map is alerted (loud, not silent)
  // but does not block release/expiry/inconsistency actions. ---
  {
    const alerts = [];
    let sweepArgs = null;
    await runNumberLifecycleSweepScheduled(baseDeps({
      loadClassifications: async () => ({ available: false, reason: 'simulated outage', map: new Map() }),
      runSweep: async (args) => { sweepArgs = args; return { scheduled: 1, expired: 0, warned: 0, alerted: 0, errors: [], totalActions: 1 }; },
      sendAlert: async (type, message, context) => { alerts.push({ type, message, context }); return true; },
    }));
    check(alerts.some(a => a.type === 'lifecycle_sweep_classification_map_unavailable'), 'an unavailable classification map is loudly alerted');
    check(sweepArgs.classificationByHousehold instanceof Map && sweepArgs.classificationByHousehold.size === 0, 'the sweep still runs with an empty (safe-default UNCLASSIFIED-for-everyone) classification map rather than being blocked entirely');
  }

  // --- structural: this file never calls a release/expiry/warning RPC
  // directly — only ever through runSweep (the already-guarded runner).
  // Confirms Priority 4's own "never bypass 047" requirement holds for
  // the new scheduler layer specifically, not just the runner it wraps. ---
  {
    const { readFileSync } = await import('node:fs');
    const schedulerSource = readFileSync(new URL('../services/numberLifecycleSweepScheduler.js', import.meta.url), 'utf8');
    check(
      !schedulerSource.includes('markTwilioNumberPendingRelease') &&
        !schedulerSource.includes('expireLapsedEntitlement') &&
        !schedulerSource.includes('.rpc(') &&
        !schedulerSource.includes('twilio_number'),
      'STRUCTURAL: the scheduler file contains no direct release/expiry RPC call and no direct twilio_number reference — every real action still goes exclusively through numberLifecycleSweepRunner.js'
    );
    check(
      schedulerSource.includes("require('./numberLifecycleSweepRunner')"),
      'STRUCTURAL: the scheduler genuinely imports and delegates to the existing, already-guarded runner rather than reimplementing anything'
    );
  }

  // --- server.js wiring (Priority 4): the schedule must be off by
  // default and require an explicit env var to enable — source-string
  // assertions, matching this codebase's established convention for
  // testing server.js's own structure without booting the real server. ---
  {
    const { readFileSync } = await import('node:fs');
    const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

    check(
      serverSource.includes('require("./services/numberLifecycleSweepScheduler")'),
      'server.js: imports the real scheduler module'
    );
    check(
      // Integration 2026-10-03: also requires the environment guard's verdict.
      serverSource.includes('if (process.env.ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE === "true" && numberLifecycleJobsDecision.run) {'),
      'server.js: the schedule is gated behind an explicit env var check, not started unconditionally like the pre-existing Twilio release checks'
    );
    check(
      serverSource.includes('console.log(`NUMBER LIFECYCLE SWEEP: schedule disabled'),
      'server.js: the disabled state is logged explicitly (visible in Railway logs), not silent — makes "is the schedule on or off" answerable without reading source'
    );

    const schedulerBlock = serverSource.slice(
      serverSource.indexOf('// Daily number-lifecycle sweep scheduler (Priority 4'),
      serverSource.indexOf('console.log("NUMBER LIFECYCLE SWEEP: schedule disabled')
    );
    check(
      (schedulerBlock.match(/runNumberLifecycleSweepScheduled\(\)\.catch\(/g) || []).length === 2,
      'server.js: BOTH the immediate first-run call and the setInterval-recurring call wrap runNumberLifecycleSweepScheduled() in .catch() — a rejected promise from either can never become an unhandled rejection'
    );
    check(
      !schedulerBlock.includes('.rpc(') && !schedulerBlock.includes('twilio_number ='),
      'server.js: the scheduler wiring block itself performs no direct RPC call or direct number mutation — it only ever calls runNumberLifecycleSweepScheduled()'
    );
  }

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} number-lifecycle-sweep-scheduler checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
