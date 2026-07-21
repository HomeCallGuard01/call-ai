const twilio = require("twilio");

// createClient()-equivalent for Twilio's REST API — not the TwiML builder
// used elsewhere via `twilio.twiml.VoiceResponse`, which needs no
// credentials at all. Only constructed when both credentials are present,
// matching services/stripeClient.js's fail-open pattern rather than
// crashing the whole server at require-time.
const twilioRestClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (!twilioRestClient) {
  console.warn(
    "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN is not set — automatic Twilio number provisioning will not function until both are configured."
  );
}

module.exports = { twilioRestClient };
