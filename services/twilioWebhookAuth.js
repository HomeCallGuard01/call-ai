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

// Media Streams WebSocket signature check — SHADOW MODE ONLY (2026-09-27,
// P0 launch hardening). This is intentionally observational, never
// enforcing: it never rejects, closes, or delays a WebSocket connection.
//
// Why not enforce yet: Twilio's own Media Streams docs confirm
// X-Twilio-Signature is "how your application verifies that a Media
// Stream is coming from an authentic Twilio source" — this IS the
// documented, first-party mechanism, not a guess. But Twilio's own
// troubleshooting guidance also warns that verifying a WebSocket
// handshake specifically may require appending a trailing "/" to the URL
// used in the signature computation — a documented quirk with no
// further specifics on when it applies. This app's <Stream> TwiML gives
// Twilio a wss:// URL (buildMediaStreamUrl in server.js), and it is not
// verified from documentation alone whether Twilio signs against that
// exact wss:// string or an https://-normalised equivalent. Getting this
// wrong in ENFORCING mode would silently reject every genuine Twilio
// Media Stream connection in production — a full live-monitoring outage,
// far worse than the crash bug this same launch-hardening pass fixed —
// with no staging environment able to originate a real Twilio Media
// Stream connection to test against first.
//
// So: this checks every plausible URL variant, logs exactly which one
// (if any) matched, and does nothing else. Once production evidence
// shows one variant reliably matches genuine connections, enforcement
// (rejecting connections that don't match) becomes a safe, evidence-based
// follow-up decision — not something this change makes unilaterally.
// Matches this codebase's existing risk posture at the /voice signature
// check just above (gates a side-effect, never call delivery itself) and
// this launch-hardening pass's own duration-recording fix (observe and
// alert first; do not guess-fix a root cause without evidence).
function describeMediaStreamSignatureCheck({ authToken, signature, appUrl, path, validate = twilio.validateRequest }) {
  if (!authToken || !signature || !appUrl || !path) {
    return { hasSignatureHeader: !!signature, matchedVariant: null };
  }

  // Every URL Twilio might plausibly have computed its signature against:
  // the wss:// form actually given to <Stream url>, and the https://
  // form (in case Twilio normalises scheme before signing) — each with
  // and without the documented trailing-slash variant.
  const wssBase = `${appUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}${path}`;
  const httpsBase = `${appUrl}${path}`;
  const variants = {
    wss: wssBase,
    "wss-trailing-slash": `${wssBase}/`,
    https: httpsBase,
    "https-trailing-slash": `${httpsBase}/`,
  };

  for (const [name, url] of Object.entries(variants)) {
    try {
      if (validate(authToken, signature, url, {})) {
        return { hasSignatureHeader: true, matchedVariant: name };
      }
    } catch {
      // A malformed signature/URL for one variant is not an error for
      // the others — keep trying, exactly like isGenuineTwilioRequest's
      // own catch-and-continue-to-false discipline above.
    }
  }

  return { hasSignatureHeader: true, matchedVariant: null };
}

module.exports = { buildWebhookUrl, isGenuineTwilioRequest, describeMediaStreamSignatureCheck };
