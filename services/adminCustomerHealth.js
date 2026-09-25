// Admin control centre (2026-09-25) — the single "is this customer OK?"
// answer shown on the Admin Dashboard's Customers tab. Pure and directly
// unit-testable (tests/admin-customer-health.test.mjs): no database, no
// Express, `now` is always passed in. Read-only interpretation for an
// administrator; it never writes anything and never changes what a
// customer sees.
//
// Builds on services/adminOnboardingStatus.js's deriveAdminCustomerState
// (unchanged) and collapses it, plus real call-delivery evidence, into
// four admin-facing health values:
//
//   healthy          — Protected (customer-facing definition, unchanged:
//                      computeProtectionStatus().fullyProtected) and no
//                      delivery failure observed since the last success.
//   setup_incomplete — membership active, not yet protected, nothing
//                      observed going wrong and still inside the 24h
//                      window (or forwarding confirmed and simply waiting
//                      for a first delivered call).
//   needs_attention  — real evidence something is wrong: provisioning
//                      problem, setup overdue (24h+ with no forwarded
//                      call), calls reaching HCG with no registered app,
//                      a genuine delivery failure since the last success,
//                      or setup incomplete with no network/device on file.
//   inactive         — no current membership.
//
// Deliberately NEVER a reason on its own:
//   - no calls recently (silence is missing information, not a fault);
//   - Twilio "no-answer" / "busy" / "canceled" (unanswered, declined, or
//     the caller hung up — normal outcomes) unless the phone itself
//     reported it never received the call;
//   - no CallInvite record from an app that predates CallInvite
//     reporting (app_version and CallInvite reporting ship in the same
//     app release — migration 045 — so a household with no reported
//     app_version cannot report invites either);
//   - network/device not recorded for an already-protected customer.

'use strict';

const { deriveAdminCustomerState, parseTimestampMs, ADMIN_STATES } = require('./adminOnboardingStatus');

const HEALTH = {
  HEALTHY: 'healthy',
  SETUP_INCOMPLETE: 'setup_incomplete',
  NEEDS_ATTENTION: 'needs_attention',
  INACTIVE: 'inactive',
};

// Display names only — carrier policy itself (services/providerPolicy.js)
// is not read or changed here. Unknown keys fall back to the raw key.
const PROVIDER_DISPLAY_NAMES = {
  o2: 'O2',
  vodafone: 'Vodafone',
  giffgaff: 'giffgaff',
  ee: 'EE',
  three: 'Three',
  sky: 'Sky',
  smarty: 'SMARTY',
  id_mobile: 'iD Mobile',
  talkmobile: 'Talkmobile',
  tesco: 'Tesco Mobile',
  '1pmobile': '1pMobile',
  lyca: 'Lyca Mobile',
  voxi: 'VOXI',
  lebara: 'Lebara',
  asda: 'Asda Mobile',
  other: 'Other network',
  bt: 'BT',
  virgin: 'Virgin Media',
  talktalk: 'TalkTalk',
  plusnet: 'Plusnet',
};

const DEVICE_DISPLAY_NAMES = { mobile: 'Android', iphone: 'iPhone', landline: 'Landline' };

const TEST_CLASSIFICATION_LABELS = {
  internal_test: 'Test',
  admin: 'Admin',
  reviewer: 'Reviewer',
  qa_automation: 'QA',
};

const PAID_ENTITLEMENT_TYPES = new Set(['paid_subscription']);
const TRIAL_ENTITLEMENT_TYPES = new Set(['free_trial']);

function providerDisplayName(key) {
  if (!key) return null;
  return PROVIDER_DISPLAY_NAMES[String(key).toLowerCase()] || String(key);
}

// Pure — "paying / complimentary / trial" from the entitlement itself,
// plus a separate test/reviewer/admin/QA label from account
// classification. A complimentary test account is BOTH (e.g.
// "Complimentary" + "Reviewer"): revenue figures elsewhere keep
// excluding it, but it stays fully visible here.
function describeAccount({ currentEntitlement, latestEntitlement, classification }) {
  const testLabel = TEST_CLASSIFICATION_LABELS[classification] || null;

  if (!currentEntitlement) {
    return {
      kind: latestEntitlement ? 'ended' : 'none',
      label: latestEntitlement ? 'Membership ended' : 'No membership',
      until: null,
      testLabel,
    };
  }

  const type = currentEntitlement.entitlement_type;
  let kind = 'complimentary';
  let label = 'Complimentary';
  if (PAID_ENTITLEMENT_TYPES.has(type)) {
    kind = 'paying';
    label = 'Paying';
  } else if (TRIAL_ENTITLEMENT_TYPES.has(type)) {
    kind = 'trial';
    label = 'Trial';
  }

  return { kind, label, until: currentEntitlement.ends_at || null, testLabel };
}

// Pure — interprets the household's most recent ATTEMPTED delivery
// (calls.dial_call_status set — migration 044) against its last
// confirmed successful delivery (households.delivery_verified_at).
// Returns labels for display plus `failure` (a genuine, observed
// delivery problem newer than the last success) — see the file header
// for what never counts as one.
function describeDeliveryEvidence(lastDial, household) {
  if (!lastDial || !lastDial.dial_call_status) {
    return { attempted: false, failure: null, twilioLabel: null, phoneLabel: null, at: null };
  }

  const status = lastDial.dial_call_status;
  const telemetryCapable = !!(household && household.app_version);
  const inviteReceived = !!lastDial.client_invite_received_at;
  const outcome = lastDial.client_outcome || null;

  const twilioLabels = {
    completed: 'Connected',
    'no-answer': 'No answer',
    busy: 'Busy / declined',
    failed: 'Failed',
    canceled: 'Caller hung up',
  };
  const twilioLabel = twilioLabels[status] || status;

  let phoneLabel;
  if (!telemetryCapable) {
    phoneLabel = 'Not reported (older app)';
  } else if (!inviteReceived) {
    phoneLabel = 'Call never reached phone';
  } else if (outcome) {
    phoneLabel = { accepted: 'Answered', rejected: 'Declined', cancelled: 'Caller hung up' }[outcome] || outcome;
  } else {
    phoneLabel = 'Rang, no outcome reported';
  }

  const dialMs = parseTimestampMs(lastDial.created_at);
  const deliveredMs = parseTimestampMs(household && household.delivery_verified_at);
  const supersededBySuccess = deliveredMs !== null && dialMs !== null && deliveredMs >= dialMs;

  let failure = null;
  if (status !== 'completed' && !supersededBySuccess) {
    if (status === 'failed') {
      failure = 'Last call could not be delivered to the app (Twilio: failed)';
    } else if (telemetryCapable && !inviteReceived && status !== 'canceled') {
      failure = 'Last call never reached the customer’s phone';
    }
  }

  return { attempted: true, failure, twilioLabel, phoneLabel, at: lastDial.created_at || null, status };
}

// Pure — the most recent confirmed-working evidence, strongest first: a
// delivered call proves the whole path; a forwarded call proves only the
// inbound leg.
function describeLastConfirmed(household) {
  if (household.delivery_verified_at) return { kind: 'delivered', at: household.delivery_verified_at };
  if (household.activation_verified_at) return { kind: 'forwarding_only', at: household.activation_verified_at };
  return { kind: 'none', at: null };
}

function describeSetup(derived) {
  if (!derived.hasCurrentEntitlement) return { label: '—', complete: false };
  if (derived.protection.fullyProtected) return { label: 'Complete', complete: true };
  if (derived.state === ADMIN_STATES.PROVISIONING_PROBLEM) return { label: 'No HCG number', complete: false };
  if (derived.forwardingProven) {
    return derived.protection.deliveryReady
      ? { label: 'Forwarding on · awaiting first delivered call', complete: false }
      : { label: 'Forwarding on · app not registered', complete: false };
  }
  if (derived.state === ADMIN_STATES.NEEDS_ATTENTION) return { label: 'Forwarding not confirmed (overdue)', complete: false };
  return { label: 'Forwarding not confirmed yet', complete: false };
}

// Pure — the one health answer for a customer row.
function deriveCustomerHealth({ household, entitlements, lastCallAt, lastDial, classification }, now) {
  const derived = deriveAdminCustomerState({ household, entitlements, lastCallAt }, now);
  const delivery = describeDeliveryEvidence(lastDial, household);
  const account = describeAccount({
    currentEntitlement: derived.currentEntitlement,
    latestEntitlement: derived.latestEntitlement,
    classification,
  });
  const networkMissing = !household.carrier_provider_key;
  const deviceMissing = !household.device_type;
  const missingInfo = [networkMissing ? 'network' : null, deviceMissing ? 'device' : null].filter(Boolean);

  let health;
  let reason;

  if (derived.state === ADMIN_STATES.INACTIVE) {
    health = HEALTH.INACTIVE;
    reason = derived.reason;
  } else if (derived.state === ADMIN_STATES.PROVISIONING_PROBLEM || derived.state === ADMIN_STATES.NEEDS_ATTENTION) {
    health = HEALTH.NEEDS_ATTENTION;
    reason = derived.reason;
  } else if (delivery.failure) {
    health = HEALTH.NEEDS_ATTENTION;
    reason = delivery.failure;
  } else if (derived.state === ADMIN_STATES.PROTECTED) {
    health = HEALTH.HEALTHY;
    reason = 'Protected — forwarding and call delivery proven';
  } else if (missingInfo.length > 0) {
    health = HEALTH.NEEDS_ATTENTION;
    reason = `Setup incomplete and ${missingInfo.join(' and ')} not recorded — can't confirm the right forwarding steps`;
  } else {
    health = HEALTH.SETUP_INCOMPLETE;
    reason = derived.reason;
  }

  return {
    health,
    reason,
    derived,
    delivery,
    account,
    setup: describeSetup(derived),
    lastConfirmed: describeLastConfirmed(household),
    network: providerDisplayName(household.carrier_provider_key),
    device: household.device_type ? DEVICE_DISPLAY_NAMES[household.device_type] || household.device_type : null,
    app: household.app_version
      ? { version: household.app_version, build: household.app_build_version || null, platform: household.app_platform || null }
      : null,
  };
}

function summariseCustomerHealth(rows) {
  const counts = { customers: 0, healthy: 0, needs_attention: 0, setup_incomplete: 0, inactive: 0, paying: 0, complimentary: 0, trial: 0, test: 0 };
  for (const r of rows || []) {
    if (r.health === HEALTH.INACTIVE) {
      counts.inactive += 1;
      continue;
    }
    counts.customers += 1;
    if (counts[r.health] !== undefined) counts[r.health] += 1;
    if (r.account && counts[r.account.kind] !== undefined) counts[r.account.kind] += 1;
    if (r.account && r.account.testLabel) counts.test += 1;
  }
  return counts;
}

module.exports = {
  HEALTH,
  PROVIDER_DISPLAY_NAMES,
  providerDisplayName,
  describeAccount,
  describeDeliveryEvidence,
  describeLastConfirmed,
  deriveCustomerHealth,
  summariseCustomerHealth,
};
