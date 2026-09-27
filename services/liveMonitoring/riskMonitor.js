// riskMonitor.js — per-call state: accumulates transcribed text as it
// arrives and runs it through two independent layers on every chunk:
//
//   Layer 1 (critical/red-line, 2026-08-15): a sufficiently dangerous
//   behaviour (scoring/criticalSignals.js) triggers immediate SMS +
//   call termination, regardless of the accumulated 0-100 score. This
//   exists because a single unambiguous scam behaviour ("don't speak to
//   your bank or your family") shouldn't have to wait for a numerical
//   threshold — see docs on the real staging call that motivated this.
//
//   Layer 2 (progressive, unchanged): the accumulated transcript is
//   scored against scorer.js, triggering exactly one SMS warning the
//   first time risk crosses LIVE_MONITORING_WARN_MIN. This is what
//   catches the slow-burn case where no single sentence crosses a red
//   line but the overall behaviour becomes increasingly suspicious.
//
// Critical detection is checked first on every chunk; if it fires, it
// also marks the progressive warningSent flag so the two layers never
// send two different SMS messages for the same call.
//
// Deliberately rules-only (no model blend): scoreTranscript() is always
// called with a null model output, so no live model-client call is added
// to the monitoring loop. This can be revisited later behind the same
// flag pattern already in thresholds.js, if evidence shows it's needed.
//
// Also tracks the PEAK risk score and which signal IDs contributed to it
// across the whole call — never the transcript itself — so the caller can
// persist a short, privacy-conscious summary once the call ends (see
// database/calls.js's recordMonitoringOutcome and mediaStreamHandler.js's
// "stop" handling).

'use strict';

const { scoreTranscript } = require('./scoring/scorer');
const { THRESHOLDS } = require('./scoring/thresholds');
const { extractCriticalSignals } = require('./scoring/criticalSignals');
const { sendWarningSms, RED_LINE_WARNING_BODY, POST_CALL_RED_LINE_WARNING_BODY } = require('./smsWarning');
const { terminateCall } = require('./callTermination');
const { describeTranscriptChunk, redactPhoneNumbers } = require('./logRedaction');
const { logEvent } = require('./structuredLog');

/**
 * @param {object} opts
 * @param {string} opts.callSid
 * @param {string} opts.householdId
 * @param {object} opts.smsClient - real or fake Twilio client (messages.create)
 * @param {string|null} opts.toNumber - household's own phone to warn, or null if none is on file
 * @param {string} opts.fromNumber - the household's protected Twilio number
 * @param {object} [opts.thresholds] - override for tests
 * @param {object|null} [opts.twilioRestClient] - real or fake Twilio REST
 *   client (calls(sid).update). If not provided, termination is skipped
 *   and logged — matching the existing "no valid destination number"
 *   skip-and-log pattern — never thrown.
 * @param {string|null} [opts.redLineRedirectUrl] - TwiML endpoint for the
 *   graceful red-line announcement+hangup. Required alongside
 *   twilioRestClient for termination to actually be attempted.
 */
function createCallMonitor({
  callSid,
  householdId,
  smsClient,
  toNumber,
  fromNumber,
  thresholds = THRESHOLDS,
  twilioRestClient = null,
  redLineRedirectUrl = null,
}) {
  // Transcribed chunks, kept in audio order. 2026-09-26: segments no
  // longer overlap (speechSegmenter.js), so a phrase spanning a cut now
  // only exists across two adjacent chunks — their order matters, and
  // Whisper responses can resolve out of order. A chunk handed in with a
  // `sequence` (mediaStreamHandler.js always does) is placed at that
  // position; one without is appended, preserving the original behaviour
  // for every existing caller.
  const orderedChunks = [];
  let nextAppendSequence = 0;
  let accumulatedTranscript = '';
  // Same chunks joined with the punctuation Whisper tends to add at the
  // very end of a chunk stripped first ("don't speak to your." + "Bank
  // or your family." -> "don't speak to your Bank or your family."). A
  // pause-aligned cut can fall mid-sentence; the old overlapping window
  // would have heard that phrase as continuous audio, with no full stop
  // at the cut. Both views are checked below — never only this one — so
  // this can only add a detection the raw transcript missed at a chunk
  // boundary, never remove one.
  let boundaryJoinedTranscript = '';
  let warningSent = false;
  let chunkCount = 0;
  let peakRiskScore = 0;
  let peakRiskIndicatorIds = [];
  let criticalTriggered = false;
  let criticalSignalIds = [];
  let terminatedBySystem = false;
  let terminationMethod = null;
  // Set by markCallEnded() when Twilio reports the call is over
  // (2026-09-26 hang-up flush). From then on, any chunk still being
  // processed — the flushed hang-up tail, or a chunk whose transcription
  // was already in flight — can still warn the customer, but a red line
  // uses POST_CALL_RED_LINE_WARNING_BODY and NEVER attempts termination:
  // there is no call left to end, and RED_LINE_WARNING_BODY's "was ended
  // automatically" would be untrue (the caller hung up first). Before
  // this, a red line in an in-flight chunk made three doomed Twilio
  // update attempts against the finished call.
  let callEnded = false;
  let detectedAfterCallEnded = false;

  async function sendCustomerWarning(body) {
    if (typeof toNumber !== 'string' || toNumber.trim().length === 0) {
      // No valid household destination number — log and move on. Never
      // throws, never touches the call; the missing-number case is not
      // treated any differently from a delivery failure.
      logEvent('sms_warning_not_delivered', { callSid, householdId, error: 'no valid household destination number' });
      return;
    }
    const result = await sendWarningSms({ client: smsClient, to: toNumber, from: fromNumber, callSid, body });
    if (!result.sent) {
      // Sending failed — do not retry and do not un-set warningSent. A
      // notification failure must never cause repeated attempts that
      // could spam the household once the underlying issue clears, and
      // must never affect the live call either way.
      logEvent('sms_warning_not_delivered', { callSid, householdId, error: redactPhoneNumbers(result.error) });
    }
  }

  function rebuildTranscripts() {
    const texts = orderedChunks.filter(t => typeof t === 'string' && t.length > 0);
    accumulatedTranscript = texts.join(' ');
    boundaryJoinedTranscript = texts.reduce(
      (joined, text) => (joined ? `${joined.replace(/[\s.,!?;:…]+$/u, '')} ${text}` : text),
      ''
    );
  }

  /**
   * @param {string|null} chunkText - null if this window failed to transcribe
   * @param {object} [opts]
   * @param {number} [opts.sequence] - the chunk's 0-based position in the
   *   call's audio; omitted -> appended after every chunk seen so far.
   * @returns {Promise<{riskScore: number, confidence: number, warningSentThisCall: boolean, criticalTriggeredThisCall: boolean, criticalSignalIds: string[]}>}
   */
  async function handleTranscribedChunk(chunkText, { sequence } = {}) {
    chunkCount += 1;

    const position = Number.isInteger(sequence) && sequence >= 0 ? sequence : nextAppendSequence;
    nextAppendSequence = Math.max(nextAppendSequence, position + 1);
    if (chunkText) {
      orderedChunks[position] = chunkText;
      rebuildTranscripts();
    }

    // --- Layer 1: critical/red-line detection, checked first ---
    if (!criticalTriggered) {
      let critical = extractCriticalSignals(accumulatedTranscript);
      if (!critical.hasCriticalSignal && boundaryJoinedTranscript !== accumulatedTranscript) {
        critical = extractCriticalSignals(boundaryJoinedTranscript);
      }
      if (critical.hasCriticalSignal) {
        criticalTriggered = true; // set before awaiting: guarantees at
        // most one termination sequence and one red-line SMS is ever
        // triggered for this call, even if two chunks resolve nearly
        // simultaneously.
        criticalSignalIds = critical.criticalSignals.map(s => s.id);
        warningSent = true; // the red-line SMS below replaces, not adds
        // to, the softer progressive SMS — a call never gets two
        // different warning messages.

        logEvent('critical_signal_detected', { callSid, householdId, criticalSignalIds, chunkIndex: chunkCount, afterCallEnded: callEnded });

        if (callEnded) {
          detectedAfterCallEnded = true;
          logEvent('red_line_termination_skipped', { callSid, householdId, error: 'call already ended' });
          await sendCustomerWarning(POST_CALL_RED_LINE_WARNING_BODY);
        } else {
          const smsPromise = sendCustomerWarning(RED_LINE_WARNING_BODY);

          let terminationPromise = Promise.resolve({ terminated: false, method: null });
          if (twilioRestClient && redLineRedirectUrl) {
            terminationPromise = terminateCall({
              client: twilioRestClient,
              callSid,
              redirectUrl: redLineRedirectUrl,
              reason: criticalSignalIds.join(', '),
            });
          } else {
            logEvent('red_line_termination_skipped', { callSid, householdId, error: 'no twilioRestClient/redLineRedirectUrl configured' });
          }

          const [, terminationResult] = await Promise.all([smsPromise, terminationPromise]);
          terminatedBySystem = terminationResult.terminated;
          terminationMethod = terminationResult.method;
        }
      }
    }

    // --- Layer 2: progressive 0-100 scoring, unchanged ---
    let scored = scoreTranscript(accumulatedTranscript, null);
    if (boundaryJoinedTranscript !== accumulatedTranscript) {
      const joinedScored = scoreTranscript(boundaryJoinedTranscript, null);
      if (joinedScored.riskScore > scored.riskScore) scored = joinedScored;
    }

    if (scored.riskScore > peakRiskScore) {
      peakRiskScore = scored.riskScore;
      peakRiskIndicatorIds = scored.riskIndicators.map(r => r.id);
    }

    // Never log the transcript text itself (privacy fix 2026-09-27; see
    // logRedaction.js): only non-content diagnostics.
    logEvent('transcript_chunk', {
      callSid,
      householdId,
      chunkIndex: chunkCount,
      ...describeTranscriptChunk(chunkText),
      riskScore: scored.riskScore,
      confidence: scored.confidence,
    });

    if (!warningSent && scored.riskScore >= thresholds.LIVE_MONITORING_WARN_MIN) {
      warningSent = true; // set before awaiting: guarantees at most one SMS
      // is ever triggered for this call even if two chunks resolve nearly
      // simultaneously.
      if (callEnded) detectedAfterCallEnded = true;
      // Progressive (possible-scam) warning keeps its existing wording
      // even after the call ended — it says "possible scam", not "clear
      // signs of fraud", so it never overclaims; only the red line gets
      // the post-call wording above.
      logEvent('risk_threshold_crossed', { callSid, householdId, riskScore: scored.riskScore, afterCallEnded: callEnded });
      await sendCustomerWarning();
    }

    return {
      riskScore: scored.riskScore,
      confidence: scored.confidence,
      warningSentThisCall: warningSent,
      criticalTriggeredThisCall: criticalTriggered,
      criticalSignalIds: criticalSignalIds.slice(),
    };
  }

  // Called once, when the stream stops — never mid-call. Returns exactly
  // the fields database/calls.js's recordMonitoringOutcome needs, and
  // nothing else: no transcript, no per-chunk history, no audio.
  function getSummary() {
    return {
      peakRiskScore,
      peakRiskIndicatorIds,
      warningSent,
      criticalSignalIds,
      terminatedBySystem,
      terminationMethod,
      detectedAfterCallEnded,
    };
  }

  // Called by mediaStreamHandler.js the moment Twilio reports the call
  // is over ("stop"), BEFORE the hang-up tail is flushed and before any
  // in-flight chunk resolves — see callEnded above. Idempotent.
  function markCallEnded() {
    callEnded = true;
  }

  // Exposed (cost-protection safeguard) so mediaStreamHandler.js can send
  // an unrelated, one-off customer notification (the monitoring-limit
  // reached message) through the exact same safe path every in-call SMS
  // already goes through — same to/from resolution, same "no valid
  // destination" skip, same catch-and-log-never-throw behaviour. Never
  // sets/reads the warningSent flag itself: that flag is specifically
  // about the progressive risk-warning SMS, not this one.
  return { handleTranscribedChunk, hasSentWarning: () => warningSent, getSummary, sendCustomerWarning, markCallEnded };
}

module.exports = { createCallMonitor };
