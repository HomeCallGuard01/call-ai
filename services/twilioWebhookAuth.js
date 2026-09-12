// Twilio request-signature verification — added 2026-09-10 in response to
// an explicit review finding: this codebase's Twilio-facing webhooks
// (/voice, /process, /call-status, /call-delivery-failed) have NEVER had
// any signature validation, unlike Stripe's webhook (routes/billing.js,
// stripe.webhooks.constructEvent) which has always been signature-checked.
// Confirmed via full-repo search before writing this file — no prior
// Twilio signature check exists anywhere to build on or conflict with.
//
// This module exists specifically to close the contradiction in P0 Batch
// 1's original activation-auto-stamp design: that design justified
// treating a POST to /voice as authoritative evidence ("Twilio-
// authenticated") while /voice itself had no authentication at all. It is
// deliberately scoped to verification only — validating that a request
// genuinely came from Twilio using the account's own auth token — not a
// general auth/authorization system.
//
// Pure, injectable `validate` dependency (defaults to the real
// twilio.validateRequest) so this is fully unit-testable without a live
// HTTP request — matches this codebase's established convention
// (services/twilioProvisioning.js, services/activationVerification.js).
const twilio = require("twilio");

// Builds the exact absolute URL Twilio's own signature was computed
// against. Deliberately uses APP_URL (this project's single validated
// source of truth for its own external base URL — server.js refuses to
// boot in production without it, see services/serverConfig.js) rather
// than req.protocol/req.hostname/req.get("host"): this app runs behind
// Railway's proxy with no `trust proxy` configured anywhere (confirmed by
// search), so those request-derived values cannot be trusted to reflect
// the real external https:// URL Twilio actually POSTed to — using them
// would make real, genuine Twilio requests fail validation.
function buildWebhookUrl(appUrl, originalUrl) {
  return `${appUrl}${originalUrl}`;
}

// Returns true only when signature, url, and authToken are all present
// AND the signature genuinely validates against the given params. Any
// missing piece or validation failure returns false, never throws — a
// malformed/missing signature is exactly the case this function exists
// to catch, not a bug in the caller.
function isGenuineTwilioRequest({ authToken, signature, url, params, validate = twilio.validateRequest }) {
  if (!authToken || !signature || !url) return false;

  try {
    return !!validate(authToken, signature, url, params || {});
  } catch {
    return false;
  }
}

module.exports = { buildWebhookUrl, isGenuineTwilioRequest };
