// Unit tests for services/phone.js's normaliseUkPhoneToE164 and
// services/householdPhoneNumber.js's setHouseholdPhoneNumber — the
// minimum write path for households.phone_number added 2026-08-07 to
// close the gap found while fixing the hardcoded call-forwarding
// destination (services/callRouting.js): nothing anywhere in this app
// had ever collected a household's real phone number.
//
// Uses a minimal fake admin client (a bare .rpc(name, args) capture, no
// real network/Supabase) — matching this codebase's established pattern
// (see tests/household-bootstrap.test.mjs).
//
// Run with: node tests/household-phone-number.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// services/householdPhoneNumber.js requires services/supabaseClients.js,
// whose module-scope client construction throws synchronously if
// SUPABASE_URL is unset — matching the same load-order fix already used
// by tests/twilio-provisioning.test.mjs, tests/mobile-api.test.mjs, etc.
// Every setHouseholdPhoneNumber call below passes its own fake `admin`
// via deps, so the real module-scope client this loads is never actually
// used.
require('dotenv').config();
const { normaliseUkPhoneToE164, wouldCreateForwardingLoop } = require('../services/phone.js');
const { setHouseholdPhoneNumber } = require('../services/householdPhoneNumber.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- normaliseUkPhoneToE164: accepts normal UK formats ---

check(normaliseUkPhoneToE164('07700 900123') === '+447700900123', 'accepts a mobile number with a space, 0-prefixed national format');
check(normaliseUkPhoneToE164('0161 123 4567') === '+441611234567', 'accepts a landline number with spaces, 0-prefixed national format');
check(normaliseUkPhoneToE164('+447700900123') === '+447700900123', 'accepts an already-E.164 number unchanged');
check(normaliseUkPhoneToE164('00447700900123') === '+447700900123', 'accepts the 00-prefixed international dialling format');
check(normaliseUkPhoneToE164('+44 7700 900123') === '+447700900123', 'accepts +44 with spaces');
check(normaliseUkPhoneToE164('(0161) 123-4567') === '+441611234567', 'accepts brackets and dashes, stripping them');

// --- normaliseUkPhoneToE164: rejects invalid input ---

check(normaliseUkPhoneToE164('12345') === null, 'rejects a too-short number');
check(normaliseUkPhoneToE164('077009001234567') === null, 'rejects a too-long number');
check(normaliseUkPhoneToE164('') === null, 'rejects an empty string');
check(normaliseUkPhoneToE164('   ') === null, 'rejects a whitespace-only string');
check(normaliseUkPhoneToE164('not a number') === null, 'rejects a string with no usable digits');
check(normaliseUkPhoneToE164(null) === null, 'rejects null without throwing');
check(normaliseUkPhoneToE164(undefined) === null, 'rejects undefined without throwing');

// --- wouldCreateForwardingLoop: the real fail-safe found missing during a
// real iPhone E2E test (2026-08-08/09) — a call to the customer's own
// forwarded phone can never connect if that phone is also the destination
// for safe/trusted calls. Compares via normaliseNumber, never raw string
// equality, so equivalent real-world formats are correctly recognised as
// the same number rather than slipping through a naive comparison. ---

check(
  wouldCreateForwardingLoop('+447715562700', '+447715562700') === true,
  'wouldCreateForwardingLoop: identical E.164 numbers are blocked — this is the exact real incident (both +447715562700)'
);

const EQUIVALENT_FORMAT_PAIRS = [
  ['07715 562700', '+447715562700'],
  ['+44 7715 562700', '07715562700'],
  ['(07715) 562-700', '447715562700'],
  ['0044 7715 562 700', '7715562700'],
];
for (const [protectedNumber, destinationNumber] of EQUIVALENT_FORMAT_PAIRS) {
  check(
    wouldCreateForwardingLoop(protectedNumber, destinationNumber) === true,
    `wouldCreateForwardingLoop: "${protectedNumber}" and "${destinationNumber}" are recognised as the same number despite different formatting — never a raw string comparison`
  );
}

check(
  wouldCreateForwardingLoop('+447715562700', '+447700900123') === false,
  'wouldCreateForwardingLoop: genuinely different numbers are never blocked'
);
check(
  wouldCreateForwardingLoop('', '') === false,
  'wouldCreateForwardingLoop: two empty/unset numbers are never treated as a match — nothing to block yet'
);
check(
  wouldCreateForwardingLoop(null, null) === false,
  'wouldCreateForwardingLoop: null inputs never throw and are never treated as a match'
);
check(
  wouldCreateForwardingLoop(undefined, '+447715562700') === false,
  'wouldCreateForwardingLoop: a missing protected number is never treated as matching a real destination'
);

// --- setHouseholdPhoneNumber: validates before ever calling the RPC ---

function makeFakeAdmin({ rpcError = null } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { error: rpcError };
    },
  };
}

async function run() {
  {
    const admin = makeFakeAdmin();
    const result = await setHouseholdPhoneNumber('household-a', 'not a number', { admin });
    check(result.ok === false && result.error === 'invalid_input', 'setHouseholdPhoneNumber: rejects an invalid number as invalid_input');
    check(admin.calls.length === 0, 'setHouseholdPhoneNumber: never calls the RPC when the input is invalid — fails closed before any write');
  }

  {
    const admin = makeFakeAdmin();
    const result = await setHouseholdPhoneNumber('household-a', '', { admin });
    check(result.ok === false && result.error === 'invalid_input', 'setHouseholdPhoneNumber: an empty number is rejected as invalid_input (fails closed)');
    check(admin.calls.length === 0, 'setHouseholdPhoneNumber: no RPC call for an empty number');
  }

  {
    const admin = makeFakeAdmin();
    const result = await setHouseholdPhoneNumber('household-a', '07700 900123', { admin });
    check(result.ok === true && result.number === '+447700900123', 'setHouseholdPhoneNumber: a valid number succeeds and returns the normalised E.164 value');
    check(admin.calls.length === 1 && admin.calls[0].name === 'set_household_phone_number', 'setHouseholdPhoneNumber: calls the sanctioned set_household_phone_number RPC, not a direct table write');
    check(
      admin.calls[0].args.p_household_id === 'household-a' && admin.calls[0].args.p_phone_number === '+447700900123',
      'setHouseholdPhoneNumber: the RPC is called with exactly the target household id and the normalised number'
    );
  }

  {
    // Proves the household id passed in is the only one ever written —
    // this is what the RPC's own `where id = p_household_id` (migration
    // 023) then enforces server-side; this test proves the service layer
    // never substitutes a different household.
    const admin = makeFakeAdmin();
    await setHouseholdPhoneNumber('household-a', '07700 900123', { admin });
    await setHouseholdPhoneNumber('household-b', '0161 123 4567', { admin });
    check(
      admin.calls[0].args.p_household_id === 'household-a' && admin.calls[1].args.p_household_id === 'household-b',
      'setHouseholdPhoneNumber: two separate calls each target only their own household id, never bleeding into each other'
    );
  }

  {
    const admin = makeFakeAdmin({ rpcError: { message: 'household does not exist' } });
    const result = await setHouseholdPhoneNumber('household-missing', '07700 900123', { admin });
    check(result.ok === false && result.error === 'failed', 'setHouseholdPhoneNumber: an RPC-level error (e.g. household does not exist) surfaces as a failure, not a silent success');
  }

  // Deliberately NOT tested here: passing { admin: null } to exercise the
  // "no admin client configured" fail-closed branch. setHouseholdPhoneNumber
  // resolves as `deps.admin || supabaseAdmin` (matching this codebase's
  // established injected-dependency pattern, e.g. twilioProvisioning.js) —
  // `null` is falsy, so that call would fall through to the REAL module-
  // scope supabaseAdmin client, which this test file's own required
  // dotenv.config() call above has just populated with real production
  // credentials (the default .env, confirmed elsewhere in this project to
  // point at psbzynxplxfbyrbdidmn). An earlier version of this test did
  // exactly that and made a genuine — if harmless, since the RPC doesn't
  // exist yet and 'household-a' isn't a valid UUID — network call to
  // production. The `if (!admin)` guard itself is simple enough (services/
  // householdPhoneNumber.js) to be covered by direct inspection rather
  // than risk a real production call to test it.

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
