// policy.js — APP-SIDE containment settings (env), validated.
//
// The authoritative limits live in the database (fc_policy,
// fc_budget_profiles). What the app may set here is limited to:
//   - how it behaves when the database can't be reached (degraded envelope),
//   - timing (RPC timeout, sweep interval),
//   - TIGHTENING overrides sent with each RPC (the database applies them only
//     if stricter: least() for limits, greatest() for rates),
//   - which callers are "essential" (funded from the separate bounded pool).
// Nothing here can raise a database limit. An invalid value never loosens
// anything: it falls back to the conservative default and is reported in
// `warnings`.
'use strict';

const DEFAULTS = Object.freeze({
  requireSignedVoice: true,
  rpcTimeoutMs: 1500,
  degradedMode: 'bounded',            // 'bounded' | 'reject'  (DECISION D3)
  degradedMaxConcurrent: 2,           // per server instance
  degradedMaxCallsPerHour: 20,        // per server instance
  degradedMaxCallSeconds: 600,        // <Dial timeLimit> for degraded calls
  degradedMaxOutageSeconds: 900,      // after this long without the DB: reject everything
  sweepIntervalMs: 15000,
  sweepBatch: 100,
  terminateOnRenewalUnavailable: true,
  renewalUnavailableGraceSeconds: 60,
  terminationMode: 'hangup',          // 'hangup' | 'announce' (wording: Claude 3 / Andrew)
  entitledCountRefreshMs: 30 * 60 * 1000,
  invariantCheckMs: 10 * 60 * 1000,
  allowShadow: false,                 // never send enforcement_mode=enforce? only if explicitly allowed
});

function parseBool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function resolveContainmentConfig(env = process.env) {
  const warnings = [];
  const c = { ...DEFAULTS };

  const intIn = (key, prop, min, max, { conservative = 'default' } = {}) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      warnings.push(`${key}=${raw} invalid (allowed ${min}–${max}); using ${conservative === 'min' ? min : c[prop]}`);
      if (conservative === 'min') c[prop] = min;
      return;
    }
    c[prop] = n;
  };
  const bool = (key, prop) => {
    const b = parseBool(env[key], c[prop]);
    if (b === null) warnings.push(`${key}=${env[key]} invalid (true|false); using ${c[prop]}`);
    else c[prop] = b;
  };

  bool('FC_REQUIRE_SIGNED_VOICE', 'requireSignedVoice');
  intIn('FC_RPC_TIMEOUT_MS', 'rpcTimeoutMs', 200, 5000);
  const mode = env.FC_DEGRADED_MODE;
  if (mode !== undefined && mode !== '') {
    if (mode === 'bounded' || mode === 'reject') c.degradedMode = mode;
    else { warnings.push(`FC_DEGRADED_MODE=${mode} invalid; using reject (most conservative)`); c.degradedMode = 'reject'; }
  }
  // Degraded envelope: values above the cap are refused, not clamped up.
  intIn('FC_DEGRADED_MAX_CONCURRENT', 'degradedMaxConcurrent', 0, 10, { conservative: 'min' });
  intIn('FC_DEGRADED_MAX_CALLS_PER_HOUR', 'degradedMaxCallsPerHour', 0, 120, { conservative: 'min' });
  intIn('FC_DEGRADED_MAX_CALL_SECONDS', 'degradedMaxCallSeconds', 60, 1800, { conservative: 'min' });
  intIn('FC_DEGRADED_MAX_OUTAGE_SECONDS', 'degradedMaxOutageSeconds', 0, 3600, { conservative: 'min' });
  intIn('FC_SWEEP_INTERVAL_MS', 'sweepIntervalMs', 2000, 60000);
  intIn('FC_SWEEP_BATCH', 'sweepBatch', 1, 1000);
  bool('FC_TERMINATE_ON_RENEWAL_UNAVAILABLE', 'terminateOnRenewalUnavailable');
  intIn('FC_RENEWAL_UNAVAILABLE_GRACE_SECONDS', 'renewalUnavailableGraceSeconds', 0, 600, { conservative: 'min' });
  const tm = env.FC_TERMINATION_MODE;
  if (tm !== undefined && tm !== '') {
    if (tm === 'hangup' || tm === 'announce') c.terminationMode = tm;
    else warnings.push(`FC_TERMINATION_MODE=${tm} invalid; using hangup`);
  }
  bool('FC_ALLOW_SHADOW', 'allowShadow');

  // Sweep must run well inside the renew-ahead window (90 s by default).
  if (c.sweepIntervalMs > 30000) { warnings.push('FC_SWEEP_INTERVAL_MS above 30000 risks missing renewals; using 30000'); c.sweepIntervalMs = 30000; }

  c.essentialCallers = parseEssentialCallers(env.FC_ESSENTIAL_CALLERS, warnings);
  c.overrides = resolveTighteningOverrides(env, c, warnings);
  c.warnings = warnings;
  return Object.freeze(c);
}

// Only tightening keys; the database ignores anything looser anyway.
const OVERRIDE_KEYS = {
  FC_TIGHTEN_LEASE_SECONDS: 'lease_seconds',
  FC_TIGHTEN_MAX_CALL_SECONDS: 'max_call_seconds',
  FC_TIGHTEN_BACKSTOP_SHARE: 'backstop_share',
  FC_MIN_CONNECTED_RATE_GBP_PER_MIN: 'connected_rate_gbp_per_min',
  FC_MIN_MONITORING_RATE_GBP_PER_MIN: 'monitoring_rate_gbp_per_min',
  FC_MIN_ESTIMATE_UPLIFT: 'estimate_uplift',
  FC_TIGHTEN_GLOBAL_DAILY_FLOOR_GBP: 'global_daily_floor_gbp',
  FC_TIGHTEN_GLOBAL_HOURLY_FLOOR_GBP: 'global_hourly_floor_gbp',
};

function resolveTighteningOverrides(env, c, warnings) {
  const o = {};
  for (const [key, field] of Object.entries(OVERRIDE_KEYS)) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { warnings.push(`${key}=${raw} ignored (must be a positive number)`); continue; }
    o[field] = n;
  }
  // The app always asks the database to ENFORCE unless shadow is explicitly
  // allowed here AND set in the database policy.
  if (!c.allowShadow) o.enforcement_mode = 'enforce';
  return Object.freeze(o);
}

// E.164-ish numbers, compared on digits with UK 0 → 44 normalisation.
function normaliseDigits(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `44${d.slice(1)}`;
  return d;
}

function parseEssentialCallers(raw, warnings) {
  if (!raw) return Object.freeze([]);
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean).map(normaliseDigits);
  const valid = list.filter((d) => d.length >= 6 && d.length <= 15);
  if (valid.length !== list.length) warnings.push('FC_ESSENTIAL_CALLERS contained invalid entries; they were dropped');
  if (valid.length > 50) { warnings.push('FC_ESSENTIAL_CALLERS truncated to 50 entries'); return Object.freeze(valid.slice(0, 50)); }
  return Object.freeze(valid);
}

function isEssentialCaller(config, from) {
  if (!from || !config.essentialCallers.length) return false;
  return config.essentialCallers.includes(normaliseDigits(from));
}

module.exports = { DEFAULTS, resolveContainmentConfig, isEssentialCaller, normaliseDigits };
