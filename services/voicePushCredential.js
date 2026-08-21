// Resolves which Twilio Push Credential SID to use for a Voice SDK
// registration, based on the requesting client's platform (2026-08-2X,
// iOS pre-flight). Android (FCM) and iOS (APN/VoIP) are two entirely
// different Twilio Push Credential resources tied to different push
// services — silently reusing one for the other platform doesn't error
// loudly, it produces a token that "registers" successfully but can
// never actually receive a push, the same class of silent failure as
// the 52004 incident (docs/operations/HANDOVER_2026-08-15.md §20.5).
//
// Pure and directly testable — no Express/Twilio involved — so this
// exact mapping, and the fail-closed behaviour for an unsupported or
// missing platform, can be proven without simulating a real request.
// Mirrors services/callRouting.js's resolveForwardingDestination shape
// ({ ok, sid } instead of { canForward, number }) — same
// never-guess-fail-closed convention, applied to a different decision.
//
// A platform's specific env var being unset is a *different*, already-
// established situation (services/voiceAccessToken.js's own comment:
// registration still succeeds, incoming calls just can't be pushed) —
// only an unrecognised/missing platform value fails closed here.
function resolvePushCredentialSid(platform, env) {
  if (platform === "android") {
    return { ok: true, sid: env.TWILIO_VOICE_PUSH_CREDENTIAL_SID };
  }
  if (platform === "ios") {
    return { ok: true, sid: env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS };
  }
  return { ok: false, sid: null };
}

module.exports = { resolvePushCredentialSid };
