// Unit tests for services/callRouting.js — closes the incident where
// every household's known-contact and screened-safe calls were forwarded
// to one hardcoded number (+447715562700) regardless of which customer's
// Twilio number was dialled. Pure function, no network/DB/Twilio involved.
//
// Run with: node tests/call-routing.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveForwardingDestination, resolveCallDelivery } = require('../services/callRouting.js');

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

// --- forwarding-loop guard (2026-08-15) ---
//
// Closes the real production incident: household.phone_number is both
// the customer's own number AND the number their carrier's unconditional
// forwarding (*21*) sends to us — so dialling it back for a genuinely
// screened-safe call gets carrier-intercepted right back to us, creating
// a new inbound call that re-enters /voice and asks the caller their
// reason again, forever. Twilio's ForwardedFrom is the direct evidence
// this exact call arrived via that forward; the guard fires only then.

{
  const household = { id: 'household-loop', phone_number: '+447715562700' };
  const result = resolveForwardingDestination(household, '+447715562700');
  check(result.canForward === false, 'forwardedFrom matches phone_number: fails closed rather than re-dialling into the loop');
  check(result.number === null, 'forwardedFrom matches phone_number: no destination number is produced');
}

{
  // Same household, same real number — but this particular call did NOT
  // arrive via a forward (no ForwardedFrom), so it is safe to connect.
  // This is the ordinary case: a genuine external caller, screened SAFE,
  // reaching the customer for the first time.
  const household = { id: 'household-loop', phone_number: '+447715562700' };
  const result = resolveForwardingDestination(household, undefined);
  check(result.canForward === true, 'no forwardedFrom: an ordinary safe call still connects normally');
  check(result.number === '+447715562700', 'no forwardedFrom: resolves to the household\'s real number');
}

{
  // forwardedFrom present but from a DIFFERENT number than phone_number —
  // e.g. forwarded from some other line entirely. Not the loop condition.
  const household = { id: 'household-loop', phone_number: '+447715562700' };
  const result = resolveForwardingDestination(household, '+449999999999');
  check(result.canForward === true, 'forwardedFrom present but different from phone_number: still connects');
}

{
  // Format variation (spaces, no +) must still be recognised as the same
  // number — mirrors wouldCreateForwardingLoop's own normalisation tests.
  const household = { id: 'household-loop', phone_number: '+447715562700' };
  const result = resolveForwardingDestination(household, '07715 562700');
  check(result.canForward === false, 'forwardedFrom in a different but equivalent format still triggers the guard');
}

// --- resolveCallDelivery (2026-08-15, same-phone VoIP delivery) ---
//
// Feature-flagged decision between PSTN dial-back (today's production
// behaviour, including the forwardedFrom loop guard) and Voice SDK
// Client delivery (the actual same-phone fix — see
// docs/operations/HANDOVER_2026-08-15.md SS12-18). clientDeliveryEnabled
// is always passed explicitly here rather than mutating process.env, so
// these checks are hermetic regardless of run order or the real
// deployment's env configuration.

{
  const household = { id: 'household-a', phone_number: '+441111111111' };
  const result = resolveCallDelivery(household, undefined, false);
  check(result.mode === 'pstn', 'flag off: falls back to PSTN mode');
  check(result.number === '+441111111111', 'flag off: PSTN mode resolves to the household\'s real number');
}

{
  const household = { id: 'household-a', phone_number: '+441111111111' };
  const result = resolveCallDelivery(household, undefined, true);
  check(result.mode === 'client', 'flag on: uses client delivery instead of PSTN');
  check(result.identity === 'household_household-a', 'flag on: identity matches buildVoiceClientIdentity — never the phone number');
  check(!('number' in result), 'flag on: no phone number is present in a client-mode result');
}

{
  // The whole point of client delivery: it must not be defeated by the
  // exact condition that breaks PSTN delivery (the household's own
  // number appearing as forwardedFrom, i.e. the real production
  // incident). Client mode has no PSTN leg for the carrier to loop.
  const household = { id: 'household-loop', phone_number: '+447715562700' };
  const pstnResult = resolveCallDelivery(household, '+447715562700', false);
  const clientResult = resolveCallDelivery(household, '+447715562700', true);
  check(pstnResult.mode === 'fail-closed', 'flag off + forwarding-loop condition: still fails closed (unchanged today\'s behaviour)');
  check(clientResult.mode === 'client', 'flag on + the exact same forwarding-loop condition: client delivery is unaffected, connects normally');
}

{
  const result = resolveCallDelivery(null, undefined, true);
  check(result.mode === 'fail-closed', 'flag on but household is null: fails closed rather than building an identity for nothing');
}

{
  const result = resolveCallDelivery({ id: 'household-e', phone_number: null }, undefined, false);
  check(result.mode === 'fail-closed', 'flag off, no phone_number on file: fails closed exactly as resolveForwardingDestination does');
}

{
  // Two different households in client mode never collide.
  const a = resolveCallDelivery({ id: 'household-a' }, undefined, true);
  const b = resolveCallDelivery({ id: 'household-b' }, undefined, true);
  check(a.identity !== b.identity, 'client mode: two different households get two different identities');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
