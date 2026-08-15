const twilio = require("twilio");

// Builds a short-lived Twilio Access Token carrying a VoiceGrant, so the
// mobile app can register the Voice SDK client and receive an approved
// (SAFE-classified or known-contact) call directly, bypassing PSTN
// entirely — see docs/operations/HANDOVER_2026-08-15.md §12-13 for why:
// dialling the customer's own number back over PSTN loops into their own
// active carrier forwarding. This token is the mobile-delivery half of
// that fix; server.js's dial-routing (the other half) is not touched by
// this file.
//
// Deliberately pure/injectable (accountSid/apiKeySid/apiKeySecret/
// twimlAppSid passed in rather than read from process.env directly) so
// this can be unit-tested without real Twilio credentials or network
// access — matching this codebase's existing pattern (e.g.
// services/callRouting.js, services/phone.js).
//
// Identity is always `household_<householdId>` — never the customer's
// phone number or any other PII — so a leaked/logged identity string
// reveals nothing beyond "some household", and matches the existing
// data-minimisation principle already used for decisionReason/
// terminationReason (supabase/migrations 024/025).
function buildVoiceClientIdentity(householdId) {
  return `household_${householdId}`;
}

// 3600s matches Twilio's own documented default/typical Access Token
// TTL for Voice SDK usage — long enough that a normal app session
// doesn't need to re-fetch on every foreground, short enough that a
// leaked token has a bounded blast radius. The mobile client is
// responsible for re-fetching before expiry (or on a 401/expired-token
// registration failure), the same "caller retries with a fresh
// credential" pattern requireAuthApi.js already documents for Supabase
// access tokens.
const DEFAULT_TTL_SECONDS = 3600;

function buildVoiceAccessToken({
  accountSid,
  apiKeySid,
  apiKeySecret,
  twimlAppSid,
  householdId,
  ttlSeconds = DEFAULT_TTL_SECONDS,
}) {
  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    throw new Error(
      "buildVoiceAccessToken: accountSid, apiKeySid, apiKeySecret and twimlAppSid are all required"
    );
  }

  if (!householdId) {
    throw new Error("buildVoiceAccessToken: householdId is required");
  }

  const identity = buildVoiceClientIdentity(householdId);

  const token = new twilio.jwt.AccessToken(accountSid, apiKeySid, apiKeySecret, {
    identity,
    ttl: ttlSeconds,
  });

  // outgoingApplicationSid is set even though V1 is receive-only (the app
  // never places outbound calls) — Twilio's own Access Token
  // documentation lists it as required for Voice SDK usage generally,
  // and leaving it unset is an unverified/undocumented edge case not
  // worth risking on a launch-critical path. The TwiML App it points to
  // (see docs/operations/HANDOVER_2026-08-15.md §14/provisioning notes)
  // just returns a "not supported" TwiML response, since it should never
  // actually be invoked.
  const voiceGrant = new twilio.jwt.AccessToken.VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);

  return { token: token.toJwt(), identity, ttlSeconds };
}

module.exports = { buildVoiceClientIdentity, buildVoiceAccessToken, DEFAULT_TTL_SECONDS };
