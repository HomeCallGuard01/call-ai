// End-to-end customer lifecycle journey (customer lifecycle automation,
// 2026-10-04). One household is walked through every lifecycle step as a
// sequence of database snapshots — visitor → signup → payment → number →
// forwarding → app → first delivery → payment issue → cancellation → end of
// period → grace → quarantine → return → deletion — and at each step the
// test asserts the activation stage, what the exception queue raises, which
// lifecycle message is due, and the quarantine plan. It also proves the queue
// is quiet when nothing is wrong (no alert fatigue) and that nothing here
// can send, confirm or release anything.
//
// Run with: node tests/lifecycle-journey.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { deriveActivationState, classifyTransition, STAGES } = require('../services/lifecycle/activationState');
const { householdExceptions, buildExceptionQueue, setupClockStartMs } = require('../services/lifecycle/exceptionQueue');
const { planLifecycleCommunications, CATALOGUE } = require('../services/lifecycle/communicationsPlan');
const { planQuarantineActions } = require('../services/lifecycle/numberRetirement');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const HH = '11111111-2222-4333-8444-555555555555';
const N1 = '+441632960001';
const N2 = '+441632960002';
const at = (iso) => new Date(iso);
const codes = (items) => items.map((i) => i.code).sort();
const types = (intents) => intents.map((i) => i.type);

const sent = new Set();
function step(label, snap, now, expect) {
  const activation = deriveActivationState(snap, now);
  const { items } = householdExceptions(snap, now);
  const due = planLifecycleCommunications(snap, activation, { now, sentKeys: sent, setupClockMs: setupClockStartMs(snap) });
  check(activation.stage === expect.stage, `${label}: stage = ${expect.stage} (got ${activation.stage})`);
  check(activation.protected === (expect.stage === STAGES.PROTECTED), `${label}: protected = ${expect.stage === STAGES.PROTECTED}`);
  check(JSON.stringify(codes(items)) === JSON.stringify((expect.exceptions || []).slice().sort()), `${label}: exceptions = [${(expect.exceptions || []).join(', ')}] (got [${codes(items).join(', ')}])`);
  check(JSON.stringify(types(due)) === JSON.stringify(expect.comms || []), `${label}: messages due = [${(expect.comms || []).join(', ')}] (got [${types(due).join(', ')}])`);
  check(due.every((d) => d.deliverable === false), `${label}: nothing is deliverable (no approved copy / channel)`);
  for (const d of due) sent.add(d.key); // as if an outbox had recorded them
  return activation;
}

const base = {
  id: HH, status: 'active', email: 'customer@example.com', auth_user_id: 'auth-1', account_number: 'HCG-00010017',
  twilio_number: null, twilio_provisioning_status: 'pending', twilio_number_pending_release_at: null,
  activation_verified_at: null, voice_client_registered_at: null, delivery_verified_at: null,
};
const paid = { id: 'e1', household_id: HH, entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-10-01T09:00:00Z', ends_at: null };
const sub = { stripe_subscription_id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: '2026-11-01T09:00:00Z', updated_at: '2026-10-01T09:00:00Z' };
const snap = (household, extra = {}) => ({ household: { ...base, ...household }, entitlements: [], subscription: null, quarantineRows: [], financialHold: null, deliveryHealth: { state: 'HEALTHY' }, currentNumberAssignedAt: null, ...extra });

// 1. Signed up (household bootstrapped), not paid.
const s1 = step('signup', snap({}), at('2026-10-01T08:00:00Z'), { stage: STAGES.SIGNED_UP });
// 2. Paid; number not yet provisioned (within the 1h provisioning window).
step('payment, provisioning in progress', snap({}, { entitlements: [paid], subscription: sub }), at('2026-10-01T09:20:00Z'),
  { stage: STAGES.AWAITING_NUMBER, comms: ['welcome'] });
// 2b. … still no number 3h later.
step('payment, provisioning stuck', snap({ twilio_provisioning_updated_at: '2026-10-01T09:00:00Z' }, { entitlements: [paid], subscription: sub }), at('2026-10-01T12:00:00Z'),
  { stage: STAGES.AWAITING_NUMBER, exceptions: ['ENTITLED_WITHOUT_NUMBER'] });
// 3. Number active; nothing else yet.
const numbered = { twilio_number: N1, twilio_provisioning_status: 'active', twilio_provisioning_updated_at: '2026-10-01T09:05:00Z' };
const ctx = { entitlements: [paid], subscription: sub, currentNumberAssignedAt: '2026-10-01T09:05:00Z' };
step('number assigned', snap(numbered, ctx), at('2026-10-01T10:00:00Z'), { stage: STAGES.AWAITING_FORWARDING });
// 3b. 26h later, forwarding still not detected → stalled + first reminder.
step('setup stalled 26h', snap(numbered, ctx), at('2026-10-02T11:05:00Z'),
  { stage: STAGES.AWAITING_FORWARDING, exceptions: ['SETUP_STALLED'], comms: ['setup_incomplete'] });
// 4. Forwarding verified.
const fwd = { ...numbered, activation_verified_at: '2026-10-02T12:00:00Z' };
step('forwarding verified', snap(fwd, ctx), at('2026-10-02T12:01:00Z'), { stage: STAGES.AWAITING_APP, exceptions: ['SETUP_STALLED'] });
// 5. App registered, no delivery yet.
const app = { ...fwd, voice_client_registered_at: '2026-10-02T12:10:00Z' };
const s5 = step('app registered', snap(app, ctx), at('2026-10-02T12:11:00Z'), { stage: STAGES.AWAITING_FIRST_DELIVERY });
// 6. First delivery confirmed → protected, protection_active message once.
const prot = { ...app, delivery_verified_at: '2026-10-02T15:00:00Z' };
const s6 = step('first delivery → protected', snap(prot, ctx), at('2026-10-02T15:01:00Z'), { stage: STAGES.PROTECTED, comms: ['protection_active'] });
check(classifyTransition(s5, s6).event === 'protection_achieved', 'transition awaiting_first_delivery → protected = protection_achieved');
// 6b. Normal usage a week later: quiet queue, no repeated messages.
step('normal usage', snap(prot, ctx), at('2026-10-09T12:00:00Z'), { stage: STAGES.PROTECTED });
// 7. Payment fails: past_due for 4 days.
const pastDue = { ...sub, status: 'past_due', updated_at: '2026-10-10T00:00:00Z' };
step('payment issue', snap(prot, { ...ctx, subscription: pastDue }), at('2026-10-14T12:00:00Z'),
  { stage: STAGES.PROTECTED, exceptions: ['PAYMENT_ISSUE'], comms: ['payment_issue'] });
// 8. Renewal succeeds; customer then cancels at period end.
const cancelling = { ...sub, cancel_at_period_end: true, updated_at: '2026-10-20T00:00:00Z' };
step('cancellation scheduled', snap(prot, { ...ctx, subscription: cancelling }), at('2026-10-20T12:00:00Z'),
  { stage: STAGES.PROTECTED, comms: ['cancellation_confirmed'] });
// 9. Period ends: subscription.deleted ⇒ entitlement expired, 30-day grace.
const expired = { ...paid, status: 'expired', ends_at: '2026-11-01T09:00:00Z' };
const grace = { ...prot, twilio_number_pending_release_at: '2026-12-01T09:00:00Z' };
const s9 = step('end of paid period (grace)', snap(grace, { ...ctx, entitlements: [expired], subscription: { ...cancelling, status: 'canceled' } }), at('2026-11-01T10:00:00Z'),
  { stage: STAGES.MEMBERSHIP_ENDED, comms: ['service_ending'] });
check(classifyTransition(s6, s9).event === 'protection_lost', 'protected → membership ended = protection_lost (expected, but visible)');
step('grace, final week', snap(grace, { ...ctx, entitlements: [expired] }), at('2026-11-26T10:00:00Z'), { stage: STAGES.MEMBERSHIP_ENDED, comms: ['service_ending'] });
// 10. Grace expires; the daily runner quarantines the number (047).
const q1 = { id: 'q1', household_id: HH, twilio_number: N1, release_reason: 'subscription_grace_expired', quarantined_at: '2026-12-01T09:30:00Z', released_at: null, deactivation_confirmed: false };
const afterRelease = { ...prot, twilio_number: null, twilio_provisioning_status: 'pending', twilio_number_pending_release_at: null };
step('number quarantined', snap(afterRelease, { ...ctx, entitlements: [expired], quarantineRows: [q1] }), at('2026-12-02T10:00:00Z'),
  { stage: STAGES.MEMBERSHIP_ENDED, exceptions: ['QUARANTINE_AWAITING_CONFIRMATION'], comms: ['service_ended'] });
// 10b. 50 days later nobody confirmed: escalates; plan shows the cost of waiting.
step('quarantine unconfirmed 50d', snap(afterRelease, { ...ctx, entitlements: [expired], quarantineRows: [q1] }), at('2027-01-20T10:00:00Z'),
  { stage: STAGES.MEMBERSHIP_ENDED, exceptions: ['QUARANTINE_AWAITING_CONFIRMATION_LONG'] });
{
  const plan = planQuarantineActions([{ ...q1, entitlements: [expired] }], { now: at('2027-01-20T10:00:00Z'), monthlyNumberCostGbp: 0.87 });
  check(plan.plans[0].next === 'awaiting_human_confirmation' && plan.plans[0].autoConfirmEligible === false, 'retirement plan: awaiting human confirmation; never auto-confirmed by default');
  check(plan.plans[0].costSinceQuarantineGbp > 1 && plan.summary.monthlyCostOfWaitingGbp === 0.87, 'retirement plan: cost of waiting is visible (£/month and accrued)');
  const withPolicy = planQuarantineActions([{ ...q1, entitlements: [expired] }], { now: at('2027-01-20T10:00:00Z'), autoConfirmAfterDays: 45 });
  check(withPolicy.plans[0].autoConfirmEligible === true, 'with an approved 45-day policy the row WOULD be eligible (planner only — nothing acts)');
}
// 11. Customer returns: new payment, NEW number while N1 is still quarantined.
const back = { ...paid, id: 'e2', starts_at: '2027-01-21T09:00:00Z' };
const renumbered = { ...prot, twilio_number: N2, twilio_provisioning_status: 'active', twilio_provisioning_updated_at: '2027-01-21T09:05:00Z' };
step('returning customer, renumbered', snap(renumbered, { entitlements: [expired, back], subscription: { ...sub, stripe_subscription_id: 'sub_2' }, quarantineRows: [q1], currentNumberAssignedAt: '2027-01-21T09:05:00Z' }), at('2027-01-21T10:00:00Z'),
  { stage: STAGES.AWAITING_FORWARDING, exceptions: ['EVIDENCE_PREDATES_CURRENT_NUMBER', 'QUARANTINE_AWAITING_CONFIRMATION_LONG', 'RETURNING_CUSTOMER_OLD_NUMBER_QUARANTINED'] });
// 12. Account deletion: anonymised; Stripe keeps retrying subscription.deleted (F-03).
const deleted = { ...base, status: 'cancelled', email: `anonymized-${HH}@deleted.homecallguard.internal`, auth_user_id: null };
const failedEvent = { stripe_event_id: 'evt_1', event_type: 'customer.subscription.deleted', household_id: HH, error: 'household does not match stripe_customer_id', received_at: '2027-02-01T00:00:00Z' };
step('account deleted', snap(deleted, { entitlements: [expired, { ...back, status: 'revoked' }], failedStripeEvents: [failedEvent] }), at('2027-02-01T01:00:00Z'),
  { stage: STAGES.ACCOUNT_DELETED, exceptions: ['STRIPE_EVENT_FOR_DELETED_HOUSEHOLD'] });
void s1;

// ---------------------------------------------------------------
// Whole-queue behaviour.
// ---------------------------------------------------------------
{
  const healthy = Array.from({ length: 50 }, (_, i) => snap({ ...prot, id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }, ctx));
  const q = buildExceptionQueue({ snapshots: healthy }, at('2026-10-09T12:00:00Z'));
  check(q.summary.total === 0 && q.summary.protected === 50, '50 healthy protected households ⇒ an EMPTY queue (no alert fatigue)');
  const held = snap(prot, { ...ctx, financialHold: { held: true, source: 'financial', heldAt: '2026-10-09T00:00:00Z' } });
  const orphan = { id: 'q9', household_id: null, twilio_number: '+441632960009', quarantined_at: '2026-09-01T00:00:00Z', released_at: null };
  const ambiguous = snap(prot, { ...ctx, entitlements: [{ ...paid, status: 'mystery' }] });
  const mixed = buildExceptionQueue({ snapshots: [held, ambiguous, ...healthy.slice(0, 3)], orphanQuarantineRows: [orphan] }, at('2026-10-09T12:00:00Z'));
  check(mixed.items[0].severity === 'critical' && mixed.items[0].code === 'LIFECYCLE_STATE_AMBIGUOUS', 'critical items sort first');
  check(codes(mixed.items).includes('HOUSEHOLD_ON_HOLD') && codes(mixed.items).includes('QUARANTINE_WITHOUT_HOUSEHOLD'), 'holds and household-less quarantine rows are raised');
  check(new Set(mixed.items.map((i) => i.dedupeKey)).size === mixed.items.length, 'every item has a unique dedupe key');
  check(mixed.items.every((i) => i.owner && i.recommendedAction && i.automation), 'every item names an owner, an action and its automation status');
  const twice = buildExceptionQueue({ snapshots: [held, held] }, at('2026-10-09T12:00:00Z'));
  check(twice.items.length === 1, 'the same household loaded twice raises its item once');
}

// ---------------------------------------------------------------
// Communications catalogue honesty, and nothing here can act.
// ---------------------------------------------------------------
{
  check(CATALOGUE.allowance_warning.status === 'exists' && CATALOGUE.welcome.status === 'missing' && /NO EVENT SOURCE/.test(CATALOGUE.account_security.trigger),
    'catalogue records what exists (allowance), what is missing (welcome) and what has no event source (security)');
  const deletedPlan = planLifecycleCommunications(snap({ ...base, status: 'cancelled', email: 'anonymized-x@deleted.homecallguard.internal', auth_user_id: null }), deriveActivationState(snap({ status: 'cancelled', auth_user_id: null }), at('2026-10-09T00:00:00Z')), { now: at('2026-10-09T00:00:00Z') });
  check(deletedPlan.length === 0, 'a deleted account is never planned a message');
  const src = ['services/lifecycle/activationState.js', 'services/lifecycle/exceptionQueue.js', 'services/lifecycle/communicationsPlan.js', 'services/lifecycle/numberRetirement.js', 'services/lifecycle/supportSearch.js']
    .map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  check(!/require\([^)]*(supabase|twilio|stripe|resend|database\/|alerting|fetch)/i.test(src) && !/\bfetch\(/.test(src), 'lifecycle services load no database, provider, email or alerting client');
  const route = readFileSync(path.join(ROOT, 'routes/adminLifecycle.js'), 'utf8');
  check(!/router\.(post|put|patch|delete)\(/.test(route) && !/\.(insert|update|upsert|delete|rpc)\(/.test(route), 'admin lifecycle routes are GET-only and issue no writes or RPCs');
  const loader = readFileSync(path.join(ROOT, 'database/lifecycleSnapshot.js'), 'utf8');
  check(!/\.(insert|update|upsert|delete|rpc)\(/.test(loader), 'the snapshot loader issues no writes or RPCs');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll lifecycle journey checks passed');
