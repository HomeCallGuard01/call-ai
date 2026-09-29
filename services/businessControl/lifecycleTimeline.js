// Business control centre — per-household lifecycle timeline (READ-ONLY).
//
// Active path:        Subscription → Entitlement → HCG number →
//                     App registration → Delivery confirmed → Protected
// Cancellation path:  Cancelled/ended → Protection ends → Release
//                     scheduled → Quarantined → Deactivation confirmed →
//                     Released (HCG record) → Gone from Twilio
//
// Each step: state 'done' | 'pending' | 'broken' | 'na', a date where
// one is recorded, and a note. `firstBroken` points at the first broken
// step, so a loose end is obvious even if every automated job has failed.
// Rules mirror the lifecycle owned by P0 (047 / sweep) and are only
// reported here — nothing is scheduled, quarantined or released.
'use strict';

const { classifyHouseholdForBusiness } = require('./definitions');
const { parseTimestampMs } = require('../adminOnboardingStatus');

const HOUR_MS = 3600 * 1000;
// Canonical grace periods (services/numberLifecycle/state.js).
const { GRACE } = require('../numberLifecycle/state');
const JOB_GRACE_MS = GRACE.releaseOverdueMs;

function step(key, label, state, at, note) {
  return { key, label, state, at: at || null, note: note || null };
}

// Pure. `onProvider`: true/false when the provider inventory was read,
// null when it wasn't (then "Gone from Twilio" is reported as unknown).
function buildLifecycleTimeline({ household, entitlements, subscriptions, classification, quarantineRows, onProvider = null }, now) {
  const nowMs = now.getTime();
  const b = classifyHouseholdForBusiness({ household, entitlements, subscriptions, classification }, now);
  const sub = b.latestSubscription;
  const ent = b.currentEntitlement || b.upcomingEntitlement || b.latestEntitlement;
  const active = b.membership === 'current' || b.membership === 'upcoming';
  const steps = [];

  // --- Active path ---
  if (sub) {
    steps.push(step('subscription', 'Subscription', ['active', 'trialing'].includes(sub.status) ? 'done' : sub.status === 'past_due' || sub.status === 'unpaid' ? 'broken' : 'na', sub.updated_at, `Stripe status: ${sub.status}${sub.cancel_at_period_end ? ' (cancels at period end)' : ''}`));
  } else {
    steps.push(step('subscription', 'Subscription', 'na', null, b.access === 'complimentary' || b.access === 'trial' ? `No subscription (${b.access} access)` : 'No Stripe subscription recorded'));
  }
  steps.push(step('entitlement', 'Entitlement', active ? 'done' : b.membership === 'never' ? 'na' : 'na', ent ? ent.starts_at : null,
    active ? `${b.membership === 'upcoming' ? 'Upcoming' : 'Current'} ${b.access === 'none' ? '' : b.access + ' '}access${ent && ent.ends_at ? ' until ' + String(ent.ends_at).slice(0, 10) : ''}` : `Membership ${b.membership}`));

  const startedMs = parseTimestampMs(b.currentEntitlement && b.currentEntitlement.starts_at);
  if (active) {
    const numberBroken = !household.twilio_number && (household.twilio_provisioning_status === 'failed' || (startedMs !== null && nowMs - startedMs > HOUR_MS));
    steps.push(step('number', 'HCG number', household.twilio_number ? 'done' : numberBroken ? 'broken' : 'pending', household.twilio_provisioning_updated_at,
      household.twilio_number ? 'Assigned' : `Provisioning ${household.twilio_provisioning_status || 'not started'}`));
    if (household.twilio_number && household.twilio_number_pending_release_at) {
      steps.push(step('release_while_entitled', 'Release scheduled while entitled', 'broken', household.twilio_number_pending_release_at, 'An entitled household\'s number must never be scheduled for release (047)'));
    }
    steps.push(step('app', 'App registration', household.voice_client_registered_at ? 'done' : 'pending', household.voice_client_registered_at, household.voice_client_registered_at ? 'Last registered' : 'Never registered'));
    steps.push(step('delivery', 'Delivery confirmed', household.delivery_verified_at ? 'done' : 'pending', household.delivery_verified_at, household.delivery_verified_at ? 'Last delivered call' : 'No delivered call yet'));
    steps.push(step('protected', 'Protected', b.protection === 'protected' ? 'done' : 'pending', null, b.protection === 'protected' ? 'Customer-facing Protected' : 'Not yet Protected'));
  }

  // --- Cancellation path ---
  const qRows = (quarantineRows || []).slice().sort((x, y) => (parseTimestampMs(y.quarantined_at) || 0) - (parseTimestampMs(x.quarantined_at) || 0));
  const q = qRows[0] || null;
  const lapsed = !active && b.membership !== 'never';
  if (lapsed || q || household.twilio_number_pending_release_at) {
    const endedAt = b.membershipEndedAt;
    steps.push(step('ended', b.membership === 'cancelled' ? 'Cancelled' : 'Membership ended', lapsed ? 'done' : 'na', endedAt, lapsed ? `Membership ${b.membership}` : 'Membership still active'));
    const protectionEnd = b.latestEntitlement && b.latestEntitlement.ends_at ? b.latestEntitlement.ends_at : endedAt;
    steps.push(step('protection_ends', 'Protection ends', lapsed ? 'done' : 'na', protectionEnd, lapsed ? 'Access ended' : null));

    const pendingMs = parseTimestampMs(household.twilio_number_pending_release_at);
    const holds = !!household.twilio_number;
    if (holds && pendingMs === null && lapsed) {
      steps.push(step('release_scheduled', 'Release scheduled', 'broken', null, 'Lapsed household still holds a number and no release is scheduled'));
    } else {
      steps.push(step('release_scheduled', 'Release scheduled', pendingMs !== null ? 'done' : q ? 'done' : 'na', household.twilio_number_pending_release_at, pendingMs !== null ? `Release due ${new Date(pendingMs).toISOString().slice(0, 10)}` : q ? 'Released into quarantine' : null));
    }

    if (q) {
      steps.push(step('quarantined', 'Quarantined', 'done', q.quarantined_at, q.release_reason));
      const confirmedMs = parseTimestampMs(q.deactivation_confirmed_at);
      steps.push(step('confirmed', 'Deactivation confirmed', q.deactivation_confirmed ? 'done' : 'pending', q.deactivation_confirmed_at, q.deactivation_confirmed ? (q.deactivation_confirmed_method || 'Confirmed') : 'Waiting for your confirmation that carrier forwarding is off'));
      const stuckBasisMs = confirmedMs ?? parseTimestampMs(q.quarantined_at);
      const releaseOverdue = q.deactivation_confirmed && !q.released_at && stuckBasisMs !== null && nowMs - stuckBasisMs > GRACE.quarantineReleaseStuckMs;
      steps.push(step('released', 'Released (HCG record)', q.released_at ? 'done' : releaseOverdue ? 'broken' : 'pending', q.released_at, q.released_at ? 'Recorded released' : releaseOverdue ? `Confirmed over ${GRACE.quarantineReleaseStuckMs / HOUR_MS}h ago, not released` : null));
      const gone = onProvider === null ? null : !onProvider;
      steps.push(step('gone_from_provider', 'Gone from Twilio', gone === null ? 'pending' : gone ? 'done' : q.released_at ? 'broken' : 'pending', null,
        gone === null ? 'Provider inventory not checked' : gone ? 'Not on the provider account' : q.released_at ? 'Recorded released but still billed by Twilio' : 'Still on the provider account'));
    } else if (holds && pendingMs !== null) {
      const overdue = nowMs - pendingMs > JOB_GRACE_MS;
      steps.push(step('quarantined', 'Quarantined', overdue ? 'broken' : 'pending', null, overdue ? `Release date passed over ${JOB_GRACE_MS / HOUR_MS}h ago; number not yet quarantined` : 'Waiting for the release date'));
    }
  }

  if (b.membership === 'never' && household.twilio_number) {
    steps.push(step('number_without_membership', 'Number held without any membership', 'broken', household.twilio_provisioning_updated_at, 'This household has never had a membership but holds a billed number'));
  }

  const firstBroken = steps.findIndex((s) => s.state === 'broken');
  return { membership: b.membership, accountClass: b.accountClass, steps, firstBroken: firstBroken === -1 ? null : firstBroken };
}

module.exports = { buildLifecycleTimeline };
