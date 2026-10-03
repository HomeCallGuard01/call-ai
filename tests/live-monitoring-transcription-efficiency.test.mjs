// Regression coverage for the 2026-09-26 transcription-efficiency fix:
// pause-aligned, NON-overlapping transcription segments
// (services/liveMonitoring/speechSegmenter.js) replacing the old 4s
// window / 2s overlap buffer (audioWindow.js), which sent every second
// of monitored audio to paid transcription twice.
//
// The overlap existed for a real reason — the 2026-08-16 staging call
// where "don't speak to your | bank" was cut mid-phrase and the
// continuation mistranscribed (see
// live-monitoring-transcription-robustness.test.mjs). So these checks
// prove not just "cheaper", but that the boundary protection the overlap
// provided is still there:
//   1. continuous audio is transcribed once, never twice
//   2. cuts land in quiet gaps, not through words
//   3. a scam phrase spanning a cut still drives detection
//   4. transcript context (Whisper prompt + accumulated transcript)
//      survives, including out-of-order responses
//   5. warning/escalation behaviour is unchanged (single-fire)
//   6. trusted-contact calls never reach this pipeline
//   7. the 30-minute per-call monitoring limit is unchanged
//   8. a failed transcription is never re-submitted by this pipeline
//
// Run with: node tests/live-monitoring-transcription-efficiency.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  createSpeechSegmenter,
  frameEnergy,
  DEFAULT_MIN_SEGMENT_MS,
  DEFAULT_MAX_SEGMENT_MS,
  DEFAULT_QUIET_MEAN_ABS,
} = require('../services/liveMonitoring/speechSegmenter.js');
const { createWindowBuffer } = require('../services/liveMonitoring/audioWindow.js');
const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');
const { createCallMonitor } = require('../services/liveMonitoring/riskMonitor.js');
const { RED_LINE_WARNING_BODY, MONITORING_LIMIT_ENDED_BODY } = require('../services/liveMonitoring/smsWarning.js');

// Test-only: trusts the stream's own parameters. Production uses
// streamAuth.js, which never does (P0 remediation, 2026-10-01).
const trustingTestAuthorizer = ({ callSid, customParameters = {} } = {}) => ({ householdId: customParameters.householdId || `test-household-${callSid}`, toNumber: customParameters.toNumber || null, fromNumber: customParameters.protectedNumber || null });


const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- synthetic Twilio audio -----------------------------------------------
// Real Twilio frames are 160 mulaw bytes (20ms @ 8kHz). 0xFF decodes to
// linear 0 (silence); 0x80/0x00 are near full scale (speech-loud). Each
// frame carries a unique id in byte 0 while keeping its loud/quiet
// energy class, so emitted segments can be traced back frame-by-frame.
const FRAME_BYTES = 160;
const LOUD_BYTE = 0x80;
const QUIET_BYTE = 0xff;

let frameCounter = 0;
// The id is spread 4 bits per byte over bytes 0-3, each byte kept in its
// energy class (0x80-0x8F decode near full scale; 0xF0-0xFF decode to
// <= 120 linear, i.e. quiet), so tagging never changes loud/quiet.
function makeFrame(loud) {
  const frame = Buffer.alloc(FRAME_BYTES, loud ? LOUD_BYTE : QUIET_BYTE);
  const id = frameCounter++;
  const base = loud ? 0x80 : 0xf0;
  for (let b = 0; b < 4; b++) frame[b] = base | ((id >> (4 * b)) & 0x0f);
  return { frame, id, loud };
}

function frameId(frame) {
  let id = 0;
  for (let b = 0; b < 4; b++) id |= (frame[b] & 0x0f) << (4 * b);
  return id;
}

// Speech-like pattern: "words" of loud frames separated by gaps of quiet
// frames. gapFrames < pause length (10) models continuous speech with
// only inter-word gaps; gapFrames >= 10 models a genuine pause.
function speech({ words, wordFrames, gapFrames }) {
  const frames = [];
  for (let w = 0; w < words; w++) {
    for (let i = 0; i < wordFrames; i++) frames.push(makeFrame(true));
    for (let i = 0; i < gapFrames; i++) frames.push(makeFrame(false));
  }
  return frames;
}

function segmentAll(segmenter, frames) {
  const segments = [];
  for (const f of frames) {
    const seg = segmenter.addFrame(f.frame);
    if (seg) segments.push(seg);
  }
  return segments;
}

function framesOf(segment) {
  const out = [];
  for (let i = 0; i < segment.length; i += FRAME_BYTES) out.push(segment.subarray(i, i + FRAME_BYTES));
  return out;
}

function makeFakeSmsClient() {
  const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); return { sid: 'SM_test' }; } } };
}

function mediaMessage(streamSid, frame) {
  return JSON.stringify({ event: 'media', streamSid, media: { payload: frame.toString('base64') } });
}

function startMessage(streamSid, callSid) {
  return JSON.stringify({
    event: 'start',
    start: {
      streamSid,
      callSid,
      customParameters: { householdId: `household-${callSid}`, toNumber: '+447700900123', protectedNumber: '+441615700779' },
    },
  });
}

async function run() {
  // ==========================================================================
  // Sanity: the energy classifier agrees with the synthetic audio.
  // ==========================================================================
  check(frameEnergy(makeFrame(false).frame) < DEFAULT_QUIET_MEAN_ABS, 'synthetic quiet frame is below the quiet threshold');
  check(frameEnergy(makeFrame(true).frame) > DEFAULT_QUIET_MEAN_ABS * 10, 'synthetic loud frame is far above the quiet threshold');
  check(frameEnergy(Buffer.alloc(FRAME_BYTES, 0xff)) === 0, 'mulaw 0xFF decodes to true silence (energy 0)');

  // ==========================================================================
  // 1. Continuous audio is transcribed ONCE, never twice.
  // ==========================================================================
  {
    // 60s of continuous speech with only short inter-word gaps (no pause
    // long enough for rule 2) — the hardest case for forced cuts.
    const input = speech({ words: 250, wordFrames: 8, gapFrames: 4 }); // 250 * 12 * 20ms = 60s
    const segmenter = createSpeechSegmenter();
    const segments = segmentAll(segmenter, input);

    const emittedFrames = segments.flatMap(framesOf);
    const totalInput = input.length;
    const buffered = segmenter.bufferedFrameCount();

    check(emittedFrames.length + buffered === totalInput, `every input frame is emitted exactly once or still buffered (${emittedFrames.length} + ${buffered} = ${totalInput})`);

    const ids = emittedFrames.map(f => frameId(f));
    const inputIds = input.slice(0, emittedFrames.length).map(f => frameId(f.frame));
    check(ids.every((id, i) => id === inputIds[i]), 'concatenated segments reproduce the input audio byte-for-byte, in order — no frame repeated, skipped or reordered');
    check(new Set(ids).size === ids.length, 'no frame appears in more than one segment (zero overlap)');

    const minF = DEFAULT_MIN_SEGMENT_MS / 20;
    const maxF = DEFAULT_MAX_SEGMENT_MS / 20;
    check(
      segments.every(s => s.length / FRAME_BYTES >= minF && s.length / FRAME_BYTES <= maxF),
      `every segment is between ${DEFAULT_MIN_SEGMENT_MS}ms and ${DEFAULT_MAX_SEGMENT_MS}ms (Whisper gets comparable context to the old 4s window)`
    );

    // Old buffer on the same audio, for the before/after ratio.
    const oldBuf = createWindowBuffer();
    let oldAudioFrames = 0;
    let oldRequests = 0;
    for (const f of input) {
      const w = oldBuf.addFrame(f.frame);
      if (w) { oldRequests++; oldAudioFrames += w.length / FRAME_BYTES; }
    }
    const ratioOld = oldAudioFrames / totalInput;
    const ratioNew = emittedFrames.length / totalInput;
    check(ratioOld > 1.9, `OLD overlap buffer submitted ~2x the audio for transcription (${ratioOld.toFixed(2)}x, ${oldRequests} requests/min)`);
    check(ratioNew <= 1.0, `NEW segmenter submits each second at most once (${ratioNew.toFixed(2)}x, ${segments.length} requests/min)`);
  }

  // ==========================================================================
  // 2. Words spanning a boundary: cuts land in quiet gaps, not in words.
  // ==========================================================================
  {
    // (a) genuine pauses (>= 200ms) — cut on the pause (rule 2)
    const input = speech({ words: 40, wordFrames: 30, gapFrames: 15 });
    const segmenter = createSpeechSegmenter();
    const segments = segmentAll(segmenter, input);
    const loudById = new Map(input.map(f => [frameId(f.frame), f.loud]));
    const lastFrameQuiet = segments.every(s => {
      const fs = framesOf(s);
      return loudById.get(frameId(fs[fs.length - 1])) === false;
    });
    check(segments.length > 0 && lastFrameQuiet, 'with real pauses, every segment ends inside a pause — no word is cut');

    // (b) continuous speech, only 80ms inter-word gaps (below the 200ms
    //     pause length) — the forced cut (rule 3) still lands in a gap
    const input2 = speech({ words: 200, wordFrames: 9, gapFrames: 4 });
    const segmenter2 = createSpeechSegmenter();
    const segments2 = segmentAll(segmenter2, input2);
    const loudById2 = new Map(input2.map(f => [frameId(f.frame), f.loud]));
    const cutInGap = segments2.every(s => {
      const fs = framesOf(s);
      return loudById2.get(frameId(fs[fs.length - 1])) === false;
    });
    check(segments2.length > 0 && cutInGap, 'in continuous speech with no pause, forced cuts still land in an inter-word gap, never mid-word');

    // (c) a single unbroken loud stretch longer than max: must still cut
    //     (bounded latency) and never lose or duplicate audio
    const input3 = [];
    for (let i = 0; i < 600; i++) input3.push(makeFrame(true));
    const segmenter3 = createSpeechSegmenter();
    const segments3 = segmentAll(segmenter3, input3);
    const emitted3 = segments3.reduce((n, s) => n + s.length / FRAME_BYTES, 0);
    check(
      segments3.length >= 2 && emitted3 + segmenter3.bufferedFrameCount() === 600,
      'an unbroken 12s loud stretch is still cut at the max length, with no audio lost or duplicated'
    );

    // (d) silence-only audio still produces regular segments (monitoring
    //     never stalls waiting for speech)
    const segmenter4 = createSpeechSegmenter();
    let silentSegments = 0;
    for (let i = 0; i < 500; i++) if (segmenter4.addFrame(makeFrame(false).frame)) silentSegments++;
    check(silentSegments === 3, `10s of silence yields 3 segments at the ${DEFAULT_MIN_SEGMENT_MS}ms minimum (got ${silentSegments})`);
  }

  // ==========================================================================
  // 3. Scam phrases spanning a boundary still influence detection.
  // ==========================================================================
  {
    // Red line, with Whisper's typical chunk-final full stop at the cut
    const sms = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-bnd-1', householdId: 'h', smsClient: sms, toNumber: '+447700900001', fromNumber: '+441615700779' });
    const r1 = await monitor.handleTranscribedChunk("Listen carefully. Don't speak to your.", { sequence: 0 });
    check(r1.criticalTriggeredThisCall === false, 'boundary red line, chunk 1 alone: no red line yet');
    const r2 = await monitor.handleTranscribedChunk('Bank or your family about this.', { sequence: 1 });
    check(r2.criticalTriggeredThisCall === true, 'boundary red line: "Don\'t speak to your." + "Bank or your family" fires despite the chunk-final full stop');
    check(sms.calls.length === 1 && sms.calls[0].body === RED_LINE_WARNING_BODY, 'boundary red line sends exactly one red-line SMS');

    // Progressive (non-red-line) signal split across a boundary
    const sms2 = makeFakeSmsClient();
    const monitor2 = createCallMonitor({ callSid: 'CA-bnd-2', householdId: 'h', smsClient: sms2, toNumber: '+447700900002', fromNumber: '+441615700779' });
    await monitor2.handleTranscribedChunk('Can you read me the one time.', { sequence: 0 });
    const p2 = await monitor2.handleTranscribedChunk('Passcode we just sent you?', { sequence: 1 });
    check(p2.riskScore >= 55, `boundary progressive signal: "one time." + "Passcode" still scores as a credential request (score ${p2.riskScore})`);

    // Boundary joining must not manufacture the real 2026-08-16 failure
    // mode into a detection: the inverted continuation stays benign.
    const sms3 = makeFakeSmsClient();
    const monitor3 = createCallMonitor({ callSid: 'CA-bnd-3', householdId: 'h', smsClient: sms3, toNumber: '+447700900003', fromNumber: '+441615700779' });
    await monitor3.handleTranscribedChunk("Don't hang up, don't speak to your.", { sequence: 0 });
    const inv = await monitor3.handleTranscribedChunk("I can't speak to your bank or your family about this, but I need you to.", { sequence: 1 });
    check(inv.criticalTriggeredThisCall === false, 'boundary joining does not turn the real inverted mistranscription ("I can\'t speak to your bank") into a red line');

    // Benign speech across a boundary stays benign
    const sms4 = makeFakeSmsClient();
    const monitor4 = createCallMonitor({ callSid: 'CA-bnd-4', householdId: 'h', smsClient: sms4, toNumber: '+447700900004', fromNumber: '+441615700779' });
    await monitor4.handleTranscribedChunk('Hi, it is your neighbour.', { sequence: 0 });
    const b = await monitor4.handleTranscribedChunk('I am returning your ladder later today.', { sequence: 1 });
    check(b.riskScore === 0 && sms4.calls.length === 0, 'benign conversation across a boundary scores 0 and sends nothing');
  }

  // ==========================================================================
  // 4. Transcript context remains available.
  // ==========================================================================
  {
    // (a) Whisper prompt context: each request gets the previous chunk's text
    const prompts = [];
    const lines = ['Hello, this is the fraud team.', 'We have seen activity on your card.', 'Nothing to worry about yet.'];
    let i = 0;
    const transcribeClient = { transcribe: async (_wav, prompt) => { prompts.push(prompt); return lines[i++] ?? null; } };
    const handler = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer, transcribeClient, smsClient: makeFakeSmsClient(), fromNumber: '+441615700779', sendAlert: async () => true });
    await handler.handleMessage(startMessage('MZ-ctx', 'CA-ctx'));
    // 3 segments of silence at the 3s minimum = 450 frames
    for (let n = 0; n < 450; n++) await handler.handleMessage(mediaMessage('MZ-ctx', makeFrame(false).frame));
    check(prompts.length === 3, `3 segments produced 3 transcription requests (got ${prompts.length})`);
    check(prompts[0] === undefined || prompts[0] === null, 'first request of a call has no prompt context');
    check(prompts[1] === lines[0] && prompts[2] === lines[1], 'each later request is given the preceding chunk\'s transcript as Whisper prompt context');

    // (b) accumulated transcript: signals from far-apart chunks combine
    const sms = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-acc', householdId: 'h', smsClient: sms, toNumber: '+447700900005', fromNumber: '+441615700779' });
    const early = await monitor.handleTranscribedChunk('This is the fraud department calling.', { sequence: 0 });
    await monitor.handleTranscribedChunk('Thank you for holding.', { sequence: 1 });
    await monitor.handleTranscribedChunk('Just checking a few details.', { sequence: 2 });
    const later = await monitor.handleTranscribedChunk('It is urgent, your account will be suspended.', { sequence: 3 });
    check(later.riskScore > early.riskScore, `signals from chunk 0 and chunk 3 accumulate across the call (score ${early.riskScore} -> ${later.riskScore})`);

    // (c) out-of-order Whisper responses are placed in audio order
    const sms5 = makeFakeSmsClient();
    const monitor5 = createCallMonitor({ callSid: 'CA-ooo', householdId: 'h', smsClient: sms5, toNumber: '+447700900006', fromNumber: '+441615700779' });
    const late = await monitor5.handleTranscribedChunk('bank or your family about this.', { sequence: 1 });
    check(late.criticalTriggeredThisCall === false, 'out of order: the second half alone does not fire');
    const first = await monitor5.handleTranscribedChunk("Don't speak to your", { sequence: 0 });
    check(first.criticalTriggeredThisCall === true, 'out of order: when the first half arrives late, the phrase is rebuilt in audio order and the red line fires');

    // (d) the handler really does tag chunks with audio-order sequences,
    //     even when transcription promises resolve in reverse order
    const resolvers = [];
    const deferredClient = { transcribe: () => new Promise(resolve => resolvers.push(resolve)) };
    const sms6 = makeFakeSmsClient();
    const handler6 = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer, transcribeClient: deferredClient, smsClient: sms6, fromNumber: '+441615700779', sendAlert: async () => true });
    await handler6.handleMessage(startMessage('MZ-ooo', 'CA-ooo2'));
    const pending = [];
    for (let n = 0; n < 300; n++) pending.push(handler6.handleMessage(mediaMessage('MZ-ooo', makeFrame(false).frame)));
    check(resolvers.length === 2, 'two segments in flight at once');
    resolvers[1]('bank or your family about this.');
    await new Promise(r => setImmediate(r));
    resolvers[0]("Don't speak to your");
    await Promise.all(pending);
    check(sms6.calls.length === 1 && sms6.calls[0].body === RED_LINE_WARNING_BODY, 'end-to-end: responses resolving in reverse order still reconstruct the phrase and fire the red line once');
  }

  // ==========================================================================
  // 5. Warning/escalation behaviour is unchanged.
  // ==========================================================================
  {
    // progressive warning fires once, even as more scam chunks arrive
    const sms = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-warn', householdId: 'h', smsClient: sms, toNumber: '+447700900007', fromNumber: '+441615700779' });
    await monitor.handleTranscribedChunk('Please confirm your one time passcode.', { sequence: 0 });
    await monitor.handleTranscribedChunk('Read me the security code now.', { sequence: 1 });
    await monitor.handleTranscribedChunk('And the card number too.', { sequence: 2 });
    check(sms.calls.length === 1, 'progressive warning SMS is sent exactly once per call');

    // red line: one SMS + one termination attempt, even though both the
    // raw and boundary-joined views contain the phrase
    const sms2 = makeFakeSmsClient();
    const updates = [];
    const twilioRestClient = { calls: (sid) => ({ update: async (p) => { updates.push({ sid, p }); return {}; } }) };
    const monitor2 = createCallMonitor({
      callSid: 'CA-red', householdId: 'h', smsClient: sms2, toNumber: '+447700900008', fromNumber: '+441615700779',
      twilioRestClient, redLineRedirectUrl: 'https://example.test/red-line-terminate',
    });
    await monitor2.handleTranscribedChunk("Don't speak to your bank or your family.", { sequence: 0 });
    await monitor2.handleTranscribedChunk("Don't speak to your bank or your family.", { sequence: 1 });
    check(sms2.calls.length === 1 && sms2.calls[0].body === RED_LINE_WARNING_BODY, 'red line sends exactly one red-line SMS (never an additional progressive one)');
    check(updates.length >= 1 && updates.every(u => u.sid === 'CA-red'), 'red line attempts call termination for the right call');
    const summary = monitor2.getSummary();
    check(summary.warningSent === true && summary.criticalSignalIds.length > 0, 'summary records the red line for the audit record');

    // chunks without a sequence (every pre-existing caller) behave exactly as before: appended
    const sms3 = makeFakeSmsClient();
    const monitor3 = createCallMonitor({ callSid: 'CA-legacy', householdId: 'h', smsClient: sms3, toNumber: '+447700900009', fromNumber: '+441615700779' });
    await monitor3.handleTranscribedChunk("Don't hang up, don't speak to your");
    const legacy = await monitor3.handleTranscribedChunk('bank or your family about this.');
    check(legacy.criticalTriggeredThisCall === true, 'chunks without a sequence are appended in arrival order, as before');
  }

  // ==========================================================================
  // 6. Trusted-contact calls never reach the monitoring pipeline.
  // ==========================================================================
  {
    const server = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
    const voiceStart = server.indexOf('app.post("/voice"');
    const knownStart = server.indexOf('if (isKnown) {', voiceStart);
    // (Telephony abuse P0: the branch now returns via sendVoiceTwiml.)
    const knownEnd = server.indexOf('return sendVoiceTwiml', knownStart);
    const knownBranch = server.slice(knownStart, knownEnd);
    check(voiceStart > 0 && knownStart > voiceStart && knownEnd > knownStart, 'located /voice\'s known-contact branch in server.js');
    check(!/attachLiveMonitoring|\.stream\(/.test(knownBranch), 'known-contact branch attaches no Media Stream — trusted calls are never transcribed');
    check(/dialHouseholdOrFailClosed\(twiml, household\)/.test(knownBranch), 'known-contact branch still dials the household directly');
  }

  // ==========================================================================
  // 7. The 30-minute per-call monitoring limit is unchanged.
  // ==========================================================================
  {
    let nowMs = Date.parse('2026-09-26T10:00:00Z');
    const now = () => new Date(nowMs);
    let requests = 0;
    const transcribeClient = { transcribe: async () => { requests++; return 'hello'; } };
    const sms = makeFakeSmsClient();
    const alerts = [];
    let closed = 0;
    const handler = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer,
      transcribeClient, smsClient: sms, fromNumber: '+441615700779', now,
      sendAlert: async (type) => { alerts.push(type); return true; },
    });
    check(require('../services/liveMonitoring/monitoringLimit.js').DEFAULT_MAX_MONITORING_DURATION_MINUTES === 30, 'default per-call monitoring limit is still 30 minutes');
    await handler.handleMessage(startMessage('MZ-lim', 'CA-lim'));
    for (let n = 0; n < 150; n++) await handler.handleMessage(mediaMessage('MZ-lim', makeFrame(false).frame));
    const before = requests;
    nowMs += 30 * 60 * 1000;
    for (let n = 0; n < 300; n++) {
      await handler.handleMessage(mediaMessage('MZ-lim', makeFrame(false).frame), { closeConnection: () => { closed++; } });
    }
    check(before === 1 && requests === 1, 'no further transcription requests once the 30-minute limit is reached');
    check(alerts.filter(a => a === 'monitoring_limit_reached').length === 1, 'limit-reached ops alert fires exactly once');
    check(sms.calls.filter(c => c.body === MONITORING_LIMIT_ENDED_BODY).length === 1, 'customer is told monitoring ended, exactly once');
    check(closed === 1, 'the media stream is closed exactly once at the limit');
  }

  // ==========================================================================
  // 8. A failed transcription is not re-submitted, and never duplicated.
  // ==========================================================================
  {
    const sizes = [];
    let call = 0;
    const transcribeClient = {
      transcribe: async (wav) => {
        sizes.push(wav.length);
        call++;
        if (call === 2) throw new Error('simulated OpenAI 500');
        return call === 3 ? 'Please confirm your one time passcode.' : 'hello';
      },
    };
    const sms = makeFakeSmsClient();
    const handler = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer, transcribeClient, smsClient: sms, fromNumber: '+441615700779', sendAlert: async () => true });
    await handler.handleMessage(startMessage('MZ-fail', 'CA-fail'));
    for (let n = 0; n < 450; n++) await handler.handleMessage(mediaMessage('MZ-fail', makeFrame(false).frame));
    check(call === 3, `3 segments -> exactly 3 transcription requests, including the failed one (got ${call}) — the pipeline adds no retry of its own (the OpenAI SDK's own retries happen inside a single request)`);
    check(new Set(sizes).size === 1, 'each request carried one segment of audio — nothing re-sent or merged after the failure');
    check(sms.calls.length === 1, 'monitoring carries on after a failed segment: the next segment\'s scam text still triggers the warning');
  }

  // ==========================================================================
  // 9. Review follow-ups: the real 2026-08-16 call, wrong-order false
  //    positives, and end-to-end single submission through the handler.
  // ==========================================================================
  {
    // (a) The real call's verbatim Whisper chunks, now through the
    //     sequenced + boundary-joined path, must produce exactly the
    //     outcome live-monitoring-transcription-robustness.test.mjs pins
    //     for the old path: no red line on the real (inverted) wording,
    //     progressive warning at chunk 11 with score 65, one SMS.
    const realChunks = [
      'you',
      'Thank you.',
      "Hello, I'm calling from your bank, I just want to speak to you about...",
      'want to speak to you about your account.',
      'Bye-bye.',
      'There is something unusual in your account and we need to solve it.',
      'account and we need to sort this out today, urgently.',
      'Thank you.',
      "Don't hang up, don't speak to your...",
      "I can't speak to your bank or your family about this, but I need you to.",
      'I need you to start looking at transferring money.',
      "That's just not going to work out.",
      'Okay, thanks. Bye.',
      'Thank you.',
    ];
    const sms = makeFakeSmsClient();
    const monitor = createCallMonitor({ callSid: 'CA-aug16', householdId: 'h', smsClient: sms, toNumber: '+447700900010', fromNumber: '+441615700779' });
    const results = [];
    for (let s = 0; s < realChunks.length; s++) results.push(await monitor.handleTranscribedChunk(realChunks[s], { sequence: s }));
    check(results.every(r => r.criticalTriggeredThisCall === false), '2026-08-16 real chunks: boundary joining does not turn the actual mistranscribed wording into a red line');
    check(results[10].riskScore === 65, `2026-08-16 real chunks: chunk 11 still scores exactly 65 (got ${results[10].riskScore}) — identical to the pinned pre-change outcome`);
    check(sms.calls.length === 1 && sms.calls[0].body !== RED_LINE_WARNING_BODY, '2026-08-16 real chunks: exactly one progressive (not red-line) SMS, as before');

    // (b) The same real call, had Whisper transcribed the continuation
    //     correctly after a pause-aligned cut (trailing "..." included):
    //     the red line must fire.
    const sms2 = makeFakeSmsClient();
    const monitor2 = createCallMonitor({ callSid: 'CA-aug16-ok', householdId: 'h', smsClient: sms2, toNumber: '+447700900011', fromNumber: '+441615700779' });
    await monitor2.handleTranscribedChunk("Don't hang up, don't speak to your...", { sequence: 0 });
    const ok = await monitor2.handleTranscribedChunk('bank or your family about this.', { sequence: 1 });
    check(ok.criticalTriggeredThisCall === true && sms2.calls.length === 1 && sms2.calls[0].body === RED_LINE_WARNING_BODY, '2026-08-16 phrase split at a cut, correctly transcribed (with Whisper\'s "..."), fires the red line exactly once');

    // (c) Wrong-order false positive: audio order is "bank or your family
    //     ..." THEN "don't speak to your" (no red line when read in
    //     order). If responses arrive reversed, naive arrival-order
    //     appending would manufacture "don't speak to your bank or your
    //     family" — a false red line. Sequencing must prevent that.
    const sms3 = makeFakeSmsClient();
    const monitor3 = createCallMonitor({ callSid: 'CA-wrong-order', householdId: 'h', smsClient: sms3, toNumber: '+447700900012', fromNumber: '+441615700779' });
    await monitor3.handleTranscribedChunk("Don't speak to your", { sequence: 1 });
    const wrong = await monitor3.handleTranscribedChunk('bank or your family', { sequence: 0 });
    check(wrong.criticalTriggeredThisCall === false && sms3.calls.length === 0, 'reversed arrival cannot manufacture a phrase that was never said in that order (no false red line, no SMS)');

    // (d) End to end through the handler: total paid audio == audio fed
    //     minus what is still buffered — each frame submitted once.
    const { wrapMulawAsWav } = require('../services/liveMonitoring/mulawWav.js');
    const headerBytes = wrapMulawAsWav(Buffer.alloc(0)).length;
    let submittedAudioBytes = 0;
    let requests = 0;
    const transcribeClient = { transcribe: async (wav) => { requests++; submittedAudioBytes += wav.length - headerBytes; return 'hello'; } };
    const handler = createMediaStreamHandler({ authorizeStream: trustingTestAuthorizer, transcribeClient, smsClient: makeFakeSmsClient(), fromNumber: '+441615700779', sendAlert: async () => true });
    await handler.handleMessage(startMessage('MZ-e2e', 'CA-e2e'));
    const fed = speech({ words: 100, wordFrames: 20, gapFrames: 12 }); // 64s of speech with real pauses
    for (const f of fed) await handler.handleMessage(mediaMessage('MZ-e2e', f.frame));
    const bufferedFrames = handler._streamsForTesting.get('MZ-e2e').windowBuffer.bufferedFrameCount();
    check(
      submittedAudioBytes === (fed.length - bufferedFrames) * FRAME_BYTES,
      `end to end: paid audio (${submittedAudioBytes} bytes over ${requests} requests) equals fed audio minus the ${bufferedFrames}-frame buffered tail — every frame submitted exactly once`
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring transcription-efficiency checks passed.');
  }
}

run();
