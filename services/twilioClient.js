const twilio = require("twilio");

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
  const accountSid = env.TWILIO_ACCOUNT_SID;
  if (!accountSid) return null;
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return twilio(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, { accountSid });
  }
  if (env.TWILIO_AUTH_TOKEN) return twilio(accountSid, env.TWILIO_AUTH_TOKEN);
  return null;
}

function twilioRestCredentialMode(env = process.env) {
  if (!env.TWILIO_ACCOUNT_SID) return "none";
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) return "api_key";
  if (env.TWILIO_AUTH_TOKEN) return "auth_token";
  return "none";
}

const twilioRestClient = createTwilioRestClient();

if (!twilioRestClient) {
  console.warn(
    "TWILIO_ACCOUNT_SID with TWILIO_API_KEY_SID/SECRET (or TWILIO_AUTH_TOKEN) is not set — automatic Twilio number provisioning will not function until configured."
  );
}

module.exports = { twilioRestClient, createTwilioRestClient, twilioRestCredentialMode };
