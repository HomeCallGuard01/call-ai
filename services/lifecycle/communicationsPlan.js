// Customer lifecycle communications — catalogue + deterministic planner
// (customer lifecycle automation, 2026-10-04).
//
// Today HCG sends exactly three kinds of customer message itself: Supabase
// Auth emails (confirm signup, password reset), the in-call scam-warning SMS,
// and allowance usage emails (services/allowance/allowanceNotices.js, OFF
// unless ALLOWANCE_NOTICE_CHANNELS is set). Everything else in the lifecycle
// — welcome, setup reminders, payment problems, cancellation, service
// ending, security events — is silent (doc §7).
//
// This module decides WHICH lifecycle message a household is due, from the
// activation state alone, with a stable idempotency key per message so a
// future outbox can never send one twice. It deliberately does NOT contain
// customer copy (all wording is Andrew's decision — the allowance notice copy
// set the precedent of DRAFT-until-approved) and does NOT send anything: every
// intent is returned with `deliverable: false` until a channel and approved
// copy exist for that type.
'use strict';

const { DAY_MS, HOUR_MS, parseTimestampMs } = require('../numberLifecycle/state');
const { STAGES } = require('./activationState');

// status: 'exists' (sent today), 'in_app_only', 'missing'.
const CATALOGUE = Object.freeze({
  welcome: { status: 'missing', today: 'Supabase "confirm signup" email only; nothing after payment', trigger: 'first current membership' },
  setup_incomplete: { status: 'in_app_only', today: 'Home/setup screens only; no reminder outside the app', trigger: 'entitled, not protected, 24h and 72h after the setup clock' },
  protection_active: { status: 'in_app_only', today: '"You\'re protected" on Home', trigger: 'first time the activation stage is protected for the current number' },
  protection_lost: { status: 'in_app_only', today: 'Home "reconnect" state; internal alert only', trigger: 'stage reconnect_needed' },
  allowance_warning: { status: 'exists', today: 'allowanceNotices.js 75/90/100% outbox (email behind ALLOWANCE_NOTICE_CHANNELS; push suppressed)', trigger: 'owned by services/allowance — not planned here' },
  payment_issue: { status: 'in_app_only', today: '"Payment issue" label; Stripe dunning only if enabled in the Dashboard', trigger: 'Stripe past_due/unpaid' },
  cancellation_confirmed: { status: 'in_app_only', today: '"Cancelling at period end" label; Stripe receipt if enabled', trigger: 'cancel_at_period_end set' },
  service_ending: { status: 'missing', today: 'nothing — forwarding keeps reaching HCG through the 30-day grace', trigger: 'membership ended and the number is in its grace period' },
  service_ended: { status: 'missing', today: 'nothing', trigger: 'number left the household after a membership ended' },
  account_security: { status: 'missing', today: 'nothing (Supabase "password changed" is dashboard config, unverified)', trigger: 'NO EVENT SOURCE — sign-in/new-device/password events are not recorded server-side' },
});

const SETUP_REMINDER_OFFSETS_MS = Object.freeze([24 * HOUR_MS, 72 * HOUR_MS]);
// DECISION: second "service ending" reminder this long before release.
const SERVICE_ENDING_FINAL_NOTICE_MS = 7 * DAY_MS;

function intent(type, key, reason) {
  return { type, key, reason, deliverable: false, blockedBy: ['copy_not_approved', 'no_channel_configured'] };
}

/**
 * @param {object} snapshot   the deriveActivationState input (household, entitlements, subscription …)
 * @param {object} activation deriveActivationState(snapshot, now)
 * @param {{ now: Date|number, sentKeys?: Set<string>, setupClockMs?: number|null }} opts
 * @returns {object[]} intents not yet sent, in a stable order
 */
function planLifecycleCommunications(snapshot, activation, { now, sentKeys = new Set(), setupClockMs = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const h = snapshot.household || {};
  const id = h.id;
  const out = [];
  if (!id || activation.stage === STAGES.ACCOUNT_DELETED) return out; // never message a deleted account

  const current = activation.numberLifecycle.membership === 'current';
  const ents = snapshot.entitlements || [];
  const firstEnt = ents.slice().sort((a, b) => (parseTimestampMs(a.starts_at) ?? 0) - (parseTimestampMs(b.starts_at) ?? 0))[0];

  if (current && firstEnt) out.push(intent('welcome', `welcome:${id}`, 'first membership in effect'));

  const settingUp = [STAGES.AWAITING_FORWARDING, STAGES.AWAITING_APP, STAGES.AWAITING_FIRST_DELIVERY].includes(activation.stage);
  if (current && settingUp && setupClockMs !== null) {
    for (const offset of SETUP_REMINDER_OFFSETS_MS) {
      if (nowMs - setupClockMs >= offset) {
        out.push(intent('setup_incomplete', `setup_incomplete:${id}:${setupClockMs}:${offset / HOUR_MS}h`, `${activation.stage} for ${Math.floor((nowMs - setupClockMs) / HOUR_MS)}h`));
      }
    }
  }

  // Keyed on the number so a renumbered household is told again.
  if (activation.protected && h.twilio_number) out.push(intent('protection_active', `protection_active:${id}:${h.twilio_number}`, 'all protection gates satisfied'));
  if (activation.stage === STAGES.RECONNECT_NEEDED) {
    const day = Math.floor(nowMs / DAY_MS);
    out.push(intent('protection_lost', `protection_lost:${id}:${day}`, 'app unreachable after delivery had worked'));
  }

  const sub = snapshot.subscription;
  if (activation.billingStanding === 'payment_issue' && sub) out.push(intent('payment_issue', `payment_issue:${id}:${sub.stripe_subscription_id}:${sub.current_period_end}`, sub.status));
  if (activation.billingStanding === 'cancelling' && sub) out.push(intent('cancellation_confirmed', `cancellation:${id}:${sub.stripe_subscription_id}:${sub.current_period_end}`, 'cancel_at_period_end'));

  const pendingMs = parseTimestampMs(h.twilio_number_pending_release_at);
  if (activation.stage === STAGES.MEMBERSHIP_ENDED && h.twilio_number && pendingMs !== null && pendingMs > nowMs) {
    out.push(intent('service_ending', `service_ending:${id}:${h.twilio_number_pending_release_at}:start`, 'membership ended; number in grace period'));
    if (pendingMs - nowMs <= SERVICE_ENDING_FINAL_NOTICE_MS) out.push(intent('service_ending', `service_ending:${id}:${h.twilio_number_pending_release_at}:final`, 'grace period ends within 7 days'));
  }
  const releasedRow = (snapshot.quarantineRows || []).find((q) => q.quarantined_at);
  if (activation.stage === STAGES.MEMBERSHIP_ENDED && !h.twilio_number && releasedRow) {
    out.push(intent('service_ended', `service_ended:${id}:${releasedRow.twilio_number}`, 'number left the household'));
  }

  return out.filter((i) => !sentKeys.has(i.key));
}

module.exports = { CATALOGUE, SETUP_REMINDER_OFFSETS_MS, SERVICE_ENDING_FINAL_NOTICE_MS, planLifecycleCommunications };
