// plans.js — monitored-minute plan configuration (Layer A; 2026-09-30).
//
// The ONE place a plan's customer allowance is defined. Nothing else may
// assume a number of minutes: every check, display and notification reads
// the household's plan from here, via entitlements.plan_code (migration 056).
//
// COMMERCIAL VALUES ARE PLACEHOLDERS PENDING ANDREW'S DECISION
// (docs/finance/PRICING_AND_ALLOWANCE_EVIDENCE.md). Metering always runs;
// the allowance only STOPS monitoring when MONITORING_ALLOWANCE_ENFORCED
// is 'true'. Until then usage is measured and displayed but never cut off
// by the allowance (Layer B's safety ceilings still apply).
//
// Layer A only. Layer B (business protection) is in safetyConfig.js and
// never depends on the advertised allowance.
//
// Env overrides (no deploy needed): PLAN_<CODE>_ALLOWANCE_MINUTES,
// MONITORING_ALLOWANCE_ENFORCED, MONITORING_ALLOWANCE_GRACE_SECONDS,
// MONITORING_WARNING_POINTS (e.g. "0.75,0.9").
'use strict';

const DEFAULT_PLAN_CODE = 'standard';

const PLAN_DEFAULTS = {
  standard: { code: 'standard', name: 'Home Call Guard', allowanceMinutes: 100 },
  // Defined so a second tier / upgrade path is exercised end to end. NOT on
  // sale: no Stripe price or store product exists and nothing sets it.
  plus: { code: 'plus', name: 'Home Call Guard Plus', allowanceMinutes: 200 },
};

// Warning points before 100% (100% itself is always the exhaustion point).
const DEFAULT_WARNING_POINTS = [0.75, 0.9];
// A monitored call in progress when the allowance runs out keeps its
// monitoring for at most this long, then monitoring stops (the call
// continues). Bounds the post-exhaustion AI cost explicitly: with 2
// streams, 300 s ≈ £0.08. DECISION REQUIRED (0 = stop immediately).
const DEFAULT_GRACE_SECONDS = 300;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function resolveWarningPoints(env) {
  const raw = env.MONITORING_WARNING_POINTS;
  if (!raw) return DEFAULT_WARNING_POINTS;
  const points = String(raw).split(',').map(Number).filter((n) => n > 0 && n < 1).sort((a, b) => a - b);
  return points.length ? points : DEFAULT_WARNING_POINTS;
}

// An unknown or missing code falls back to Standard — the smallest
// allowance — never to "unlimited".
function resolvePlan(planCode, env = process.env) {
  const code = typeof planCode === 'string' && PLAN_DEFAULTS[planCode] ? planCode : DEFAULT_PLAN_CODE;
  const base = PLAN_DEFAULTS[code];
  const allowanceMinutes = positiveNumber(env[`PLAN_${code.toUpperCase()}_ALLOWANCE_MINUTES`], base.allowanceMinutes);
  return {
    code,
    name: base.name,
    allowanceMinutes,
    allowanceSeconds: Math.round(allowanceMinutes * 60),
    enforced: env.MONITORING_ALLOWANCE_ENFORCED === 'true',
    graceSeconds: nonNegativeInt(env.MONITORING_ALLOWANCE_GRACE_SECONDS, DEFAULT_GRACE_SECONDS),
    warningPoints: resolveWarningPoints(env),
  };
}

function resolvePlanForEntitlement(entitlement, env = process.env) {
  return resolvePlan(entitlement && entitlement.plan_code, env);
}

module.exports = { DEFAULT_PLAN_CODE, PLAN_DEFAULTS, DEFAULT_WARNING_POINTS, DEFAULT_GRACE_SECONDS, resolvePlan, resolvePlanForEntitlement };
