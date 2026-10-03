// safetyConfig.js — Layer B: hard business financial protection limits
// (2026-09-30). Independent of the customer's advertised allowance.
// Every value is env-overridable; every default is DECISION REQUIRED and
// derived in docs/finance/FINANCIAL_SAFETY_ARCHITECTURE.md §4.
//
// Rates used below: connected minute c = £0.010718 (inbound + app leg at
// list, conservative), monitoring-only minute m = £0.008069.
//
// PER CALL
//   maxCallMinutes 240 — <Dial timeLimit>. Twilio's own default is 4 h, but
//     an account-level 24-hour-call setting would raise it; setting it
//     explicitly makes the bound HCG's. One call ≤ 240·c = £2.57.
//     (120 would halve it; it would also cut genuine 2 h+ calls.)
//   monitoring per call: 30 min (MONITORING_MAX_DURATION_MINUTES, existing).
// PER HOUSEHOLD — admission (refusals are <Reject>, unbilled)
//   maxCallsPerHousehold 3 — one handset holds one call + one waiting; a
//     third simultaneous call is already implausible for a person.
//   burst — OFF by default (integration 2026-10-03). Household-wide volume
//     is owned by the telephony-abuse layer (flag + suspend trusted bypass,
//     never refuse): refusing on it let a spoofed many-caller flood switch
//     the victim's phone off, trusted callers included. Set
//     SAFETY_BURST_MAX_ATTEMPTS > 0 to re-enable as an unknown-caller-only
//     backstop. Money is bounded by the Fortress budget and concurrency.
//   caller flood 9 attempts / 300 s from one caller (withheld excluded) —
//     the cross-instance DB backstop for the abuse layer's per-caller limit
//     (> 8 in 5 min → refused), aligned so the two agree (was 6 / 600 s).
//   householdDailyHardGbp £10 — one line cannot legitimately reach this:
//     it is ≈ 930 connected minutes (15.5 h of talk) in one day, or 13 h of
//     talk plus the full daily monitoring ceiling. Reaching it in practice
//     needs simultaneous calls (flood/loop). New calls refused for the rest
//     of the UTC day.
//   householdDailyWatchGbp £3 — ≈ 4.7 h of talk in a day: abnormal but
//     possible; refused ONLY while the company is in EMERGENCY.
//   householdPeriodUnknownBlockGbp £20 — unknown callers refused for the
//     rest of the billing period, trusted callers still delivered. ≈ 4× the
//     £4.99–£6.99 after-fees revenue: a customer this expensive is a
//     business-use / abuse case, not a margin question.
//   householdPeriodHardGbp £40 — every new call refused for the rest of
//     the period (≈ 3,700 connected minutes, ≈ 2 h/day every day).
// PER HOUSEHOLD — monitoring (Layer B ceilings, even when the allowance is not enforced)
//   maxMonitoredStreamsPerHousehold 2
//   dailyMonitoringCostLimitGbp £1.50 ≈ 186 monitored min in one day
//   periodMonitoringCostLimitGbp £5 ≈ 620 monitored min in a period (≈ 6× a 100-min allowance)
// COMPANY (scaled by entitled households N; floors for small N)
//   companyDailyEmergencyGbp max(£25, N × £0.75) — ≈ 10× a normal day
//     (typical household ≈ £0.10/day). Refuses new calls only for
//     households already above their daily WATCH level.
//   companyHourlyEmergencyGbp = daily emergency ÷ 4.
//   companyDailyHardGbp max(£100, N × £2) — refuses new UNKNOWN calls for
//     everyone (trusted still delivered).
//   globalDailyCostLimitGbp (monitoring only) max(£30, N × £0.30),
//   globalHourlyCostLimitGbp = that ÷ 6, globalMaxMonitoredStreams max(20, ceil(N/10)).
// SMS
//   householdDailySms 5, householdPeriodSms 30, companyDailySms max(50, N).
// FAIL-SAFE
//   budgetCheckTimeoutMs 1500 — monitoring: no answer → no monitoring.
//     Admission: no answer → the in-memory fallback applies the same
//     per-household call/burst/caller limits (the £ ceilings cannot be
//     evaluated without the database), and a CRITICAL alert is raised.
//   staleSessionSeconds 90, progressIntervalSeconds 10, maxProgressFailureSeconds 60,
//   maxTranscriptionRequestsPerHouseholdPerMinute 45 (WIP values, unchanged).
//   admissionRequiresSignature true — only Twilio-signed /voice requests
//     count against a household's limits, so forged requests can't exhaust
//     a household's budget and block its genuine calls.
// KILL SWITCHES: financial_safety_state.telephony_suspended / monitoring_suspended
//   (database, Andrew only); MONITORING_EMERGENCY_DISABLED=true (env).
'use strict';

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function int(value, fallback) {
  return Math.round(num(value, fallback));
}

function resolveSafetyConfig(env = process.env, { entitledHouseholds = 0 } = {}) {
  const n = Math.max(0, Number(entitledHouseholds) || 0);
  const companyDailyEmergencyGbp = num(env.SAFETY_COMPANY_DAILY_EMERGENCY_GBP, Math.max(25, n * 0.75));
  const globalDailyMonitoring = num(env.SAFETY_GLOBAL_DAILY_MONITORING_COST_LIMIT_GBP, Math.max(30, n * 0.3));
  return {
    // per call
    maxCallMinutes: int(env.SAFETY_MAX_CALL_MINUTES, 240),
    // per household admission
    maxCallsPerHousehold: int(env.SAFETY_MAX_CALLS_PER_HOUSEHOLD, 3),
    burstMaxAttempts: int(env.SAFETY_BURST_MAX_ATTEMPTS, 0),
    burstWindowSeconds: int(env.SAFETY_BURST_WINDOW_SECONDS, 120),
    callerMaxAttempts: int(env.SAFETY_CALLER_MAX_ATTEMPTS, 9),
    callerWindowSeconds: int(env.SAFETY_CALLER_WINDOW_SECONDS, 300),
    householdDailyWatchGbp: num(env.SAFETY_HOUSEHOLD_DAILY_WATCH_GBP, 3),
    householdDailyHardGbp: num(env.SAFETY_HOUSEHOLD_DAILY_HARD_GBP, 10),
    householdPeriodUnknownBlockGbp: num(env.SAFETY_HOUSEHOLD_PERIOD_UNKNOWN_BLOCK_GBP, 20),
    householdPeriodHardGbp: num(env.SAFETY_HOUSEHOLD_PERIOD_HARD_GBP, 40),
    // per household monitoring
    maxMonitoredStreamsPerHousehold: int(env.SAFETY_MAX_MONITORED_STREAMS_PER_HOUSEHOLD, 2),
    dailyMonitoringCostLimitGbp: num(env.SAFETY_DAILY_MONITORING_COST_LIMIT_GBP, 1.5),
    periodMonitoringCostLimitGbp: num(env.SAFETY_PERIOD_MONITORING_COST_LIMIT_GBP, 5),
    // company
    entitledHouseholds: n,
    companyDailyEmergencyGbp,
    companyHourlyEmergencyGbp: num(env.SAFETY_COMPANY_HOURLY_EMERGENCY_GBP, companyDailyEmergencyGbp / 4),
    companyDailyHardGbp: num(env.SAFETY_COMPANY_DAILY_HARD_GBP, Math.max(100, n * 2)),
    globalDailyCostLimitGbp: globalDailyMonitoring,
    globalHourlyCostLimitGbp: num(env.SAFETY_GLOBAL_HOURLY_MONITORING_COST_LIMIT_GBP, globalDailyMonitoring / 6),
    globalMaxMonitoredStreams: int(env.SAFETY_GLOBAL_MAX_MONITORED_STREAMS, Math.max(20, Math.ceil(n / 10))),
    // SMS
    householdDailySms: int(env.SAFETY_HOUSEHOLD_DAILY_SMS, 5),
    householdPeriodSms: int(env.SAFETY_HOUSEHOLD_PERIOD_SMS, 30),
    companyDailySms: int(env.SAFETY_COMPANY_DAILY_SMS, Math.max(50, n)),
    // fail-safe / timing
    budgetCheckTimeoutMs: int(env.SAFETY_BUDGET_CHECK_TIMEOUT_MS, 1500),
    staleSessionSeconds: int(env.SAFETY_STALE_SESSION_SECONDS, 90),
    progressIntervalSeconds: int(env.SAFETY_PROGRESS_INTERVAL_SECONDS, 10),
    maxProgressFailureSeconds: int(env.SAFETY_MAX_PROGRESS_FAILURE_SECONDS, 60),
    maxTranscriptionRequestsPerHouseholdPerMinute: int(env.SAFETY_MAX_TRANSCRIPTION_REQUESTS_PER_HOUSEHOLD_PER_MINUTE, 45),
    admissionRequiresSignature: env.SAFETY_ADMISSION_REQUIRES_SIGNATURE !== 'false',
    emergencyDisabled: env.MONITORING_EMERGENCY_DISABLED === 'true',
  };
}

// The jsonb limits object admit_call (migration 056) expects.
function admissionLimits(config, rates) {
  return {
    maxCallsPerHousehold: config.maxCallsPerHousehold,
    maxCallSeconds: config.maxCallMinutes * 60,
    costPerMinuteGbp: rates.connectedPerMinGbp,
    burstMaxAttempts: config.burstMaxAttempts,
    burstWindowSeconds: config.burstWindowSeconds,
    callerMaxAttempts: config.callerMaxAttempts,
    callerWindowSeconds: config.callerWindowSeconds,
    householdDailyHardGbp: config.householdDailyHardGbp,
    householdPeriodHardGbp: config.householdPeriodHardGbp,
    householdPeriodUnknownBlockGbp: config.householdPeriodUnknownBlockGbp,
    householdDailyWatchGbp: config.householdDailyWatchGbp,
    companyDailyEmergencyGbp: config.companyDailyEmergencyGbp,
    companyHourlyEmergencyGbp: config.companyHourlyEmergencyGbp,
    companyDailyHardGbp: config.companyDailyHardGbp,
  };
}

// The jsonb limits object begin_monitoring_session expects.
function monitoringLimits(config) {
  return {
    staleAfterSeconds: config.staleSessionSeconds,
    globalHourlyCostLimitGbp: config.globalHourlyCostLimitGbp,
    globalDailyCostLimitGbp: config.globalDailyCostLimitGbp,
    periodCostLimitGbp: config.periodMonitoringCostLimitGbp,
    dailyCostLimitGbp: config.dailyMonitoringCostLimitGbp,
    maxHouseholdStreams: config.maxMonitoredStreamsPerHousehold,
    globalMaxStreams: config.globalMaxMonitoredStreams,
  };
}

function smsLimits(config) {
  return { householdDailySms: config.householdDailySms, householdPeriodSms: config.householdPeriodSms, companyDailySms: config.companyDailySms };
}

module.exports = { resolveSafetyConfig, admissionLimits, monitoringLimits, smsLimits };
