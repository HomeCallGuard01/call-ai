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
  computeKpiSummary,
  mergeCustomerActivity,
  mergeAlerts,
  looksLikeUuid,
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

// --- computeKpiSummary ---

const kpiWithPrice = computeKpiSummary({
  customerCount: 10,
  totalCalls: 200,
  blockedCalls: 15,
  activeEntitlements: 7,
  failedProvisioning: 2,
  price: { unitAmount: 999, currency: 'gbp' },
});

check(kpiWithPrice.customers === 10, 'customers KPI passes through the raw count');
check(kpiWithPrice.protectedCalls === 200, 'protectedCalls KPI passes through the raw count');
check(kpiWithPrice.blockedCalls === 15, 'blockedCalls KPI passes through the raw count');
check(kpiWithPrice.activeSubscriptions === 7, 'activeSubscriptions KPI passes through the raw count');
check(kpiWithPrice.failedProvisioning === 2, 'failedProvisioning KPI passes through the raw count');
check(kpiWithPrice.revenue.available === true, 'revenue is marked available when a Stripe price was fetched');
check(kpiWithPrice.revenue.amount === 69.93, 'revenue is active subscriptions × unit price, in major currency units (7 × £9.99)');
check(kpiWithPrice.revenue.currency === 'gbp', 'revenue currency comes from the Stripe price');

const kpiWithoutPrice = computeKpiSummary({
  customerCount: 3,
  totalCalls: 10,
  blockedCalls: 1,
  activeEntitlements: 2,
  failedProvisioning: 0,
  price: null,
});

check(kpiWithoutPrice.revenue.available === false, 'revenue is marked unavailable rather than invented when no Stripe price could be fetched');
check(kpiWithoutPrice.revenue.amount === null, 'revenue amount is null, not a fabricated number, when unavailable');

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
