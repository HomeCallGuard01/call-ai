'use strict';

// What the caller hears when an approved call could not be delivered to
// the household's app (the /call-delivery-failed Dial action callback).
//
// PRODUCTION BEHAVIOUR IS UNCHANGED. Mode "off" reproduces the existing
// response exactly: a short apology, then hang up. The only other mode,
// "voicemail_prototype", is a LOCAL/STAGING PROTOTYPE of option E in
// docs/launch/CALL_DELIVERY_RESILIENCE.md (take a message instead of
// silently dropping the caller). It is hard-disabled whenever
// NODE_ENV=production, regardless of CALL_DELIVERY_FALLBACK_MODE,
// because shipping it needs decisions that have not been made: consent
// wording for recording, where recordings are stored and for how long,
// and how the customer is told a message is waiting.
//
// Never a PSTN fallback: dialling the household's own mobile would hit
// the unconditional divert straight back into HCG (a loop), which is the
// invariant services/callRouting.js exists to enforce.

const MODES = Object.freeze({ OFF: "off", VOICEMAIL_PROTOTYPE: "voicemail_prototype" });

const SAY_OPTIONS = { voice: "Polly.Amy", language: "en-GB" };
const CANNOT_CONNECT = "We're sorry, this call cannot be connected right now. Please try again later.";
const VOICEMAIL_PROMPT =
  "We're sorry, we couldn't connect your call just now. Please leave a short message after the tone, then hang up.";

// Recording limits for the prototype: 60 s is long enough for "it's me,
// please call back" and short enough to bound cost and misuse; 5 s of
// silence ends the recording so an abandoned line is not billed to 60 s.
const VOICEMAIL_MAX_SECONDS = 60;
const VOICEMAIL_SILENCE_TIMEOUT_SECONDS = 5;
const VOICEMAIL_COMPLETE_PATH = "/call-delivery-voicemail-complete";

function resolveFallbackMode(env = process.env) {
  if (env.NODE_ENV === "production") return MODES.OFF;
  return env.CALL_DELIVERY_FALLBACK_MODE === MODES.VOICEMAIL_PROTOTYPE ? MODES.VOICEMAIL_PROTOTYPE : MODES.OFF;
}

// Appends the caller-facing response to `twiml` for a finished Dial.
// A completed (connected) call just hangs up, exactly as today. Mode
// "off" is byte-identical to the pre-2026-09-29 route body (tested).
function buildDeliveryFailedResponse(twiml, { dialCallStatus, mode = MODES.OFF }) {
  if (dialCallStatus === "completed") {
    twiml.hangup();
    return twiml;
  }
  if (mode === MODES.VOICEMAIL_PROTOTYPE && dialCallStatus !== "canceled") {
    // 'canceled' = the caller already hung up; there is no one to record.
    twiml.say(SAY_OPTIONS, VOICEMAIL_PROMPT);
    twiml.record({
      maxLength: VOICEMAIL_MAX_SECONDS,
      timeout: VOICEMAIL_SILENCE_TIMEOUT_SECONDS,
      playBeep: true,
      trim: "trim-silence",
      action: VOICEMAIL_COMPLETE_PATH,
    });
    twiml.hangup();
    return twiml;
  }
  twiml.say(SAY_OPTIONS, CANNOT_CONNECT);
  twiml.hangup();
  return twiml;
}

module.exports = {
  MODES,
  CANNOT_CONNECT,
  VOICEMAIL_PROMPT,
  VOICEMAIL_MAX_SECONDS,
  VOICEMAIL_COMPLETE_PATH,
  resolveFallbackMode,
  buildDeliveryFailedResponse,
};
