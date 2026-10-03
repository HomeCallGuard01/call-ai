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
//
// Monitored-minute accounting + financial safety (2026-09-26,
// services/usage/): when a `usageMeter` is supplied (server.js always
// supplies one), a stream is only transcribed once it has attached to a
// budget reservation made by /voice's gate; its elapsed seconds are
// reported to the database every few seconds (duplicate-safe absolute
// totals) and at the end; and monitoring stops mid-call — the call itself
// carrying on — if a household daily/monthly £ ceiling or the global
// emergency level is reached, if usage can't be recorded for too long,
// or if transcription volume becomes impossible for the audio received.

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
const { createCostCaps, resolveCostCapConfig, guardSmsClient } = require('./costCaps');
const { MONITORING_LIMIT_ENDED_BODY } = require('./smsWarning');
const { resolveSafetyConfig } = require('../usage/safetyConfig');

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
 * @param {object|null} [deps.usageMeter] - services/usage/usageMeter.js.
 *   When present, monitoring is metered and financially bounded (see the
 *   header). Omitted only by tests that pre-date metering.
 * @param {object} [deps.safetyConfig] - services/usage/safetyConfig.js
 *   values (progress interval, failure window, household request rate).
 * @param {object|null} [deps.smsBudget] - services/usage/smsBudget.js; when
 *   present every customer SMS first claims the Layer B SMS budget.
 * @param {string|null} [deps.safetyStopMessage] - customer SMS sent when a
 *   safety rule or the allowance stops monitoring mid-call. null (default)
 *   = none: wording is a product decision; the app shows the state instead.
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
  // P0 remediation (2026-10-01). authorizeStream({ callSid, streamToken, customParameters })
  // returns the SERVER-derived { householdId, toNumber, fromNumber } for a
  // stream bound to a Twilio-signed /voice (streamAuth.js ignores
  // customParameters entirely; only tests' explicit trusting authoriser
  // reads them), or null. When it is not supplied, every stream is
  // refused (fail closed).
  authorizeStream = null,
  costCaps = null,
  // Telephony abuse P0: async (action, ctx) => boolean — global incident
  // mode for new paid actions (SMS here). Absent = no extra gate.
  paidActionGate = null,
  usageMeter = null,
  safetyConfig = resolveSafetyConfig(),
  smsBudget = null,
  safetyStopMessage = null,
}) {
  // Per-stream state, keyed by Twilio's streamSid — one entry per active
  // call being monitored. Cleaned up on "stop" (or when the monitoring
  // limit is reached, below).
  const streams = new Map();
  const caps = costCaps || createCostCaps(resolveCostCapConfig(), {
    now: () => now().getTime(),
    onLimit: (rule, householdId) => {
      logEvent('media_stream_cost_cap_reached', { rule, householdId: householdId || null });
      sendAlert(`media_stream_${rule}`, `Live monitoring cost cap reached (${rule}); the expensive step was skipped, calls unaffected.`, { rule }).catch(() => {});
    },
  });

  // Transcription requests per household over the last minute, across
  // all of that household's streams — the loop/fault detector in
  // processSegment. Timestamps in ms.
  const householdRequestTimes = new Map();

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
  function finalizeStream(streamSid, entry, { monitoringLimitReached, stopReason = null }) {
    if (!entry.capReleased) { entry.capReleased = true; caps.endStream(entry.householdId); }
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
      stopReason,
    });

    // Final, duplicate-safe usage report — before the audit record, so the
    // session is closed and its seconds counted even if recordOutcome
    // fails. A failure here is logged; the seconds already reported
    // mid-call stay counted.
    const usageRecorded = recordFinalUsage(streamSid, entry, monitoredDurationSeconds, stopReason || (monitoringLimitReached ? 'per_call_limit' : 'call_ended'));

    if (typeof recordOutcome !== 'function') return usageRecorded;

    return usageRecorded.then(() => recordOutcome({
      callSid: entry.callSid,
      riskScore: summary.peakRiskScore,
      decisionReason: summary.peakRiskIndicatorIds.length > 0 ? summary.peakRiskIndicatorIds.join(', ') : null,
      warningSent: summary.warningSent,
      terminatedBySystem: summary.terminatedBySystem,
      terminationReason: summary.criticalSignalIds.length > 0 ? summary.criticalSignalIds.join(', ') : null,
      monitoredDurationSeconds,
      monitoringLimitReached,
      monitoringStopReason: stopReason,
    })).catch(err => {
      // The call has already ended (or monitoring for it has stopped) —
      // a persistence failure here must never be treated as anything
      // other than "we couldn't save the audit record", never surfaced
      // as a call-affecting error.
      logEvent('monitoring_outcome_record_failed', { streamSid, error: err.message });
    });
  }

  function recordFinalUsage(streamSid, entry, totalSeconds, endReason) {
    if (!usageMeter || !entry.attachPromise) return Promise.resolve();
    return entry.attachPromise
      .then(() => {
        if (!entry.metering) return null;
        return usageMeter.progress({ callSid: entry.callSid, streamSid, totalSeconds, final: true, endReason });
      })
      .then(result => {
        if (result && result.ok) notifyUsage(entry, result);
      })
      .catch(err => logEvent('monitoring_usage_final_record_failed', { streamSid, callSid: entry.callSid, error: err.message }));
  }

  // 80% / 100% customer messages — once per billing period, enforced in
  // the database (usageNotifier.js). Fire-and-forget: never delays or
  // affects monitoring.
  function notifyUsage(entry, result) {
    if (!usageMeter || typeof usageMeter.notify !== 'function') return;
    usageMeter.notify({
      householdId: result.householdId || entry.householdId,
      periodStart: result.periodStart,
      usedSeconds: Number(result.periodSeconds),
      allowanceSeconds: Number(result.allowanceSeconds),
      toNumber: entry.toNumber,
      fromNumber: entry.fromNumber,
    }).catch(err => logEvent('usage_notification_failed', { callSid: entry.callSid, error: err.message }));
  }

  // Stops paid monitoring for one stream part-way through a call because
  // a financial-safety rule fired. The telephone call itself is never
  // touched — only this stream is closed. The customer is told plainly
  // that the call is no longer being monitored; the intervention is
  // audited and (critical/emergency) alerted. Single-fire per stream.
  function safetyStop(streamSid, entry, rule, { level = 'critical', notifyCustomer = true, usage = null } = {}) {
    if (entry.safetyStopped) return Promise.resolve();
    entry.safetyStopped = true;
    entry.monitoringStopped = true;
    streams.delete(streamSid);

    logEvent('monitoring_safety_stop', { streamSid, callSid: entry.callSid, householdId: entry.householdId, rule, level });

    const smsSent = Boolean(notifyCustomer && safetyStopMessage);
    if (smsSent) {
      entry.monitor.sendCustomerWarning(safetyStopMessage).catch(err => {
        logEvent('monitoring_safety_stop_notification_failed', { streamSid, error: err.message });
      });
    }

    if (usageMeter && typeof usageMeter.recordIntervention === 'function') {
      usageMeter.recordIntervention({
        level,
        rule,
        action: 'paid monitoring stopped mid-call; the call itself continues',
        householdId: entry.householdId,
        callSid: entry.callSid,
        streamSid,
        usageSecondsBefore: usage ? Number(usage.periodSeconds) : undefined,
        estimatedCostBeforeGbp: usage ? Number(usage.periodCostGbp) : undefined,
        notification: smsSent ? 'sms_safety_monitoring_stopped' : null,
      }).catch(() => {});
    }

    const finalizePromise = finalizeStream(streamSid, entry, { monitoringLimitReached: false, stopReason: rule });
    closeStream(streamSid, entry);
    return finalizePromise;
  }

  function closeStream(streamSid, entry) {
    if (typeof entry.closeConnection !== 'function') return;
    try {
      entry.closeConnection();
    } catch (err) {
      logEvent('media_stream_close_failed', { streamSid, error: err.message });
    }
  }

  // Mid-call usage report (absolute elapsed seconds). Enforces the
  // household daily/monthly £ ceilings and the global emergency level on
  // the returned totals. One report in flight per stream at a time.
  function reportProgress(streamSid, entry, totalSeconds) {
    entry.progressInFlight = true;
    return usageMeter.progress({ callSid: entry.callSid, streamSid, totalSeconds, final: false })
      .then(result => {
        if (!result || !result.ok) {
          logEvent('monitoring_usage_progress_rejected', { streamSid, callSid: entry.callSid, reason: result && result.reason });
          return;
        }
        entry.lastProgressOkAt = now();
        entry.lastReportedSeconds = totalSeconds;
        entry.lastUsage = result;

        if (Number(result.dayCostGbp) >= Number(result.dailyCostLimitGbp)) {
          return safetyStop(streamSid, entry, 'daily_cost_limit', { usage: result });
        }
        if (Number(result.periodCostGbp) >= Number(result.periodCostLimitGbp)) {
          return safetyStop(streamSid, entry, 'period_cost_limit', { usage: result });
        }
        if (Number(result.globalHourCostGbp) >= 2 * safetyConfig.globalHourlyCostLimitGbp) {
          return safetyStop(streamSid, entry, 'global_hourly_cost_emergency', { level: 'emergency', usage: result });
        }
        notifyUsage(entry, result);
        // Layer A, mid-call (enforced plans only): the allowance ran out
        // during this call. Monitoring continues for at most the grace
        // period (plans.js), then stops; the call itself carries on
        // unmonitored. Advertised plan behaviour, not a safety incident.
        if (result.enforceAllowance && Number(result.periodSeconds) >= Number(result.allowanceSeconds) + (usageMeter.graceSeconds || 0)) {
          return safetyStop(streamSid, entry, 'allowance_exhausted_mid_call', { level: 'info', usage: result });
        }
      })
      .catch(err => logEvent('monitoring_usage_progress_failed', { streamSid, callSid: entry.callSid, error: err.message }))
      .finally(() => {
        entry.progressInFlight = false;
      });
  }

  // Transcription-volume anomaly guard. Segments are at least 3s of audio
  // (speechSegmenter.js), so one stream can't legitimately need more than
  // one request per 2s of audio received (+3 slack for the hang-up tail
  // and rounding), and one household's streams together can't exceed
  // maxTranscriptionRequestsPerHouseholdPerMinute. Exceeding either means
  // a loop or fault — stop paying for it.
  function transcriptionRateExceeded(entry) {
    const audioSeconds = entry.framesReceived * 0.02;
    if (entry.requestCount > Math.floor(audioSeconds / 2) + 3) return 'transcription_rate_anomaly';
    if (entry.householdId) {
      const nowMs = now().getTime();
      const times = (householdRequestTimes.get(entry.householdId) || []).filter(t => nowMs - t < 60000);
      times.push(nowMs);
      householdRequestTimes.set(entry.householdId, times);
      if (times.length > safetyConfig.maxTranscriptionRequestsPerHouseholdPerMinute) return 'household_transcription_rate_anomaly';
    }
    return null;
  }

  // Transcribes one segment exactly once and hands the text to the
  // monitor at its audio-order position. Shared by live segments and the
  // hang-up tail flush, so both go through identical, never-throwing
  // handling. Tracked in entry.inFlight until settled.
  function processSegment(streamSid, entry, segment) {
    const sequence = entry.nextSequence;
    entry.nextSequence += 1;

    // With metering on, no paid transcription happens until this stream
    // is confirmed attached to a budget reservation — and never after a
    // safety stop. Fail-closed: an attach that failed or hasn't resolved
    // means no request is sent.
    const startTranscription = () => {
      if (entry.safetyStopped || (usageMeter && !entry.metering)) return Promise.resolve(undefined);
      // Security P0 hard cost cap (costCaps.js), kept alongside the 056
      // metering above (integration 2026-10-03): over a per-household
      // ceiling the segment is skipped — no paid transcription, call untouched.
      if (!caps.allowTranscription(entry.householdId)) return Promise.resolve(undefined);
      entry.requestCount += 1;
      const anomaly = transcriptionRateExceeded(entry);
      if (anomaly) {
        safetyStop(streamSid, entry, anomaly, { usage: entry.lastUsage });
        return Promise.resolve(undefined);
      }
      return transcribeChunk(segment, { client: transcribeClient, callSid: entry.callSid, promptContext: entry.lastTranscript })
        .then(text => ({ text }));
    };
    // Started immediately (same tick, as before metering existed) unless
    // the budget attach is genuinely still pending.
    const attachPending = usageMeter && !entry.metering && !entry.safetyStopped && entry.attachPromise;
    const transcription = attachPending ? entry.attachPromise.then(startTranscription) : startTranscription();

    const promise = transcription
      .then(result => {
        if (!result) return undefined;
        const { text } = result;
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

      // P0 remediation: the stream must present the single-use token issued
      // by a Twilio-signed /voice for THIS CallSid. Household, SMS
      // destination and sender come only from that server-side record —
      // nothing the WebSocket client sends is trusted. Unauthorised: no
      // monitor, no transcription, no SMS; the socket is closed.
      const auth = typeof authorizeStream === 'function' && typeof streamSid === 'string'
        ? authorizeStream({ callSid, streamToken: customParameters.streamToken, customParameters })
        : null;
      if (!auth || !auth.householdId) {
        logEvent('media_stream_unauthorised_start', { streamSid: typeof streamSid === 'string' ? streamSid : null });
        if (typeof closeConnection === 'function') {
          try { closeConnection(); } catch (err) { logEvent('media_stream_close_failed', { error: err.message }); }
        }
        return Promise.resolve();
      }
      const householdId = auth.householdId;
      if (!caps.tryStartStream(householdId)) {
        if (typeof closeConnection === 'function') {
          try { closeConnection(); } catch (err) { logEvent('media_stream_close_failed', { error: err.message }); }
        }
        return Promise.resolve();
      }
      const windowBuffer = createSpeechSegmenter();
      const monitor = createCallMonitor({
        callSid,
        householdId,
        // Integration 2026-10-03 — SMS passes EVERY layer, cheapest refusal first:
        //   guardSmsClient: incident-mode gate, destination policy (UK mobile
        //     only, numberPolicy), per-household SMS count caps (costCaps.js)
        //   → smsBudget: 056 Layer B SMS ceiling charged to this call's period
        //   → smsClient: server.js passes containedSmsClient (Financial
        //     Containment £ authorisation per message), never the raw client.
        smsClient: smsClient
          ? guardSmsClient(
            smsBudget && householdId
              ? smsBudget.forHousehold(householdId, () => {
                const e = streams.get(streamSid);
                return e && e.metering ? { periodStart: e.metering.periodStart, periodEnd: e.metering.periodEnd } : null;
              })
              : smsClient,
            caps, householdId, paidActionGate)
          : smsClient,
        // No fallback here: the household's own number and the protected
        // Twilio number are different things, and silently warning "to"
        // the Twilio number itself would make no sense. A missing
        // auth.toNumber (from the signed /voice's server-side record) means
        // server.js found no valid household.phone_number — riskMonitor treats that as
        // "no valid destination" and skips the SMS, never the call.
        toNumber: auth.toNumber || null,
        // Per-call protected number takes priority over the server-wide
        // default, so the warning SMS is sent "from" the same number the
        // household actually recognises as their protected line.
        fromNumber: auth.fromNumber || fromNumber,
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
        // Financial safety (2026-09-26) — see the file header.
        safetyStopped: false,
        toNumber: customParameters.toNumber || null,
        fromNumber: customParameters.protectedNumber || fromNumber,
        closeConnection,
        framesReceived: 0,
        requestCount: 0,
        metering: null,
        attachPromise: null,
        lastReportedSeconds: 0,
        lastProgressOkAt: now(),
        lastUsage: null,
        progressInFlight: false,
      });
      logEvent('media_stream_started', { streamSid, callSid, householdId });

      if (usageMeter) {
        const entry = streams.get(streamSid);
        entry.attachPromise = Promise.resolve()
          .then(() => usageMeter.attach({ callSid, streamSid }))
          .then(result => {
            if (result && result.ok) {
              entry.metering = result;
              entry.lastProgressOkAt = now();
              return;
            }
            const reason = (result && result.reason) || 'no_budget_reservation';
            // A second stream for a call that already has one is a fault,
            // not a customer-facing event: the first stream keeps
            // monitoring, so this one is closed quietly.
            safetyStop(streamSid, entry, reason === 'duplicate_stream' ? 'duplicate_stream' : 'no_budget_reservation', {
              notifyCustomer: reason !== 'duplicate_stream',
            });
          })
          .catch(err => {
            logEvent('monitoring_usage_attach_failed', { streamSid, callSid, error: err.message });
            safetyStop(streamSid, entry, 'usage_recording_unavailable');
          });
      }
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

        const finalizePromise = finalizeStream(message.streamSid, entry, { monitoringLimitReached: true, stopReason: 'per_call_limit' });

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

      entry.framesReceived += 1;

      if (usageMeter) {
        const elapsed = elapsedSeconds(entry.startedAt, nowValue);
        // Fail-safe: if this stream's usage hasn't been recorded for too
        // long (database down, RPC failing), stop paying for monitoring
        // rather than continue unaccounted.
        if (nowValue.getTime() - entry.lastProgressOkAt.getTime() > safetyConfig.maxProgressFailureSeconds * 1000) {
          return safetyStop(message.streamSid, entry, 'usage_recording_unavailable', { usage: entry.lastUsage });
        }
        if (entry.metering && !entry.progressInFlight && elapsed >= entry.lastReportedSeconds + safetyConfig.progressIntervalSeconds) {
          reportProgress(message.streamSid, entry, elapsed);
        }
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
