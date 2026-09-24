// Unit tests for services/callRouting.js — closes the incident where
// every household's known-contact and screened-safe calls were forwarded
// to one hardcoded number (+447715562700) regardless of which customer's
// Twilio number was dialled, and (2026-09-07) the incident where every
// household was routed into Voice-SDK client-only delivery with no
// reachability check at all. Pure functions, no network/DB/Twilio
// involved.
//
// Scope note (2026-09-08): a households.device_type column and a
// PSTN delivery path for explicitly-classified landline households were
// designed and tested alongside this release, then deferred before
// shipping — read-only production evidence found Twilio's ForwardedFrom
// request parameter, the only live signal available to prove a
// landline's PSTN destination can't loop, carries no usable information
// in this account's real call history (populated with the Twilio number
// itself on all 184 calls checked, never the actual diverting line). A
// guard built on it would have given the appearance of proof while
// providing none. Full evidence: docs/mobile-app/
// APP_DECISION_008_call_delivery_architecture.md's 2026-09-08 update.
// This release ships only the mobile/self-protecting reachability gate
// below — decideCallDeliveryPlan has no landline-specific branch, and no
// plan it returns can ever include a PSTN number, for any household.
//
// Run with: node tests/call-routing.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveForwardingDestination,
  decideCallDeliveryPlan,
  hasVoiceClientRegistrationHistory,
  computeProtectionStatus,
  hasRecentDeliveryProblem,
} = require('../services/callRouting.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const householdA = { id: 'household-a', phone_number: '+441111111111' };
const householdB = { id: 'household-b', phone_number: '+442222222222' };

// --- resolveForwardingDestination (still used directly by server.js's
// attachLiveMonitoring for the SMS-warning destination lookup — not
// called by decideCallDeliveryPlan itself in this release) ---

{
  const result = resolveForwardingDestination(householdA);
  check(result.canForward === true, 'household A: can forward');
  check(result.number === '+441111111111', "household A: resolves to household A's own number");
  check(result.number !== householdB.phone_number, "household A: never resolves to household B's number");
}

{
  const result = resolveForwardingDestination(householdB);
  check(result.canForward === true, 'household B: can forward');
  check(result.number === '+442222222222', "household B: resolves to household B's own number");
  check(result.number !== householdA.phone_number, "household B: never resolves to household A's number");
}

{
  const OLD_HARDCODED_NUMBER = '+447715562700';
  const result = resolveForwardingDestination(householdA);
  check(
    result.number !== OLD_HARDCODED_NUMBER,
    'the old hardcoded fallback number is never returned for a household with its own number on file'
  );
}

{
  const householdWithThatExactNumber = { id: 'household-c', phone_number: '+447715562700' };
  const result = resolveForwardingDestination(householdWithThatExactNumber);
  check(result.canForward === true, 'a household whose own real number happens to match the old constant still forwards correctly');
}

{
  const result = resolveForwardingDestination({ id: 'household-d', phone_number: null });
  check(result.canForward === false, 'null phone_number: fails closed, not forwarded');
  check(result.number === null, 'null phone_number: no destination number is produced');
}

{
  const result = resolveForwardingDestination({ id: 'household-e', phone_number: '' });
  check(result.canForward === false, 'empty-string phone_number: fails closed');
}

{
  const result = resolveForwardingDestination({ id: 'household-f', phone_number: '   ' });
  check(result.canForward === false, 'whitespace-only phone_number: fails closed, not treated as a real number');
}

{
  const result = resolveForwardingDestination({ id: 'household-g' });
  check(result.canForward === false, 'phone_number field entirely absent: fails closed');
}

{
  const result = resolveForwardingDestination(null);
  check(result.canForward === false, 'household itself is null: fails closed rather than throwing');
}

// --- hasVoiceClientRegistrationHistory ---
//
// 2026-09-13 architecture correction: this used to be
// isVoiceClientReachable, gating on registeredAt being no older than the
// Access Token's ~1-hour TTL plus a 15-minute grace window. Confirmed
// directly against Twilio's own current Voice Mobile SDK documentation:
// the push-registration binding this timestamp represents has a TTL of
// roughly ONE YEAR of idle time, entirely independent of the Access
// Token used to establish it. A household that registered minutes, hours,
// or days ago must all be treated identically — only "never registered
// at all" is a genuinely different case. This directly regression-tests
// the real incident: a real household registered ~2 hours earlier was
// incorrectly refused a <Dial><Client> attempt by the old time-windowed check.

{
  check(hasVoiceClientRegistrationHistory(null) === false, 'null registeredAt: never-registered household, no registration history');
  check(hasVoiceClientRegistrationHistory(undefined) === false, 'undefined registeredAt: never-registered household, no registration history');
  check(hasVoiceClientRegistrationHistory('') === false, 'empty-string registeredAt: treated the same as no registration history');
}

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  check(hasVoiceClientRegistrationHistory(tenMinutesAgo) === true, 'registered 10 minutes ago: has registration history');
}

{
  // The exact real-world incident this fix closes: a registration from
  // ~2 hours ago (well past the old 75-minute window) must still count.
  const now = new Date('2026-09-07T12:00:00.000Z');
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  check(
    hasVoiceClientRegistrationHistory(twoHoursAgo) === true,
    'registered 2 hours ago (past the old 75-minute window): still has registration history — the stale-timestamp-alone regression this fix closes'
  );
}

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  const severalDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  check(
    hasVoiceClientRegistrationHistory(severalDaysAgo) === true,
    'registered several days ago: still has registration history — a stale timestamp alone can no longer produce self-protecting-unreachable'
  );
}

{
  // A registeredAt in the future is a malformed/clock-skew input, not a
  // meaningful "not registered" signal — this function only asks "does a
  // registration timestamp exist at all," so a genuinely present (if odd)
  // value still counts. Fail-closed behaviour for bad input is handled by
  // the caller resolving voice_client_registered_at from a real database
  // column, not by this function second-guessing the value's plausibility.
  const inTheFuture = new Date(Date.now() + 60_000).toISOString();
  check(hasVoiceClientRegistrationHistory(inTheFuture) === true, 'a non-null registeredAt (even one somehow in the future) still counts as registration history');
}

// --- decideCallDeliveryPlan: reachable -> client-only ---

{
  const household = { id: 'h-a', phone_number: '+447700900003' };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-a', { voiceClientReachable: true });
  check(plan.mode === 'client-only', 'reachable household: delivery mode is client-only');
  check(plan.clientIdentity === 'client:household_h-a', 'the correct client identity is used');
  check(!('number' in plan), 'the returned plan has no "number" key at all — not just null, structurally absent, so a PSTN number can never leak into TwiML from this plan');
}

{
  const household = { id: 'h-b', phone_number: '+447700900004' };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-b', { voiceClientReachable: true });
  check(plan.mode === 'client-only', 'a second, differently-shaped household: still client-only when reachable');
}

// --- decideCallDeliveryPlan: unreachable -> fail safely, never PSTN ---

{
  const household = { id: 'h-c', phone_number: '+447700900005' };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-c', { voiceClientReachable: false });
  check(plan.mode === 'self-protecting-unreachable', 'unreachable household: mode is self-protecting-unreachable');
  check(!('number' in plan), 'unreachable household: the plan has absolutely no "number" key — the absolute invariant, never weakened by unreachability');
  check(!('clientIdentity' in plan), 'unreachable household: no Client leg is attempted either — a doomed dial is never built');
}

{
  const household = { id: 'h-d', phone_number: '+447700900006' };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-d', { voiceClientReachable: false });
  check(plan.mode === 'self-protecting-unreachable', 'a second household: still self-protecting-unreachable when not reachable');
}

{
  // Omitting the options argument entirely defaults voiceClientReachable
  // to false — the safe default, never accidentally treated as reachable.
  const household = { id: 'h-e', phone_number: '+447700900007' };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-e');
  check(plan.mode === 'self-protecting-unreachable', 'omitted options argument: defaults to unreachable, never silently client-only');
}

// --- decideCallDeliveryPlan: NULL/legacy household data behaves exactly
// like any other household — no special-casing, no PSTN, ever ---

{
  const household = { id: 'h-legacy', phone_number: '+447700900008' };
  const reachablePlan = decideCallDeliveryPlan(household, 'client:household_h-legacy', { voiceClientReachable: true });
  check(reachablePlan.mode === 'client-only', 'household with no other classification data: client-only when reachable');

  const unreachablePlan = decideCallDeliveryPlan(household, 'client:household_h-legacy', { voiceClientReachable: false });
  check(unreachablePlan.mode === 'self-protecting-unreachable', 'household with no other classification data, unreachable: self-protecting-unreachable, never PSTN');
  check(!('number' in unreachablePlan), 'never a PSTN number, regardless of any other field');
}

{
  // household itself null: the one genuinely distinct fail-closed case —
  // no household matches the dialled Twilio number at all, so there is no
  // clientIdentity to dial and no meaningful reachability question.
  const plan = decideCallDeliveryPlan(null, 'client:household_x', { voiceClientReachable: true });
  check(plan.mode === 'fail-closed', 'household itself null: fails closed rather than throwing, regardless of voiceClientReachable — never a Client dial with a null identity');
  check(!('number' in plan), 'household itself null: never a fabricated PSTN number either');
}

// --- F&F / paid entitlement sources behave identically ---
// (decideCallDeliveryPlan never reads entitlement/source data at all —
// proven here by constructing the same household shape with an extra,
// irrelevant `entitlementSource` field and confirming identical output
// either way, for both the reachable and unreachable case)

{
  const base = { id: 'h-source-test', phone_number: '+447700900011' };
  const opts = { voiceClientReachable: true };
  const stripeResult = decideCallDeliveryPlan({ ...base, entitlementSource: 'stripe' }, 'x', opts);
  const revenuecatResult = decideCallDeliveryPlan({ ...base, entitlementSource: 'apple_revenuecat' }, 'x', opts);
  const complimentaryResult = decideCallDeliveryPlan({ ...base, entitlementSource: 'admin_manual' }, 'x', opts);
  check(
    stripeResult.mode === revenuecatResult.mode && revenuecatResult.mode === complimentaryResult.mode && stripeResult.mode === 'client-only',
    'reachable: stripe/revenuecat/complimentary entitlement sources produce identical routing (client-only)'
  );
}

{
  const base = { id: 'h-source-test-2', phone_number: '+447700900012' };
  const opts = { voiceClientReachable: false };
  const stripeResult = decideCallDeliveryPlan({ ...base, entitlementSource: 'stripe' }, 'x', opts);
  const revenuecatResult = decideCallDeliveryPlan({ ...base, entitlementSource: 'apple_revenuecat' }, 'x', opts);
  const complimentaryResult = decideCallDeliveryPlan({ ...base, entitlementSource: 'admin_manual' }, 'x', opts);
  check(
    stripeResult.mode === revenuecatResult.mode && revenuecatResult.mode === complimentaryResult.mode && stripeResult.mode === 'self-protecting-unreachable',
    'unreachable: stripe/revenuecat/complimentary entitlement sources produce identical routing (self-protecting-unreachable, never PSTN)'
  );
}

// --- computeProtectionStatus ---

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  const household = {
    voice_client_registered_at: new Date(now.getTime() - 5_000).toISOString(),
    delivery_verified_at: '2026-09-07T11:59:00.000Z',
  };
  const status = computeProtectionStatus(household, now);
  check(status.deliveryReady === true, 'currently reachable: deliveryReady true');
  check(status.endToEndDeliveryVerified === true, 'real delivery evidence on file: endToEndDeliveryVerified true');
  check(status.fullyProtected === true, 'reachable now AND real delivery evidence exists: fullyProtected true');
}

{
  // Reachable now, but never actually proven to deliver a call — the
  // exact "reachability is necessary but not sufficient" case this
  // design exists to enforce.
  const now = new Date('2026-09-07T12:00:00.000Z');
  const household = {
    voice_client_registered_at: new Date(now.getTime() - 5_000).toISOString(),
    delivery_verified_at: null,
  };
  const status = computeProtectionStatus(household, now);
  check(status.deliveryReady === true, 'reachable but never proven to deliver: deliveryReady is still true (it is a capability fact)');
  check(status.fullyProtected === false, 'reachable but never proven to deliver: fullyProtected is false — reachability alone is not proof');
}

{
  // 2026-09-13 architecture correction: a long-old registration timestamp
  // (previously treated as "stale" past the 75-minute window) must now
  // still count as registration history — Twilio's real push-registration
  // binding lasts ~1 year, so this is no longer a meaningful regression
  // signal on its own. This directly regression-tests the real incident.
  const now = new Date('2026-09-07T12:00:00.000Z');
  const household = {
    voice_client_registered_at: '2026-01-01T00:00:00.000Z',
    delivery_verified_at: '2026-01-01T00:05:00.000Z',
  };
  const status = computeProtectionStatus(household, now);
  check(status.deliveryReady === true, 'evidence exists and registration is long old (months): deliveryReady is still true — a stale timestamp alone no longer regresses this');
  check(status.fullyProtected === true, 'long-old registration with real past delivery evidence: fullyProtected true — no longer incorrectly regressed by elapsed time alone');
}

{
  // Forwarding verified but delivery never proven — the exact case this
  // whole change series exists to prevent: activationVerifiedAt alone
  // must never imply fullyProtected.
  const now = new Date('2026-09-07T12:00:00.000Z');
  const household = {
    activation_verified_at: '2026-09-06T12:00:00.000Z',
    voice_client_registered_at: null,
    delivery_verified_at: null,
  };
  const status = computeProtectionStatus(household, now);
  check(status.forwardingVerified === true, 'forwarding-only: forwardingVerified is still true (it genuinely happened)');
  check(status.fullyProtected === false, 'forwarding verified but never delivered and never reachable: fullyProtected is false — forwarding alone never claims protection');
}

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  const household = { activation_verified_at: '2026-09-06T12:00:00.000Z', delivery_verified_at: '2026-09-06T12:05:00.000Z' };
  const status = computeProtectionStatus(household, now);
  check(status.deliveryReady === false, 'household with no voice_client_registered_at at all (never registered, or every pre-migration-035 household): deliveryReady is false, never assumed ready');
  check(status.fullyProtected === false, 'never assumed fully protected without current reachability, regardless of past delivery evidence');
}

{
  const status = computeProtectionStatus(null, new Date());
  check(status.fullyProtected === false, 'household itself null: fullyProtected false rather than throwing');
  check(status.deliveryReady === false, 'household itself null: deliveryReady false rather than throwing');
}

// --- hasRecentDeliveryProblem (diagnostic instrumentation, 2026-09-24) ---
// Real production case this closes: p_deane@sky.com's 16:20 UTC call on
// 2026-09-24 reached HCG, a real <Dial><Client> was attempted, and it
// resulted in duration_seconds: 0 with no dial_call_status persisted at
// all at the time — this is exactly the gap migration 044 closes.

check(
  hasRecentDeliveryProblem(null, null) === false,
  'no dial attempt on record at all: never a problem (nothing to compare — e.g. a household that has never received a call)'
);
check(
  hasRecentDeliveryProblem({ dial_call_status: null, created_at: '2026-09-24T16:00:00Z' }, null) === false,
  'a call row exists but no dial was ever attempted (dial_call_status null — e.g. screened out, or routed to self-protecting-unreachable without ever building a <Dial>): never a problem'
);
check(
  hasRecentDeliveryProblem({ dial_call_status: 'completed', created_at: '2026-09-24T16:00:00Z' }, null) === false,
  'the most recent dial attempt succeeded: never a problem, regardless of delivery_verified_at'
);
check(
  hasRecentDeliveryProblem({ dial_call_status: 'no-answer', created_at: '2026-09-24T16:20:14Z' }, null) === true,
  'a genuine failed dial attempt (no-answer) with no prior confirmed delivery at all: a real problem — real case, 2026-09-24 (p_deane@sky.com)'
);
check(
  hasRecentDeliveryProblem({ dial_call_status: 'failed', created_at: '2026-09-24T16:20:14Z' }, '2026-09-19T14:54:28Z') === true,
  'a genuine failed dial attempt more recent than the last confirmed success: a real problem, even though the household has worked before'
);
check(
  hasRecentDeliveryProblem({ dial_call_status: 'no-answer', created_at: '2026-09-18T10:00:00Z' }, '2026-09-19T14:54:28Z') === false,
  'a failed dial attempt OLDER than the last confirmed success: not a current problem — a later success supersedes an earlier failure'
);
check(
  hasRecentDeliveryProblem({ dial_call_status: 'busy', created_at: 'not-a-real-date' }, '2026-09-19T14:54:28Z') === true,
  'an unparseable timestamp fails closed (treated as a problem) rather than silently hiding a genuine failure behind a NaN comparison'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
