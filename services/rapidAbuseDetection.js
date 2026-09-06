// rapidAbuseDetection.js — pure logic behind the rapid-abuse
// instrumentation added as part of the call-monitoring cost-protection
// safeguard. Log-and-alert only in this phase — nothing here blocks,
// delays, or otherwise affects call delivery; server.js calls these as
// fire-and-forget checks after a call has already been classified and
// logged, exactly like the existing logCall pattern.
//
// Thresholds: 20 Unknown-caller calls in a single day is well above any
// legitimate household's normal volume and catches a fast, sustained
// abuse burst long before it could ever reach the existing monthly
// count-based fair-use system's own 40/80 thresholds
// (services/businessMetrics/fairUse.js) — a burst concentrated into one
// day would otherwise go unnoticed until the end of the month. The same
// caller number calling 3+ times within a 10-minute window is
// characteristic of an automated/abusive dialer, not normal human
// caller behaviour, and catches a pattern the daily aggregate wouldn't
// specifically flag as fast. Both are alert-only, so a false positive
// costs nothing beyond an ops notification for review — no customer or
// caller is ever blocked, delayed, or deprovisioned by either check.
// Both are configurable via env vars for the same reason
// monitoringLimit.js's threshold is: real usage data may justify
// revisiting them without a code change.
'use strict';

const { normaliseNumber } = require('./phone');

const DEFAULT_DAILY_UNKNOWN_CALL_ALERT_THRESHOLD = 20;
const DEFAULT_REPEAT_CALLER_WINDOW_MINUTES = 10;
const DEFAULT_REPEAT_CALLER_COUNT_THRESHOLD = 3;

function resolvePositiveIntEnv(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return fallback;
}

function resolveDailyUnknownCallAlertThreshold(env = process.env) {
  return resolvePositiveIntEnv(env.RAPID_ABUSE_DAILY_UNKNOWN_CALL_THRESHOLD, DEFAULT_DAILY_UNKNOWN_CALL_ALERT_THRESHOLD);
}

function resolveRepeatCallerWindowMs(env = process.env) {
  return (
    resolvePositiveIntEnv(env.RAPID_ABUSE_REPEAT_CALLER_WINDOW_MINUTES, DEFAULT_REPEAT_CALLER_WINDOW_MINUTES) * 60 * 1000
  );
}

function resolveRepeatCallerCountThreshold(env = process.env) {
  return resolvePositiveIntEnv(env.RAPID_ABUSE_REPEAT_CALLER_COUNT_THRESHOLD, DEFAULT_REPEAT_CALLER_COUNT_THRESHOLD);
}

// Pure — counts today's Unknown-status calls from an already-fetched
// list (server.js's own getCallsToday), so this never needs its own
// database query.
function countUnknownCallsToday(callsToday) {
  return (callsToday || []).filter(c => c.status === 'Unknown').length;
}

// Pure — how many of `recentCalls` are from the same caller number as
// `callerNumber`, within `windowMs` of `now`. Compares via
// normaliseNumber (never raw string equality), matching this codebase's
// established convention (services/phone.js's wouldCreateForwardingLoop).
function countRecentCallsFromSameCaller(recentCalls, callerNumber, now, windowMs) {
  const targetNorm = normaliseNumber(callerNumber);
  if (!targetNorm) return 0;

  return (recentCalls || []).filter(c => {
    if (!c.number || normaliseNumber(c.number) !== targetNorm) return false;
    const createdAtMs = new Date(c.created_at).getTime();
    if (Number.isNaN(createdAtMs)) return false;
    return now.getTime() - createdAtMs <= windowMs;
  }).length;
}

module.exports = {
  DEFAULT_DAILY_UNKNOWN_CALL_ALERT_THRESHOLD,
  DEFAULT_REPEAT_CALLER_WINDOW_MINUTES,
  DEFAULT_REPEAT_CALLER_COUNT_THRESHOLD,
  resolveDailyUnknownCallAlertThreshold,
  resolveRepeatCallerWindowMs,
  resolveRepeatCallerCountThreshold,
  countUnknownCallsToday,
  countRecentCallsFromSameCaller,
};
