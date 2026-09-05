// Minimal, fail-open critical-alert emailer. Not an observability
// platform — one function, one destination, one dedup rule. Every
// call site that uses this already has its own error handling for the
// actual failure (webhook retry, provisioning failure record, etc.);
// this only adds "and also tell Andrew", best-effort, never load-bearing.
'use strict';

const https = require("https");

const ALERT_TO = "support@homecallguard.co.uk";
const ALERT_FROM = "Home Call Guard Alerts <alerts@mail.homecallguard.co.uk>";

// One entry per failure `type`, so a whole outage (many failures, same
// type, in quick succession) sends exactly one email per window, not
// one per occurrence. Deliberately in-memory/per-process — resets on
// every deploy/restart, which just means "at most one extra email right
// after a deploy", an acceptable tradeoff for staying this simple.
const RATE_LIMIT_MS = 30 * 60 * 1000; // 30 minutes
const lastSentAt = new Map();

function shouldSend(type) {
  const last = lastSentAt.get(type);
  const now = Date.now();
  if (last && now - last < RATE_LIMIT_MS) return false;
  lastSentAt.set(type, now);
  return true;
}

// Real HTTPS call, no SDK dependency — Resend's API is a single POST.
// Always resolves, never rejects: a broken alert must never surface as
// an error to whatever real request/webhook/call triggered it.
function postToResend(payload) {
  return new Promise((resolve) => {
    try {
      const apiKey = process.env.Resend_API_Key;
      if (!apiKey) {
        console.error("ALERTING: Resend_API_Key not configured, alert not sent:", payload.subject);
        return resolve(false);
      }

      const body = JSON.stringify({
        from: ALERT_FROM,
        to: [ALERT_TO],
        subject: payload.subject,
        text: payload.text,
      });

      const req = https.request(
        {
          hostname: "api.resend.com",
          path: "/emails",
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 5000,
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        }
      );

      req.on("error", (err) => {
        console.error("ALERTING: failed to send alert email:", err.message);
        resolve(false);
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });

      req.write(body);
      req.end();
    } catch (err) {
      console.error("ALERTING: unexpected error building alert:", err.message);
      resolve(false);
    }
  });
}

// type: short machine-readable key (also the dedup key) — e.g.
// "stripe_webhook_failure", "twilio_provisioning_failure".
// message: one-line human summary, safe to read in an email subject.
// context: plain object of already-redacted diagnostic fields (IDs,
// error messages, HTTP statuses) — callers must never pass raw
// passwords/API keys/full transcripts/unnecessary phone numbers here.
// deps.post is injectable (defaults to the real Resend call) so this is
// unit-testable without a real network call or Resend credentials —
// same pattern as services/voiceAccessToken.js and services/phone.js.
async function sendCriticalAlert(type, message, context = {}, deps = {}) {
  const post = deps.post || postToResend;

  try {
    if (!shouldSend(type)) {
      console.error(`ALERTING: suppressed (rate-limited) — ${type}: ${message}`);
      return false;
    }

    const timestamp = new Date().toISOString();
    const env = process.env.NODE_ENV || "development";
    // Presentation only (2026-09) — this used to hardcode "production
    // alert" regardless of the real environment, directly contradicting
    // the Environment: line a few rows below whenever NODE_ENV wasn't
    // actually "production" (e.g. every local/dev run). Routing,
    // recipients, and the rate-limit/dedup behavior above are unchanged.
    const lines = [
      `Home Call Guard — ${env === "production" ? "production" : "development"} alert`,
      ``,
      `Type: ${type}`,
      `Time: ${timestamp}`,
      `Environment: ${env}`,
      `Message: ${message}`,
      ``,
      `Context:`,
      JSON.stringify(context, null, 2),
      ``,
      `(Repeats of the same alert type are suppressed for ${RATE_LIMIT_MS / 60000} minutes.)`,
    ];

    return await post({
      subject: `[HCG ALERT] ${type}`,
      text: lines.join("\n"),
    });
  } catch (err) {
    // Absolute last resort — this function must never throw.
    console.error("ALERTING: sendCriticalAlert itself failed:", err.message);
    return false;
  }
}

// Test-only: clears rate-limit state between test cases. Never called
// from production code paths.
function _resetForTests() {
  lastSentAt.clear();
}

module.exports = { sendCriticalAlert, _resetForTests, RATE_LIMIT_MS };
