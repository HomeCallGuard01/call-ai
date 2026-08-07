// Unit tests for services/callRouting.js — closes the incident where
// every household's known-contact and screened-safe calls were forwarded
// to one hardcoded number (+447715562700) regardless of which customer's
// Twilio number was dialled. Pure function, no network/DB/Twilio involved.
//
// Run with: node tests/call-routing.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveForwardingDestination } = require('../services/callRouting.js');

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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
