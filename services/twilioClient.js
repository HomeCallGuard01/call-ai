const twilio = require("twilio");
const { twilioRestCredentialMode } = require("./config/twilioCredentials");

// createClient()-equivalent for Twilio's REST API — not the TwiML builder
// used elsewhere via `twilio.twiml.VoiceResponse`, which needs no
// credentials at all. Only constructed when credentials are present,
// matching services/stripeClient.js's fail-open pattern rather than
// crashing the whole server at require-time.
//
// Credential isolation (2026-10-10, containment design C-6): when
// TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET are set, REST calls use that
// scoped API key on TWILIO_ACCOUNT_SID (the HCG runtime SUBACCOUNT), so the
// backend never needs the master account's auth token. TWILIO_AUTH_TOKEN is
// then the subaccount's own token, still needed to validate webhook
// signatures for numbers the subaccount owns. Without an API key the
// previous account-SID + auth-token client is used, unchanged.
function createTwilioRestClient(env = process.env) {
  // One source of truth for which credential is used (the same function
  // launchConfig reports on), so the report can never disagree with the client.
  const mode = twilioRestCredentialMode(env);
  const accountSid = mode === "none" ? null : env.TWILIO_ACCOUNT_SID.trim();
  if (mode === "api_key") return twilio(env.TWILIO_API_KEY_SID.trim(), env.TWILIO_API_KEY_SECRET.trim(), { accountSid });
  if (mode === "auth_token") return twilio(accountSid, env.TWILIO_AUTH_TOKEN.trim());
  return null;
}

// twilioRestCredentialMode lives in services/config/twilioCredentials.js
// (pure; also used by services/config/launchConfig.js, which warns or
// refuses to start when production uses the auth-token REST client or the
// parent account's SID — Agent 1, 2026-10-11).

const twilioRestClient = createTwilioRestClient();

if (!twilioRestClient) {
  console.warn(
    "TWILIO_ACCOUNT_SID with TWILIO_API_KEY_SID/SECRET (or TWILIO_AUTH_TOKEN) is not set — automatic Twilio number provisioning will not function until configured."
  );
}

module.exports = { twilioRestClient, createTwilioRestClient, twilioRestCredentialMode };
