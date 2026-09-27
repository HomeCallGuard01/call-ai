// Regression coverage for the P0 launch-hardening fix (2026-09-27):
// services/liveMonitoring/mediaStreamHandler.js's handleMessage() used to
// access nested properties of an untrusted, unauthenticated WebSocket
// message (message.event, message.start, message.media.payload,
// message.start.customParameters) without first checking they existed.
// JSON.parse only guarantees valid JSON, not any particular shape — the
// JSON text "null", the array "[1,2,3]", {"event":"start"} with no
// "start" object, or {"event":"media","media":{}} with no "payload" all
// parse successfully and then threw a genuine synchronous TypeError.
//
// Why this matters more than an ordinary bug: handleMessage is a plain
// (non-async) function. mediaStreamServer.js calls it as
// `handler.handleMessage(...).catch(err => ...)` — a .catch() can only
// catch a REJECTED PROMISE, never a SYNCHRONOUS throw from a non-async
// function. Each throw above therefore escaped as an uncaught exception,
// reaching server.js's global `uncaughtException` handler, which calls
// alertThenExit() and kills the entire process — dropping EVERY live
// call being monitored at that moment, from a single malformed frame on
// the unauthenticated /media-stream endpoint. Confirmed by independent
// local reproduction against the pre-fix handler before this fix was
// written, not assumed or taken on trust from another branch's claim.
//
// This file exists to prove the fix, not to re-test the pipeline's
// normal behaviour (tests/live-monitoring-media-stream-handler.test.mjs
// already covers that, including the pre-existing "non-JSON string"
// malformed-input case this file complements rather than duplicates).
//
// Run with: node tests/media-stream-handler-crash-hardening.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function makeHandler() {
  return createMediaStreamHandler({ transcribeClient: null, smsClient: null, fromNumber: '+441000000000' });
}

// Every one of these is a real, previously-crashing input. Each is
// asserted twice: the synchronous call must not throw, AND the returned
// promise (if any) must not reject uncaught — matching exactly how
// mediaStreamServer.js drives this function in production.
async function assertSurvives(label, handler, raw) {
  let threw = false;
  let result;
  try {
    result = handler.handleMessage(raw, { closeConnection: () => {} });
  } catch (err) {
    threw = true;
  }
  check(threw === false, `${label}: does not throw synchronously`);
  if (result && typeof result.then === 'function') {
    let rejected = false;
    await result.catch(() => { rejected = true; });
    check(rejected === false, `${label}: the returned promise does not reject either`);
  }
}

async function main() {
  // --- top-level shape guard: message itself is not a usable object ---
  {
    const handler = makeHandler();
    await assertSurvives('the JSON text "null"', handler, 'null');
  }
  {
    const handler = makeHandler();
    await assertSurvives('a bare JSON array', handler, '[1,2,3]');
  }
  {
    const handler = makeHandler();
    await assertSurvives('a bare JSON number', handler, '42');
  }
  {
    const handler = makeHandler();
    await assertSurvives('a bare JSON string', handler, '"hello"');
  }
  {
    const handler = makeHandler();
    await assertSurvives('an object with a non-string "event"', handler, JSON.stringify({ event: 123 }));
  }
  {
    const handler = makeHandler();
    await assertSurvives('an object with no "event" field at all', handler, JSON.stringify({ streamSid: 'MZ1' }));
  }

  // --- "start" event, missing/wrong-shaped nested "start" object ---
  {
    const handler = makeHandler();
    await assertSurvives('{"event":"start"} with no .start property at all', handler, JSON.stringify({ event: 'start' }));
  }
  {
    const handler = makeHandler();
    await assertSurvives('{"event":"start","start":null}', handler, JSON.stringify({ event: 'start', start: null }));
  }
  {
    const handler = makeHandler();
    await assertSurvives('{"event":"start","start":"not an object"}', handler, JSON.stringify({ event: 'start', start: 'not an object' }));
  }
  {
    // customParameters: null is a distinct trap from a missing
    // customParameters — a default value (`= {}`) only applies to
    // `undefined`, never to an explicit `null`.
    const handler = makeHandler();
    await assertSurvives(
      '{"event":"start","start":{"customParameters":null}}',
      handler,
      JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: null } })
    );
  }

  // --- "media" event, missing/wrong-shaped nested "media" object,
  // exercised on a genuinely-started stream so the guard under test is
  // actually reached (an unknown streamSid is already safely ignored by
  // the pre-existing entry lookup, before this guard would ever run) ---
  {
    const handler = makeHandler();
    await handler.handleMessage(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: {} } }));
    await assertSurvives('a started stream receiving {"event":"media"} with no .media property', handler, JSON.stringify({ event: 'media', streamSid: 'MZ1' }));
  }
  {
    const handler = makeHandler();
    await handler.handleMessage(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: {} } }));
    await assertSurvives('a started stream receiving {"event":"media","media":null}', handler, JSON.stringify({ event: 'media', streamSid: 'MZ1', media: null }));
  }
  {
    const handler = makeHandler();
    await handler.handleMessage(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: {} } }));
    await assertSurvives('a started stream receiving {"event":"media","media":{}} (no payload)', handler, JSON.stringify({ event: 'media', streamSid: 'MZ1', media: {} }));
  }
  {
    const handler = makeHandler();
    await handler.handleMessage(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: {} } }));
    await assertSurvives('a started stream receiving a non-string media.payload', handler, JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { payload: 12345 } }));
  }

  // --- sanity check: genuine, well-formed Twilio messages are completely
  // unaffected by any of the guards above — this fix must be purely
  // additive, never a behaviour change for real traffic ---
  {
    const handler = makeHandler();
    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: { streamSid: 'MZGOOD', callSid: 'CAGOOD', customParameters: { householdId: 'h1' } },
    }));
    check(handler._streamsForTesting.has('MZGOOD'), 'a genuinely well-formed "start" message still registers the stream exactly as before');

    let threw = false;
    try {
      await handler.handleMessage(JSON.stringify({
        event: 'media',
        streamSid: 'MZGOOD',
        media: { payload: Buffer.alloc(160).toString('base64') },
      }));
    } catch (err) {
      threw = true;
    }
    check(threw === false, 'a genuinely well-formed "media" message with a real base64 payload is still processed without error');
  }

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} media-stream-handler-crash-hardening checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
