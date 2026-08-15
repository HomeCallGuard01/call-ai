// Unit tests for services/activationVerification.js — the "is this call
// recent enough to count as proof call forwarding actually works" check
// used by both POST /activation-verify (server.js, web) and
// POST /api/v1/activation/verify (routes/mobileApi.js, mobile). Pure
// function, no network/DB involved.
//
// Run with: node tests/activation-verification.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ACTIVATION_VERIFY_WINDOW_MS, isCallWithinVerificationWindow } = require('../services/activationVerification.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

check(ACTIVATION_VERIFY_WINDOW_MS === 30 * 60 * 1000, 'the verification window is 30 minutes');

const now = new Date('2026-08-15T12:00:00.000Z');

check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T11:59:00.000Z' }, now) === true,
  'a call one minute ago is within the window'
);
check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T11:30:00.000Z' }, now) === true,
  'a call exactly 30 minutes ago is within the window (inclusive boundary)'
);
check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T11:29:59.000Z' }, now) === false,
  'a call 30 minutes and 1 second ago is outside the window — a stale, possibly abandoned setup attempt must not count as current proof'
);
check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T09:00:00.000Z' }, now) === false,
  'a call from hours ago is outside the window'
);
check(
  isCallWithinVerificationWindow(undefined, now) === false,
  'no call at all is never treated as verified'
);
check(
  isCallWithinVerificationWindow(null, now) === false,
  'a null call is never treated as verified'
);
check(
  isCallWithinVerificationWindow({}, now) === false,
  'a call object with no created_at is never treated as verified'
);
check(
  isCallWithinVerificationWindow({ created_at: 'not a real date' }, now) === false,
  'an unparseable created_at never throws and is never treated as verified'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
