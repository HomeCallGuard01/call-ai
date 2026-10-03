// Coverage for the /media-stream concurrent-stream cap (2026-09-27,
// launch-hardening — closes the "assess rate-limit/abuse considerations"
// item from the original media-stream security ask, never actually
// implemented when the crash fix + shadow signature check shipped).
//
// Why this matters: /media-stream is unauthenticated (the shadow-mode
// signature check observes and logs but never rejects — see
// media-stream-signature-shadow-check.test.mjs). Without this cap, a
// flood of forged "start" events — each individually well-formed enough
// to pass the crash-hardening shape guards — would grow the handler's
// in-memory `streams` Map without bound, and every forged "media" event
// on top of that triggers a REAL OpenAI Whisper API call: a real,
// unbounded financial-cost vector, not just a memory one.
//
// Run with: node tests/media-stream-concurrent-stream-cap.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler');
const { DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS, resolveMaxConcurrentStreams } = require('../services/liveMonitoring/monitoringLimit');

// Test-only: trusts the stream's own parameters. Production uses
// streamAuth.js, which never does (P0 remediation, 2026-10-01).
const trustingTestAuthorizer = ({ callSid, customParameters = {} } = {}) => ({ householdId: customParameters.householdId || `test-household-${callSid}`, toNumber: customParameters.toNumber || null, fromNumber: customParameters.protectedNumber || null });


let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function startMessage(streamSid) {
  return JSON.stringify({ event: 'start', start: { streamSid, callSid: `CA-${streamSid}`, customParameters: {} } });
}

async function main() {
  // --- resolveMaxConcurrentStreams: env-configurable, sane default, never throws on garbage ---
  {
    check(resolveMaxConcurrentStreams({}) === DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS, 'defaults to 200 with no env var set');
    check(resolveMaxConcurrentStreams({ MEDIA_STREAM_MAX_CONCURRENT_STREAMS: '5' }) === 5, 'a valid positive integer env var is honoured');
    check(resolveMaxConcurrentStreams({ MEDIA_STREAM_MAX_CONCURRENT_STREAMS: '0' }) === DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS, 'zero falls back to the default rather than disabling the cap entirely');
    check(resolveMaxConcurrentStreams({ MEDIA_STREAM_MAX_CONCURRENT_STREAMS: '-5' }) === DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS, 'a negative value falls back to the default');
    check(resolveMaxConcurrentStreams({ MEDIA_STREAM_MAX_CONCURRENT_STREAMS: 'not-a-number' }) === DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS, 'garbage falls back to the default, never throws or produces NaN');
    check(resolveMaxConcurrentStreams({ MEDIA_STREAM_MAX_CONCURRENT_STREAMS: '3.5' }) === DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS, 'a non-integer falls back to the default');
  }

  // --- the cap genuinely stops new streams from being created once reached ---
  {
    const closedConnections = [];
    const alerts = [];
    const handler = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer,
      transcribeClient: null,
      smsClient: null,
      fromNumber: '+441000000000',
      maxConcurrentStreams: 3,
      sendAlert: (type, message, context) => {
        alerts.push({ type, message, context });
        return Promise.resolve(true);
      },
    });

    // Fill exactly to the cap — all three must succeed.
    await handler.handleMessage(startMessage('MZ1'));
    await handler.handleMessage(startMessage('MZ2'));
    await handler.handleMessage(startMessage('MZ3'));
    check(handler._streamsForTesting.size === 3, 'three "start" events under the cap of 3 all register normally');

    // A fourth must be refused.
    let threw = false;
    try {
      await handler.handleMessage(startMessage('MZ4'), { closeConnection: () => closedConnections.push('MZ4') });
    } catch (err) {
      threw = true;
    }
    check(threw === false, 'a "start" event over the cap never throws');
    check(handler._streamsForTesting.size === 3, 'a "start" event over the cap does NOT create a new stream entry — still exactly 3');
    check(!handler._streamsForTesting.has('MZ4'), 'the rejected stream (MZ4) was never registered');
    check(closedConnections.includes('MZ4'), 'the rejected connection is closed (stops Twilio sending further media it can never be billed/processed for)');
    check(alerts.some(a => a.type === 'media_stream_concurrent_limit_reached'), 'an ops alert fires when the cap is hit');

    // Critically: the three streams already active must be completely
    // unaffected by the rejection — the cap must never punish existing,
    // legitimate calls to make room for a new (possibly forged) one.
    check(handler._streamsForTesting.has('MZ1') && handler._streamsForTesting.has('MZ2') && handler._streamsForTesting.has('MZ3'), 'all three pre-existing streams remain completely untouched after a rejection');
  }

  // --- once a stream legitimately ends, capacity is freed for a new one ---
  {
    const handler = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer,
      transcribeClient: null,
      smsClient: null,
      fromNumber: '+441000000000',
      maxConcurrentStreams: 1,
    });

    await handler.handleMessage(startMessage('MZA'));
    check(handler._streamsForTesting.size === 1, 'sanity: one stream active, at the cap of 1');

    await handler.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZA', stop: {} }));
    check(handler._streamsForTesting.size === 0, 'the stream is cleaned up on a genuine "stop"');

    await handler.handleMessage(startMessage('MZB'));
    check(handler._streamsForTesting.has('MZB'), 'a new stream is accepted once capacity is freed — the cap is a live ceiling, not a one-shot lockout');
  }

  // --- default behaviour: the cap is generous enough that ordinary,
  // realistic test traffic never comes close to it ---
  {
    const handler = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer, transcribeClient: null, smsClient: null, fromNumber: '+441000000000' });
    for (let i = 0; i < 10; i++) {
      await handler.handleMessage(startMessage(`MZ-normal-${i}`));
    }
    check(handler._streamsForTesting.size === 10, 'ten concurrent genuine-shaped streams (far below the default 200) all register normally — the default cap never interferes with realistic real-world load');
  }

  console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} media-stream-concurrent-stream-cap checks ${failures === 0 ? 'passed' : 'FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
