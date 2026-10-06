// Adversarial coverage for services/lifecycle/activationState.js — the one
// definition of "this customer is protected" (customer lifecycle automation,
// 2026-10-04).
//
// The property under test: NO customer is protected merely because one (or
// several, but not all) parts of onboarding succeeded. Thirteen independent
// ways a household can be incomplete or broken are toggled in every one of
// the 2^13 = 8,192 combinations; `protected` must be true for exactly one of
// them (nothing wrong) and the stage label must always agree.
//
// Run with: node tests/lifecycle-activation-state.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { deriveActivationState, classifyTransition, STAGES, PROTECTION_GATES, HAPPY_PATH } = require('../services/lifecycle/activationState');
const { computeProtectionStatus } = require('../services/callRouting');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const NOW = new Date('2026-10-04T12:00:00Z');
const HH = '11111111-2222-4333-8444-555555555555';
const NUMBER = '+441632960001';

const TOGGLES = [
  'deleted', 'ambiguousEntitlement', 'holdUnreadable', 'noEntitlement', 'held', 'noNumber', 'provisioningPending',
  'quarantined', 'noForwarding', 'noRegistration', 'unreachable', 'noDelivery', 'staleEvidence',
];

function snapshot(t = {}) {
  const household = {
    id: HH,
    status: 'active',
    email: 'customer@example.com',
    auth_user_id: 'auth-1',
    account_number: 'HCG-00010017',
    twilio_number: NUMBER,
    twilio_provisioning_status: 'active',
    twilio_number_pending_release_at: null,
    activation_verified_at: '2026-10-02T10:00:00Z',
    // LF-2 (2026-10-06): genuine forwarding proof (migration 074) — the ONLY
    // forwarding input to `protected`. activation_verified_at above now only
    // means "a call reached the HCG number".
    forwarding_proven_at: '2026-10-02T10:00:00Z',
    voice_client_registered_at: '2026-10-04T08:00:00Z',
    delivery_verified_at: '2026-10-02T10:05:00Z',
  };
  let entitlements = [{ id: 'e1', household_id: HH, entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-10-01T00:00:00Z', ends_at: null }];
  let financialHold = null;
  let quarantineRows = [];
  let deliveryHealth = { state: 'HEALTHY' };
  let currentNumberAssignedAt = '2026-10-01T00:10:00Z';
  if (t.deleted) Object.assign(household, { status: 'cancelled', email: `anonymized-${HH}@deleted.homecallguard.internal`, auth_user_id: null });
  if (t.noEntitlement) entitlements = [{ ...entitlements[0], status: 'expired', ends_at: '2026-10-03T00:00:00Z' }];
  if (t.ambiguousEntitlement) entitlements = [...entitlements, { id: 'e2', household_id: HH, entitlement_type: 'paid_subscription', status: 'paused_unknown', starts_at: '2026-09-01T00:00:00Z', ends_at: null }];
  if (t.held) financialHold = { held: true, source: 'financial', reason: 'auto hold', heldAt: '2026-10-04T09:00:00Z' };
  if (t.holdUnreadable) financialHold = { unreadable: true };
  if (t.noNumber) household.twilio_number = null;
  if (t.provisioningPending) household.twilio_provisioning_status = 'pending';
  if (t.quarantined) quarantineRows = [{ id: 'q1', household_id: HH, twilio_number: NUMBER, quarantined_at: '2026-10-03T00:00:00Z', released_at: null, deactivation_confirmed: false }];
  if (t.noForwarding) household.forwarding_proven_at = null;
  if (t.noCallsReachHcg) household.activation_verified_at = null;
  if (t.noRegistration) household.voice_client_registered_at = null;
  if (t.unreachable) deliveryHealth = { state: 'UNREACHABLE' };
  if (t.noDelivery) household.delivery_verified_at = null;
  if (t.staleEvidence) currentNumberAssignedAt = '2026-10-03T00:00:00Z';
  return { household, entitlements, financialHold, quarantineRows, deliveryHealth, currentNumberAssignedAt, subscription: null };
}

// ---------------------------------------------------------------
// Baseline: everything done ⇒ protected.
// ---------------------------------------------------------------
{
  const s = deriveActivationState(snapshot(), NOW);
  check(s.protected === true && s.stage === STAGES.PROTECTED && s.blockers.length === 0, 'a fully set-up, paying, unheld household is protected');
  check(PROTECTION_GATES.every((g) => s.gates[g] === true), 'every protection gate is reported satisfied');
  check(s.screeningEligible === true && s.callsStillReachHcg === true, 'screening eligible; calls reach HCG');
}

// ---------------------------------------------------------------
// Exhaustive: 8,192 combinations.
// ---------------------------------------------------------------
{
  let protectedCount = 0;
  let disagreements = 0;
  let threw = 0;
  let missingBlocker = 0;
  for (let mask = 0; mask < (1 << TOGGLES.length); mask++) {
    const t = {};
    TOGGLES.forEach((name, i) => { if (mask & (1 << i)) t[name] = true; });
    let s;
    try { s = deriveActivationState(snapshot(t), NOW); } catch (err) { threw++; continue; }
    if (s.protected) protectedCount++;
    if ((s.stage === STAGES.PROTECTED) !== s.protected) disagreements++;
    if (s.protected !== PROTECTION_GATES.every((g) => s.gates[g])) disagreements++;
    if (mask !== 0 && s.blockers.length === 0) missingBlocker++;
  }
  check(threw === 0, 'no combination throws (the stage/gate invariant never fires)');
  check(protectedCount === 1, `exactly ONE of 8,192 combinations is protected — the one with nothing wrong (got ${protectedCount})`);
  check(disagreements === 0, 'stage label, `protected` and the gate conjunction always agree');
  check(missingBlocker === 0, 'every not-protected combination names at least one blocker');
}

// ---------------------------------------------------------------
// One part done is never enough — each happy-path step alone.
// ---------------------------------------------------------------
{
  const onlyPaid = deriveActivationState(snapshot({ noNumber: true, provisioningPending: true, noForwarding: true, noRegistration: true, noDelivery: true }), NOW);
  check(!onlyPaid.protected && onlyPaid.stage === STAGES.AWAITING_NUMBER, 'paid only ⇒ awaiting_number, not protected');
  const paidAndNumber = deriveActivationState(snapshot({ noForwarding: true, noCallsReachHcg: true, noRegistration: true, noDelivery: true }), NOW);
  check(!paidAndNumber.protected && paidAndNumber.stage === STAGES.AWAITING_FORWARDING, 'paid + number ⇒ awaiting_forwarding');
  const forwarded = deriveActivationState(snapshot({ noRegistration: true, noDelivery: true }), NOW);
  check(!forwarded.protected && forwarded.stage === STAGES.AWAITING_APP, 'paid + number + forwarding ⇒ awaiting_app');
  const registered = deriveActivationState(snapshot({ noDelivery: true }), NOW);
  check(!registered.protected && registered.stage === STAGES.AWAITING_FIRST_DELIVERY, 'paid + number + forwarding + app ⇒ awaiting_first_delivery');
  const deliveryWithoutPayment = deriveActivationState(snapshot({ noEntitlement: true }), NOW);
  check(!deliveryWithoutPayment.protected && deliveryWithoutPayment.stage === STAGES.MEMBERSHIP_ENDED, 'all technical evidence but no membership ⇒ membership_ended, not protected');
  const neverPaid = deriveActivationState({ ...snapshot({ noNumber: true }), entitlements: [] }, NOW);
  check(neverPaid.stage === STAGES.SIGNED_UP && !neverPaid.protected, 'an account that never had a membership ⇒ signed_up');
  const deliveredNoForwardStamp = deriveActivationState(snapshot({ noForwarding: true }), NOW);
  check(!deliveredNoForwardStamp.protected && deliveredNoForwardStamp.stage === STAGES.FORWARDING_UNCONFIRMED,
    'calls reach HCG and are delivered but forwarding is NOT proven ⇒ forwarding_unconfirmed, never protected (LF-2)');
}

// ---------------------------------------------------------------
// The concrete gaps the audit found in the legacy rule.
// ---------------------------------------------------------------
{
  const legacy = (t) => computeProtectionStatus(snapshot(t).household, NOW, snapshot(t).deliveryHealth).fullyProtected;
  for (const [toggle, stage] of [['held', STAGES.ON_HOLD], ['quarantined', STAGES.NUMBER_CONFLICT], ['staleEvidence', STAGES.AWAITING_FORWARDING], ['noEntitlement', STAGES.MEMBERSHIP_ENDED], ['provisioningPending', STAGES.AWAITING_NUMBER]]) {
    const s = deriveActivationState(snapshot({ [toggle]: true }), NOW);
    check(legacy({ [toggle]: true }) === true && s.protected === false && s.stage === stage,
      `${toggle}: legacy computeProtectionStatus says fullyProtected, the state machine says ${stage} (not protected)`);
  }
  const held = deriveActivationState(snapshot({ held: true }), NOW);
  check(held.screeningEligible === false && held.blockers[0] === 'notOnHold', 'a financial hold blocks screening and is the first blocker');
  const stale = deriveActivationState(snapshot({ staleEvidence: true }), NOW);
  check(stale.attention.includes('evidence_predates_current_number'), 'stale evidence after renumbering is flagged for attention');
}

// ---------------------------------------------------------------
// Fail closed and honest about what was not checked.
// ---------------------------------------------------------------
{
  const amb = deriveActivationState(snapshot({ ambiguousEntitlement: true }), NOW);
  check(amb.stage === STAGES.AMBIGUOUS && !amb.protected, 'unknown entitlement status ⇒ ambiguous, not protected');
  const unreadable = deriveActivationState(snapshot({ holdUnreadable: true }), NOW);
  check(unreadable.stage === STAGES.AMBIGUOUS && !unreadable.protected, 'hold table unreadable ⇒ ambiguous (fail closed)');
  const notDeployed = deriveActivationState({ ...snapshot(), financialHold: undefined }, NOW);
  check(notDeployed.protected && notDeployed.attention.includes('hold_not_checked') && notDeployed.evidence.holdChecked === false,
    'hold table not deployed ⇒ gate passes but the result says the hold was NOT checked');
  const noAssign = deriveActivationState({ ...snapshot(), currentNumberAssignedAt: null }, NOW);
  check(noAssign.protected && noAssign.evidence.numberAssignedAtKnown === false, 'unknown number-assignment time ⇒ evidence accepted, and reported as unverifiable');
  const deleted = deriveActivationState(snapshot({ deleted: true }), NOW);
  check(deleted.stage === STAGES.ACCOUNT_DELETED && !deleted.protected, 'anonymised household ⇒ account_deleted');
}

// ---------------------------------------------------------------
// Delivery regressions and billing standing.
// ---------------------------------------------------------------
{
  const lost = deriveActivationState(snapshot({ unreachable: true }), NOW);
  check(lost.stage === STAGES.RECONNECT_NEEDED && !lost.protected, 'delivery worked before, now UNREACHABLE ⇒ reconnect_needed');
  const signedOut = deriveActivationState(snapshot({ noRegistration: true }), NOW);
  check(signedOut.stage === STAGES.RECONNECT_NEEDED, 'delivery worked before, registration gone ⇒ reconnect_needed');
  const suspect = deriveActivationState({ ...snapshot(), deliveryHealth: { state: 'SUSPECT' } }, NOW);
  check(suspect.protected && suspect.attention.includes('delivery_suspect'), 'SUSPECT health stays protected but is flagged');
  const pastDue = deriveActivationState({ ...snapshot(), subscription: { status: 'past_due', cancel_at_period_end: false } }, NOW);
  check(pastDue.protected && pastDue.billingStanding === 'payment_issue' && pastDue.attention.includes('payment_issue'),
    'Stripe past_due: access continues (current billing rule) but standing = payment_issue');
  const cancelling = deriveActivationState({ ...snapshot(), subscription: { status: 'active', cancel_at_period_end: true } }, NOW);
  check(cancelling.billingStanding === 'cancelling' && cancelling.protected, 'cancel at period end: protected until the period ends, standing = cancelling');
  const comp = deriveActivationState({ ...snapshot(), entitlements: [{ id: 'c', household_id: HH, entitlement_type: 'complimentary', status: 'active', source: 'admin_manual', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' }] }, NOW);
  check(comp.billingStanding === 'complimentary' && comp.protected, 'complimentary membership is a distinct standing');
  const ended = deriveActivationState({ ...snapshot({ noEntitlement: true }), household: { ...snapshot().household, twilio_number_pending_release_at: '2026-11-02T00:00:00Z' } }, NOW);
  check(ended.stage === STAGES.MEMBERSHIP_ENDED && ended.callsStillReachHcg && ended.numberLifecycle.state === 'grace_period',
    'membership ended, number in grace ⇒ calls still reach HCG (the window a "service ending" message must cover)');
}

// ---------------------------------------------------------------
// Transitions.
// ---------------------------------------------------------------
{
  const p = deriveActivationState(snapshot(), NOW);
  const h = deriveActivationState(snapshot({ held: true }), NOW);
  const a = deriveActivationState(snapshot({ noRegistration: true, noDelivery: true }), NOW);
  const f = deriveActivationState(snapshot({ noDelivery: true }), NOW);
  check(classifyTransition(p, h).event === 'protection_lost' && classifyTransition(p, h).regression && classifyTransition(p, h).cause === 'notOnHold', 'protected → hold = protection_lost (regression, cause notOnHold)');
  check(classifyTransition(f, p).event === 'protection_achieved', 'first delivery = protection_achieved');
  check(classifyTransition(a, f).event === 'progressed' && !classifyTransition(a, f).regression, 'awaiting_app → awaiting_first_delivery = progressed');
  check(classifyTransition(f, a).event === 'went_backwards' && classifyTransition(f, a).regression, 'awaiting_first_delivery → awaiting_app = went_backwards (regression)');
  check(classifyTransition(null, p).event === 'initial' && classifyTransition(p, p).event === 'unchanged', 'initial and unchanged');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll lifecycle activation-state checks passed');
