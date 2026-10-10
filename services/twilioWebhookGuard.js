// twilioWebhookGuard.js — fail-closed Twilio signature enforcement for every
// Twilio-facing HTTP webhook (/voice, /process, /red-line-terminate,
// /call-delivery-failed, /call-status). P0 remediation, 2026-10-01.
//
// A request without a valid X-Twilio-Signature is refused with 403 BEFORE
// any database read/write, alert, AI call, TwiML or call flow. Nothing from
// the request body is logged.
//
// Host handling: Twilio signs the exact URL it requested. HCG numbers have
// been configured with more than one host over time (www, apex, an old
// Railway domain), so the signature is checked against APP_URL's host and
// every host listed in TWILIO_WEBHOOK_ALLOWED_HOSTS (comma-separated). The
// Host header itself is never trusted: only allowlisted hosts are tried,
// and an attacker still needs the auth token to produce a valid HMAC.
//
// Throttling is applied ONLY to requests that have already failed
// verification (keyed by X-Forwarded-For or the socket address), so a flood
// of forged requests can never throttle genuine Twilio traffic, even when
// every request arrives through the same proxy address. It changes the
// response from 403 to 429 and suppresses log volume; it is not an
// authentication control.
//
// Emergency-only escape hatch: TWILIO_WEBHOOK_AUTH_MODE=report lets
// unsigned requests through (logged, alerted at boot). Default and
// production setting: enforce.
'use strict';

const { isGenuineTwilioRequest } = require('./twilioWebhookAuth');
const { resolveAdditionalTwilioAccounts, signingTokensFor } = require('./telephony/twilioAccounts');

function hostsFrom(appUrl, allowedHostsCsv) {
  const hosts = new Set();
  try { hosts.add(new URL(appUrl).host); } catch { /* invalid APP_URL → no canonical host */ }
  for (const h of String(allowedHostsCsv || '').split(',')) {
    const host = h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function createTwilioWebhookGuard({
  authToken,
  appUrl,
  allowedHosts = '',
  mode = 'enforce',
  failureLimitPerWindow = 20,
  windowMs = 60 * 1000,
  now = () => Date.now(),
  log = (line, fields) => console.error(line, fields),
  validate,
  // WS6 BYOC (2026-10-11): optional additional (sub)account tokens, used only
  // for a request whose signed AccountSid is that account
  // (services/telephony/twilioAccounts.js). Default: from env; none set ⇒ [].
  additionalAccounts = resolveAdditionalTwilioAccounts(process.env).accounts,
} = {}) {
  const hosts = hostsFrom(appUrl, allowedHosts);
  const failures = new Map(); // key -> { count, windowStart, logged }

  function verify(req) {
    if (!authToken) return false; // fail closed (production refuses to boot without it anyway)
    const signature = req.get('X-Twilio-Signature');
    if (!signature) return false;
    const params = req.body && typeof req.body === 'object' ? req.body : {};
    const tokens = signingTokensFor({ primaryToken: authToken, accountSid: params.AccountSid, additionalAccounts });
    return tokens.some((token) => hosts.some((host) => isGenuineTwilioRequest({
      authToken: token,
      signature,
      url: `https://${host}${req.originalUrl}`,
      params,
      ...(validate ? { validate } : {}),
    })));
  }

  function noteFailure(key) {
    const t = now();
    let f = failures.get(key);
    if (!f || t - f.windowStart > windowMs) { f = { count: 0, windowStart: t, logged: false }; failures.set(key, f); }
    f.count += 1;
    if (failures.size > 10000) { // bounded memory
      for (const [k, v] of failures) if (t - v.windowStart > windowMs) failures.delete(k);
    }
    return f;
  }

  return function requireTwilioSignature(req, res, next) {
    if (verify(req)) {
      req.twilioVerified = true;
      return next();
    }
    if (mode === 'report') {
      log('TWILIO WEBHOOK SIGNATURE INVALID (report mode — ALLOWED, emergency setting)', { path: req.path });
      req.twilioVerified = false;
      return next();
    }
    const key = String(req.get('X-Forwarded-For') || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const f = noteFailure(key);
    if (!f.logged) {
      f.logged = true;
      log('TWILIO WEBHOOK REFUSED: missing or invalid signature', { path: req.path });
    }
    if (f.count > failureLimitPerWindow) return res.status(429).end();
    return res.status(403).end();
  };
}

module.exports = { createTwilioWebhookGuard, hostsFrom };
