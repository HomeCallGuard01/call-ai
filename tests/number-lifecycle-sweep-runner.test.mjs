// Coverage for services/numberLifecycleSweepRunner.js — the orchestration
// layer that turns numberLifecycleSweep.js's proposed actions into real
// RPC calls. All dependencies injected/mocked — no real database, no
// real Twilio, matching this codebase's established convention for
// testing route/service orchestration (e.g. services/twilioProvisioning.js's
// own test file).
//
// Run with: node tests/number-lifecycle-sweep-runner.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('dotenv').config();
const { runNumberLifecycleSweep } = require('../services/numberLifecycleSweepRunner');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function household(id, overrides = {}) {
  return { id, twilio_number: null, twilio_provisioning_status: 'pending', twilio_number_pending_release_at: null, ...overrides };
}

async function main() {
  // --- a schedule_release action calls the injected scheduleRelease, and only that ---
  {
    const calls = [];
    const result = await runNumberLifecycleSweep({
      households: [household('h1', { twilio_number: '+441000000001' })],
      entitlementsByHousehold: new Map(),
      classificationByHousehold: new Map(),
      quarantineRows: [],
      now: () => new Date('2026-09-27T12:00:00Z'),
      scheduleRelease: async (id) => { calls.push(['scheduleRelease', id]); return true; },
      expireEntitlement: async () => { throw new Error('should not be called'); },
      recordWarningSent: async () => { throw new Error('should not be called'); },
      loadWarnedIds: async () => new Set(),
      sendAlert: async () => true,
    });
    check(calls.length === 1 && calls[0][0] === 'scheduleRelease' && calls[0][1] === 'h1', 'a schedule_release action calls scheduleRelease with the correct household id, and nothing else');
    check(result.scheduled === 1, 'result.scheduled reflects the one successful scheduling');
  }

  // --- an expire_lapsed_entitlement action calls expireEntitlement ---
  {
    const calls = [];
    const h = household('h2', { twilio_provisioning_status: 'active' });
    const e = { id: 'e2', status: 'active', starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-09-20T00:00:00Z' };
    const result = await runNumberLifecycleSweep({
      households: [h],
      entitlementsByHousehold: new Map([['h2', [e]]]),
      classificationByHousehold: new Map(),
      quarantineRows: [],
      now: () => new Date('2026-09-27T12:00:00Z'),
      scheduleRelease: async () => true,
      expireEntitlement: async (id) => { calls.push(id); return true; },
      recordWarningSent: async () => true,
      loadWarnedIds: async () => new Set(),
      sendAlert: async () => true,
    });
    check(calls.includes('e2'), 'the lapsed entitlement is passed to expireEntitlement');
    check(result.expired === 1, 'result.expired reflects the one successful expiry');
  }

  // --- a critical alert action calls sendAlert with the specific reason, never a generic message ---
  {
    const alerts = [];
    const h = household('h3', {
      twilio_number: '+441000000003',
      twilio_provisioning_status: 'active',
      twilio_number_pending_release_at: '2026-09-28T00:00:00Z',
    });
    const e = { id: 'e3', status: 'active', starts_at: '2026-09-01T00:00:00Z', ends_at: null };
    const result = await runNumberLifecycleSweep({
      households: [h],
      entitlementsByHousehold: new Map([['h3', [e]]]),
      classificationByHousehold: new Map(),
      quarantineRows: [],
      now: () => new Date('2026-09-27T12:00:00Z'),
      scheduleRelease: async () => true,
      expireEntitlement: async () => true,
      recordWarningSent: async () => true,
      loadWarnedIds: async () => new Set(),
      sendAlert: async (type, message, context) => { alerts.push({ type, message, context }); return true; },
    });
    check(alerts.some(a => a.type === 'lifecycle_sweep_pending_release_despite_entitlement'), 'the specific inconsistency reason is embedded in the alert type, not a generic string');
    check(result.alerted === 1, 'result.alerted reflects the one alert');
  }

  // --- FAIL CLOSED: if loadWarnedIds itself fails, warnings are skipped
  // entirely this run (never guessed as "nothing warned yet", which
  // would risk a duplicate) — but release/expiry/alert actions still proceed ---
  {
    const h1 = household('skip1', { twilio_number: '+441000000099' }); // no entitlement -> schedule_release
    const h2 = household('skip2', { twilio_provisioning_status: 'active' });
    const e2 = { id: 'eskip2', status: 'active', starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-10-01T00:00:00Z' };
    const classifications = new Map([['skip2', 'internal_test']]);
    let scheduleCalled = false;
    let warningRecorded = false;
    const result = await runNumberLifecycleSweep({
      households: [h1, h2],
      entitlementsByHousehold: new Map([['skip2', [e2]]]),
      classificationByHousehold: classifications,
      quarantineRows: [],
      now: () => new Date('2026-09-27T12:00:00Z'),
      scheduleRelease: async () => { scheduleCalled = true; return true; },
      expireEntitlement: async () => true,
      recordWarningSent: async () => { warningRecorded = true; return true; },
      loadWarnedIds: async () => { throw new Error('simulated DB failure loading warned ids'); },
      sendAlert: async () => true,
    });
    check(scheduleCalled === true, 'FAIL-CLOSED: a loadWarnedIds failure does not prevent an unrelated schedule_release action from still running');
    check(warningRecorded === false, 'FAIL-CLOSED: when warned-ids cannot be loaded, no warning is recorded this run — skip, never guess "nothing warned yet"');
  }

  // --- one household's failure never aborts the whole sweep ---
  {
    const h1 = household('fail1', { twilio_number: '+441000000001' });
    const h2 = household('fail2', { twilio_number: '+441000000002' });
    let secondCalled = false;
    const result = await runNumberLifecycleSweep({
      households: [h1, h2],
      entitlementsByHousehold: new Map(),
      classificationByHousehold: new Map(),
      quarantineRows: [],
      now: () => new Date('2026-09-27T12:00:00Z'),
      scheduleRelease: async (id) => {
        if (id === 'fail1') throw new Error('simulated RPC failure');
        secondCalled = true;
        return true;
      },
      expireEntitlement: async () => true,
      recordWarningSent: async () => true,
      loadWarnedIds: async () => new Set(),
      sendAlert: async () => true,
    });
    check(secondCalled === true, 'RESILIENCE: household 2\'s action still runs even though household 1\'s action threw');
    check(result.errors.length === 1 && result.errors[0].householdId === 'fail1', 'the failure is captured in result.errors, not silently swallowed or allowed to crash the run');
    check(result.scheduled === 1, 'the one genuinely successful scheduling is still counted correctly');
  }

  // --- expiry warning notification: default (no notifyExpiryWarning
  // injected) goes to an ops alert, never invents a customer channel ---
  {
    const alerts = [];
    const h = household('warn1');
    const e = { id: 'ewarn1', status: 'active', starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-10-03T00:00:00Z' };
    const classifications = new Map([['warn1', 'reviewer']]);
    await runNumberLifecycleSweep({
      households: [h],
      entitlementsByHousehold: new Map([['warn1', [e]]]),
      classificationByHousehold: classifications,
      quarantineRows: [],
      now: () => new Date('2026-09-27T12:00:00Z'),
      scheduleRelease: async () => true,
      expireEntitlement: async () => true,
      recordWarningSent: async () => true,
      loadWarnedIds: async () => new Set(),
      sendAlert: async (type, message) => { alerts.push({ type, message }); return true; },
      // notifyExpiryWarning deliberately NOT provided
    });
    check(alerts.some(a => a.type === 'test_membership_expiring_soon'), 'DECISION REQUIRED default: with no customer-facing notifier injected, the warning becomes an ops-facing alert, never a guessed SMS/email send');
  }

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} number-lifecycle-sweep-runner checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
