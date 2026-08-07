// Unit tests for the mobile app backend groundwork (Phase 0/2,
// docs/mobile-app/APP_DECISION_005): the activation-verification time
// window (services/activationVerification.js) and the parts of
// requireAuthApi that don't require a real Supabase call (malformed/
// missing Authorization header rejection — the same "no real network
// needed for this branch" reasoning already used for requireAuth's own
// untested Supabase-dependent branches, which have no direct test either).
//
// Run with: node tests/mobile-api.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();
const { isCallWithinVerificationWindow, ACTIVATION_VERIFY_WINDOW_MS } = require('../services/activationVerification.js');
const { requireAuthApi } = require('../middleware/requireAuthApi.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

async function run() {
  // --- isCallWithinVerificationWindow ---

  const now = new Date('2026-01-01T12:00:00Z');

  check(
    isCallWithinVerificationWindow({ created_at: '2026-01-01T11:59:00Z' }, now) === true,
    'a call from 1 minute ago counts as recent enough to verify activation'
  );

  check(
    isCallWithinVerificationWindow({ created_at: '2026-01-01T11:31:00Z' }, now) === true,
    'a call from 29 minutes ago (just inside the 30-minute window) still counts'
  );

  check(
    isCallWithinVerificationWindow({ created_at: '2026-01-01T11:00:00Z' }, now) === false,
    'a call from an hour ago is too stale to count as proof activation just worked'
  );

  check(
    isCallWithinVerificationWindow(undefined, now) === false,
    'no call at all (undefined) is correctly not verified, not a thrown error'
  );

  check(
    isCallWithinVerificationWindow(null, now) === false,
    'null is correctly not verified'
  );

  check(
    isCallWithinVerificationWindow({ created_at: 'not-a-real-date' }, now) === false,
    'a malformed created_at value is treated as not-verified rather than throwing or matching by accident'
  );

  check(
    ACTIVATION_VERIFY_WINDOW_MS === 30 * 60 * 1000,
    'the verification window is exactly 30 minutes, matching the documented rationale'
  );

  // --- requireAuthApi: header-parsing branches (no real Supabase call needed) ---

  {
    const req = { headers: {} };
    const res = makeRes();
    let nextCalled = false;
    await requireAuthApi(req, res, () => { nextCalled = true; });
    check(
      res.statusCode === 401 && res.body?.error === 'unauthenticated' && !nextCalled,
      'missing Authorization header is rejected with 401, next() never called'
    );
  }

  {
    const req = { headers: { authorization: 'NotBearer sometoken' } };
    const res = makeRes();
    let nextCalled = false;
    await requireAuthApi(req, res, () => { nextCalled = true; });
    check(
      res.statusCode === 401 && res.body?.error === 'unauthenticated' && !nextCalled,
      'a non-Bearer auth scheme is rejected with 401'
    );
  }

  {
    const req = { headers: { authorization: 'Bearer' } };
    const res = makeRes();
    let nextCalled = false;
    await requireAuthApi(req, res, () => { nextCalled = true; });
    check(
      res.statusCode === 401 && !nextCalled,
      'a "Bearer" header with no token value is rejected with 401, not passed through to Supabase as an empty string'
    );
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
