// Coverage for services/adminNumberLifecycleReconciliation.js
// (2026-09-27 launch-hardening, Priority 2) — the admin visibility layer
// for subscription -> entitlement -> HCG number -> pending release/
// quarantine -> released. Pure function, no database.
//
// Run with: node tests/admin-number-lifecycle-reconciliation.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeNumberLifecycleReconciliation, ANOMALY } = require('../services/adminNumberLifecycleReconciliation');

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

function household(id, overrides = {}) {
  return {
    id,
    email: `${id}@example.com`,
    twilio_number: null,
    twilio_provisioning_status: 'pending',
    twilio_provisioning_last_error: null,
    twilio_number_pending_release_at: null,
    ...overrides,
  };
}

function activeEntitlement(overrides = {}) {
  return { status: 'active', starts_at: '2026-09-01T00:00:00Z', ends_at: null, ...overrides };
}

function findRow(result, id) {
  return result.households.find(h => h.householdId === id);
}

// --- a fully healthy household produces zero anomalies ---
{
  const households = [household('h1', { twilio_number: '+441000000001', twilio_provisioning_status: 'active' })];
  const entitlements = new Map([['h1', [activeEntitlement()]]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  check(result.status === 'OK', 'a fully healthy household reports overall status OK');
  check(findRow(result, 'h1').anomalies.length === 0, 'a fully healthy household has zero anomalies');
}

// --- anomaly 1: active entitlement, no number ---
{
  const households = [household('h2', { twilio_number: null })];
  const entitlements = new Map([['h2', [activeEntitlement()]]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  check(result.status === 'ACTION_REQUIRED', 'active entitlement with no number flips status to ACTION_REQUIRED');
  check(findRow(result, 'h2').anomalies.includes(ANOMALY.ACTIVE_NO_NUMBER), 'flags active_entitlement_no_number');
}

// --- anomaly 2: no entitlement, number still retained, no pending release ---
{
  const households = [household('h3', { twilio_number: '+441000000003', twilio_provisioning_status: 'active' })];
  const result = computeNumberLifecycleReconciliation(households, new Map(), new Map(), [], NOW);
  check(findRow(result, 'h3').anomalies.includes(ANOMALY.CANCELLED_RETAINS_NUMBER), 'flags no_entitlement_retains_number');
}

// --- NOT an anomaly: no entitlement, number retained, but a release IS pending (normal in-grace-period state) ---
{
  const households = [household('h3b', { twilio_number: '+441000000003', twilio_number_pending_release_at: '2026-10-20T00:00:00Z' })];
  const result = computeNumberLifecycleReconciliation(households, new Map(), new Map(), [], NOW);
  check(!findRow(result, 'h3b').anomalies.includes(ANOMALY.CANCELLED_RETAINS_NUMBER), 'a number correctly scheduled for release during its grace period is NOT flagged as an anomaly');
}

// --- anomaly 3: entitled but a release is (wrongly) still pending — the #8 signature ---
{
  const households = [household('h4', {
    twilio_number: '+441000000004',
    twilio_provisioning_status: 'active',
    twilio_number_pending_release_at: '2026-09-28T00:00:00Z',
  })];
  const entitlements = new Map([['h4', [activeEntitlement()]]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  check(findRow(result, 'h4').anomalies.includes(ANOMALY.ENTITLED_PENDING_RELEASE), 'flags entitled_but_pending_release — the exact #8 signature this dashboard exists to surface');
}

// --- upcoming (not current) entitlement also protects against this anomaly ---
{
  const households = [household('h4b', {
    twilio_number: '+441000000004',
    twilio_number_pending_release_at: '2026-09-28T00:00:00Z',
  })];
  const entitlements = new Map([['h4b', [{ status: 'scheduled', starts_at: '2026-10-05T00:00:00Z', ends_at: null }]]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  check(findRow(result, 'h4b').hasUpcomingEntitlement === true, 'upcoming entitlement correctly detected');
  check(findRow(result, 'h4b').anomalies.includes(ANOMALY.ENTITLED_PENDING_RELEASE), 'an upcoming (not just current) entitlement with a pending release is also flagged');
}

// --- anomaly 4: provisioning failed ---
{
  const households = [household('h5', { twilio_provisioning_status: 'failed', twilio_provisioning_last_error: 'timeout' })];
  const result = computeNumberLifecycleReconciliation(households, new Map(), new Map(), [], NOW);
  check(findRow(result, 'h5').anomalies.includes(ANOMALY.PROVISIONING_FAILED), 'flags provisioning_failed');
}

// --- anomaly 5: quarantine confirmed for deactivation but never confirmed released at the provider ---
{
  const households = [household('h6')];
  const quarantine = [{ household_id: 'h6', release_reason: 'subscription_grace_expired', deactivation_confirmed: true, released_at: null, quarantined_at: '2026-09-01T00:00:00Z' }];
  const result = computeNumberLifecycleReconciliation(households, new Map(), new Map(), quarantine, NOW);
  check(findRow(result, 'h6').anomalies.includes(ANOMALY.QUARANTINE_RELEASE_FAILED), 'flags quarantine_release_failed');
  check(findRow(result, 'h6').quarantine !== null, 'the quarantine detail is surfaced on the row');
}

// --- NOT an anomaly: quarantine row that HAS been released ---
{
  const households = [household('h6b')];
  const quarantine = [{ household_id: 'h6b', release_reason: 'subscription_grace_expired', deactivation_confirmed: true, released_at: '2026-09-15T00:00:00Z', quarantined_at: '2026-09-01T00:00:00Z' }];
  const result = computeNumberLifecycleReconciliation(households, new Map(), new Map(), quarantine, NOW);
  check(findRow(result, 'h6b').anomalies.length === 0, 'a genuinely released quarantine row produces no anomaly');
}

// --- classification: test/internal/reviewer accounts never contaminate the genuine-customer summary ---
{
  const households = [
    household('genuine1', { twilio_number: null }), // would be an anomaly if it had an entitlement
    household('test1', { twilio_number: null }),
  ];
  const entitlements = new Map([
    ['genuine1', [activeEntitlement()]],
    ['test1', [activeEntitlement()]],
  ]);
  const classifications = new Map([['test1', 'internal_test']]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, classifications, [], NOW);
  check(result.genuineCustomerHouseholds === 1, 'only the unclassified/genuine_customer household counts toward genuineCustomerHouseholds');
  check(result.anomalyCounts[ANOMALY.ACTIVE_NO_NUMBER] === 1, 'the anomaly count only reflects the genuine household, not the internal_test one, even though both technically have the same anomaly');
  check(findRow(result, 'test1').anomalies.includes(ANOMALY.ACTIVE_NO_NUMBER), 'the test household\'s row still shows its own anomaly (visible to an operator), just excluded from the headline count');
  check(findRow(result, 'test1').isGenuineCustomer === false, 'the test household is correctly marked not a genuine customer');
}

// --- unclassified defaults to counted-as-genuine (safe default: never silently hide a real customer\'s anomaly) ---
{
  const households = [household('unclassified1', { twilio_number: null })];
  const entitlements = new Map([['unclassified1', [activeEntitlement()]]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  check(findRow(result, 'unclassified1').classification === 'unclassified', 'a household with no classification row is reported as "unclassified"');
  check(findRow(result, 'unclassified1').isGenuineCustomer === true, 'unclassified defaults to counted-as-genuine — the safe default per account_classifications\' own migration comment ("absence of a row is the safe default")');
}

// --- expired entitlement: neither current nor upcoming, correctly does not suppress the retains-number anomaly ---
{
  const households = [household('h7', { twilio_number: '+441000000007' })];
  const entitlements = new Map([['h7', [{ status: 'expired', starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-09-01T00:00:00Z' }]]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  check(findRow(result, 'h7').hasCurrentEntitlement === false, 'an expired entitlement is correctly not counted as current');
  check(findRow(result, 'h7').anomalies.includes(ANOMALY.CANCELLED_RETAINS_NUMBER), 'an expired-only entitlement with a retained, non-scheduled number is flagged');
}

// --- multiple households, multiple anomaly types, overall counts ---
{
  const households = [
    household('multi1', { twilio_number: null }),
    household('multi2', { twilio_provisioning_status: 'failed' }),
  ];
  const entitlements = new Map([['multi1', [activeEntitlement()]]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  check(result.totalAnomalies === 2, 'total anomaly count sums correctly across multiple households/types');
  check(result.status === 'ACTION_REQUIRED', 'any anomaly at all flips the overall status');
}

// --- empty input never throws, reports OK ---
{
  const result = computeNumberLifecycleReconciliation([], new Map(), new Map(), [], NOW);
  check(result.status === 'OK', 'zero households reports OK, not a false anomaly');
  check(result.totalHouseholds === 0 && result.totalAnomalies === 0, 'zero households, zero anomalies');
}

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} admin-number-lifecycle-reconciliation checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
