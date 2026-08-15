// Integration-style tests for services/liveMonitoring/mediaStreamHandler.js
// — drives it with plain objects shaped exactly like Twilio's real Media
// Streams protocol messages (start/media/stop), using fake transcription
// and fake Twilio SMS clients. No real websocket, no real external call
// of any kind.
//
// Run with: node tests/live-monitoring-media-stream-handler.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');
const { createWindowBuffer } = require('../services/liveMonitoring/audioWindow.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function makeFakeSmsClient() {
  const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); return { sid: 'SM_test' }; } } };
}

// Deterministic fake transcription: returns a scripted line of text for
// each successive window, regardless of the actual (fake, silent) audio
// bytes — mirrors the sandbox's existing "deterministic fake, not a real
// model" convention (Sprint 14).
function makeScriptedTranscribeClient(scriptedLines) {
  let i = 0;
  return {
    calls: [],
    transcribe: async (wavBuffer) => {
      const text = scriptedLines[i] ?? null;
      i += 1;
      return text;
    },
  };
}

function silentMediaFrame() {
  // A single 20ms mulaw "frame" — content doesn't matter, the fake
  // transcribe client ignores it and returns scripted text instead.
  return Buffer.from([0xff]).toString('base64');
}

function feedFramesForOneWindow(handler, streamSid) {
  // Defaults: 4000ms window / 20ms frames = 200 frames needed to close one window.
  const promises = [];
  for (let i = 0; i < 200; i++) {
    promises.push(
      handler.handleMessage(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: silentMediaFrame() },
      }))
    );
  }
  return Promise.all(promises);
}

async function run() {
  // --- full lifecycle: start -> media (one window) -> stop, genuine call ---
  {
    const smsClient = makeFakeSmsClient();
    const transcribeClient = makeScriptedTranscribeClient(['hi it is your neighbour returning your ladder']);
    const handler = createMediaStreamHandler({ transcribeClient, smsClient, fromNumber: '+441615700779' });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZ1',
        callSid: 'CA1',
        customParameters: { householdId: 'household-1', toNumber: '+447700900001', protectedNumber: '+441615700779' },
      },
    }));

    check(handler._streamsForTesting.has('MZ1'), 'a "start" event registers the stream by its streamSid');

    await feedFramesForOneWindow(handler, 'MZ1');

    await handler.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ1', stop: { accountSid: 'AC1', callSid: 'CA1' } }));

    check(!handler._streamsForTesting.has('MZ1'), 'a "stop" event removes the stream\'s state');
    check(smsClient.calls.length === 0, 'a genuine transcript across one full window never triggers an SMS');
  }

  // --- scam scenario end-to-end through the real message protocol ---
  {
    const smsClient = makeFakeSmsClient();
    const transcribeClient = makeScriptedTranscribeClient(['please confirm your one time passcode urgently']);
    const handler = createMediaStreamHandler({ transcribeClient, smsClient, fromNumber: '+441615700779' });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZ2',
        callSid: 'CA2',
        customParameters: { householdId: 'household-2', toNumber: '+447700900002', protectedNumber: '+441615700779' },
      },
    }));

    await feedFramesForOneWindow(handler, 'MZ2');

    check(smsClient.calls.length === 1, 'a scam-shaped transcript delivered through the real message protocol triggers exactly one SMS');
    check(smsClient.calls[0].to === '+447700900002', 'the SMS goes to the correct household number carried in customParameters');

    await handler.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ2', stop: { accountSid: 'AC1', callSid: 'CA2' } }));
  }

  // --- media for an unknown/already-stopped stream is ignored, never throws ---
  {
    const smsClient = makeFakeSmsClient();
    const transcribeClient = makeScriptedTranscribeClient([]);
    const handler = createMediaStreamHandler({ transcribeClient, smsClient, fromNumber: '+441615700779' });

    let threw = false;
    try {
      await handler.handleMessage(JSON.stringify({ event: 'media', streamSid: 'MZ_never_started', media: { payload: silentMediaFrame() } }));
    } catch (err) {
      threw = true;
    }
    check(threw === false, 'a media event for a stream that never sent "start" is silently ignored, not an error');
  }

  // --- malformed message is ignored, never throws ---
  {
    const smsClient = makeFakeSmsClient();
    const transcribeClient = makeScriptedTranscribeClient([]);
    const handler = createMediaStreamHandler({ transcribeClient, smsClient, fromNumber: '+441615700779' });

    let threw = false;
    try {
      await handler.handleMessage('this is not valid JSON {{{');
    } catch (err) {
      threw = true;
    }
    check(threw === false, 'a malformed (non-JSON) message is caught and logged, never thrown');
  }

  // --- a "start" event with no customParameters.toNumber (household has no
  // phone_number on file) must never fall back to the Twilio protected
  // number as an SMS destination — a scam-shaped transcript still never
  // sends, and the call itself is completely unaffected ---
  {
    const smsClient = makeFakeSmsClient();
    const transcribeClient = makeScriptedTranscribeClient(['please confirm your one time passcode urgently']);
    const handler = createMediaStreamHandler({ transcribeClient, smsClient, fromNumber: '+441615700779' });

    await handler.handleMessage(JSON.stringify({
      event: 'start',
      start: {
        streamSid: 'MZ3',
        callSid: 'CA3',
        customParameters: { householdId: 'household-3', protectedNumber: '+441615700779' },
      },
    }));

    let threw = false;
    try {
      await feedFramesForOneWindow(handler, 'MZ3');
    } catch (err) {
      threw = true;
    }

    check(threw === false, 'a missing toNumber customParameter never throws while processing media');
    check(smsClient.calls.length === 0, 'a missing toNumber customParameter means no SMS is ever sent, even for a scam-shaped transcript');

    await handler.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ3', stop: { accountSid: 'AC1', callSid: 'CA3' } }));
  }

  // --- known-contact bypass is unaffected: this handler is never invoked
  // for that path at all (server.js only attaches <Start><Stream> to the
  // two dial.number() sites, both of which already run after the bypass
  // decision) — nothing to test here beyond confirming the handler makes
  // no assumption about isKnown; it only ever sees whatever calls actually
  // reach it. ---

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring media-stream-handler checks passed.');
  }
}

run();
