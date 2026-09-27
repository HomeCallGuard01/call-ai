// mediaStreamHandler.js — parses Twilio Media Streams' JSON protocol
// messages and drives the per-call window buffer / transcription / risk
// monitor pipeline. Deliberately separated from the actual WebSocket
// transport (mediaStreamServer.js) so this — the part with real logic —
// is testable with plain message objects, no real socket needed.
//
// Twilio's documented message shapes (https://www.twilio.com/docs/voice/twiml/stream):
//   {"event":"connected", ...}
//   {"event":"start","start":{"streamSid","callSid","customParameters":{...}}}
//   {"event":"media","media":{"payload":"<base64 mulaw>"}}
//   {"event":"stop","stop":{"streamSid"}}
//
// Per-call monitoring safety limit added (cost-protection safeguard): a
// pure cost-control concern layered on top of the existing pipeline — it
// never changes whether, how, or to whom the underlying <Dial>'d call
// connects. See services/liveMonitoring/monitoringLimit.js's own header
// for exactly what the limit does and does not do.

'use strict';

// 2026-09-26: pause-aligned, non-overlapping segments replace
// audioWindow.js's 4s-window/2s-overlap buffer, so each second of audio
// is transcribed once instead of twice — see speechSegmenter.js for why
// that's safe. audioWindow.js is deliberately left intact (and still
// tested) as the one-line rollback: swap createSpeechSegmenter() back to
// createWindowBuffer() below.
const { createSpeechSegmenter } = require('./speechSegmenter');
const { transcribeChunk } = require('./transcribeChunk');
const { createCallMonitor } = require('./riskMonitor');
const { logEvent } = require('./structuredLog');
const { sendCriticalAlert } = require('../alerting');
const { resolveMonitoringMaxDurationMs, hasReachedDurationThreshold, elapsedSeconds, resolveMaxConcurrentStreams } = require('./monitoringLimit');
const { MONITORING_LIMIT_ENDED_BODY } = require('./smsWarning');

const DEFAULT_FINALIZE_WAIT_MS = 15000;

// True only for a genuine JSON object ({...}) — excludes null (typeof
// 'object' but not safe to property-access) and arrays (structurally the
// wrong shape for every message.* field this handler reads). Used
// throughout handleMessage below to validate untrusted WebSocket input
// before any property access or destructuring, never after.
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {object} deps
 * @param {object} deps.transcribeClient - passed through to transcribeChunk
 * @param {object} deps.smsClient - passed through to riskMonitor
 * @param {string} deps.fromNumber - the household's protected Twilio number (default SMS "from")
 * @param {object|null} [deps.twilioRestClient] - passed through to riskMonitor
 *   for red-line termination. Omit in tests that don't exercise it.
 * @param {string|null} [deps.redLineRedirectUrl] - passed through to riskMonitor
 * @param {(outcome: object) => Promise<void>} [deps.recordOutcome]
 *   - called once per call, when monitoring for it ends (either Twilio's
 *   own "stop", or this module proactively stopping at the monitoring
 *   limit), with a short summary only (no transcript, no audio).
 *   Optional so tests can omit it; a rejection here is caught and
 *   logged, never allowed to affect anything else — this runs after the
 *   call has already ended (or after monitoring for it has stopped).
 * @param {number} [deps.maxMonitoringDurationMs] - the per-call AI/live-
 *   monitoring safety limit (default resolved from
 *   MONITORING_MAX_DURATION_MINUTES, 30 minutes). Once reached, the
 *   transcription/scoring pipeline stops for that call — the underlying
 *   dialled call is never touched.
 * @param {() => Date} [deps.now] - injectable clock for tests.
 * @param {number} [deps.finalizeWaitMs] - on "stop", the longest the
 *   audit record (recordOutcome) waits for the hang-up tail and any
 *   still-in-flight chunks to finish before being written anyway
 *   (default 15s). Bounded so a hung transcription request can never
 *   stop a call's outcome being recorded.
 * @param {(type: string, message: string, context?: object) => Promise<boolean>} [deps.sendAlert]
 * @param {number} [deps.maxConcurrentStreams] - abuse/cost-exhaustion
 *   guard (default resolved from MEDIA_STREAM_MAX_CONCURRENT_STREAMS, 200)
 *   — see monitoringLimit.js's own comment. /media-stream has no
 *   authentication yet (shadow-mode signature check only, see
 *   mediaStreamServer.js), so this is the one thing standing between a
 *   flood of forged "start" events and unbounded memory growth / real
 *   OpenAI transcription cost from forged "media" events on top of them.
 */
function createMediaStreamHandler({
  transcribeClient,
  smsClient,
  fromNumber,
  twilioRestClient = null,
  redLineRedirectUrl = null,
  recordOutcome,
  maxMonitoringDurationMs = resolveMonitoringMaxDurationMs(),
  now = () => new Date(),
  sendAlert = sendCriticalAlert,
  finalizeWaitMs = DEFAULT_FINALIZE_WAIT_MS,
  maxConcurrentStreams = resolveMaxConcurrentStreams(),
}) {
  // Per-stream state, keyed by Twilio's streamSid — one entry per active
  // call being monitored. Cleaned up on "stop" (or when the monitoring
  // limit is reached, below).
  const streams = new Map();

  // Shared finalize path — the ONE place recordOutcome is called from,
  // whether the stream ended because Twilio genuinely sent "stop" (the
  // call ended normally, or was red-line terminated — Twilio's stream
  // naturally stops either way) or because THIS module proactively
  // closed the connection once the monitoring limit was reached (in
  // which case Twilio never gets to send its own "stop" — we've already
  // closed our end of the socket — so this is the only chance to
  // persist the outcome). A single call site here is what guarantees a
  // call's monitored duration/outcome is never double-recorded or
  // silently dropped regardless of which path ends it.
  function finalizeStream(streamSid, entry, { monitoringLimitReached }) {
    const summary = entry.monitor.getSummary();
    const monitoredDurationSeconds = elapsedSeconds(entry.startedAt, now());

    logEvent('media_stream_stopped', {
      streamSid,
      callSid: entry.callSid,
      householdId: entry.householdId,
      warningSent: summary.warningSent,
      peakRiskScore: summary.peakRiskScore,
      terminatedBySystem: summary.terminatedBySystem,
      detectedAfterCallEnded: summary.detectedAfterCallEnded,
      monitoredDurationSeconds,
      monitoringLimitReached,
    });

    if (typeof recordOutcome !== 'function') return Promise.resolve();

    return recordOutcome({
      callSid: entry.callSid,
      riskScore: summary.peakRiskScore,
      decisionReason: summary.peakRiskIndicatorIds.length > 0 ? summary.peakRiskIndicatorIds.join(', ') : null,
      warningSent: summary.warningSent,
      terminatedBySystem: summary.terminatedBySystem,
      terminationReason: summary.criticalSignalIds.length > 0 ? summary.criticalSignalIds.join(', ') : null,
      monitoredDurationSeconds,
      monitoringLimitReached,
    }).catch(err => {
      // The call has already ended (or monitoring for it has stopped) —
      // a persistence failure here must never be treated as anything
      // other than "we couldn't save the audit record", never surfaced
      // as a call-affecting error.
      logEvent('monitoring_outcome_record_failed', { streamSid, error: err.message });
    });
  }

  // closeConnection, when provided, is the real WebSocket's own close()
  // (mediaStreamServer.js) — called ONLY when the monitoring limit is
  // reached, to stop Twilio continuing to send (and bill for) Media
  // Streams data for this call. Closing our end of this WebSocket has no
  // effect on the underlying <Dial>'d call whatsoever — Media Streams
  // and the Dial are independent, parallel TwiML actions; this is the
  // entire reason the limit can be enforced without ever touching call
  // routing. Optional so every existing test (which drives this handler
  // with plain message objects, no real socket) continues to work
  // unchanged.
  // Transcribes one segment exactly once and hands the text to the
  // monitor at its audio-order position. Shared by live segments and the
  // hang-up tail flush, so both go through identical, never-throwing
  // handling. Tracked in entry.inFlight until settled.
  function processSegment(streamSid, entry, segment) {
    const sequence = entry.nextSequence;
    entry.nextSequence += 1;

    const promise = transcribeChunk(segment, { client: transcribeClient, callSid: entry.callSid, promptContext: entry.lastTranscript })
      .then(text => {
        if (text) entry.lastTranscript = text;
        return entry.monitor.handleTranscribedChunk(text, { sequence });
      })
      .catch(err => {
        // Belt-and-braces: transcribeChunk already never throws, but a
        // failure anywhere in this pipeline must never propagate up to
        // the WebSocket connection or the live call. Alerted (rate-
        // limited by type, see services/alerting.js) since a run of
        // these across calls in a short window usually means the
        // whole transcription/scoring pipeline is broken (e.g. OpenAI
        // down), not one bad audio frame.
        logEvent('media_stream_pipeline_error', { streamSid, error: err.message });
        sendAlert('live_monitoring_pipeline_error', `Live-monitoring pipeline error: ${err.message}`, {
          streamSid,
        }).catch(() => {});
      });

    entry.inFlight.add(promise);
    promise.then(() => entry.inFlight.delete(promise));
    return promise;
  }

  // Resolves once every in-flight segment has settled, or after
  // finalizeWaitMs — whichever is first. Never rejects.
  function waitForInFlight(streamSid, entry) {
    if (entry.inFlight.size === 0) return Promise.resolve();
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        logEvent('monitoring_outcome_wait_timed_out', { streamSid, callSid: entry.callSid, pending: entry.inFlight.size, finalizeWaitMs });
        resolve();
      }, finalizeWaitMs);
      // Deliberately NOT unref()'d: if nothing else is keeping the
      // process alive, the audit record must still be written, so this
      // timer holds the process for at most finalizeWaitMs.
    });
    return Promise.race([Promise.allSettled([...entry.inFlight]), timeout]).then(() => clearTimeout(timer));
  }

  function handleMessage(rawMessage, { closeConnection } = {}) {
    let message;
    try {
      message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    } catch (err) {
      logEvent('media_stream_malformed_message', { error: err.message });
      return Promise.resolve();
    }

    // Shape guard (2026-09-27, P0 launch hardening) — Twilio's documented
    // protocol (this file's own header comment) always sends a JSON
    // object with a string "event" field, but nothing upstream guarantees
    // that. JSON.parse happily returns null, an array, a string, a
    // number, or an object missing the nested "start"/"media" property
    // this handler used to destructure/access unconditionally. Each of
    // those previously reached a genuine synchronous TypeError — e.g.
    // JSON.parse("null") then `message.event` throws "Cannot read
    // properties of null"; `{"event":"start"}` with no `.start` throws on
    // destructuring — that escapes mediaStreamServer.js's `.catch()`
    // entirely (a .catch() can only catch a REJECTED PROMISE, never a
    // SYNCHRONOUS throw from this non-async function), reaching server.js's
    // global uncaughtException handler, which calls alertThenExit() and
    // kills the whole process — dropping every live call being monitored
    // from a single malformed WebSocket frame. Confirmed by independent
    // local reproduction, not assumed. Treated exactly like a JSON.parse
    // failure: logged, never processed, never thrown.
    if (!isPlainObject(message) || typeof message.event !== 'string') {
      logEvent('media_stream_malformed_message', { error: 'parsed message is not a JSON object with a string "event" field' });
      return Promise.resolve();
    }

    if (message.event === 'start') {
      if (!isPlainObject(message.start)) {
        logEvent('media_stream_malformed_message', { error: '"start" event has no "start" object', streamSid: typeof message.streamSid === 'string' ? message.streamSid : null });
        return Promise.resolve();
      }

      // Concurrent-stream cap (see monitoringLimit.js's own comment) —
      // checked BEFORE any pipeline resource is allocated (windowBuffer,
      // monitor, the streams.set() entry itself), so a rejected "start"
      // costs almost nothing and never touches any OTHER already-active
      // stream's state. This can never affect a genuine call under any
      // plausible real load (default 200, this business's busiest single
      // household has never exceeded ~30 calls total, let alone
      // concurrent) — it exists purely to bound a flood, not to
      // distinguish genuine from forged traffic.
      if (streams.size >= maxConcurrentStreams) {
        logEvent('media_stream_concurrent_limit_reached', {
          streamSid: typeof message.streamSid === 'string' ? message.streamSid : null,
          activeStreams: streams.size,
          maxConcurrentStreams,
        });
        sendAlert(
          'media_stream_concurrent_limit_reached',
          `/media-stream refused a new stream — ${streams.size} already active, at the configured limit of ${maxConcurrentStreams}. Investigate for a genuine traffic spike or abuse.`,
          { activeStreams: streams.size, maxConcurrentStreams }
        ).catch(() => {});
        if (typeof closeConnection === 'function') {
          try {
            closeConnection();
          } catch (err) {
            logEvent('media_stream_close_failed', { error: err.message });
          }
        }
        return Promise.resolve();
      }

      const { streamSid, callSid } = message.start;
      // Guarded separately from the destructuring above: a default value
      // (`= {}`) only applies when the destructured property is
      // undefined, NOT when it is explicitly null — {"start":{"customParameters":null}}
      // would otherwise set customParameters to null and crash the very
      // next line. Same class of bug as the guards above, closed the same way.
      const customParameters = isPlainObject(message.start.customParameters) ? message.start.customParameters : {};
      const householdId = customParameters.householdId || null;
      const windowBuffer = createSpeechSegmenter();
      const monitor = createCallMonitor({
        callSid,
        householdId,
        smsClient,
        // No fallback here: the household's own number and the protected
        // Twilio number are different things, and silently warning "to"
        // the Twilio number itself would make no sense. A missing
        // customParameters.toNumber means server.js found no valid
        // household.phone_number — riskMonitor treats that as
        // "no valid destination" and skips the SMS, never the call.
        toNumber: customParameters.toNumber || null,
        // Per-call protected number takes priority over the server-wide
        // default, so the warning SMS is sent "from" the same number the
        // household actually recognises as their protected line.
        fromNumber: customParameters.protectedNumber || fromNumber,
        twilioRestClient,
        redLineRedirectUrl,
      });
      // lastTranscript: the immediately preceding window's transcribed
      // text, passed to the next transcribeChunk() call as Whisper prompt
      // context (2026-08-16) — see transcribeChunk.js's doc comment.
      streams.set(streamSid, {
        windowBuffer,
        monitor,
        callSid,
        householdId,
        lastTranscript: null,
        // Audio-order position of the next segment sent for
        // transcription — passed to the monitor with the result so a
        // response that resolves out of order is still placed where its
        // audio belongs (riskMonitor.js's handleTranscribedChunk).
        nextSequence: 0,
        // Transcribe-and-score promises not yet settled — awaited (with a
        // bound) on "stop" so the audit record includes any detection
        // that lands after the caller hangs up.
        inFlight: new Set(),
        startedAt: now(),
        // Guards against ever running the limit-reached branch twice for
        // the same stream — the narrow window between us deciding to
        // stop and Twilio actually noticing the closed connection (which
        // may still deliver a few more queued "media" events, or even a
        // "stop") is what this protects against. This is what makes the
        // customer SMS and the ops alert both single-fire per call.
        monitoringStopped: false,
      });
      logEvent('media_stream_started', { streamSid, callSid, householdId });
      return Promise.resolve();
    }

    if (message.event === 'media') {
      const entry = streams.get(message.streamSid);
      // Stray media after stop/limit-reached, or an unknown stream —
      // ignore, never throw. entry.monitoringStopped guards the narrow
      // window between us deciding to stop and Twilio actually noticing
      // the closed connection.
      if (!entry || entry.monitoringStopped) return Promise.resolve();

      const nowValue = now();

      if (hasReachedDurationThreshold(entry.startedAt, nowValue, maxMonitoringDurationMs)) {
        // Set BEFORE anything async below, for the same reason
        // riskMonitor.js sets warningSent before awaiting its own SMS
        // send: guarantees at most one limit-reached notification/alert
        // even if further "media" events for this streamSid are already
        // queued/in-flight when this branch runs.
        entry.monitoringStopped = true;
        streams.delete(message.streamSid);

        const monitoredDurationSeconds = elapsedSeconds(entry.startedAt, nowValue);
        logEvent('monitoring_limit_reached', {
          streamSid: message.streamSid,
          callSid: entry.callSid,
          householdId: entry.householdId,
          monitoredDurationSeconds,
          maxMonitoringDurationMs,
        });

        // Ops alert — existing operational-alerting mechanism, unchanged
        // shape from every other sendAlert call in this codebase.
        sendAlert(
          'monitoring_limit_reached',
          `Live AI monitoring stopped for a call after reaching the ${Math.round(maxMonitoringDurationMs / 60000)}-minute safety limit — the call itself remains connected`,
          { callSid: entry.callSid, householdId: entry.householdId, monitoredDurationSeconds }
        ).catch(() => {});

        // Customer notification — mandatory, not optional: a customer
        // must never be left believing live scam-monitoring is still
        // active on this call once it silently isn't. Reuses the exact
        // same safe SMS path (to/from resolution, "no valid destination"
        // skip, catch-and-log-never-throw) every other in-call SMS
        // already goes through — see riskMonitor.js's sendCustomerWarning
        // and services/liveMonitoring/smsWarning.js. A notification
        // failure here is only ever logged (inside sendCustomerWarning
        // itself) — it can never restart monitoring (the pipeline has
        // already been torn down above) and never affects the
        // underlying telephone call, which nothing in this branch
        // touches at all.
        entry.monitor.sendCustomerWarning(MONITORING_LIMIT_ENDED_BODY).catch(err => {
          logEvent('monitoring_limit_notification_failed', { streamSid: message.streamSid, error: err.message });
        });

        const finalizePromise = finalizeStream(message.streamSid, entry, { monitoringLimitReached: true });

        // Stop Twilio sending further Media Streams data for this call —
        // see this function's own header comment for why this can never
        // affect the connected <Dial>. Never allowed to throw past this
        // point; a close failure is logged, not propagated.
        if (typeof closeConnection === 'function') {
          try {
            closeConnection();
          } catch (err) {
            logEvent('media_stream_close_failed', { streamSid: message.streamSid, error: err.message });
          }
        }

        return finalizePromise;
      }

      // Same shape guard as the "start" branch above — {"event":"media"}
      // with no "media" object, or a "media" object with no string
      // "payload", previously reached Buffer.from(undefined, 'base64'),
      // a synchronous TypeError with the exact same server-crashing
      // consequence. A single hostile/malformed "media" frame mid-call
      // must never bring down monitoring for every other live call.
      if (!isPlainObject(message.media) || typeof message.media.payload !== 'string') {
        logEvent('media_stream_malformed_message', { error: '"media" event missing a string "media.payload"', streamSid: message.streamSid });
        return Promise.resolve();
      }

      const frame = Buffer.from(message.media.payload, 'base64');
      const window = entry.windowBuffer.addFrame(frame);
      if (!window) return Promise.resolve();

      return processSegment(message.streamSid, entry, window);
    }

    if (message.event === 'stop') {
      const entry = streams.get(message.streamSid);
      streams.delete(message.streamSid);

      if (!entry) {
        // A stray "stop" for a stream we never registered (or already
        // finalized via the monitoring limit above) — nothing to
        // finalize. Logged plainly, matching this handler's existing
        // convention of never silently swallowing an unexpected message
        // shape.
        logEvent('media_stream_stopped', {
          streamSid: message.streamSid,
          callSid: null,
          warningSent: null,
          peakRiskScore: null,
          terminatedBySystem: null,
        });
        return Promise.resolve();
      }

      // Hang-up flush (2026-09-26). The call is over: mark it so before
      // anything else, so the flushed tail AND any chunk still in flight
      // can warn the customer (post-call wording for a red line) but can
      // never attempt to terminate a call that no longer exists — see
      // riskMonitor.js's markCallEnded. The stream entry was already
      // removed above, so no further media can reach this segmenter;
      // flush() also empties it, so the tail is transcribed at most once.
      // Not done at the monitoring limit (that path finalizes above and
      // deliberately stops all transcription for the call).
      entry.monitoringStopped = true;
      entry.monitor.markCallEnded();
      const tail = entry.windowBuffer.flush();
      if (tail) {
        logEvent('hangup_tail_flushed', { streamSid: message.streamSid, callSid: entry.callSid, tailMs: Math.round(tail.length / 8) });
        processSegment(message.streamSid, entry, tail);
      }

      // The audit record waits (bounded) for the tail and any in-flight
      // chunks, so a detection landing after hang-up is recorded rather
      // than lost — previously it was written before they resolved.
      return waitForInFlight(message.streamSid, entry)
        .then(() => finalizeStream(message.streamSid, entry, { monitoringLimitReached: false }));
    }

    // "connected" and any other/unknown event: nothing to do.
    return Promise.resolve();
  }

  return { handleMessage, _streamsForTesting: streams };
}

module.exports = { createMediaStreamHandler };
