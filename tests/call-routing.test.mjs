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
  isVoiceClientReachable,
  computeProtectionStatus,
} = require('../services/callRouting.js');
const { DEFAULT_TTL_SECONDS } = require('../services/voiceAccessToken.js');

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

// --- isVoiceClientReachable ---

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  check(isVoiceClientReachable(null, now) === false, 'null registeredAt: never reachable');
  check(isVoiceClientReachable(undefined, now) === false, 'undefined registeredAt: never reachable');
}

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  const justRegistered = new Date(now.getTime() - 5_000).toISOString();
  check(isVoiceClientReachable(justRegistered, now) === true, 'registered 5 seconds ago: reachable');
}

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  // Exactly at the TTL + grace boundary — still reachable (inclusive).
  const atBoundary = new Date(now.getTime() - (DEFAULT_TTL_SECONDS + 15 * 60) * 1000).toISOString();
  check(isVoiceClientReachable(atBoundary, now) === true, 'registered exactly at the TTL+grace boundary: still reachable (inclusive)');
}

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  // One second past the TTL + grace boundary — no longer reachable.
  const pastBoundary = new Date(now.getTime() - ((DEFAULT_TTL_SECONDS + 15 * 60) * 1000 + 1000)).toISOString();
  check(isVoiceClientReachable(pastBoundary, now) === false, 'registered one second past the TTL+grace boundary: no longer reachable');
}

{
  const now = new Date('2026-09-07T12:00:00.000Z');
  const inTheFuture = new Date(now.getTime() + 60_000).toISOString();
  check(isVoiceClientReachable(inTheFuture, now) === false, 'a registeredAt somehow in the future is never treated as reachable');
}

{
  check(isVoiceClientReachable('not-a-real-date', new Date()) === false, 'an unparseable registeredAt fails closed rather than throwing');
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
  // Proven once, but no longer currently reachable.
  const now = new Date('2026-09-07T12:00:00.000Z');
  const household = {
    voice_client_registered_at: '2026-01-01T00:00:00.000Z',
    delivery_verified_at: '2026-01-01T00:05:00.000Z',
  };
  const status = computeProtectionStatus(household, now);
  check(status.deliveryReady === false, 'evidence exists but registration is long stale: deliveryReady false');
  check(status.fullyProtected === false, 'stale registration despite past delivery evidence: fullyProtected false — delivery capability can regress after one real success');
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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
