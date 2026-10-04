// Stripe subscription events for a DELETED (anonymised) household — lifecycle
// finding F-03, fixed in the soft-launch integration (2026-10-04).
//
// Account deletion (migration 029 anonymize_inactive_household) refuses to run
// while any entitlement is active, then nulls households.stripe_customer_id.
// The subscription.deleted that Stripe sends afterwards could never succeed:
// process_stripe_webhook_event (070) raises on the customer mismatch, the
// event is marked failed, the route returns 500, and Stripe retries for days
// (with a critical alert every time).
//
// Rule: an event for an anonymised household is recorded as `ignored` (with
// the reason) and acknowledged with 200. It NEVER reaches the entitlement RPC,
// so it can never re-entitle a deleted account (security preserved). Replay is
// idempotent through the existing claim (ignored is terminal).
// A deleted household whose Stripe subscription is still LIVE (created/updated
// with trialing/active/past_due) may still be paying: that is alerted and kept
// visible in the operational exception queue, not silently dropped.
'use strict';

const { isDeletedHousehold } = require('./lifecycle/activationState');

const LIVE_STATUSES = new Set(['trialing', 'active', 'past_due']);
const REASON_DELETED = 'ignored:deleted_household';
const REASON_DELETED_LIVE = 'ignored:deleted_household_subscription_live';

/**
 * @param {{ household: object|null, eventType: string, subscriptionStatus: string }} input
 * @returns {null | { reason: string, alert: boolean }}  null = process normally
 */
function decideDeletedHouseholdEvent({ household, eventType, subscriptionStatus }) {
  if (!household) return null;
  if (!isDeletedHousehold(household) || household.stripe_customer_id) return null;
  const live = eventType !== 'customer.subscription.deleted' && LIVE_STATUSES.has(subscriptionStatus);
  return { reason: live ? REASON_DELETED_LIVE : REASON_DELETED, alert: live };
}

module.exports = { decideDeletedHouseholdEvent, REASON_DELETED, REASON_DELETED_LIVE };
