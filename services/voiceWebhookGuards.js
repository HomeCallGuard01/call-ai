'use strict';

// Voice webhook guards (2026-09-30, release readiness P5 — mobile call
// delivery security).
//
// The Voice access token issued to the app carries a VoiceGrant with an
// outgoingApplicationSid (services/voiceAccessToken.js — kept because
// removing it is unverified on a device). Anyone holding a valid token (any
// entitled household, or anyone who obtains one) can therefore place an
// OUTGOING Voice SDK call; Twilio then requests the TwiML App's Voice URL.
// The route that TwiML App was configured with in August
// (/voice-sdk-outbound-not-supported) never reached main, and the App's
// current Voice URL is not recorded anywhere in the repository.
//
// If that URL is (or is ever changed to) /voice, a client could supply any
// `To` and make HCG treat it as an inbound call to that household: paid live
// monitoring, a ring on the victim's app, a fake Activity row. Genuine
// inbound PSTN calls never carry a `client:` identity, so /voice rejects
// them outright, before any lookup, write or paid step. <Reject> is not
// billed by Twilio.

const CLIENT_PREFIX = /^client:/i;

function isVoiceSdkClientOriginated(body) {
  if (!body || typeof body !== 'object') return false;
  return [body.From, body.Caller].some(v => typeof v === 'string' && CLIENT_PREFIX.test(v.trim()));
}

module.exports = { isVoiceSdkClientOriginated };
