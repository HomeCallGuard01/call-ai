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

module.exports = {
  DEFAULT_MAX_MONITORING_DURATION_MINUTES,
  resolveMonitoringMaxDurationMs,
  hasReachedDurationThreshold,
  elapsedSeconds,
};
