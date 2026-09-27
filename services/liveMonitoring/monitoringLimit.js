// monitoringLimit.js — the per-call AI/live-monitoring safety limit
// (call-monitoring cost-protection safeguard). Deliberately separate
// from any call-routing/delivery decision: this only ever governs
// whether the transcription/scoring pipeline keeps running for a given
// stream — the underlying <Dial>'d call is never touched by anything in
// this file.
//
// Configurable via MONITORING_MAX_DURATION_MINUTES (default 30) rather
// than hardcoded — a value the team expects to revisit once real usage
// data exists.

'use strict';

const DEFAULT_MAX_MONITORING_DURATION_MINUTES = 30;

function resolvePositiveMinutesEnv(value, fallbackMinutes) {
  const minutes = Number(value);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  return fallbackMinutes;
}

function resolveMonitoringMaxDurationMs(env = process.env) {
  return resolvePositiveMinutesEnv(env.MONITORING_MAX_DURATION_MINUTES, DEFAULT_MAX_MONITORING_DURATION_MINUTES) * 60 * 1000;
}

// Pure, directly unit-testable with an injected `now` — same shape as
// services/callRouting.js's isVoiceClientReachable. A missing/malformed
// startedAt is always "not yet reached" (fail toward continuing to
// monitor, never toward silently stopping protection on bad input).
function hasReachedDurationThreshold(startedAt, now, thresholdMs) {
  if (!startedAt) return false;
  const startedAtMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedAtMs)) return false;
  return now.getTime() - startedAtMs >= thresholdMs;
}

function elapsedSeconds(startedAt, now) {
  if (!startedAt) return 0;
  const startedAtMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedAtMs)) return 0;
  return Math.max(0, Math.round((now.getTime() - startedAtMs) / 1000));
}

// Concurrent-stream cap (2026-09-27, launch-hardening) — a second, distinct
// safety limit from the per-call duration one above. /media-stream is an
// unauthenticated WebSocket endpoint (see mediaStreamServer.js/
// mediaStreamHandler.js's own comments on the shadow-mode signature check
// for why it can't safely be authentication-gated yet). Without this, a
// flood of forged "start" events — each one well-formed enough to pass the
// crash-hardening shape guards — would grow the handler's in-memory
// `streams` Map without bound, and every forged "media" event on top of
// that triggers a REAL OpenAI Whisper API call (transcribeChunk), a real
// per-frame cost. This is a cost-and-resource-exhaustion guard, not an
// authenticity check: it never distinguishes genuine Twilio traffic from
// forged traffic (nothing here can, yet), it only bounds the *total*
// concurrent damage either one can do. Default (200) is deliberately far
// above any realistic real concurrent-call volume for this business
// (production's busiest single household has never exceeded ~30 calls
// total, let alone concurrent) — safe for genuine traffic under any
// plausible real load, while still capping a flood at a fixed ceiling
// instead of unbounded growth.
const DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS = 200;

function resolvePositiveIntEnv(value, fallback) {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  return fallback;
}

function resolveMaxConcurrentStreams(env = process.env) {
  return resolvePositiveIntEnv(env.MEDIA_STREAM_MAX_CONCURRENT_STREAMS, DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS);
}

module.exports = {
  DEFAULT_MAX_MONITORING_DURATION_MINUTES,
  resolveMonitoringMaxDurationMs,
  hasReachedDurationThreshold,
  elapsedSeconds,
  DEFAULT_MAX_CONCURRENT_MEDIA_STREAMS,
  resolveMaxConcurrentStreams,
};
