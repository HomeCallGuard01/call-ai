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

'use strict';

const { createWindowBuffer } = require('./audioWindow');
const { transcribeChunk } = require('./transcribeChunk');
const { createCallMonitor } = require('./riskMonitor');
const { logEvent } = require('./structuredLog');
const { sendCriticalAlert } = require('../alerting');

/**
 * @param {object} deps
 * @param {object} deps.transcribeClient - passed through to transcribeChunk
 * @param {object} deps.smsClient - passed through to riskMonitor
 * @param {string} deps.fromNumber - the household's protected Twilio number (default SMS "from")
 * @param {object|null} [deps.twilioRestClient] - passed through to riskMonitor
 *   for red-line termination. Omit in tests that don't exercise it.
 * @param {string|null} [deps.redLineRedirectUrl] - passed through to riskMonitor
 * @param {(outcome: {callSid, riskScore, decisionReason, warningSent, terminatedBySystem, terminationReason}) => Promise<void>} [deps.recordOutcome]
 *   - called once per call, on "stop", with a short summary only (no
 *   transcript, no audio). Optional so tests can omit it; a rejection
 *   here is caught and logged, never allowed to affect anything else —
 *   this runs after the call has already ended.
 */
function createMediaStreamHandler({ transcribeClient, smsClient, fromNumber, twilioRestClient = null, redLineRedirectUrl = null, recordOutcome }) {
  // Per-stream state, keyed by Twilio's streamSid — one entry per active
  // call being monitored. Cleaned up on "stop".
  const streams = new Map();

  function handleMessage(rawMessage) {
    let message;
    try {
      message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    } catch (err) {
      logEvent('media_stream_malformed_message', { error: err.message });
      return Promise.resolve();
    }

    if (message.event === 'start') {
      const { streamSid, callSid, customParameters = {} } = message.start;
      const windowBuffer = createWindowBuffer();
      const monitor = createCallMonitor({
        callSid,
        householdId: customParameters.householdId || null,
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
      streams.set(streamSid, { windowBuffer, monitor, callSid, lastTranscript: null });
      logEvent('media_stream_started', { streamSid, callSid, householdId: customParameters.householdId || null });
      return Promise.resolve();
    }

    if (message.event === 'media') {
      const entry = streams.get(message.streamSid);
      if (!entry) return Promise.resolve(); // stray media after stop, or unknown stream — ignore, never throw

      const frame = Buffer.from(message.media.payload, 'base64');
      const window = entry.windowBuffer.addFrame(frame);
      if (!window) return Promise.resolve();

      return transcribeChunk(window, { client: transcribeClient, callSid: entry.callSid, promptContext: entry.lastTranscript })
        .then(text => {
          if (text) entry.lastTranscript = text;
          return entry.monitor.handleTranscribedChunk(text);
        })
        .catch(err => {
          // Belt-and-braces: transcribeChunk already never throws, but a
          // failure anywhere in this pipeline must never propagate up to
          // the WebSocket connection or the live call. Alerted (rate-
          // limited by type, see services/alerting.js) since a run of
          // these across calls in a short window usually means the
          // whole transcription/scoring pipeline is broken (e.g. OpenAI
          // down), not one bad audio frame.
          logEvent('media_stream_pipeline_error', { streamSid: message.streamSid, error: err.message });
          sendCriticalAlert('live_monitoring_pipeline_error', `Live-monitoring pipeline error: ${err.message}`, {
            streamSid: message.streamSid,
          }).catch(() => {});
        });
    }

    if (message.event === 'stop') {
      const entry = streams.get(message.streamSid);
      const summary = entry ? entry.monitor.getSummary() : null;

      logEvent('media_stream_stopped', {
        streamSid: message.streamSid,
        callSid: entry ? entry.callSid : null,
        warningSent: summary ? summary.warningSent : null,
        peakRiskScore: summary ? summary.peakRiskScore : null,
        terminatedBySystem: summary ? summary.terminatedBySystem : null,
      });

      streams.delete(message.streamSid);

      if (entry && summary && typeof recordOutcome === 'function') {
        return recordOutcome({
          callSid: entry.callSid,
          riskScore: summary.peakRiskScore,
          decisionReason: summary.peakRiskIndicatorIds.length > 0 ? summary.peakRiskIndicatorIds.join(', ') : null,
          warningSent: summary.warningSent,
          terminatedBySystem: summary.terminatedBySystem,
          terminationReason: summary.criticalSignalIds.length > 0 ? summary.criticalSignalIds.join(', ') : null,
        }).catch(err => {
          // The call has already ended — a persistence failure here must
          // never be treated as anything other than "we couldn't save the
          // audit record", never surfaced as a call-affecting error.
          logEvent('monitoring_outcome_record_failed', { streamSid: message.streamSid, error: err.message });
        });
      }

      return Promise.resolve();
    }

    // "connected" and any other/unknown event: nothing to do.
    return Promise.resolve();
  }

  return { handleMessage, _streamsForTesting: streams };
}

module.exports = { createMediaStreamHandler };
