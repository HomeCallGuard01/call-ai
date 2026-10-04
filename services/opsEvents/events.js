// Operational events — model, keys and SAFE rendering (soft-launch
// integration 2026-10-04). Pure.
//
// One event, many deliveries: the event is the business fact (recorded
// exactly once by event_key); channels (dashboard, email, future admin-app
// push) render it from the same safe payload, so adding push later needs no
// change to lifecycle logic.
//
// Never in a payload or a rendered message: email address, telephone number
// (the HCG number is described by state only), payment/transaction ids,
// customer name. The HCG account number is the reference.
'use strict';

const TYPES = Object.freeze({
  NEW_GENUINE_CUSTOMER: 'new_genuine_customer',
  CUSTOMER_PROTECTED: 'customer_protected',
  CUSTOMER_NEEDS_ATTENTION: 'customer_needs_attention',
});
const SEVERITY = { new_genuine_customer: 'info', customer_protected: 'info', customer_needs_attention: 'action' };
const FORBIDDEN_PAYLOAD_KEYS = ['email', 'phone', 'phone_number', 'twilio_number', 'stripe_customer_id', 'external_reference', 'payment_id'];
const CHANNEL_LABEL = { web_stripe: 'Web (Stripe)', apple: 'Apple App Store', google: 'Google Play' };
// Launch sprint 2026-10-05 (Andrew: "particularly the first 5/10/25/50/100"):
// the Nth genuine customer to join. Every one of the first five is a
// milestone; after that 10, 25, 50, 100.
const GENUINE_MILESTONES = new Set([1, 2, 3, 4, 5, 10, 25, 50, 100]);
function isGenuineMilestone(ordinal) { return Number.isInteger(ordinal) && GENUINE_MILESTONES.has(ordinal); }

/** Exactly-once keys. NEEDS_ATTENTION is once per reason per episode. */
function eventKey(type, householdId, { reason = null, episode = null } = {}) {
  if (type === TYPES.CUSTOMER_NEEDS_ATTENTION) return `${type}:${householdId}:${reason || 'unknown'}:${episode || 'first'}`;
  return `${type}:${householdId}`;
}

function numberState(household) {
  if (!household || !household.twilio_number) return household && household.twilio_provisioning_status === 'failed' ? 'failed' : 'not_allocated';
  return household.twilio_provisioning_status === 'active' ? 'active' : String(household.twilio_provisioning_status || 'unknown');
}

/** Builds the (safe) event record. */
function buildEvent({ type, household, activation, commercial, planLabel = null, reason = null, episode = null, occurredAt }) {
  const payload = {
    joinedAt: household.created_at || null,
    channel: commercial ? commercial.channel : null,
    channelLabel: commercial && commercial.channel ? CHANNEL_LABEL[commercial.channel] || commercial.channel : null,
    plan: planLabel, // only when authoritative (e.g. the household's own Stripe Price); else null
    numberState: numberState(household),
    onboardingStage: activation ? activation.stage : null,
    protected: activation ? activation.protected === true : false,
    blockers: activation ? activation.blockers.slice(0, 9) : [],
    ...(reason ? { reason } : {}),
  };
  return {
    event_key: eventKey(type, household.id, { reason, episode }),
    event_type: type,
    household_id: household.id,
    account_number: household.account_number || null,
    severity: SEVERITY[type],
    payload,
    occurred_at: new Date(occurredAt).toISOString(),
  };
}

function assertSafe(event) {
  for (const k of FORBIDDEN_PAYLOAD_KEYS) if (event.payload && Object.prototype.hasOwnProperty.call(event.payload, k)) throw new Error(`unsafe ops event payload key: ${k}`);
  return event;
}

const TITLES = {
  new_genuine_customer: 'New genuine customer',
  customer_protected: 'Customer now protected',
  customer_needs_attention: 'Customer needs attention',
};

/** Plain-text rendering shared by every channel (subject + body). */
function renderMessage(event) {
  const p = event.payload || {};
  const ref = event.account_number || 'account number pending';
  const ordinal = Number.isInteger(p.genuineCustomerOrdinal) ? p.genuineCustomerOrdinal : null;
  const title = event.event_type === TYPES.NEW_GENUINE_CUSTOMER && ordinal
    ? `${isGenuineMilestone(ordinal) ? 'MILESTONE: ' : ''}genuine customer #${ordinal}`
    : TITLES[event.event_type] || event.event_type;
  const lines = [
    `${title}: ${ref}`,
    p.joinedAt ? `Joined: ${p.joinedAt}` : null,
    p.channelLabel ? `Channel: ${p.channelLabel}` : null,
    p.plan ? `Plan: ${p.plan}` : null,
    `HCG number: ${p.numberState || 'unknown'}`,
    `Onboarding: ${p.onboardingStage || 'unknown'}`,
    `Protected: ${p.protected ? 'yes' : 'no'}`,
    p.reason ? `Reason: ${p.reason}` : null,
    p.blockers && p.blockers.length && !p.protected ? `Outstanding: ${p.blockers.join(', ')}` : null,
    'Details: Admin Dashboard → Operations (no customer contact details are included in this message).',
  ].filter(Boolean);
  return { subject: `[HCG ops] ${title} — ${ref}`, text: lines.join('\n') };
}

module.exports = { GENUINE_MILESTONES, isGenuineMilestone, TYPES, SEVERITY, FORBIDDEN_PAYLOAD_KEYS, eventKey, buildEvent, assertSafe, renderMessage, numberState };
