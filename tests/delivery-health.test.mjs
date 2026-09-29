// Unit tests for services/deliveryHealth.js — the evidence-based
// call-delivery health model (2026-09-29, P0 call-delivery resilience),
// written after household f06bc964 failed 4/4 app deliveries on 24–26
// Sep 2026 while every status surface still said "Protection Active".
// Pure functions, no network/DB/Twilio.
//
// Run with: node tests/delivery-health.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  STATES,
  classifyDeliveryAttempt,
  computeDeliveryHealth,
  customerDeliveryStatus,
  isDeliveryHealthDegradation,
  isDeadTokenFailure,
  attemptFromCallRow,
} = require('../services/deliveryHealth.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

let n = 0;
const at = minutes => new Date(Date.UTC(2026, 8, 25, 12, 0) + minutes * 60000).toISOString();
const attempt = (minutes, fields) => ({ callSid: `CA${String(++n).padStart(32, '0')}`, at: at(minutes), ...fields });
const delivered = m => attempt(m, { dialCallStatus: 'completed' });
const noAnswer = m => attempt(m, { dialCallStatus: 'no-answer' });
const pushDead = m => attempt(m, { dialCallStatus: 'no-answer', pushFailure: 'fcm:NotRegistered' });
const REG_EARLY = at(-10000);

// --- classification: never treat every unanswered call as an app failure ---
check(classifyDeliveryAttempt({ dialCallStatus: 'completed' }) === 'delivered', 'completed → delivered');
check(classifyDeliveryAttempt({ dialCallStatus: 'no-answer', clientOutcome: 'rejected' }) === 'customer_declined', 'customer declined → neutral customer_declined');
check(classifyDeliveryAttempt({ dialCallStatus: 'no-answer', clientOutcome: 'cancelled' }) === 'caller_abandoned', 'app saw caller hang up → caller_abandoned');
check(classifyDeliveryAttempt({ dialCallStatus: 'canceled' }) === 'caller_abandoned', "Twilio 'canceled' → caller_abandoned");
check(classifyDeliveryAttempt({ dialCallStatus: 'busy' }) === 'customer_busy', 'busy → neutral customer_busy');
check(classifyDeliveryAttempt({ dialCallStatus: 'no-answer', clientInviteReceivedAt: at(0) }) === 'rang_unanswered', 'phone confirmed ringing, nobody answered → rang_unanswered (app works)');
check(classifyDeliveryAttempt({ dialCallStatus: 'no-answer', pushFailure: 'fcm:NotRegistered' }) === 'push_failed', 'push failure (52103) → push_failed');
check(classifyDeliveryAttempt({ dialCallStatus: 'failed' }) === 'delivery_error', "Dial 'failed' (SDK/infrastructure) → delivery_error");
check(classifyDeliveryAttempt({ dialCallStatus: 'no-answer' }) === 'unconfirmed_no_answer', 'no-answer with no device evidence → unconfirmed (soft), not a proven app failure');
check(classifyDeliveryAttempt({ dialCallStatus: 'no-answer' }, { inviteReportingVerified: true }) === 'not_reached_device',
  'no-answer with no invite report, from an app known to report invites → not_reached_device (hard)');
check(classifyDeliveryAttempt({ dialCallStatus: 'no-answer', clientOutcome: 'accepted' }) === 'delivered', 'accepted on device → delivered');
check(classifyDeliveryAttempt({ dialCallStatus: 'failed', clientOutcome: 'accepted' }) === 'delivery_error', 'accepted but Dial failed → delivery_error, not delivered');
check(classifyDeliveryAttempt({}) === 'unknown', 'no status → unknown (soft)');

check(isDeadTokenFailure('fcm:NotRegistered') && isDeadTokenFailure('apns:BadDeviceToken') && isDeadTokenFailure('fcm:InvalidRegistration'),
  'dead-token failures recognised for FCM and APNs');
check(!isDeadTokenFailure('fcm:QuotaExceeded') && !isDeadTokenFailure(null), 'transient push failures are not dead-token');

// --- no registration ---
const unreg = computeDeliveryHealth({ attempts: [], lastRegisteredAt: null });
check(unreg.state === STATES.UNREGISTERED && unreg.customerStatus === 'unavailable', 'never registered → UNREGISTERED / unavailable');

// --- valid registration, no calls yet ---
const fresh = computeDeliveryHealth({ attempts: [], lastRegisteredAt: REG_EARLY });
check(fresh.state === STATES.UNKNOWN && !fresh.needsAttention && fresh.customerStatus === 'active', 'registered, no calls → UNKNOWN, not flagged');

// --- valid registration + successful call ---
const ok = computeDeliveryHealth({ attempts: [delivered(0)], lastRegisteredAt: REG_EARLY });
check(ok.state === STATES.HEALTHY && ok.lastSuccessAt === at(0), 'registration + delivered call → HEALTHY');

// --- dead FCM token / 52103: one is conclusive ---
const dead = computeDeliveryHealth({ attempts: [delivered(0), pushDead(10)], lastRegisteredAt: REG_EARLY });
check(dead.state === STATES.UNREACHABLE && dead.customerStatus === 'unavailable' && dead.needsAttention,
  'one 52103 NotRegistered after the latest registration → UNREACHABLE immediately');
check(dead.lastFailureCategory === 'push_failed' && dead.lastFailureAt === at(10), 'last failure category and time reported');

const transientPush = computeDeliveryHealth({ attempts: [delivered(0), attempt(10, { dialCallStatus: 'no-answer', pushFailure: 'fcm:Unavailable' })], lastRegisteredAt: REG_EARLY });
check(transientPush.state === STATES.SUSPECT, 'one transient (non-dead-token) push failure → SUSPECT, not UNREACHABLE');

// --- hard failures ---
const oneHard = computeDeliveryHealth({ attempts: [delivered(0), attempt(10, { dialCallStatus: 'failed' })], lastRegisteredAt: REG_EARLY });
check(oneHard.state === STATES.SUSPECT, '1 Dial failure → SUSPECT');
const twoHard = computeDeliveryHealth({ attempts: [delivered(0), attempt(10, { dialCallStatus: 'failed' }), attempt(20, { dialCallStatus: 'failed' })], lastRegisteredAt: REG_EARLY });
check(twoHard.state === STATES.UNREACHABLE && twoHard.consecutiveFailures === 2, '2 consecutive hard failures → UNREACHABLE');

// --- soft failures: 2 is ordinary life, 3 needs attention ---
const twoSoft = computeDeliveryHealth({ attempts: [delivered(0), noAnswer(10), noAnswer(20)], lastRegisteredAt: REG_EARLY });
check(twoSoft.state === STATES.HEALTHY && !twoSoft.needsAttention, '2 unconfirmed no-answers → not flagged (customer may just be out)');
const threeSoft = computeDeliveryHealth({ attempts: [delivered(0), noAnswer(10), noAnswer(20), noAnswer(30)], lastRegisteredAt: REG_EARLY });
check(threeSoft.state === STATES.SUSPECT && threeSoft.customerStatus === 'needs_attention', '3 consecutive unconfirmed no-answers → SUSPECT / needs_attention, never unavailable');

// --- success resets the sequence ---
const reset = computeDeliveryHealth({ attempts: [pushDead(0), noAnswer(10), noAnswer(20), delivered(30)], lastRegisteredAt: REG_EARLY });
check(reset.state === STATES.HEALTHY && reset.consecutiveFailures === 0, 'a delivered call resets the failure run');
const afterReset = computeDeliveryHealth({ attempts: [pushDead(0), delivered(30), noAnswer(40)], lastRegisteredAt: REG_EARLY });
check(afterReset.state === STATES.HEALTHY && afterReset.consecutiveFailures === 1, 'failures before the last success are not counted');

// --- neutral outcomes neither count nor reset ---
const neutral = computeDeliveryHealth({
  attempts: [
    delivered(0),
    attempt(10, { dialCallStatus: 'no-answer', clientOutcome: 'rejected' }),
    attempt(20, { dialCallStatus: 'canceled' }),
    attempt(30, { dialCallStatus: 'no-answer', clientInviteReceivedAt: at(30) }),
    attempt(40, { dialCallStatus: 'busy' }),
  ],
  lastRegisteredAt: REG_EARLY,
});
check(neutral.state === STATES.HEALTHY && neutral.consecutiveFailures === 0, 'declined / caller abandoned / rang unanswered / busy → never failures');
const neutralBetween = computeDeliveryHealth({
  attempts: [delivered(0), attempt(10, { dialCallStatus: 'failed' }), attempt(20, { dialCallStatus: 'canceled' }), attempt(30, { dialCallStatus: 'failed' })],
  lastRegisteredAt: REG_EARLY,
});
check(neutralBetween.state === STATES.UNREACHABLE, 'a neutral outcome between two hard failures does not reset the run');

// --- stale historical registration: time alone never flags ---
const oldReg = computeDeliveryHealth({ attempts: [delivered(-500000)], lastRegisteredAt: at(-600000) });
check(oldReg.state === STATES.HEALTHY, 'an old registration with no failures since is not flagged by age alone (sparse call households)');

// --- re-registration recovery (f06bc964 shape) ---
const beforeRereg = computeDeliveryHealth({ attempts: [delivered(-5000), pushDead(0), pushDead(1000)], lastRegisteredAt: REG_EARLY });
check(beforeRereg.state === STATES.UNREACHABLE, 'f06bc964 as of 25 Sep: dead token → UNREACHABLE');
const afterRereg = computeDeliveryHealth({ attempts: [delivered(-5000), pushDead(0), pushDead(1000)], lastRegisteredAt: at(2000) });
check(afterRereg.state === STATES.SUSPECT && afterRereg.customerStatus === 'needs_attention',
  're-registration after the failures downgrades UNREACHABLE → SUSPECT, never straight to HEALTHY');
const afterReregFail = computeDeliveryHealth({ attempts: [delivered(-5000), pushDead(0), pushDead(1000), noAnswer(2002)], lastRegisteredAt: at(2000) });
check(afterReregFail.state === STATES.SUSPECT, 'f06bc964 as of 26 Sep 14:09 (unanswered 2 min after re-registering) → still SUSPECT');
const afterReregOk = computeDeliveryHealth({ attempts: [pushDead(0), pushDead(1000), delivered(2002)], lastRegisteredAt: at(2000) });
check(afterReregOk.state === STATES.HEALTHY, 'only a delivered call after re-registration restores HEALTHY');
const softCleared = computeDeliveryHealth({ attempts: [delivered(0), noAnswer(10), noAnswer(20), noAnswer(30)], lastRegisteredAt: at(40) });
check(softCleared.state === STATES.HEALTHY && softCleared.consecutiveFailures === 0, 'soft failures that predate a new registration are cleared (app proved alive)');
const newDead = computeDeliveryHealth({ attempts: [pushDead(0), pushDead(3000)], lastRegisteredAt: at(2000) });
check(newDead.state === STATES.UNREACHABLE, 'a dead-token failure AFTER re-registration → UNREACHABLE again');

// --- app offline / backend error shapes ---
const offline = computeDeliveryHealth({ attempts: [delivered(0), noAnswer(10), noAnswer(20)], lastRegisteredAt: REG_EARLY, inviteReportingVerified: true });
check(offline.state === STATES.UNREACHABLE, 'app offline (invite-reporting app never saw the invite, twice) → UNREACHABLE');
const offlineOnce = computeDeliveryHealth({ attempts: [delivered(0), noAnswer(10)], lastRegisteredAt: REG_EARLY, inviteReportingVerified: true });
check(offlineOnce.state === STATES.SUSPECT, 'app offline once → SUSPECT');
const backendDown = computeDeliveryHealth({ attempts: [delivered(0)], lastRegisteredAt: REG_EARLY });
check(backendDown.state === STATES.HEALTHY,
  'HCG backend unavailable produces no delivery attempt row at all → health is unchanged (infrastructure failures are surfaced by Twilio 11200 alerts / health checks, not blamed on the app)');

// --- duplicate events ---
const dup = attempt(10, { dialCallStatus: 'failed' });
const dupHealth = computeDeliveryHealth({ attempts: [delivered(0), dup, { ...dup }], lastRegisteredAt: REG_EARLY });
check(dupHealth.state === STATES.SUSPECT && dupHealth.consecutiveFailures === 1, 'duplicate rows for the same CallSid are counted once');
const order = computeDeliveryHealth({ attempts: [noAnswer(30), delivered(0), noAnswer(20), noAnswer(10)], lastRegisteredAt: REG_EARLY });
check(order.state === STATES.SUSPECT, 'input order does not matter');
const junk = computeDeliveryHealth({ attempts: [null, { at: 'not-a-date', dialCallStatus: 'failed' }, delivered(0)], lastRegisteredAt: REG_EARLY });
check(junk.state === STATES.HEALTHY, 'malformed attempts are ignored');

// --- degradation (alert-once semantics) ---
check(isDeliveryHealthDegradation(ok, oneHard), 'HEALTHY → SUSPECT is a degradation');
check(isDeliveryHealthDegradation(oneHard, twoHard), 'SUSPECT → UNREACHABLE is a degradation');
check(!isDeliveryHealthDegradation(twoHard, twoHard), 'UNREACHABLE → UNREACHABLE is not (no repeat alert per call)');
check(!isDeliveryHealthDegradation(twoHard, ok), 'recovery is not a degradation');
check(!isDeliveryHealthDegradation(null, ok), 'healthy with no prior state is not a degradation');
check(isDeliveryHealthDegradation(null, dead), 'first-ever evaluation that is UNREACHABLE is a degradation');

// --- customer mapping never leaks provider terms ---
for (const s of Object.values(STATES)) {
  const status = customerDeliveryStatus(s);
  check(['active', 'needs_attention', 'unavailable'].includes(status), `customer status for ${s} is one of the three plain states (${status})`);
}
for (const h of [dead, afterRereg, threeSoft]) {
  check(!/fcm|twilio|52103|token|sdk/i.test(h.customerStatus), 'customerStatus contains no provider terminology');
}

// --- row mapping ---
const mapped = attemptFromCallRow({ call_sid: 'CA1', created_at: at(0), dial_call_status: 'no-answer', client_invite_received_at: null, client_outcome: null, push_failure: 'fcm:NotRegistered' });
check(mapped.callSid === 'CA1' && mapped.pushFailure === 'fcm:NotRegistered' && mapped.dialCallStatus === 'no-answer', 'calls row maps to attempt');
check(attemptFromCallRow({ call_sid: 'CA2', created_at: at(0), dial_call_status: 'failed' }).pushFailure === null, 'pre-055 rows (no push_failure column) map cleanly');

if (failures) {
  console.error(`\n✗ ${failures} delivery-health checks FAILED`);
  process.exit(1);
}
console.log('\n✓ All delivery-health checks passed');
