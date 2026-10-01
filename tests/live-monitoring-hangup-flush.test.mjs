// Regression coverage for the 2026-09-26 hang-up flush: audio still
// buffered in the speech segmenter when the caller hangs up is now
// transcribed once, and any detection that lands after the call has
// ended (the flushed tail, or a chunk whose transcription was already in
// flight) warns the customer with post-call wording and never attempts
// to terminate a call that no longer exists.
//
// Why: with pause-aligned, non-overlapping segments the untranscribed
// tail at hang-up grew from ~0.6s mean / 1.1s p90 of speech to ~1.1s /
// 2.2s — enough for a short red-line instruction said as a scammer's
// last words ("withdraw the cash, don't tell your bank") to go unseen.
//
// Run with: node tests/live-monitoring-hangup-flush.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechSegmenter } = require('../services/liveMonitoring/speechSegmenter.js');
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');
const { wrapMulawAsWav } = require('../services/liveMonitoring/mulawWav.js');

// Test-only: trusts the stream's own parameters. Production uses
// streamAuth.js, which never does (P0 remediation, 2026-10-01).
const trustingTestAuthorizer = ({ callSid, customParameters = {} } = {}) => ({ householdId: customParameters.householdId || `test-household-${callSid}`, toNumber: customParameters.toNumber || null, fromNumber: customParameters.protectedNumber || null });

const {
  WARNING_BODY,
  RED_LINE_WARNING_BODY,
  POST_CALL_RED_LINE_WARNING_BODY,
  MONITORING_LIMIT_ENDED_BODY,
} = require('../services/liveMonitoring/smsWarning.js');

let failures = 0;
// Guard against a silent early exit: if the event loop empties while a
// check is still awaiting (e.g. an unref()'d timer), Node exits 0 with
// the remaining checks never run. Found for real while writing this
// file — fail loudly instead.
let completed = false;
process.on('exit', (code) => {
  if (!completed && code === 0) {
    console.error('✗ test run exited before completing all checks');
    process.exitCode = 1;
  }
});

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const FRAME_BYTES = 160; // 20ms of 8kHz mulaw, as Twilio sends
const LOUD = () => Buffer.alloc(FRAME_BYTES, 0x80);
const QUIET = () => Buffer.alloc(FRAME_BYTES, 0xff);
const WAV_HEADER_BYTES = wrapMulawAsWav(Buffer.alloc(0)).length;

const TAIL_RED_LINE = "Go and withdraw the cash now. Don't tell your bank or your family.";

function makeFakeSmsClient() {
  const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); return { sid: 'SM_test' }; } } };
}

function makeFakeTwilioRestClient() {
  const updates = [];
  return { updates, calls: (sid) => ({ update: async (p) => { updates.push({ sid, p }); return {}; } }) };
}

// Scripted transcription that also records exactly how much audio each
// request carried (bytes of mulaw, WAV header removed).
function makeRecordingClient(lines) {
  let i = 0;
  const audioBytes = [];
  return {
    audioBytes,
    get requests() { return audioBytes.length; },
    transcribe: async (wav) => {
      audioBytes.push(wav.length - WAV_HEADER_BYTES);
      const text = lines[i] ?? 'hello';
      i += 1;
      return text;
    },
  };
}

function makeHandler({ transcribeClient, smsClient, twilioRestClient, outcomes, alerts = [], now, finalizeWaitMs }) {
  return createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer,
    transcribeClient,
    smsClient,
    fromNumber: '+441615700779',
    twilioRestClient,
    redLineRedirectUrl: 'https://example.test/red-line-terminate',
    recordOutcome: async (o) => { outcomes.push(o); },
    sendAlert: async (type) => { alerts.push(type); return true; },
    ...(now ? { now } : {}),
    ...(finalizeWaitMs !== undefined ? { finalizeWaitMs } : {}),
  });
}

const start = (sid, callSid) => JSON.stringify({
  event: 'start',
  start: { streamSid: sid, callSid, customParameters: { householdId: `hh-${callSid}`, toNumber: '+447700900200', protectedNumber: '+441615700779' } },
});
const media = (sid, frame) => JSON.stringify({ event: 'media', streamSid: sid, media: { payload: frame.toString('base64') } });
const stop = (sid, callSid) => JSON.stringify({ event: 'stop', streamSid: sid, stop: { accountSid: 'AC1', callSid } });

async function feed(handler, sid, frames) {
  for (const f of frames) await handler.handleMessage(media(sid, f));
}
const n = (count, make) => Array.from({ length: count }, make);

async function run() {
  // ==========================================================================
  // A. Segmenter flush(): duplicate-free by construction.
  // ==========================================================================
  {
    const seg = createSpeechSegmenter();
    for (const f of n(100, LOUD)) seg.addFrame(f); // 2s of speech, below the 3s minimum
    check(seg.bufferedFrameCount() === 100, '2s of speech is held in the buffer (below the 3s segment minimum)');
    const tail = seg.flush();
    check(Buffer.isBuffer(tail) && tail.length === 100 * FRAME_BYTES, 'flush() returns exactly the buffered audio');
    check(seg.bufferedFrameCount() === 0, 'flush() empties the buffer');
    check(seg.flush() === null, 'a second flush() returns nothing — the tail can never be emitted twice');
    let reEmitted = 0;
    for (const f of n(150, QUIET)) if (seg.addFrame(f)) reEmitted += 1;
    check(reEmitted === 1, 'after a flush, the next segment contains only new audio');

    const short = createSpeechSegmenter();
    for (const f of n(20, LOUD)) short.addFrame(f); // 0.4s
    check(short.flush() === null && short.bufferedFrameCount() === 0, 'a tail under 0.5s is discarded (and cleared), not transcribed');

    const silent = createSpeechSegmenter();
    for (const f of n(120, QUIET)) silent.addFrame(f); // 2.4s of silence
    check(silent.flush() === null, 'a silent tail is not sent for transcription (no cost, no Whisper hallucination on silence)');

    const click = createSpeechSegmenter();
    for (const f of [...n(100, QUIET), ...n(3, LOUD)]) click.addFrame(f); // 60ms of noise in 2s
    check(click.flush() === null, 'a tail with under 100ms of speech (a click) is not sent');
  }

  // ==========================================================================
  // B1. Red line spoken as the caller's last words, then hang-up.
  // ==========================================================================
  {
    const sms = makeFakeSmsClient();
    const twilio = makeFakeTwilioRestClient();
    const outcomes = [];
    const client = makeRecordingClient(['Hello, is that Mrs Smith?', TAIL_RED_LINE]);
    const handler = makeHandler({ transcribeClient: client, smsClient: sms, twilioRestClient: twilio, outcomes });

    await handler.handleMessage(start('MZ-tail', 'CA-tail'));
    const fed = [...n(150, QUIET), ...n(100, LOUD)]; // one 3s segment, then a 2s spoken tail
    await feed(handler, 'MZ-tail', fed);
    check(client.requests === 1, 'before hang-up, only the completed segment has been transcribed');
    await handler.handleMessage(stop('MZ-tail', 'CA-tail'));

    check(client.requests === 2, 'on hang-up, the buffered tail is transcribed — exactly one extra request');
    const submitted = client.audioBytes.reduce((a, b) => a + b, 0);
    check(submitted === fed.length * FRAME_BYTES, `all fed audio was transcribed exactly once, tail included (${submitted} of ${fed.length * FRAME_BYTES} bytes)`);
    check(sms.calls.length === 1, 'exactly one SMS');
    check(sms.calls[0].body === POST_CALL_RED_LINE_WARNING_BODY, 'the SMS uses the post-call red-line wording');
    check(
      POST_CALL_RED_LINE_WARNING_BODY === "Home Call Guard: the call that just ended showed clear signs of fraud. Don't act on anything the caller asked. If you shared details, contact your bank using the number on your card.",
      'the post-call wording is exactly the approved text'
    );
    check(twilio.updates.length === 0, 'no termination attempt against the already-ended call');
    check(outcomes.length === 1, 'the audit record is written exactly once');
    check(outcomes[0].warningSent === true && outcomes[0].terminatedBySystem === false, 'audit record: warning sent, not terminated by the system');
    check(typeof outcomes[0].terminationReason === 'string' && outcomes[0].terminationReason.includes('isolation_from_bank'), `audit record includes the red line found in the tail (${outcomes[0].terminationReason})`);
  }

  // ==========================================================================
  // B2. A chunk already in flight when the caller hangs up.
  // ==========================================================================
  {
    const sms = makeFakeSmsClient();
    const twilio = makeFakeTwilioRestClient();
    const outcomes = [];
    const resolvers = [];
    const client = { transcribe: () => new Promise(resolve => resolvers.push(resolve)) };
    const handler = makeHandler({ transcribeClient: client, smsClient: sms, twilioRestClient: twilio, outcomes });

    await handler.handleMessage(start('MZ-inflight', 'CA-inflight'));
    const mediaPromises = [];
    for (const f of n(150, QUIET)) mediaPromises.push(handler.handleMessage(media('MZ-inflight', f)));
    check(resolvers.length === 1, 'one segment is in flight');

    const stopPromise = handler.handleMessage(stop('MZ-inflight', 'CA-inflight'));
    await new Promise(r => setImmediate(r));
    check(outcomes.length === 0, 'the audit record waits for the in-flight segment instead of being written first');

    resolvers[0](TAIL_RED_LINE);
    await Promise.all(mediaPromises);
    await stopPromise;

    check(sms.calls.length === 1 && sms.calls[0].body === POST_CALL_RED_LINE_WARNING_BODY, 'a red line resolving after hang-up sends one post-call SMS (not "was ended automatically")');
    check(twilio.updates.length === 0, 'a red line resolving after hang-up makes zero termination attempts (previously three doomed attempts)');
    check(outcomes.length === 1 && outcomes[0].terminationReason && outcomes[0].terminationReason.includes('isolation_from_bank'), 'the audit record includes the detection that landed after hang-up');
  }

  // ==========================================================================
  // B3. Silent tail: no request, outcome still recorded.
  // ==========================================================================
  {
    const outcomes = [];
    const client = makeRecordingClient([]);
    const handler = makeHandler({ transcribeClient: client, smsClient: makeFakeSmsClient(), twilioRestClient: makeFakeTwilioRestClient(), outcomes });
    await handler.handleMessage(start('MZ-silent', 'CA-silent'));
    await feed(handler, 'MZ-silent', n(250, QUIET)); // 3s segment + 2s silent tail
    await handler.handleMessage(stop('MZ-silent', 'CA-silent'));
    check(client.requests === 1, 'a silent tail at hang-up costs no transcription request');
    check(outcomes.length === 1, 'the audit record is still written');
  }

  // ==========================================================================
  // B4. Double stop, and stray media after stop.
  // ==========================================================================
  {
    const outcomes = [];
    const client = makeRecordingClient([]);
    const handler = makeHandler({ transcribeClient: client, smsClient: makeFakeSmsClient(), twilioRestClient: makeFakeTwilioRestClient(), outcomes });
    await handler.handleMessage(start('MZ-dbl', 'CA-dbl'));
    await feed(handler, 'MZ-dbl', n(100, LOUD)); // 2s spoken tail, nothing emitted yet
    await handler.handleMessage(stop('MZ-dbl', 'CA-dbl'));
    await handler.handleMessage(stop('MZ-dbl', 'CA-dbl'));
    check(client.requests === 1, 'two "stop" events flush the tail once');
    check(outcomes.length === 1, 'two "stop" events write the audit record once');
    await feed(handler, 'MZ-dbl', n(300, LOUD));
    check(client.requests === 1, 'media arriving after "stop" is ignored — no further requests');
  }

  // ==========================================================================
  // B5. No flush at the 30-minute monitoring limit.
  // ==========================================================================
  {
    let nowMs = Date.parse('2026-09-26T10:00:00Z');
    const sms = makeFakeSmsClient();
    const outcomes = [];
    const alerts = [];
    const client = makeRecordingClient([]);
    const handler = makeHandler({ transcribeClient: client, smsClient: sms, twilioRestClient: makeFakeTwilioRestClient(), outcomes, alerts, now: () => new Date(nowMs) });
    await handler.handleMessage(start('MZ-cap', 'CA-cap'));
    await feed(handler, 'MZ-cap', n(100, LOUD)); // 2s spoken, buffered
    nowMs += 30 * 60 * 1000;
    await handler.handleMessage(media('MZ-cap', LOUD()), { closeConnection: () => {} });
    await handler.handleMessage(stop('MZ-cap', 'CA-cap'));
    check(client.requests === 0, 'reaching the 30-minute limit does not flush the buffer — transcription stops there, as before');
    check(outcomes.length === 1 && outcomes[0].monitoringLimitReached === true, 'the limit path records its outcome once, unchanged');
    check(sms.calls.length === 1 && sms.calls[0].body === MONITORING_LIMIT_ENDED_BODY, 'the customer still gets the monitoring-ended SMS, once');
  }

  // ==========================================================================
  // B6. Live red line (call still connected) is unchanged.
  // ==========================================================================
  {
    const sms = makeFakeSmsClient();
    const twilio = makeFakeTwilioRestClient();
    const outcomes = [];
    const client = makeRecordingClient([TAIL_RED_LINE]);
    const handler = makeHandler({ transcribeClient: client, smsClient: sms, twilioRestClient: twilio, outcomes });
    await handler.handleMessage(start('MZ-live', 'CA-live'));
    await feed(handler, 'MZ-live', n(150, QUIET));
    check(sms.calls.length === 1 && sms.calls[0].body === RED_LINE_WARNING_BODY, 'a red line while the call is live still sends the existing red-line SMS');
    check(twilio.updates.length >= 1 && twilio.updates[0].sid === 'CA-live', 'a red line while the call is live still terminates the call');
    await handler.handleMessage(stop('MZ-live', 'CA-live'));
    check(outcomes.length === 1 && outcomes[0].terminatedBySystem === true, 'live termination is recorded as before');
    check(sms.calls.length === 1, 'no second SMS at hang-up after a live red line');
  }

  // ==========================================================================
  // B7. Progressive (non-red-line) risk found only in the tail.
  // ==========================================================================
  {
    const sms = makeFakeSmsClient();
    const twilio = makeFakeTwilioRestClient();
    const outcomes = [];
    const client = makeRecordingClient(['Hello there.', 'Please read me the one time passcode.']);
    const handler = makeHandler({ transcribeClient: client, smsClient: sms, twilioRestClient: twilio, outcomes });
    await handler.handleMessage(start('MZ-prog', 'CA-prog'));
    await feed(handler, 'MZ-prog', [...n(150, QUIET), ...n(100, LOUD)]);
    await handler.handleMessage(stop('MZ-prog', 'CA-prog'));
    check(sms.calls.length === 1, 'risk found only in the tail still warns the customer, once');
    check([WARNING_BODY, POST_CALL_RED_LINE_WARNING_BODY].includes(sms.calls[0].body) && sms.calls[0].body !== RED_LINE_WARNING_BODY, 'post-call warning never claims the call "was ended automatically"');
    check(twilio.updates.length === 0, 'no termination attempt after hang-up');
  }

  // ==========================================================================
  // B8. A hung transcription cannot block the audit record forever.
  // ==========================================================================
  {
    const outcomes = [];
    const client = { transcribe: () => new Promise(() => {}) }; // never resolves
    const handler = makeHandler({ transcribeClient: client, smsClient: makeFakeSmsClient(), twilioRestClient: makeFakeTwilioRestClient(), outcomes, finalizeWaitMs: 20 });
    await handler.handleMessage(start('MZ-hung', 'CA-hung'));
    for (const f of n(150, QUIET)) handler.handleMessage(media('MZ-hung', f));
    const t0 = Date.now();
    await handler.handleMessage(stop('MZ-hung', 'CA-hung'));
    check(outcomes.length === 1, 'the audit record is still written when a transcription never returns');
    check(Date.now() - t0 < 1000, 'and only after the bounded wait, not indefinitely');
  }

  // ==========================================================================
  // C. Monitor-level: markCallEnded semantics.
  // ==========================================================================
  {
    const sms = makeFakeSmsClient();
    const twilio = makeFakeTwilioRestClient();
    const monitor = createCallMonitor({
      callSid: 'CA-mon', householdId: 'h', smsClient: sms, toNumber: '+447700900201', fromNumber: '+441615700779',
      twilioRestClient: twilio, redLineRedirectUrl: 'https://example.test/red-line-terminate',
    });
    await monitor.handleTranscribedChunk('Hello, this is your bank.', { sequence: 0 });
    monitor.markCallEnded();
    monitor.markCallEnded();
    await monitor.handleTranscribedChunk("Don't speak to your bank or your family.", { sequence: 1 });
    const summary = monitor.getSummary();
    check(sms.calls.length === 1 && sms.calls[0].body === POST_CALL_RED_LINE_WARNING_BODY, 'monitor: after markCallEnded, a red line sends the post-call SMS');
    check(twilio.updates.length === 0 && summary.terminatedBySystem === false, 'monitor: after markCallEnded, no termination is attempted or recorded');
    check(summary.detectedAfterCallEnded === true, 'monitor: the summary records that detection happened after the call ended');

    const sms2 = makeFakeSmsClient();
    const monitor2 = createCallMonitor({ callSid: 'CA-mon2', householdId: 'h', smsClient: sms2, toNumber: '+447700900202', fromNumber: '+441615700779' });
    await monitor2.handleTranscribedChunk("Don't speak to your bank or your family.", { sequence: 0 });
    monitor2.markCallEnded();
    await monitor2.handleTranscribedChunk("Don't speak to your bank or your family.", { sequence: 1 });
    check(sms2.calls.length === 1 && sms2.calls[0].body === RED_LINE_WARNING_BODY, 'monitor: a red line already handled live is not repeated after the call ends');
  }

  completed = true;
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring hang-up flush checks passed.');
  }
}

run();
