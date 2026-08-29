// Regression tests for the 2026-08-22 webhook provisioning-race fix —
// see services/twilioProvisioning.js's handleWebhookProvisioningDecision
// and routes/billing.js's webhook handler for the full history. Proves,
// with a fully mocked/stubbed Twilio client (no real API calls, no
// number ever purchased), that:
//   - the webhook's provisioning intent comes from the Stripe event's
//     own subscription status, never from a fresh getActiveEntitlement()
//     re-read (the exact race that left a real household's twilio_number
//     null after a successful subscription/entitlement sync);
//   - qualifying statuses (active/trialing/past_due) request provisioning
//     exactly once;
//   - non-qualifying statuses never purchase a number, and preserve the
//     existing mark-pending-release disable path;
//   - a household that already has a number is never purchased for
//     again (the provisioning layer's own idempotency);
//   - a missing household_id or missing household row fails safely,
//     without throwing, and logs clearly;
//   - a stale/out-of-order webhook event (migrations/027's
//     'ignored_stale' result) never triggers provisioning or
//     deprovisioning and never overrides the state an already-accepted
//     newer event established, in both orderings (a late "canceled"
//     after an accepted "active", and a late "active" after an accepted
//     "canceled").
//
// Run with: node tests/webhook-provisioning-decision.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const {
  isQualifyingSubscriptionStatus,
  handleWebhookProvisioningDecision,
  handleProcessedWebhookEvent,
} = require('../services/twilioProvisioning.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// A fake Twilio client shaped exactly like ensureTwilioNumberProvisioned's
// real usage (services/twilioProvisioning.js) — callable
// incomingPhoneNumbers with a .create() static, matching the real SDK's
// own shape. Counts .create() calls so a test can assert a real Twilio
// purchase was never attempted.
function makeFakeTwilioClient() {
  let createCalls = 0;
  const incomingPhoneNumbers = () => ({ remove: async () => {} });
  incomingPhoneNumbers.create = async params => {
    createCalls++;
    return { phoneNumber: params.phoneNumber, sid: 'PNfake00000000000000000000000000' };
  };
  return {
    client: {
      availablePhoneNumbers: () => ({
        local: { list: async () => [{ phoneNumber: '+441234567890' }] },
      }),
      incomingPhoneNumbers,
    },
    createCalls: () => createCalls,
  };
}

function makeSpyLog() {
  const calls = [];
  return { fn: (...args) => calls.push(args), calls };
}

// --- pure isQualifyingSubscriptionStatus ---

{
  check(isQualifyingSubscriptionStatus('active') === true, 'isQualifyingSubscriptionStatus: "active" qualifies');
  check(isQualifyingSubscriptionStatus('trialing') === true, 'isQualifyingSubscriptionStatus: "trialing" qualifies');
  check(isQualifyingSubscriptionStatus('past_due') === true, 'isQualifyingSubscriptionStatus: "past_due" qualifies');
  check(isQualifyingSubscriptionStatus('canceled') === false, 'isQualifyingSubscriptionStatus: "canceled" does not qualify');
  check(isQualifyingSubscriptionStatus('incomplete_expired') === false, 'isQualifyingSubscriptionStatus: "incomplete_expired" does not qualify');
  check(isQualifyingSubscriptionStatus(undefined) === false, 'isQualifyingSubscriptionStatus: undefined does not qualify');
}

// --- active subscription -> provisioning requested exactly once ---

{
  const fake = makeFakeTwilioClient();
  const assignCalls = [];
  const household = { id: 'hh-active', twilio_number: null, twilio_provisioning_attempts: 0 };
  const decision = makeSpyLog();
  const result = { calls: 0 };

  const outcome = await handleWebhookProvisioningDecision(
    { householdId: household.id, eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_active' },
    {
      getHouseholdByStripeCustomerId: async () => household,
      client: fake.client,
      assign: async (id, phoneNumber) => {
        assignCalls.push([id, phoneNumber]);
        return true;
      },
      cancelPendingRelease: async () => {},
      logDecision: decision.fn,
      logSkip: () => {},
    }
  );

  check(outcome.action === 'provision', 'active: outcome action is "provision"');
  check(outcome.success === true, 'active: provisioning reported success');
  check(fake.createCalls() === 1, 'active: Twilio incomingPhoneNumbers.create() called exactly once (mocked, no real purchase)');
  check(assignCalls.length === 1 && assignCalls[0][0] === 'hh-active', 'active: the purchased number was assigned to the correct household');
  check(decision.calls.length >= 1, 'active: a provisioning decision was logged');
}

// --- trialing subscription -> provisioning requested ---

{
  const fake = makeFakeTwilioClient();
  const household = { id: 'hh-trialing', twilio_number: null, twilio_provisioning_attempts: 0 };

  const outcome = await handleWebhookProvisioningDecision(
    { householdId: household.id, eventType: 'customer.subscription.created', subscriptionStatus: 'trialing', stripeCustomerId: 'cus_trialing' },
    {
      getHouseholdByStripeCustomerId: async () => household,
      client: fake.client,
      assign: async () => true,
      cancelPendingRelease: async () => {},
    }
  );

  check(outcome.action === 'provision', 'trialing: outcome action is "provision"');
  check(fake.createCalls() === 1, 'trialing: Twilio incomingPhoneNumbers.create() called exactly once (mocked)');
}

// --- canceled/inactive -> no new number purchase; existing disable path preserved ---

{
  const fake = makeFakeTwilioClient();
  const household = { id: 'hh-canceled', twilio_number: '+441111111111', twilio_provisioning_attempts: 0 };
  const markCalls = [];

  const outcome = await handleWebhookProvisioningDecision(
    { householdId: household.id, eventType: 'customer.subscription.deleted', subscriptionStatus: 'canceled', stripeCustomerId: 'cus_canceled' },
    {
      getHouseholdByStripeCustomerId: async () => household,
      client: fake.client,
      markPendingRelease: async (id, gracePeriodDays) => {
        markCalls.push([id, gracePeriodDays]);
        return true;
      },
    }
  );

  check(outcome.action === 'mark-pending-release', 'canceled: existing mark-pending-release disable path preserved');
  check(outcome.marked === true, 'canceled: pending release was recorded');
  check(fake.createCalls() === 0, 'canceled: Twilio incomingPhoneNumbers.create() never called — no number purchased');
  check(markCalls.length === 1 && markCalls[0][0] === 'hh-canceled', 'canceled: pending-release was marked for the correct household');
}

{
  // Canceled with no number ever provisioned — nothing to do, no purchase.
  const fake = makeFakeTwilioClient();
  const household = { id: 'hh-never-provisioned', twilio_number: null, twilio_provisioning_attempts: 0 };

  const outcome = await handleWebhookProvisioningDecision(
    { householdId: household.id, eventType: 'customer.subscription.deleted', subscriptionStatus: 'canceled', stripeCustomerId: 'cus_never' },
    { getHouseholdByStripeCustomerId: async () => household, client: fake.client }
  );

  check(outcome.action === 'none', 'canceled with no prior number: action is "none"');
  check(fake.createCalls() === 0, 'canceled with no prior number: Twilio incomingPhoneNumbers.create() never called');
}

// --- duplicate webhook / provisioning-layer idempotency: a household
// that already has a number is never purchased for again ---

{
  const fake = makeFakeTwilioClient();
  const assignCalls = [];
  const household = { id: 'hh-duplicate', twilio_number: null, twilio_provisioning_attempts: 0 };

  const deps = {
    getHouseholdByStripeCustomerId: async () => household,
    client: fake.client,
    assign: async (id, phoneNumber) => {
      assignCalls.push(phoneNumber);
      household.twilio_number = phoneNumber; // simulate the real DB write this triggers
      return true;
    },
    cancelPendingRelease: async () => {},
  };

  const first = await handleWebhookProvisioningDecision(
    { householdId: household.id, eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_dup' },
    deps
  );
  // A duplicate/redelivered webhook for the same still-active subscription —
  // household now already has a number, exactly as it would after the
  // first delivery's real DB write.
  const second = await handleWebhookProvisioningDecision(
    { householdId: household.id, eventType: 'customer.subscription.updated', subscriptionStatus: 'active', stripeCustomerId: 'cus_dup' },
    deps
  );

  check(first.action === 'provision' && first.success === true, 'duplicate webhook: first delivery provisions successfully');
  check(second.action === 'provision' && second.attempted === false, 'duplicate webhook: second delivery does not re-attempt provisioning (shouldAttemptProvisioning sees an existing number)');
  check(fake.createCalls() === 1, 'duplicate webhook: Twilio incomingPhoneNumbers.create() called exactly once across both deliveries, not twice');
}

// --- no household_id resolved -> fail safely, log clearly, never throw ---

{
  const skip = makeSpyLog();
  let lookupCalled = false;

  const outcome = await handleWebhookProvisioningDecision(
    { householdId: null, eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_orphan' },
    {
      getHouseholdByStripeCustomerId: async () => {
        lookupCalled = true;
        return null;
      },
      logSkip: skip.fn,
    }
  );

  check(outcome.action === 'skipped' && outcome.reason === 'no_household_id', 'no household_id: fails safely with a clear reason, does not throw');
  check(lookupCalled === false, 'no household_id: never even attempts a household lookup');
  check(skip.calls.length === 1, 'no household_id: exactly one clear skip log emitted');
}

// --- household_id present but no matching household row -> fail safely, log clearly ---

{
  const skip = makeSpyLog();
  const fake = makeFakeTwilioClient();

  const outcome = await handleWebhookProvisioningDecision(
    { householdId: 'hh-ghost', eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_ghost' },
    {
      getHouseholdByStripeCustomerId: async () => null,
      client: fake.client,
      logSkip: skip.fn,
    }
  );

  check(outcome.action === 'skipped' && outcome.reason === 'no_household_row', 'no matching household row: fails safely with a clear reason, does not throw');
  check(fake.createCalls() === 0, 'no matching household row: Twilio incomingPhoneNumbers.create() never called');
  check(skip.calls.length === 1, 'no matching household row: exactly one clear skip log emitted');
}

// --- THE regression: entitlement starts_at slightly ahead of Node time
// must not prevent a newly active subscription from reaching the
// (mocked) provisioning call. Modelled by never wiring an entitlement
// re-read into deps at all, and asserting a poisoned stand-in is never
// invoked — proving structurally that this decision no longer consults
// any timestamp-sensitive entitlement read, so the exact race that left
// household 816b3f10-217a-43f2-b242-e3f8ba44fd95's twilio_number null
// cannot recur here. ---

{
  const fake = makeFakeTwilioClient();
  const household = { id: 'hh-race', twilio_number: null, twilio_provisioning_attempts: 0 };
  let poisonedEntitlementReadCalls = 0;

  // Simulates getActiveEntitlement() as it would behave mid-race: the
  // entitlement row exists, but its database-generated starts_at is a
  // few hundred milliseconds ahead of this process's own clock, so a
  // fresh .lte("starts_at", now) read would (wrongly) find nothing yet.
  // handleWebhookProvisioningDecision must reach the mocked provisioning
  // call successfully WITHOUT ever calling this at all.
  const poisonedGetActiveEntitlement = async () => {
    poisonedEntitlementReadCalls++;
    const startsAtAheadOfNode = new Date(Date.now() + 500).toISOString(); // 500ms in the future
    const nodeNow = new Date().toISOString();
    return startsAtAheadOfNode <= nodeNow ? { status: 'active' } : null; // null: the race, reproduced
  };

  const outcome = await handleWebhookProvisioningDecision(
    { householdId: household.id, eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_race' },
    {
      getHouseholdByStripeCustomerId: async () => household,
      client: fake.client,
      assign: async () => true,
      cancelPendingRelease: async () => {},
      // Included specifically so we can prove it's dead code from this
      // function's perspective — never destructured, never called.
      getActiveEntitlement: poisonedGetActiveEntitlement,
    }
  );

  check(poisonedEntitlementReadCalls === 0, 'race regression: the timestamp-sensitive entitlement re-read is never invoked at all');
  check(outcome.action === 'provision' && outcome.success === true, 'race regression: an active subscription still reaches the mocked provisioning call and succeeds');
  check(fake.createCalls() === 1, 'race regression: Twilio incomingPhoneNumbers.create() called exactly once (mocked) despite the simulated race');
}

// --- out-of-order webhook regression: a stale event (migrations/027's
// 'ignored_stale' result) must never trigger provisioning/deprovisioning,
// and must never override the state an already-accepted newer event
// established. Both orderings, as requested. ---

{
  // Ordering 1: newer "active" accepted first, then an older "canceled"
  // event is delivered late and correctly identified as stale.
  const fake = makeFakeTwilioClient();
  const household = { id: 'hh-order-1', twilio_number: null, twilio_provisioning_attempts: 0 };
  const markCalls = [];

  const deps = {
    getHouseholdByStripeCustomerId: async () => household,
    client: fake.client,
    assign: async (id, phoneNumber) => {
      household.twilio_number = phoneNumber; // simulate the real DB write
      return true;
    },
    cancelPendingRelease: async () => {},
    markPendingRelease: async (id, gracePeriodDays) => {
      markCalls.push([id, gracePeriodDays]);
      return true;
    },
  };

  const accepted = await handleProcessedWebhookEvent(
    'processed',
    { householdId: household.id, eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_order_1' },
    deps
  );
  const stale = await handleProcessedWebhookEvent(
    'ignored_stale',
    { householdId: household.id, eventType: 'customer.subscription.deleted', subscriptionStatus: 'canceled', stripeCustomerId: 'cus_order_1' },
    deps
  );

  check(accepted.action === 'provision' && accepted.success === true, 'out-of-order (active then stale canceled): the accepted newer "active" event provisions');
  check(fake.createCalls() === 1, 'out-of-order (active then stale canceled): exactly one purchase from the accepted event');
  check(stale.action === 'skipped' && stale.reason === 'stale_event', 'out-of-order (active then stale canceled): the stale event is skipped, not acted on');
  check(markCalls.length === 0, 'out-of-order (active then stale canceled): the stale "canceled" event never marks the number for release');
  check(household.twilio_number === '+441234567890', 'out-of-order (active then stale canceled): the accepted event\'s provisioned number is left untouched by the stale event');
}

{
  // Ordering 2 ("vice versa"): newer "canceled" accepted first (number
  // marked for release), then an older "active" event is delivered late
  // and correctly identified as stale — must not resurrect the number.
  const fake = makeFakeTwilioClient();
  const household = { id: 'hh-order-2', twilio_number: '+441111111111', twilio_provisioning_attempts: 0 };
  const markCalls = [];

  const deps = {
    getHouseholdByStripeCustomerId: async () => household,
    client: fake.client,
    assign: async () => true,
    cancelPendingRelease: async () => {},
    markPendingRelease: async (id, gracePeriodDays) => {
      markCalls.push([id, gracePeriodDays]);
      return true;
    },
  };

  const accepted = await handleProcessedWebhookEvent(
    'processed',
    { householdId: household.id, eventType: 'customer.subscription.deleted', subscriptionStatus: 'canceled', stripeCustomerId: 'cus_order_2' },
    deps
  );
  const stale = await handleProcessedWebhookEvent(
    'ignored_stale',
    { householdId: household.id, eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_order_2' },
    deps
  );

  check(accepted.action === 'mark-pending-release' && accepted.marked === true, 'out-of-order (canceled then stale active): the accepted newer "canceled" event marks the number for release');
  check(markCalls.length === 1, 'out-of-order (canceled then stale active): exactly one mark-pending-release from the accepted event');
  check(stale.action === 'skipped' && stale.reason === 'stale_event', 'out-of-order (canceled then stale active): the stale "active" event is skipped, not acted on');
  check(fake.createCalls() === 0, 'out-of-order (canceled then stale active): the stale "active" event never triggers a purchase, never resurrects the number');
}

{
  // A genuinely 'failed' or otherwise-unrecognised result (routes/billing.js
  // handles 'failed' itself via a 500 response) must also never reach
  // provisioning if passed here — belt-and-braces on the gating function
  // itself, not just the two known outcomes.
  const fake = makeFakeTwilioClient();
  const household = { id: 'hh-unrecognised', twilio_number: null, twilio_provisioning_attempts: 0 };

  const outcome = await handleProcessedWebhookEvent(
    'failed',
    { householdId: household.id, eventType: 'customer.subscription.created', subscriptionStatus: 'active', stripeCustomerId: 'cus_unrecognised' },
    { getHouseholdByStripeCustomerId: async () => household, client: fake.client }
  );

  check(outcome.action === 'skipped' && outcome.reason === 'not_processed', 'unrecognised RPC result: skipped, not acted on');
  check(fake.createCalls() === 0, 'unrecognised RPC result: never triggers a purchase');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
