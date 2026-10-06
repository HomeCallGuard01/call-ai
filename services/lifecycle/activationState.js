// Customer activation state machine — the ONE definition of "is this
// customer protected?" (customer lifecycle automation, 2026-10-04).
//
// Why this exists: "protected" was decided in several places from partial
// evidence (docs/operations/CUSTOMER_LIFECYCLE_AUTOMATION.md §4).
// services/callRouting.js's computeProtectionStatus looks only at the three
// delivery timestamps, so a household on a Fortress financial hold, one whose
// number has been quarantined, or one whose forwarding evidence belongs to a
// PREVIOUS number all still read "fullyProtected". The mobile Account tab uses
// a fourth, weaker rule (forwarding OR delivery).
//
// Rule this module makes structural: `protected` is true only when EVERY gate
// in PROTECTION_GATES is satisfied — one successful onboarding step (payment,
// a number, a forwarded call, an app registration) can never be enough on its
// own. `protected` is computed as `PROTECTION_GATES.every(...)`, never set by a
// branch, and tests/lifecycle-activation-state.test.mjs checks all 2^n gate
// combinations.
//
// Pure: no database, provider or clock reads. Composes, never duplicates:
//   - services/numberLifecycle/state.js deriveHouseholdLifecycle — the
//     canonical entitlement/number state (mirrors migration 047's SQL);
//   - services/callRouting.js hasVoiceClientRegistrationHistory semantics
//     (via computeProtectionStatus) for app registration/reachability.
// Fail closed: anything unreadable (entitlement status, hold table) makes the
// stage AMBIGUOUS and `protected` false; it is never guessed.
//
// NOT WIRED into any customer-facing response yet. The integration step (and
// why it is a decision) is in the doc §5.
'use strict';

const { deriveHouseholdLifecycle, parseTimestampMs } = require('../numberLifecycle/state');
const { computeProtectionStatus } = require('../callRouting');

const STAGES = Object.freeze({
  ACCOUNT_DELETED: 'account_deleted',
  AMBIGUOUS: 'ambiguous',
  SIGNED_UP: 'signed_up', // account exists, never had a membership
  MEMBERSHIP_UPCOMING: 'membership_upcoming',
  ON_HOLD: 'on_hold', // Fortress per-household financial hold
  NUMBER_FAILED: 'number_failed',
  AWAITING_NUMBER: 'awaiting_number',
  NUMBER_CONFLICT: 'number_conflict', // entitled, but its live number is in quarantine
  AWAITING_FORWARDING: 'awaiting_forwarding',
  AWAITING_APP: 'awaiting_app',
  AWAITING_FIRST_DELIVERY: 'awaiting_first_delivery',
  // LF-2 (2026-10-06): calls reach HCG and are delivered to the app, but the
  // customer's own phone forwarding is NOT proven (an ordinary inbound call —
  // even a direct dial or a stray call — cannot prove it). Never "protected".
  FORWARDING_UNCONFIRMED: 'forwarding_unconfirmed',
  RECONNECT_NEEDED: 'reconnect_needed', // delivery worked before; app now unreachable
  PROTECTED: 'protected',
  MEMBERSHIP_ENDED: 'membership_ended', // had a membership; none in effect now
});

// Customer-journey order (for "furthest stage reached" and docs). ON_HOLD,
// NUMBER_CONFLICT, AMBIGUOUS and ACCOUNT_DELETED are off the happy path.
const HAPPY_PATH = Object.freeze([
  STAGES.SIGNED_UP,
  STAGES.MEMBERSHIP_UPCOMING,
  STAGES.AWAITING_NUMBER,
  STAGES.AWAITING_FORWARDING,
  STAGES.AWAITING_APP,
  STAGES.AWAITING_FIRST_DELIVERY,
  STAGES.FORWARDING_UNCONFIRMED,
  STAGES.PROTECTED,
]);

// Every gate must hold for `protected`. Order = the order blockers are
// reported in (first blocker = what to fix first).
const PROTECTION_GATES = Object.freeze([
  'accountActive',
  'stateKnown',
  'entitledNow',
  'notOnHold',
  'numberActive',
  'numberNotQuarantined',
  'forwardingVerifiedForCurrentNumber',
  'appReachable',
  'deliveryVerifiedForCurrentNumber',
]);

const PAST_DUE_STATUSES = new Set(['past_due', 'unpaid']);

function isDeletedHousehold(household) {
  if (!household) return false;
  // migration 029 anonymize_inactive_household: status 'cancelled', auth user
  // detached, email rewritten to the internal deleted domain.
  const anonymisedEmail = typeof household.email === 'string' && /@deleted\.homecallguard\.internal$/i.test(household.email);
  return household.status === 'cancelled' && (anonymisedEmail || household.auth_user_id === null);
}

// Financial hold input:
//   undefined          → the Fortress hold table is not deployed here; the
//                        gate passes but `evidence.holdChecked` is false;
//   { unreadable }     → fail closed (AMBIGUOUS);
//   { held, source, reason, heldAt } → as recorded in fc_household_holds.
function holdState(financialHold) {
  if (financialHold === undefined) return { checked: false, held: false, unreadable: false };
  if (financialHold === null) return { checked: true, held: false, unreadable: false };
  if (financialHold.unreadable) return { checked: true, held: false, unreadable: true };
  return { checked: true, held: !!financialHold.held, unreadable: false, source: financialHold.source || null, heldAt: financialHold.heldAt || null };
}

// Evidence older than the moment the CURRENT number became active belongs to
// a previous number (re-provisioning after quarantine/release): the
// customer's carrier may still be diverting to the old one. Unknown
// assignment time ⇒ cannot prove staleness ⇒ evidence accepted (and
// `evidence.numberAssignedAtKnown` says so).
function evidenceForCurrentNumber(evidenceAt, assignedAtMs) {
  const ms = parseTimestampMs(evidenceAt);
  if (ms === null) return false;
  if (assignedAtMs === null) return true;
  return ms >= assignedAtMs;
}

function billingStanding({ lifecycle, subscription }) {
  if (lifecycle.membership === 'ambiguous') return 'ambiguous';
  if (lifecycle.membership === 'none') return 'none';
  if (lifecycle.membership === 'upcoming') return 'upcoming';
  const ent = lifecycle.currentEntitlement || {};
  if (ent.source === 'stripe' && subscription) {
    if (PAST_DUE_STATUSES.has(subscription.status)) return 'payment_issue';
    if (subscription.cancel_at_period_end) return 'cancelling';
  }
  if (['complimentary', 'staff', 'partner', 'promotion', 'founding_offer'].includes(ent.entitlement_type)) return 'complimentary';
  if (ent.entitlement_type === 'free_trial') return 'trial';
  return 'active';
}

/**
 * The canonical activation state for one household. Pure.
 * @param {object} input
 * @param {object} input.household           households row
 * @param {object[]} input.entitlements      all entitlements rows for it
 * @param {object} [input.subscription]      newest subscriptions row (Stripe)
 * @param {object[]} [input.quarantineRows]  twilio_number_quarantine rows
 * @param {object} [input.deliveryHealth]    getHouseholdDeliveryHealth() result
 * @param {object} [input.financialHold]     see holdState()
 * @param {string} [input.currentNumberAssignedAt] when the current number became active
 *                 (routing_assignments.state_changed_at of the active primary row)
 * @param {Date|number} now
 */
function deriveActivationState(input, now) {
  const { household, entitlements = [], subscription = null, quarantineRows = [], deliveryHealth = null, financialHold, currentNumberAssignedAt = null } = input || {};
  const lifecycle = deriveHouseholdLifecycle({ household, entitlements, quarantineRows }, now);
  const hold = holdState(financialHold);
  const delivery = computeProtectionStatus(household || {}, now, deliveryHealth);
  const assignedAtMs = parseTimestampMs(currentNumberAssignedAt);
  const number = household ? household.twilio_number || null : null;
  const liveQuarantine = (quarantineRows || []).filter((q) => !q.released_at);
  const currentNumberQuarantined = !!number && liveQuarantine.some((q) => q.twilio_number === number);
  const knownUnreachable = !!(deliveryHealth && deliveryHealth.state === 'UNREACHABLE');

  // LF-2 (2026-10-06): forwarding is proven ONLY by forwarding_proven_at
  // (migration 074) — never by activation_verified_at, which any inbound call
  // to the HCG number stamps (direct dials and stray calls included). Absent
  // column (074 not applied) ⇒ undefined ⇒ not proven.
  const forwardingCurrent = evidenceForCurrentNumber(household && household.forwarding_proven_at, assignedAtMs);
  // "A call reached the HCG number" (evidence only; drives wording, not protection).
  const callsReachHcgCurrent = evidenceForCurrentNumber(household && household.activation_verified_at, assignedAtMs);
  const deliveryCurrent = evidenceForCurrentNumber(household && household.delivery_verified_at, assignedAtMs);
  const deliveryEver = !!(household && household.delivery_verified_at);
  const staleEvidence = assignedAtMs !== null && (
    (!!(household && household.activation_verified_at) && !callsReachHcgCurrent)
    || (!!(household && household.forwarding_proven_at) && !forwardingCurrent)
    || (deliveryEver && !deliveryCurrent)
  );

  const gates = {
    accountActive: !!household && !isDeletedHousehold(household),
    stateKnown: lifecycle.membership !== 'ambiguous' && !hold.unreadable,
    entitledNow: lifecycle.membership === 'current',
    notOnHold: !hold.held,
    numberActive: !!number && household.twilio_provisioning_status === 'active',
    numberNotQuarantined: !currentNumberQuarantined,
    forwardingVerifiedForCurrentNumber: forwardingCurrent,
    appReachable: delivery.deliveryReady,
    deliveryVerifiedForCurrentNumber: deliveryCurrent,
  };
  const blockers = PROTECTION_GATES.filter((g) => !gates[g]);
  const isProtected = PROTECTION_GATES.every((g) => gates[g] === true);

  let stage;
  if (!gates.accountActive) stage = STAGES.ACCOUNT_DELETED;
  else if (!gates.stateKnown) stage = STAGES.AMBIGUOUS;
  else if (lifecycle.membership === 'upcoming') stage = STAGES.MEMBERSHIP_UPCOMING;
  else if (lifecycle.membership === 'none') stage = entitlements.length > 0 ? STAGES.MEMBERSHIP_ENDED : STAGES.SIGNED_UP;
  else if (!gates.notOnHold) stage = STAGES.ON_HOLD;
  else if (household.twilio_provisioning_status === 'failed' && !number) stage = STAGES.NUMBER_FAILED;
  else if (!gates.numberActive) stage = STAGES.AWAITING_NUMBER;
  else if (!gates.numberNotQuarantined) stage = STAGES.NUMBER_CONFLICT;
  // No proof AND no sign of calls arriving yet: forwarding still to be set up.
  else if (!gates.forwardingVerifiedForCurrentNumber && !callsReachHcgCurrent && !gates.deliveryVerifiedForCurrentNumber) stage = STAGES.AWAITING_FORWARDING;
  else if (!gates.appReachable) stage = deliveryEver && !staleEvidence ? STAGES.RECONNECT_NEEDED : STAGES.AWAITING_APP;
  else if (!gates.deliveryVerifiedForCurrentNumber) stage = STAGES.AWAITING_FIRST_DELIVERY;
  // LF-2: calls arrive and are delivered, but the customer's forwarding is not
  // proven — truthful "not yet confirmed", never protected.
  else if (!gates.forwardingVerifiedForCurrentNumber) stage = STAGES.FORWARDING_UNCONFIRMED;
  else stage = STAGES.PROTECTED;

  // Invariant, asserted rather than assumed: the stage label and the gate
  // conjunction can never disagree.
  if ((stage === STAGES.PROTECTED) !== isProtected) {
    throw new Error(`activationState invariant violated: stage=${stage} protected=${isProtected}`);
  }

  const standing = billingStanding({ lifecycle, subscription });
  const attention = [];
  if (standing === 'payment_issue') attention.push('payment_issue');
  if (standing === 'cancelling') attention.push('cancelling');
  if (staleEvidence) attention.push('evidence_predates_current_number');
  if (deliveryHealth && deliveryHealth.state === 'SUSPECT') attention.push('delivery_suspect');
  if (knownUnreachable) attention.push('delivery_unreachable');
  if (!hold.checked) attention.push('hold_not_checked');

  return {
    stage,
    protected: isProtected,
    blockers,
    gates,
    attention,
    billingStanding: standing,
    // Whether paid AI screening of unknown callers can run (entitled, not
    // held). Distinct from `protected`: delivery may still be unproven.
    screeningEligible: gates.accountActive && gates.stateKnown && gates.entitledNow && gates.notOnHold,
    // Whether a forwarded call still reaches HCG at all. True after a
    // membership ends until the number leaves the household (server.js
    // dials the household regardless of entitlement) — the window the
    // "service ending" message must cover.
    callsStillReachHcg: !!number,
    numberLifecycle: { state: lifecycle.numberState, membership: lifecycle.membership, anomalies: lifecycle.anomalies, releaseEligibleNow: lifecycle.releaseEligibleNow },
    evidence: {
      holdChecked: hold.checked,
      held: hold.held,
      holdSource: hold.source || null,
      numberAssignedAtKnown: assignedAtMs !== null,
      deliveryHealthChecked: !!deliveryHealth,
      activationVerifiedAt: (household && household.activation_verified_at) || null,
      // LF-2: "a call reached the HCG number" (evidence) vs genuine forwarding proof.
      callsReachHcg: callsReachHcgCurrent,
      forwardingProvenAt: (household && household.forwarding_proven_at) || null,
      deliveryVerifiedAt: (household && household.delivery_verified_at) || null,
      voiceClientRegisteredAt: (household && household.voice_client_registered_at) || null,
    },
  };
}

// Between two snapshots of the same household: name what happened and say
// whether it needs a human. Losing protection is always attention-worthy.
function classifyTransition(prev, next) {
  if (!prev || !next) return { event: 'initial', regression: false };
  if (prev.stage === next.stage) return { event: 'unchanged', regression: false };
  if (prev.protected && !next.protected) return { event: 'protection_lost', regression: true, cause: next.blockers[0] || null, to: next.stage };
  if (!prev.protected && next.protected) return { event: 'protection_achieved', regression: false };
  const pi = HAPPY_PATH.indexOf(prev.stage);
  const ni = HAPPY_PATH.indexOf(next.stage);
  if (pi !== -1 && ni !== -1) return ni > pi ? { event: 'progressed', regression: false } : { event: 'went_backwards', regression: true, to: next.stage };
  return { event: `entered_${next.stage}`, regression: [STAGES.ON_HOLD, STAGES.NUMBER_CONFLICT, STAGES.AMBIGUOUS].includes(next.stage), to: next.stage };
}

module.exports = {
  STAGES,
  HAPPY_PATH,
  PROTECTION_GATES,
  isDeletedHousehold,
  deriveActivationState,
  classifyTransition,
};
