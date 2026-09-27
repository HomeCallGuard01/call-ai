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

// --- SANDBOX_TEST_PURCHASE_NO_NUMBER (2026-09-27, found during this
// session's own Priority 7 audit — PR #50's sandbox fix would otherwise
// have reproduced exactly the false-alarm this dashboard exists to
// avoid: an unclassified sandbox purchaser counting as a genuine-customer
// anomaly). ---
{
  const households = [household('sandbox1', { twilio_number: null })];
  const entitlements = new Map([[
    'sandbox1',
    [activeEntitlement({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' })],
  ]]);
  // No classification row at all — exactly PR #50's own deliberate
  // design (a sandbox purchase is never auto-classified).
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  const row = findRow(result, 'sandbox1');

  check(row.anomalies.includes(ANOMALY.SANDBOX_TEST_PURCHASE_NO_NUMBER), 'a confirmed sandbox-origin entitlement with no number raises SANDBOX_TEST_PURCHASE_NO_NUMBER, not the genuine-failure ACTIVE_NO_NUMBER');
  check(!row.anomalies.includes(ANOMALY.ACTIVE_NO_NUMBER), 'the same row never ALSO carries the genuine-failure anomaly — they are mutually exclusive for a single active_entitlement_no_number condition');
  check(row.isGenuineCustomer === true, 'the row is still correctly treated as unclassified/"genuine" for visibility purposes (an operator can still see it in the full list)');
  check(result.totalAnomalies === 0, 'THE ACTUAL FIX: despite being an unclassified household with an active entitlement and no number, totalAnomalies is 0 — the sandbox anomaly is informational, never counted');
  check(result.status === 'OK', 'THE ACTUAL FIX: overall status stays OK — a confirmed sandbox purchase never flips the dashboard to ACTION_REQUIRED');
  check(result.anomalyCounts[ANOMALY.SANDBOX_TEST_PURCHASE_NO_NUMBER] === 1, 'the sandbox anomaly is still counted in its OWN bucket (anomalyCounts) — visible/queryable, just excluded from the actionable total');
}

// --- Backward compatibility: a caller not yet selecting source/
// revenuecat_environment (i.e. migration 053 not yet applied) must
// continue to see the exact pre-existing ACTIVE_NO_NUMBER behaviour —
// never crash, never silently misclassify. ---
{
  const households = [household('legacy1', { twilio_number: null })];
  const entitlements = new Map([['legacy1', [activeEntitlement()]]]); // no source/revenuecat_environment fields at all
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  const row = findRow(result, 'legacy1');

  check(row.anomalies.includes(ANOMALY.ACTIVE_NO_NUMBER), 'BACKWARD COMPAT: an entitlement row with no source/revenuecat_environment fields at all falls through to the pre-existing ACTIVE_NO_NUMBER anomaly, exactly as before this change');
  check(!row.anomalies.includes(ANOMALY.SANDBOX_TEST_PURCHASE_NO_NUMBER), 'BACKWARD COMPAT: never guesses sandbox from absence of the field');
  check(result.status === 'ACTION_REQUIRED', 'BACKWARD COMPAT: a genuine (or pre-053, indistinguishable) no-number state still correctly flips status to ACTION_REQUIRED');
}

// --- A real Stripe-sourced entitlement is never mistaken for sandbox,
// even if some other bug ever set revenuecat_environment on a non-
// apple_revenuecat row (defence in depth: both conditions required). ---
{
  const households = [household('stripe1', { twilio_number: null })];
  const entitlements = new Map([[
    'stripe1',
    [activeEntitlement({ source: 'stripe', revenuecat_environment: 'sandbox' })],
  ]]);
  const result = computeNumberLifecycleReconciliation(households, entitlements, new Map(), [], NOW);
  const row = findRow(result, 'stripe1');
  check(row.anomalies.includes(ANOMALY.ACTIVE_NO_NUMBER), 'DEFENCE IN DEPTH: source must ALSO be apple_revenuecat, not just revenuecat_environment=sandbox — a non-RevenueCat row is never misclassified as sandbox no matter what stray field value it carries');
}

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} admin-number-lifecycle-reconciliation checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
