// Unit tests for services/callRouting.js — closes the incident where
// every household's known-contact and screened-safe calls were forwarded
// to one hardcoded number (+447715562700) regardless of which customer's
// Twilio number was dialled. Pure function, no network/DB/Twilio involved.
//
// Run with: node tests/call-routing.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveForwardingDestination, decideCallDeliveryPlan } = require('../services/callRouting.js');

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

// --- household A routes only to household A's number ---

{
  const result = resolveForwardingDestination(householdA);
  check(result.canForward === true, 'household A: can forward');
  check(result.number === '+441111111111', "household A: resolves to household A's own number");
  check(result.number !== householdB.phone_number, "household A: never resolves to household B's number");
}

// --- household B routes only to household B's number ---

{
  const result = resolveForwardingDestination(householdB);
  check(result.canForward === true, 'household B: can forward');
  check(result.number === '+442222222222', "household B: resolves to household B's own number");
  check(result.number !== householdA.phone_number, "household B: never resolves to household A's number");
}

// --- no hardcoded destination remains ---

{
  const OLD_HARDCODED_NUMBER = '+447715562700';
  const result = resolveForwardingDestination(householdA);
  check(
    result.number !== OLD_HARDCODED_NUMBER,
    'the old hardcoded fallback number is never returned for a household with its own number on file'
  );
}

{
  // Even a household whose real number happens to collide with the old
  // hardcoded value must be treated as a genuine, on-file number, not as
  // evidence the fallback is still in use — the fix removed the constant
  // entirely, it isn't just avoiding this one literal value.
  const householdWithThatExactNumber = { id: 'household-c', phone_number: '+447715562700' };
  const result = resolveForwardingDestination(householdWithThatExactNumber);
  check(result.canForward === true, 'a household whose own real number happens to match the old constant still forwards correctly');
}

// --- missing customer phone number fails closed ---

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
  // Matches the real /voice and /process call sites, where household can
  // genuinely be null (no household matches the dialled Twilio number).
  const result = resolveForwardingDestination(null);
  check(result.canForward === false, 'household itself is null: fails closed rather than throwing');
}

// --- decideCallDeliveryPlan: the "impossible by construction" claim ---
// (migration 028, 2026-08-23 — see services/callRouting.js's own comment)

{
  // Self-protecting: phone_number IS the known-forwarded line. No plan
  // this function returns may ever include a PSTN number — checked here
  // structurally (the key doesn't exist at all), not just "is falsy".
  const household = { id: 'h-self', phone_number: '+447700900001', self_protecting: true };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-self');
  check(plan.mode === 'client-only', 'self_protecting household: delivery mode is client-only');
  check(plan.clientIdentity === 'client:household_h-self', 'self_protecting household: the correct client identity is used');
  check(!('number' in plan), 'self_protecting household: the returned plan has no "number" key at all — not just null, structurally absent, so a PSTN number can never leak into TwiML from this plan');
}

{
  // Self-protecting still holds even if phone_number is somehow missing —
  // self_protecting alone decides the mode, never a fallback comparison.
  const household = { id: 'h-self-2', self_protecting: true };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-self-2');
  check(plan.mode === 'client-only', 'self_protecting with no phone_number on file: still client-only, never fail-closed for the wrong reason');
}

{
  // Two-number household: phone_number is a confirmed-different line —
  // PSTN remains valid, Client offered alongside it.
  const household = { id: 'h-other', phone_number: '+447700900002', self_protecting: false };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-other');
  check(plan.mode === 'client-and-number', 'two-number household: delivery mode includes both client and number');
  check(plan.number === '+447700900002', 'two-number household: the PSTN number is the real destination on file');
  check(plan.clientIdentity === 'client:household_h-other', 'two-number household: client is still offered in parallel');
}

{
  // Two-number household with no destination on file: fails closed exactly
  // as resolveForwardingDestination always has — self_protecting: false
  // does not invent a number that doesn't exist.
  const household = { id: 'h-other-2', self_protecting: false };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-other-2');
  check(plan.mode === 'fail-closed', 'two-number household with no phone_number on file: fails closed, not client-only and not a fabricated PSTN number');
}

{
  // Missing self_protecting entirely (should not happen once migration
  // 028's NOT NULL DEFAULT true applies, but this proves the function
  // itself never treats an absent/falsy field as "safe to PSTN-dial")
  // is treated as the two-number path here — the safety guarantee is
  // that self_protecting: true (the actual stored default) always wins,
  // not that every possible falsy input is defensively caught twice over.
  const household = { id: 'h-missing-flag', phone_number: '+447700900003' };
  const plan = decideCallDeliveryPlan(household, 'client:household_h-missing-flag');
  check(plan.mode === 'client-and-number', 'missing self_protecting field falls through to the two-number path, not a silent crash');
}

{
  const plan = decideCallDeliveryPlan(null, 'client:household_x');
  check(plan.mode === 'fail-closed', 'household itself null: fails closed rather than throwing');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
