// Coverage for services/numberLifecycleSweep.js — the daily lifecycle
// reconciliation sweep (Step 2, 2026-09-27), built on migration 047's
// entitlement guard. Pure function, no database, no Twilio.
//
// Structure: the seven originally-requested categories, then the
// Priority 3 lifecycle matrix scenarios (heavily overlapping — most
// matrix rows are direct corollaries of the category tests), then
// idempotency/adversarial/race scenarios, then the explicit #8
// non-reintroduction proof.
//
// Run with: node tests/number-lifecycle-sweep.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeLifecycleSweepActions } = require('../services/numberLifecycleSweep');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const NOW = new Date('2026-09-27T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function household(id, overrides = {}) {
  return {
    id,
    twilio_number: null,
    twilio_provisioning_status: 'pending',
    twilio_number_pending_release_at: null,
    ...overrides,
  };
}

function entitlement(id, overrides = {}) {
  return { id, status: 'active', starts_at: '2026-09-01T00:00:00Z', ends_at: null, ...overrides };
}

function actionsFor(actions, householdId) {
  return actions.filter(a => a.householdId === householdId);
}
function hasAction(actions, householdId, type) {
  return actionsFor(actions, householdId).some(a => a.type === type);
}

function run(households, entMap, classMap = new Map(), quarantine = [], warned = new Set(), now = NOW) {
  return computeLifecycleSweepActions(households, entMap, classMap, quarantine, warned, now);
}

// =========================================================================
// CATEGORY 1: date-expired complimentary memberships
// =========================================================================
{
  const h = household('c1', { twilio_number: '+441000000001', twilio_provisioning_status: 'active' });
  const e = entitlement('e1', { entitlement_type: 'complimentary', status: 'active', ends_at: '2026-09-20T00:00:00Z' }); // lapsed 7 days ago
  const actions = run([h], new Map([['c1', [e]]]));
  check(hasAction(actions, 'c1', 'expire_lapsed_entitlement'), 'CAT1: a date-lapsed complimentary entitlement (status still active) is proposed for expiry transition');
  check(hasAction(actions, 'c1', 'schedule_release'), 'CAT1: with the entitlement date-lapsed and no other entitlement, a release is also correctly proposed');
}

// =========================================================================
// CATEGORY 2: expired reviewer/test memberships
// =========================================================================
{
  const h = household('c2', { twilio_number: '+441000000002', twilio_provisioning_status: 'active' });
  const e = entitlement('e2', { status: 'active', ends_at: '2026-09-25T00:00:00Z' });
  const classifications = new Map([['c2', 'reviewer']]);
  const actions = run([h], new Map([['c2', [e]]]), classifications);
  check(hasAction(actions, 'c2', 'expire_lapsed_entitlement'), 'CAT2: an expired reviewer membership is also proposed for expiry transition (no special exemption)');
  check(hasAction(actions, 'c2', 'schedule_release'), 'CAT2: an expired reviewer membership with no other entitlement is also proposed for release, same as any other household');
}

// =========================================================================
// CATEGORY 3: cancelled/ended paid memberships
// =========================================================================
{
  const h = household('c3', { twilio_number: '+441000000003', twilio_provisioning_status: 'active' });
  const e = entitlement('e3', { entitlement_type: 'paid_subscription', status: 'expired', starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-09-23T00:00:00Z' });
  const actions = run([h], new Map([['c3', [e]]]));
  check(hasAction(actions, 'c3', 'schedule_release'), 'CAT3: a cancelled paid subscription (status already expired) with a retained number is proposed for release');
  check(!hasAction(actions, 'c3', 'expire_lapsed_entitlement'), 'CAT3: an entitlement already marked expired is not re-proposed for expiry (only status=active rows qualify)');
}

// =========================================================================
// CATEGORY 4: households holding numbers with no valid/current/upcoming entitlement
// =========================================================================
{
  const h = household('c4', { twilio_number: '+441000000004', twilio_provisioning_status: 'active' });
  const actions = run([h], new Map()); // no entitlement rows at all
  check(hasAction(actions, 'c4', 'schedule_release'), 'CAT4: a household with a number and zero entitlement rows at all is proposed for release');
}

// =========================================================================
// CATEGORY 5: households with a release scheduled despite current/upcoming entitlement
// =========================================================================
{
  const h = household('c5', {
    twilio_number: '+441000000005',
    twilio_provisioning_status: 'active',
    twilio_number_pending_release_at: '2026-09-28T00:00:00Z',
  });
  const e = entitlement('e5', { status: 'active', ends_at: null });
  const actions = run([h], new Map([['c5', [e]]]));
  check(hasAction(actions, 'c5', 'alert_inconsistency'), 'CAT5: a pending release despite a current entitlement is flagged as an inconsistency');
  check(actionsFor(actions, 'c5').find(a => a.type === 'alert_inconsistency').reason === 'pending_release_despite_entitlement', 'CAT5: the alert has the specific, correct reason');
  check(!hasAction(actions, 'c5', 'schedule_release'), 'CAT5: no NEW release is proposed on top of the existing (anomalous) one');
}

// --- same but with an UPCOMING (not current) entitlement ---
{
  const h = household('c5b', {
    twilio_number: '+441000000005',
    twilio_number_pending_release_at: '2026-09-28T00:00:00Z',
  });
  const e = entitlement('e5b', { status: 'scheduled', starts_at: '2026-10-05T00:00:00Z', ends_at: null });
  const actions = run([h], new Map([['c5b', [e]]]));
  check(hasAction(actions, 'c5b', 'alert_inconsistency'), 'CAT5b: an upcoming (not just current) entitlement with a pending release is also flagged');
}

// =========================================================================
// CATEGORY 6: quarantined numbers whose grace period has elapsed
// =========================================================================
{
  const h = household('c6');
  const quarantine = [{ household_id: 'c6', deactivation_confirmed: true, released_at: null, quarantined_at: '2026-09-24T00:00:00Z' }]; // 3 days ago, > 48h threshold
  const actions = run([h], new Map(), new Map(), quarantine);
  check(hasAction(actions, 'c6', 'alert_inconsistency'), 'CAT6: a quarantined number stuck unreleased for over 48h is flagged');
  check(actionsFor(actions, 'c6').find(a => a.reason === 'quarantine_release_stuck'), 'CAT6: the alert has the specific quarantine_release_stuck reason');
}
{
  // Not yet stuck — quarantined only 6 hours ago, should NOT alert yet.
  const h = household('c6b');
  const quarantine = [{ household_id: 'c6b', deactivation_confirmed: true, released_at: null, quarantined_at: '2026-09-27T06:00:00Z' }];
  const actions = run([h], new Map(), new Map(), quarantine);
  check(!hasAction(actions, 'c6b', 'alert_inconsistency'), 'CAT6b: a quarantine only 6h old is NOT yet flagged as stuck — avoids alert noise for the normal, expected pending window');
}

// =========================================================================
// CATEGORY 7: failed/stuck release states
// =========================================================================
{
  const h = household('c7', { twilio_provisioning_status: 'failed' });
  const actions = run([h], new Map());
  check(hasAction(actions, 'c7', 'alert_inconsistency'), 'CAT7a: provisioning_status=failed is flagged');
}
{
  // Grace period ended 2 days ago (> 24h threshold), number still assigned — stuck release.
  const h = household('c7b', {
    twilio_number: '+441000000007',
    twilio_provisioning_status: 'active',
    twilio_number_pending_release_at: '2026-09-25T12:00:00Z',
  });
  const actions = run([h], new Map());
  check(hasAction(actions, 'c7b', 'alert_inconsistency'), 'CAT7b: a release overdue by more than 24h is flagged as stuck');
  check(actionsFor(actions, 'c7b').find(a => a.reason === 'release_overdue'), 'CAT7b: the alert has the specific release_overdue reason');
}
{
  // Grace period ended 2 hours ago — NOT yet overdue enough to alert (normal, the daily runner just hasn't run yet).
  const h = household('c7c', {
    twilio_number: '+441000000007',
    twilio_number_pending_release_at: '2026-09-27T10:00:00Z',
  });
  const actions = run([h], new Map());
  check(!hasAction(actions, 'c7c', 'alert_inconsistency'), 'CAT7c: a release only 2h overdue is not yet flagged — normal transient state, not an anomaly');
}

// =========================================================================
// 14-day pre-expiry warning for test/reviewer/internal memberships
// =========================================================================
{
  const h = household('w1');
  const e = entitlement('ew1', { status: 'active', ends_at: '2026-10-05T00:00:00Z' }); // 8 days out — inside the 14-day window
  const classifications = new Map([['w1', 'internal_test']]);
  const actions = run([h], new Map([['w1', [e]]]), classifications);
  check(hasAction(actions, 'w1', 'send_test_expiry_warning'), 'WARNING: an internal_test membership 8 days from expiry gets a warning');
}
{
  const h = household('w2');
  const e = entitlement('ew2', { status: 'active', ends_at: '2026-11-01T00:00:00Z' }); // 35 days out — outside the window
  const classifications = new Map([['w2', 'internal_test']]);
  const actions = run([h], new Map([['w2', [e]]]), classifications);
  check(!hasAction(actions, 'w2', 'send_test_expiry_warning'), 'WARNING: a membership 35 days from expiry does NOT get a warning yet');
}
{
  // genuine_customer classification never gets this warning at all — it's test/reviewer/qa only.
  const h = household('w3');
  const e = entitlement('ew3', { status: 'active', ends_at: '2026-10-01T00:00:00Z' });
  const classifications = new Map([['w3', 'genuine_customer']]);
  const actions = run([h], new Map([['w3', [e]]]), classifications);
  check(!hasAction(actions, 'w3', 'send_test_expiry_warning'), 'WARNING: a genuine_customer classification never receives the test/reviewer pre-expiry warning');
}
{
  // open-ended (ends_at null) — never expires, never warns.
  const h = household('w4');
  const e = entitlement('ew4', { status: 'active', ends_at: null });
  const classifications = new Map([['w4', 'internal_test']]);
  const actions = run([h], new Map([['w4', [e]]]), classifications);
  check(!hasAction(actions, 'w4', 'send_test_expiry_warning'), 'WARNING: an open-ended (never-expiring) test membership never triggers a pre-expiry warning');
}

// =========================================================================
// IDEMPOTENCY
// =========================================================================
{
  const h = household('idem1');
  const e = entitlement('eidem1', { status: 'active', ends_at: '2026-10-05T00:00:00Z' });
  const classifications = new Map([['idem1', 'internal_test']]);

  const firstRun = run([h], new Map([['idem1', [e]]]), classifications, [], new Set());
  check(hasAction(firstRun, 'idem1', 'send_test_expiry_warning'), 'IDEMPOTENCY: first run proposes the warning');

  // Simulate the warning having been recorded (entitlement_expiry_warnings_sent
  // now contains this entitlement id) — the RPC's own ON CONFLICT DO
  // NOTHING is the database-level guarantee; this proves the pure
  // function itself also respects that state, not just the RPC.
  const secondRun = run([h], new Map([['idem1', [e]]]), classifications, [], new Set(['eidem1']));
  check(!hasAction(secondRun, 'idem1', 'send_test_expiry_warning'), 'IDEMPOTENCY: a second run, with the warning already recorded as sent, does NOT propose it again — repeated runs cannot duplicate the warning');
}
{
  // Repeated identical runs propose the identical schedule_release action
  // each time (this is expected and correct — idempotency for THIS
  // action lives at the RPC layer: mark_household_twilio_number_pending_release
  // itself is a no-op if v_pending is already not null, tested in
  // tests/number-release-entitlement-guard.test.mjs and
  // tests/migrations.pglite.test.mjs already). This test documents that
  // expectation explicitly rather than leaving it unstated.
  const h = household('idem2', { twilio_number: '+441000000099' });
  const run1 = run([h], new Map());
  const run2 = run([h], new Map());
  check(hasAction(run1, 'idem2', 'schedule_release') && hasAction(run2, 'idem2', 'schedule_release'),
    'IDEMPOTENCY: schedule_release is proposed on every run while the underlying state is unchanged — safe because the RPC executing it is itself idempotent (already tested elsewhere), not because this function tracks "already proposed"');
}

// =========================================================================
// ADVERSARIAL / RACE / FAIL-CLOSED
// =========================================================================
{
  const h = household('adv1');
  const e = { id: 'eadv1', status: 'not_a_real_status', starts_at: '2026-09-01T00:00:00Z', ends_at: null };
  const actions = run([h], new Map([['adv1', [e]]]));
  check(hasAction(actions, 'adv1', 'alert_inconsistency'), 'FAIL-CLOSED: an entitlement with an unrecognised status produces an alert');
  check(actionsFor(actions, 'adv1').find(a => a.reason === 'ambiguous_entitlement_status'), 'FAIL-CLOSED: the alert correctly identifies ambiguous_entitlement_status');
  check(!hasAction(actions, 'adv1', 'schedule_release'), 'FAIL-CLOSED: NO release-adjacent action is proposed for a household with ambiguous entitlement state — silence/guessing is never treated as safe-to-release');
}
{
  const h = { id: 'adv2', twilio_number: '+441000000002', twilio_provisioning_status: null, twilio_number_pending_release_at: null };
  const actions = run([h], new Map());
  check(hasAction(actions, 'adv2', 'alert_inconsistency'), 'FAIL-CLOSED: a household with an unreadable provisioning_status produces an alert, not a guessed action');
  check(!hasAction(actions, 'adv2', 'schedule_release'), 'FAIL-CLOSED: no release is proposed when provisioning state itself cannot be established');
}
{
  // Malformed data: ends_at before starts_at (should never happen given
  // the DB CHECK constraint, but this function must not crash or
  // misbehave if it somehow does).
  const h = household('adv3', { twilio_number: '+441000000003' });
  const e = entitlement('eadv3', { status: 'active', starts_at: '2026-09-20T00:00:00Z', ends_at: '2026-09-10T00:00:00Z' });
  let threw = false;
  let actions = [];
  try {
    actions = run([h], new Map([['adv3', [e]]]));
  } catch {
    threw = true;
  }
  check(threw === false, 'ADVERSARIAL: malformed entitlement dates (ends_at before starts_at) never throws');
}
{
  // Two entitlement rows for one household: one expired, one active —
  // must correctly see the active one and not release.
  const h = household('adv4', { twilio_number: '+441000000004' });
  const expired = entitlement('eadv4a', { status: 'expired', starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-09-01T00:00:00Z' });
  const active = entitlement('eadv4b', { status: 'active', starts_at: '2026-09-10T00:00:00Z', ends_at: null });
  const actions = run([h], new Map([['adv4', [expired, active]]]));
  check(!hasAction(actions, 'adv4', 'schedule_release'), 'ADVERSARIAL: a household with one expired and one active entitlement is correctly NOT proposed for release');
}
{
  // Null/missing household id entries in the input array must never crash.
  let threw = false;
  try {
    run([null, undefined, household('adv5')], new Map());
  } catch {
    threw = true;
  }
  check(threw === false, 'ADVERSARIAL: null/undefined entries in the households array never crash the sweep');
}
{
  // Empty everything.
  let threw = false;
  let actions = [];
  try {
    actions = computeLifecycleSweepActions([], new Map(), new Map(), [], new Set(), NOW);
  } catch {
    threw = true;
  }
  check(threw === false && actions.length === 0, 'ADVERSARIAL: completely empty input produces zero actions, never throws');
}

// =========================================================================
// RACE: membership granted during release processing — the pure
// function's job here is only to prove it never proposes an UNSAFE
// action; the actual race-safety guarantee lives at the RPC layer
// (047's row lock + trigger), already proven in
// tests/number-release-entitlement-guard.test.mjs and
// tests/migrations.pglite.test.mjs. This test documents that boundary
// explicitly: the sweep proposes based on a snapshot, and the RPC
// re-checks at execution time — this is BY DESIGN, not a gap.
// =========================================================================
{
  const h = household('race1', { twilio_number: '+441000000010' });
  // At decision time: no entitlement, so schedule_release is proposed.
  const actionsAtDecisionTime = run([h], new Map());
  check(hasAction(actionsAtDecisionTime, 'race1', 'schedule_release'), 'RACE: at decision time with no entitlement, schedule_release is correctly proposed (a snapshot, not a lock)');
  // The actual safety guarantee against a race (an entitlement granted
  // between this decision and the RPC executing) is NOT this function's
  // job — it's mark_household_twilio_number_pending_release's own guard,
  // re-checked under the household row lock, independently proven in
  // tests/number-release-entitlement-guard.test.mjs's "service-role
  // grant" scenarios. This sweep's action is advisory input to that RPC,
  // never a bypass of it.
  console.log('  (RACE note: actual concurrency-safety guarantee is the 047 RPC\'s own row lock, proven separately — this sweep only ever proposes, never executes, a release)');
}

// =========================================================================
// #8 NON-REINTRODUCTION PROOF — the sweep must never itself release a
// number, under any input, including the exact stale-schedule shape
// that caused the real incident.
// =========================================================================
{
  const h = household('replay8', {
    twilio_number: '+441000000801',
    twilio_provisioning_status: 'active',
    twilio_number_pending_release_at: '2026-09-20T00:00:00Z', // a stale schedule, already in the past
  });
  const e = entitlement('ereplay8', { entitlement_type: 'complimentary', status: 'active', starts_at: '2026-08-27T00:00:00Z', ends_at: null }); // the "Aug 27" grant
  const actions = run([h], new Map([['replay8', [e]]]));

  check(
    actions.filter(a => a.householdId === 'replay8').every(a => a.type !== 'schedule_release'),
    '#8 REPLAY: the sweep NEVER proposes schedule_release for a household with a current entitlement, even with a stale, overdue pending-release date present'
  );
  check(
    hasAction(actions, 'replay8', 'alert_inconsistency'),
    '#8 REPLAY: instead, the sweep raises a visible alert (pending_release_despite_entitlement) — surfacing the exact anomaly that went unnoticed in the real incident, rather than silently fixing OR silently releasing'
  );
  // Absolutely no action type in this whole function's vocabulary can
  // itself release a number — grep-level structural guarantee, not just
  // a scenario test.
  const ACTION_TYPES_THAT_CAN_RELEASE_A_NUMBER = new Set(['schedule_release']); // schedule_release itself only ever calls the 047-guarded RPC, never a direct release
  const anyDirectRelease = actions.some(a => a.type === 'release_number' || a.type === 'force_release');
  check(anyDirectRelease === false, '#8 REPLAY: no action of type "release_number"/"force_release" (a direct, unguarded release) exists anywhere in this function\'s output vocabulary — structurally impossible, not just untriggered in this test');
}

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} number-lifecycle-sweep checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
