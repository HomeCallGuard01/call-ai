// Pure detection of operational events from one household's lifecycle facts
// (soft-launch integration 2026-10-04). Uses the SAME canonical definitions
// as everything else: deriveActivationState (protection) and
// classifyCommercialStatus (genuine paying). Test, reviewer, internal,
// complimentary, Apple/Google sandbox (TestFlight / App Review), Stripe test
// and environment-unverified store grants NEVER produce a customer event.
'use strict';

const { deriveActivationState, STAGES } = require('../lifecycle/activationState');
const { classifyCommercialStatus } = require('../commercial/commercialStatus');
const { currentEntitlementOf, setupClockStartMs } = require('../lifecycle/exceptionQueue');
const { TYPES, buildEvent } = require('./events');

const DEFAULT_THRESHOLDS = Object.freeze({
  // The approved onboarding window is a DECISION (D-OPS1). 24 h matches the
  // existing SETUP_STALLED threshold and the admin onboarding monitor.
  onboardingWindowMs: 24 * 3600e3,
});

// Loss of protection that needs a human (not a customer still onboarding).
const LOSS_REASONS = Object.freeze({
  [STAGES.RECONNECT_NEEDED]: 'protection_lost_app_unreachable',
  [STAGES.ON_HOLD]: 'financial_hold',
  [STAGES.NUMBER_CONFLICT]: 'number_quarantined_while_entitled',
  [STAGES.AMBIGUOUS]: 'state_unreadable',
  [STAGES.NUMBER_FAILED]: 'number_provisioning_failed',
});

/**
 * @param {object} snapshot  database/lifecycleSnapshot.js shape (+ classification)
 * @param {Date|number} now
 * @returns {{ events: object[], commercial: object, activation: object }}
 */
function detectOpsEvents(snapshot, now, { thresholds = DEFAULT_THRESHOLDS, planLabel = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const household = snapshot.household;
  const activation = deriveActivationState(snapshot, now);
  const commercial = classifyCommercialStatus({ currentEntitlement: currentEntitlementOf(snapshot.entitlements, nowMs), classification: snapshot.classification || null });
  const events = [];
  if (!household || !commercial.genuinePaying) return { events, commercial, activation };

  const base = { household, activation, commercial, planLabel };
  events.push(buildEvent({ ...base, type: TYPES.NEW_GENUINE_CUSTOMER, occurredAt: nowMs }));
  if (activation.protected) events.push(buildEvent({ ...base, type: TYPES.CUSTOMER_PROTECTED, occurredAt: nowMs }));

  const lossReason = LOSS_REASONS[activation.stage];
  if (lossReason) {
    // One event per reason per episode: the episode is anchored on the fact
    // that changed (hold time / last delivery proof), else the calendar day.
    const anchor = (snapshot.financialHold && snapshot.financialHold.heldAt) || household.delivery_verified_at || new Date(nowMs).toISOString().slice(0, 10);
    events.push(buildEvent({ ...base, type: TYPES.CUSTOMER_NEEDS_ATTENTION, reason: lossReason, episode: String(anchor), occurredAt: nowMs }));
  } else if (activation.stage === STAGES.FORWARDING_UNCONFIRMED) {
    // LF-2 (2026-10-06): everything works except proof of the customer's own
    // forwarding — told immediately, with its own reason (support checks it).
    events.push(buildEvent({ ...base, type: TYPES.CUSTOMER_NEEDS_ATTENTION, reason: 'forwarding_not_proven', episode: String(household.twilio_number || 'number'), occurredAt: nowMs }));
  } else if (!activation.protected) {
    const clock = setupClockStartMs(snapshot);
    if (clock !== null && nowMs - clock > thresholds.onboardingWindowMs) {
      events.push(buildEvent({ ...base, type: TYPES.CUSTOMER_NEEDS_ATTENTION, reason: 'not_protected_within_onboarding_window', episode: new Date(clock).toISOString(), occurredAt: nowMs }));
    }
  }
  return { events, commercial, activation };
}

module.exports = { detectOpsEvents, DEFAULT_THRESHOLDS, LOSS_REASONS };
