// Unit tests for database/adminMetrics.js — the pure aggregation/merge
// functions behind the Sprint 11 Admin Dashboard. Only the pure functions
// are tested here (no real Supabase/Stripe calls) — same convention as
// tests/twilio-provisioning.test.mjs.
//
// Run with: node tests/admin-metrics.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const {
  mergeCustomerActivity,
  mergeAlerts,
  looksLikeUuid,
  computeBusinessOverview,
  computeProtectionRate,
  computeProtectionActivity,
  computeSubscriptionStatusBreakdown,
  computeProvisioningStatusBreakdown,
  computeReadinessSummary,
} = require('../database/adminMetrics.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- computeBusinessOverview ---

const overviewWithPrice = computeBusinessOverview({
  totalCustomers: 10,
  activeProtectedHouseholds: 6,
  newCustomersThisWeek: 2,
  activeEntitlements: 7,
  failedPayments: 2,
  price: { unitAmount: 999, currency: 'gbp' },
});

check(overviewWithPrice.totalCustomers === 10, 'totalCustomers passes through the raw count');
check(overviewWithPrice.activeProtectedHouseholds === 6, 'activeProtectedHouseholds passes through the raw count');
check(overviewWithPrice.newCustomersThisWeek === 2, 'newCustomersThisWeek passes through the raw count');
check(overviewWithPrice.failedPayments === 2, 'failedPayments passes through the raw count');
check(overviewWithPrice.mrr.available === true, 'mrr is marked available when a Stripe price was fetched');
check(overviewWithPrice.mrr.amount === 69.93, 'mrr is active subscriptions × unit price, in major currency units (7 × £9.99)');
check(overviewWithPrice.mrr.currency === 'gbp', 'mrr currency comes from the Stripe price');

const overviewWithoutPrice = computeBusinessOverview({
  totalCustomers: 3,
  activeProtectedHouseholds: 1,
  newCustomersThisWeek: 0,
  activeEntitlements: 2,
  failedPayments: 0,
  price: null,
});

check(overviewWithoutPrice.mrr.available === false, 'mrr is marked unavailable rather than invented when no Stripe price could be fetched');
check(overviewWithoutPrice.mrr.amount === null, 'mrr amount is null, not a fabricated number, when unavailable');

// --- computeProtectionRate / computeProtectionActivity ---

check(computeProtectionRate(5, 20) === 25, 'computeProtectionRate: 5 blocked of 20 processed is 25%');
check(computeProtectionRate(1, 3) === 33.3, 'computeProtectionRate: rounds to one decimal place');
check(computeProtectionRate(0, 0) === null, 'computeProtectionRate: null (not 0%) when no calls were processed at all');

const activitySummary = computeProtectionActivity({
  callsProcessedToday: 20,
  callsBlockedToday: 5,
  callsAllowedToday: 12,
  unknownChallengedToday: 8,
});

check(activitySummary.protectionRate === 25, 'computeProtectionActivity derives protectionRate from the same-day counts');
check(activitySummary.callsAllowedToday === 12, 'computeProtectionActivity passes callsAllowedToday through unchanged');

// --- computeSubscriptionStatusBreakdown ---

const subscriptionBreakdown = computeSubscriptionStatusBreakdown([
  { household_id: 'a', status: 'active', updated_at: '2026-07-20T10:00:00Z' },
  { household_id: 'a', status: 'past_due', updated_at: '2026-07-21T10:00:00Z' },
  { household_id: 'b', status: 'active', updated_at: '2026-07-19T10:00:00Z' },
]);

check(
  subscriptionBreakdown.find(r => r.status === 'past_due').count === 1 && subscriptionBreakdown.find(r => r.status === 'active').count === 1,
  'computeSubscriptionStatusBreakdown counts only the most recent status per household, not every historical row'
);

// --- computeProvisioningStatusBreakdown ---

const provisioningBreakdown = computeProvisioningStatusBreakdown([
  { twilio_provisioning_status: 'active' },
  { twilio_provisioning_status: 'failed' },
  { twilio_provisioning_status: 'active' },
]);

check(provisioningBreakdown.find(r => r.status === 'active').count === 2, 'computeProvisioningStatusBreakdown counts households by provisioning status');
check(provisioningBreakdown.find(r => r.status === 'failed').count === 1, 'computeProvisioningStatusBreakdown counts the failed status separately');

// --- computeReadinessSummary ---

check(
  computeReadinessSummary([{ severity: 'blocker', status: 'pending' }, { severity: 'medium', status: 'pending' }]).status === 'not_ready',
  'computeReadinessSummary: a single open blocker makes the whole launch not_ready, regardless of other items'
);

check(
  computeReadinessSummary([{ severity: 'medium', status: 'pending' }]).status === 'ready_with_open_items',
  'computeReadinessSummary: open items with no blocker is ready_with_open_items'
);

check(computeReadinessSummary([]).status === 'ready', 'computeReadinessSummary: no items at all is ready');

// --- mergeCustomerActivity ---

const activity = mergeCustomerActivity(
  {
    households: [
      { id: 'h1', email: 'newer@example.com', created_at: '2026-07-20T10:00:00Z' },
      { id: 'h2', email: 'older@example.com', created_at: '2026-07-01T10:00:00Z' },
    ],
    subscriptions: [
      { household_id: 'h2', status: 'active', updated_at: '2026-07-21T09:00:00Z', households: { email: 'older@example.com' } },
    ],
  },
  10
);

check(activity.length === 3, 'mergeCustomerActivity combines signup and subscription events into one feed');
check(activity[0].type === 'subscription_active' && activity[0].householdId === 'h2', 'mergeCustomerActivity sorts most-recent-first across both event types');
check(activity[2].householdId === 'h2' && activity[2].type === 'signup', 'the oldest event (h2 signup) sorts last');

const limitedActivity = mergeCustomerActivity(
  { households: [{ id: 'h1', email: 'a@example.com', created_at: '2026-07-20T10:00:00Z' }], subscriptions: [] },
  0
);
check(limitedActivity.length === 0, 'mergeCustomerActivity respects the limit argument');

// --- mergeAlerts ---

const alerts = mergeAlerts({
  failedHouseholds: [
    { id: 'h1', email: 'a@example.com', twilio_provisioning_last_error: 'No numbers available', twilio_provisioning_updated_at: '2026-07-20T08:00:00Z' },
  ],
  failedWebhookEvents: [
    { household_id: 'h2', event_type: 'customer.subscription.updated', error: 'timeout', received_at: '2026-07-21T08:00:00Z' },
  ],
});

check(alerts.length === 2, 'mergeAlerts combines provisioning failures and webhook failures');
check(alerts[0].type === 'webhook_failed', 'mergeAlerts sorts most-recent-first');
check(alerts[1].type === 'provisioning_failed' && alerts[1].severity === 'high', 'a provisioning failure is surfaced as high severity');

// --- looksLikeUuid ---

check(looksLikeUuid('00000000-0000-0000-0000-000000000000') === true, 'looksLikeUuid accepts a well-formed UUID');
check(looksLikeUuid('not-a-uuid') === false, 'looksLikeUuid rejects a non-UUID search term');
check(looksLikeUuid('andrew@example.com') === false, 'looksLikeUuid rejects an email address');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll admin metrics checks passed.');
}
