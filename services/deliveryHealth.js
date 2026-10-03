'use strict';

// Call-delivery health — pure, provider-neutral, no network/DB.
//
// Why this exists (2026-09-29, P0 call-delivery resilience): household
// f06bc964 failed 4/4 app deliveries on 24–26 Sep 2026 (two with Twilio
// error 52103, FCM 'NotRegistered') while every customer-facing and
// admin-facing status still said "Protection Active". The only
// reachability input anywhere was households.voice_client_registered_at,
// and hasVoiceClientRegistrationHistory (services/callRouting.js)
// deliberately treats ANY past registration as reachable, because
// Twilio's push binding outlives the 1-hour access token. That is right
// for ROUTING (refusing to even attempt a dial on a stale timestamp would
// drop calls that could still succeed), and this module does not change
// routing. It is wrong as a HEALTH claim: a registration only proves the
// app could receive calls when it registered. Health has to come from
// what actually happened on real calls.
//
// Inputs are real evidence only:
//   - delivery attempts: calls rows with dial_call_status set (a
//     <Dial><Client> was really attempted; screened/terminated calls
//     that never dialled are not attempts, same convention as
//     database/calls.js's getMostRecentDialOutcome). Each carries the
//     Twilio DialCallStatus, and optionally device-side evidence
//     (client_invite_received_at / client_outcome, reported by the app)
//     and provider push-failure evidence (push_failure, from Twilio
//     Monitor alerts such as 52103).
//   - the most recent successful Voice SDK registration.
//
// States:
//   UNREGISTERED — the app has never registered. The existing router
//                  already refuses to dial (self-protecting-unreachable).
//   UNKNOWN      — registered, but no delivery attempt since then that
//                  proves or disproves anything.
//   HEALTHY      — the most recent meaningful attempt was delivered.
//   SUSPECT      — evidence of a problem, but not conclusive.
//   UNREACHABLE  — conclusive evidence the app cannot currently receive
//                  calls.
//
// Thresholds and why:
//   - A push failure that says the device token is dead (FCM
//     NotRegistered/Unregistered/InvalidRegistration, APNs
//     BadDeviceToken/Unregistered) and is newer than the latest
//     registration → UNREACHABLE after ONE occurrence. The provider has
//     said the token no longer exists, and every later push to it will
//     fail the same way until the app registers a new token. Waiting for
//     a second failure would only drop another real call.
//   - HARD failures (push failed, Dial 'failed', or 'no-answer' with no
//     invite ever reaching a device that is known to report invites) →
//     SUSPECT at 1, UNREACHABLE at 2 consecutive. One is plausibly
//     transient (a network blip); two in a row with no success between
//     is a pattern.
//   - SOFT failures ('no-answer' where we cannot tell whether the phone
//     rang) → SUSPECT at 3 consecutive. They are indistinguishable from
//     a customer simply not answering, which is ordinary behaviour.
//     Two missed calls in a row is common for an elderly customer away
//     from the phone. Three approved calls with no answer and no
//     success between them is worth a gentle "needs attention", never
//     "unavailable".
//   - NEUTRAL outcomes are never failures and never reset the run:
//     customer declined, caller hung up first, customer busy, and 'no-
//     answer' after the device confirmed the invite arrived (the phone
//     rang; the person didn't pick up). They say nothing about whether
//     the app works, except that invite-received proves it does, which
//     is why they are neutral rather than failures.
//   - Only a DELIVERED call (DialCallStatus 'completed') proves health
//     and resets the run. A new registration does NOT restore HEALTHY.
//     In the f06bc964 evidence, the app re-registered at 14:07:01 on 26
//     Sep and the call at 14:09 still was not answered. A registration
//     newer than the failures does downgrade UNREACHABLE to SUSPECT (the
//     dead token may have been replaced), and clears soft failures that
//     predate it (the app was demonstrably alive after them).
//   - No time-based expiry. Calls to these households are sparse and
//     irregular; a rolling window would either forget real failures on
//     quiet households or need an arbitrary constant. The run is
//     "consecutive attempts since the last delivered call". Staleness
//     is still reported (lastRegisteredAt, lastSuccessAt) for operators.

const STATES = Object.freeze({
  UNREGISTERED: 'UNREGISTERED',
  UNKNOWN: 'UNKNOWN',
  HEALTHY: 'HEALTHY',
  SUSPECT: 'SUSPECT',
  UNREACHABLE: 'UNREACHABLE',
});

const HARD_FAILURE_UNREACHABLE_THRESHOLD = 2;
const SOFT_FAILURE_SUSPECT_THRESHOLD = 3;

// Push-provider failures that mean "this device token will never work
// again". Anything else (quota, transient 5xx) is treated as a hard
// failure but not as conclusive.
const DEAD_TOKEN_FAILURES = new Set([
  'notregistered',
  'unregistered',
  'invalidregistration',
  'baddevicetoken',
  'devicetokennotfortopic',
]);

// Returns one of:
//   delivered            — success
//   customer_declined    — neutral
//   caller_abandoned     — neutral
//   customer_busy        — neutral
//   rang_unanswered      — neutral (device confirmed the invite arrived)
//   push_failed          — hard
//   delivery_error       — hard (Dial 'failed': SDK/infrastructure)
//   not_reached_device   — hard (no invite report from a device known to report them)
//   unconfirmed_no_answer— soft
//   unknown              — soft
function classifyDeliveryAttempt(attempt, { inviteReportingVerified = false } = {}) {
  const status = attempt && attempt.dialCallStatus;
  const outcome = attempt && attempt.clientOutcome;

  if (status === 'completed' || status === 'answered') return 'delivered';
  if (outcome === 'accepted' && status !== 'failed') return 'delivered';
  if (outcome === 'rejected') return 'customer_declined';
  if (outcome === 'cancelled' || status === 'canceled') return 'caller_abandoned';
  if (attempt && attempt.pushFailure) return 'push_failed';
  if (status === 'failed') return 'delivery_error';
  if (status === 'busy') return 'customer_busy';
  if (status === 'no-answer') {
    if (attempt.clientInviteReceivedAt) return 'rang_unanswered';
    return inviteReportingVerified ? 'not_reached_device' : 'unconfirmed_no_answer';
  }
  return 'unknown';
}

const HARD = new Set(['push_failed', 'delivery_error', 'not_reached_device']);
const SOFT = new Set(['unconfirmed_no_answer', 'unknown']);

function isDeadTokenFailure(pushFailure) {
  if (!pushFailure) return false;
  const reason = String(pushFailure).split(':').pop().toLowerCase();
  return DEAD_TOKEN_FAILURES.has(reason);
}

function toMs(value) {
  if (!value) return NaN;
  return new Date(value).getTime();
}

// attempts: any order; each { at, dialCallStatus, clientInviteReceivedAt?,
// clientOutcome?, pushFailure? }. Duplicates by callSid are collapsed.
// Device readiness (2026-09-30, release readiness): a registered app can
// still be unable to present a call. On Android the Twilio SDK drops an
// incoming call before posting any notification or ringtone when the
// microphone permission is off (Android 11+), and posts no answerable
// notification when POST_NOTIFICATIONS is off (Android 13+) — error 31401,
// Twilio just sees no-answer. The app reports its permission state
// (device_readiness) and any 31401 (app_presentation_blocked); a report
// newer than the last delivered call that shows the phone cannot ring is
// UNREACHABLE without waiting for failures to accumulate. A later
// delivered call always wins (it proves the phone can ring now).
function deviceReadinessBlockReason(deviceReadiness, lastSuccessAt) {
  if (!deviceReadiness) return null;
  const successMs = toMs(lastSuccessAt);
  const newerThanSuccess = at => Number.isFinite(toMs(at)) && (!Number.isFinite(successMs) || toMs(at) > successMs);
  const reportMs = toMs(deviceReadiness.reportedAt);
  const blockMs = toMs(deviceReadiness.presentationBlockedAt);
  if (newerThanSuccess(deviceReadiness.reportedAt)) {
    if (deviceReadiness.microphone === 'denied') return 'the phone cannot ring for calls: microphone permission is off for the app';
    if (deviceReadiness.notifications === 'denied') return 'the phone cannot show incoming calls: notifications are off for the app';
  }
  // A 31401 is superseded only by a later report showing both granted.
  if (newerThanSuccess(deviceReadiness.presentationBlockedAt)) {
    const laterAllClear = Number.isFinite(reportMs) && reportMs > blockMs
      && deviceReadiness.microphone !== 'denied' && deviceReadiness.notifications !== 'denied';
    if (!laterAllClear) return 'the phone blocked an incoming call from ringing (missing permission)';
  }
  return null;
}

function computeDeliveryHealth({ attempts = [], lastRegisteredAt = null, inviteReportingVerified = false, deviceReadiness = null } = {}) {
  const seen = new Set();
  const ordered = attempts
    .filter(a => a && Number.isFinite(toMs(a.at)))
    .filter(a => {
      if (!a.callSid) return true;
      if (seen.has(a.callSid)) return false;
      seen.add(a.callSid);
      return true;
    })
    .sort((a, b) => toMs(b.at) - toMs(a.at)); // newest first

  const registeredMs = toMs(lastRegisteredAt);
  const base = {
    lastRegisteredAt: lastRegisteredAt || null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCategory: null,
    consecutiveFailures: 0,
    hardFailures: 0,
    softFailures: 0,
    reasons: [],
  };

  const run = [];
  for (const attempt of ordered) {
    const category = classifyDeliveryAttempt(attempt, { inviteReportingVerified });
    if (category === 'delivered') {
      base.lastSuccessAt = attempt.at;
      break;
    }
    run.push({ ...attempt, category });
  }

  const failures = run.filter(a => HARD.has(a.category) || SOFT.has(a.category));
  if (failures.length) {
    base.lastFailureAt = failures[0].at;
    base.lastFailureCategory = failures[0].category;
  }

  if (!Number.isFinite(registeredMs)) {
    return finish({ ...base, consecutiveFailures: failures.length }, STATES.UNREGISTERED, ['app has never registered for calls']);
  }

  // Soft failures that predate the latest registration are cleared: the
  // app was demonstrably alive afterwards. Hard failures are kept but
  // lose their conclusiveness (see header).
  const counted = failures.filter(a => HARD.has(a.category) || toMs(a.at) > registeredMs);
  const hard = counted.filter(a => HARD.has(a.category));
  const soft = counted.filter(a => SOFT.has(a.category));
  const hardAfterRegistration = hard.filter(a => toMs(a.at) > registeredMs);
  const deadTokenAfterRegistration = hardAfterRegistration.some(a => a.category === 'push_failed' && isDeadTokenFailure(a.pushFailure));

  const result = {
    ...base,
    consecutiveFailures: counted.length,
    hardFailures: hard.length,
    softFailures: soft.length,
  };

  const deviceBlock = deviceReadinessBlockReason(deviceReadiness, base.lastSuccessAt);
  if (deviceBlock) {
    return finish(result, STATES.UNREACHABLE, [deviceBlock]);
  }
  if (deadTokenAfterRegistration) {
    return finish(result, STATES.UNREACHABLE, ['push provider reports the app\'s device token is no longer valid']);
  }
  if (hardAfterRegistration.length >= HARD_FAILURE_UNREACHABLE_THRESHOLD) {
    return finish(result, STATES.UNREACHABLE, [`${hardAfterRegistration.length} consecutive calls could not reach the app`]);
  }
  if (hard.length > 0) {
    const reason = hardAfterRegistration.length
      ? 'a recent call could not reach the app'
      : 'calls failed to reach the app before its latest registration; not yet confirmed working since';
    return finish(result, STATES.SUSPECT, [reason]);
  }
  if (soft.length >= SOFT_FAILURE_SUSPECT_THRESHOLD) {
    return finish(result, STATES.SUSPECT, [`${soft.length} consecutive calls went unanswered with no confirmation the phone rang`]);
  }
  if (base.lastSuccessAt) return finish(result, STATES.HEALTHY, []);
  return finish(result, STATES.UNKNOWN, []);
}

// Customer-facing mapping. Customers never see FCM/Twilio/Voice SDK terms.
//   active          — nothing known to be wrong (HEALTHY/UNKNOWN; whether
//                     setup is complete is still the protection checklist's
//                     job, not this one's)
//   needs_attention — SUSPECT
//   unavailable     — UNREACHABLE or UNREGISTERED
function customerDeliveryStatus(state) {
  if (state === STATES.UNREACHABLE || state === STATES.UNREGISTERED) return 'unavailable';
  if (state === STATES.SUSPECT) return 'needs_attention';
  return 'active';
}

function finish(result, state, reasons) {
  return {
    ...result,
    state,
    needsAttention: state === STATES.SUSPECT || state === STATES.UNREACHABLE,
    customerStatus: customerDeliveryStatus(state),
    reasons,
  };
}

const SEVERITY = { UNREGISTERED: 0, UNKNOWN: 0, HEALTHY: 0, SUSPECT: 1, UNREACHABLE: 2 };

// True when `after` is a strictly worse attention state than `before`.
// Used so an alert fires on the transition, not on every later failure.
function isDeliveryHealthDegradation(before, after) {
  if (!after || !after.needsAttention) return false;
  const b = before ? SEVERITY[before.state] || 0 : 0;
  return SEVERITY[after.state] > b;
}

// calls row (snake_case, as stored) → attempt (camelCase, as used here).
function attemptFromCallRow(row) {
  return {
    callSid: row.call_sid || null,
    dialCallSid: row.dial_call_sid || null,
    at: row.created_at,
    dialCallStatus: row.dial_call_status || null,
    clientInviteReceivedAt: row.client_invite_received_at || null,
    clientOutcome: row.client_outcome || null,
    pushFailure: row.push_failure || null,
  };
}

module.exports = {
  STATES,
  HARD_FAILURE_UNREACHABLE_THRESHOLD,
  SOFT_FAILURE_SUSPECT_THRESHOLD,
  classifyDeliveryAttempt,
  computeDeliveryHealth,
  deviceReadinessBlockReason,
  customerDeliveryStatus,
  isDeliveryHealthDegradation,
  isDeadTokenFailure,
  attemptFromCallRow,
};
