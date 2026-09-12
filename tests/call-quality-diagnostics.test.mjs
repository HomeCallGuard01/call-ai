// POST /api/v1/voice/call-quality (2026-09-12 audio-quality investigation
// follow-up; reworked same day after security review — the endpoint was
// briefly unauthenticated and was reworked to require the same
// requireAuthApi + requireEntitlement pattern as its sibling
// /api/v1/voice/registered before ever being committed).
//
// Two things are tested, matching this codebase's established
// conventions (see tests/mobile-api.test.mjs for requireAuthApi's own
// header-parsing test style, and tests/account-deletion.test.mjs for the
// "structurally confirm the route is gated" style):
//
//   1. Structural: the route is genuinely registered behind requireAuthApi
//      and requireEntitlement — an anonymous or unentitled request never
//      reaches the handler at all (relying on those middlewares' own,
//      already-tested 401/402 behaviour rather than re-testing it here).
//   2. Functional: the handler itself, extracted directly from the real
//      router (not reimplemented), is invoked with a fake req that
//      already carries a resolved req.household (exactly what
//      requireAuthApi would have set) — proving the handler only ever
//      uses the server-resolved household, sanitizes every field, and
//      never throws on malformed input.
//
// Run with: node tests/call-quality-diagnostics.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('dotenv').config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function findRouteLayer(router, method, routePath) {
  return router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
}

function fakeReq(body, household) {
  return { body, household: household || { id: 'household-real-123' } };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = payload => {
    res.body = payload;
    return res;
  };
  return res;
}

function run() {
  const router = require('../routes/mobileApi.js');
  const routeSrc = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');

  // --- structural: anonymous/unentitled requests are rejected before the
  // handler is ever reached ---
  const layer = findRouteLayer(router, 'post', '/api/v1/voice/call-quality');
  check(Boolean(layer), 'sanity check: POST /api/v1/voice/call-quality is registered on the router');
  check(
    Boolean(layer) && layer.route.stack.length === 3,
    'the route has exactly three middleware/handler layers: requireAuthApi, requireEntitlement, and the real handler — no anonymous path exists'
  );

  const routeDeclarationMatch = routeSrc.match(/router\.post\("\/api\/v1\/voice\/call-quality",[^)]*\)/);
  check(
    Boolean(routeDeclarationMatch) &&
      routeDeclarationMatch[0].includes('requireAuthApi') &&
      routeDeclarationMatch[0].includes('requireEntitlement'),
    'the route declaration itself names both requireAuthApi and requireEntitlement — anonymous POSTs never reach the handler (401, per requireAuthApi\'s own tested behaviour), and an unentitled household is rejected too (402, per requireEntitlement\'s own tested behaviour)'
  );
  check(
    !routeSrc.includes('/debug/call-quality-beacon'),
    'the old unauthenticated /debug/call-quality-beacon endpoint no longer exists'
  );

  // The actual handler is the last layer in the route's own middleware
  // stack (index 2: requireAuthApi, requireEntitlement, handler).
  const handler = layer.route.stack[2].handle;

  // --- functional: the handler only ever uses the server-resolved
  // household, never one supplied in the request body — proving no
  // household id can be spoofed through the request. ---
  {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args);
    const req = fakeReq(
      { stage: 'post-connect-stats', householdId: 'attacker-supplied-household', household_id: 'also-attacker-supplied' },
      { id: 'household-real-123' }
    );
    const res = fakeRes();
    handler(req, res);
    console.log = originalLog;

    check(res.body && res.body.ok === true, 'a well-formed authenticated payload gets {ok: true} back');
    const loggedEntry = logged.find(args => args[0] === 'CALL QUALITY:');
    check(Boolean(loggedEntry), 'a well-formed payload is actually logged');
    check(
      Boolean(loggedEntry) && loggedEntry[1].householdId === 'household-real-123',
      'the logged householdId is always req.household.id (server-resolved by requireAuthApi) — never anything from the request body'
    );
    check(
      Boolean(loggedEntry) && !JSON.stringify(loggedEntry).includes('attacker-supplied'),
      'a householdId/household_id field supplied in the request body is never read or logged — no way to spoof or influence which household a report is attributed to'
    );
  }

  // --- functional: the full well-formed payload round-trips correctly ---
  {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args);
    const req = fakeReq({
      stage: 'post-connect-stats',
      platform: 'android',
      callSid: 'CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      codec: 'opus',
      jitter: 12.5,
      packetsLost: 0,
      roundTripTime: 145,
      mos: 4.1,
      warnings: ['high-jitter'],
    });
    const res = fakeRes();
    handler(req, res);
    console.log = originalLog;

    const loggedEntry = logged.find(args => args[0] === 'CALL QUALITY:');
    check(
      Boolean(loggedEntry) &&
        loggedEntry[1].codec === 'opus' &&
        loggedEntry[1].jitter === 12.5 &&
        loggedEntry[1].packetsLost === 0 &&
        loggedEntry[1].roundTripTime === 145 &&
        loggedEntry[1].mos === 4.1 &&
        Array.isArray(loggedEntry[1].warnings) &&
        loggedEntry[1].warnings[0] === 'high-jitter',
      'every documented technical field round-trips correctly for a well-formed payload'
    );
  }

  // --- unexpected fields are discarded safely (never read, never logged) ---
  {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args);
    const req = fakeReq({
      stage: 'post-connect-stats',
      transcript: 'this is a private conversation about a bank transfer',
      audioBase64: 'ZmFrZS1hdWRpby1ieXRlcw==',
      phoneNumber: '+441234567890',
      email: 'person@example.com',
    });
    const res = fakeRes();
    handler(req, res);
    console.log = originalLog;

    check(res.body && res.body.ok === true, 'a payload with unexpected extra fields still succeeds');
    const loggedText = JSON.stringify(logged);
    check(
      !loggedText.includes('bank transfer') &&
        !loggedText.includes('ZmFrZS1hdWRpby1ieXRlcw==') &&
        !loggedText.includes('+441234567890') &&
        !loggedText.includes('person@example.com'),
      'transcript, audio, phone number, and email fields are never read or logged — only the named whitelisted technical fields are ever used'
    );
  }

  // --- oversized/invalid payloads fail safely: never throw, always
  // {ok: true}, and invalid individual fields are dropped (nulled/
  // truncated) rather than corrupting or rejecting the whole report ---
  {
    const badPayloads = [
      undefined,
      {},
      { stage: 123 },
      { stage: '' },
      { stage: 'x'.repeat(51) },
      { stage: 'ok', platform: 'windows' },
      { stage: 'ok', jitter: 'not-a-number' },
      { stage: 'ok', jitter: Infinity },
      { stage: 'ok', jitter: NaN },
      { stage: 'ok', warnings: 'not-an-array' },
      { stage: 'ok', warnings: new Array(50).fill('x'.repeat(200)) },
      { stage: 'ok', callSid: 'x'.repeat(1000) },
      { stage: 'ok', codec: { toString: () => 'x'.repeat(100000) } },
    ];

    for (const payload of badPayloads) {
      const res = fakeRes();
      let threw = false;
      try {
        handler(fakeReq(payload), res);
      } catch {
        threw = true;
      }
      check(threw === false, `malformed payload never throws: ${JSON.stringify(payload)}`);
      check(res.body && res.body.ok === true, `malformed payload still returns {ok: true}: ${JSON.stringify(payload)}`);
    }

    // The oversized-warnings-array case is specifically capped, not just
    // "doesn't throw" — proving the endpoint can't be used to write an
    // unbounded amount of data into Railway's logs per request.
    {
      const logged = [];
      const originalLog = console.log;
      console.log = (...args) => logged.push(args);
      handler(fakeReq({ stage: 'ok', warnings: new Array(50).fill('x'.repeat(200)) }), fakeRes());
      console.log = originalLog;
      const loggedEntry = logged.find(args => args[0] === 'CALL QUALITY:');
      check(
        Boolean(loggedEntry) && loggedEntry[1].warnings.length === 0,
        'an oversized warnings array (individual strings too long) is filtered down to nothing rather than logged unbounded — every element exceeds the 50-char cap here, so all are dropped'
      );
    }
    {
      const logged = [];
      const originalLog = console.log;
      console.log = (...args) => logged.push(args);
      handler(fakeReq({ stage: 'ok', warnings: new Array(50).fill('short') }), fakeRes());
      console.log = originalLog;
      const loggedEntry = logged.find(args => args[0] === 'CALL QUALITY:');
      check(
        Boolean(loggedEntry) && loggedEntry[1].warnings.length === 10,
        'a warnings array with many valid short entries is capped at 10 entries, not logged unbounded'
      );
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll call-quality-diagnostics checks passed.');
  }
}

run();
