// Central, single-location configuration for the business/profitability
// dashboard (routes/admin.js's /admin/api/business/* endpoints, 2026-09
// build). Every value here is either a hard business fact (VAT rate,
// the product price) or an explicitly-labeled estimate/operator input
// (FX rate, fixed provider costs, fair-use thresholds) — never invented
// silently. All configuration lives in environment variables, matching
// this codebase's established convention throughout (see
// services/liveMonitoring/householdUsageThresholds.js for the same
// pattern), so operators can change any of these without a deploy or a
// migration.
'use strict';

// UK standard VAT rate. AFMD Ltd is VAT registered; the consumer price
// (£4.99) is VAT-inclusive — see services/businessMetrics/vat.js for the
// actual gross/VAT/net split this feeds.
const DEFAULT_VAT_RATE = 0.20;

function resolveVatRate(env = process.env) {
  const rate = Number(env.BUSINESS_VAT_RATE);
  return Number.isFinite(rate) && rate >= 0 && rate < 1 ? rate : DEFAULT_VAT_RATE;
}

// USD->GBP conversion for the few provider figures priced in USD
// (OpenAI's published pricing, Twilio's public Media Streams/Voice SDK
// pricing where account-specific billing isn't available). Twilio's
// account-specific voice/number pricing is already billed in GBP
// directly (confirmed against the live account) and needs no
// conversion. Deliberately a configurable, visibly-labeled ESTIMATE, not
// a live FX feed — the dashboard must never present a converted figure
// as more precise than it is.
const DEFAULT_USD_TO_GBP_RATE = 0.79;

function resolveUsdToGbpRate(env = process.env) {
  const rate = Number(env.BUSINESS_FX_USD_TO_GBP);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_GBP_RATE;
}

// Fixed monthly provider costs with no suitable billing API for direct
// integration (per the audit — do not scrape a dashboard, do not store
// login credentials). Operator-entered, in GBP. 0 is a legitimate value
// (e.g. Resend's free tier) — never a "missing data" signal, so this
// never fails open to a guess; it fails open to £0 with an explicit
// "configured value" label the UI can show plainly.
function resolveFixedMonthlyCostsGbp(env = process.env) {
  const parse = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    railway: parse(env.BUSINESS_FIXED_COST_RAILWAY_GBP),
    supabase: parse(env.BUSINESS_FIXED_COST_SUPABASE_GBP),
    resend: parse(env.BUSINESS_FIXED_COST_RESEND_GBP),
  };
}

// OpenAI Whisper's published per-minute rate (USD) — see
// services/businessMetrics/openaiCosts.js for why this can only ever
// produce an ESTIMATE in the current architecture (no call-duration
// instrumentation in production yet, and the configured OpenAI key
// cannot query organisation-level cost APIs — see that file's own
// comment). Configurable so it can be corrected without a deploy the
// moment real pricing is confirmed.
const DEFAULT_OPENAI_WHISPER_USD_PER_MINUTE = 0.006;
// A single monitored (Unknown-caller) call's assumed average duration,
// for the per-call cost estimate only — see openaiCosts.js. This is the
// single least-confident number in this whole dashboard; kept
// configurable and always rendered with an "ESTIMATE" label, never as a
// plain figure.
const DEFAULT_ASSUMED_AVG_MONITORED_CALL_MINUTES = 2;

function resolveOpenAiEstimateInputs(env = process.env) {
  const perMinuteUsd = Number(env.BUSINESS_OPENAI_WHISPER_USD_PER_MINUTE);
  const avgMinutes = Number(env.BUSINESS_ASSUMED_AVG_MONITORED_CALL_MINUTES);
  return {
    perMinuteUsd: Number.isFinite(perMinuteUsd) && perMinuteUsd > 0 ? perMinuteUsd : DEFAULT_OPENAI_WHISPER_USD_PER_MINUTE,
    avgMinutesPerMonitoredCall: Number.isFinite(avgMinutes) && avgMinutes > 0 ? avgMinutes : DEFAULT_ASSUMED_AVG_MONITORED_CALL_MINUTES,
  };
}

// Fair-use visibility thresholds (2026-09 dashboard build). Expressed as
// Unknown-caller CALL COUNT per household per month, not monitored
// minutes — production has no call-duration column yet (see this
// build's own audit), so minutes-based thresholds designed on a separate,
// unmerged branch cannot be evaluated against real production data today.
// Call count is a real, honest, currently-available proxy for the same
// underlying concern (a household generating disproportionate monitoring
// volume) — labeled as such everywhere it's shown, never presented as
// the final, minutes-based design. Visibility/alerting only — nothing
// here disables or restricts a household.
const DEFAULT_FAIR_USE_WARNING_CALLS = 40;
const DEFAULT_FAIR_USE_HARD_CALLS = 80;

function resolveFairUseThresholds(env = process.env) {
  const warning = Number(env.BUSINESS_FAIR_USE_WARNING_UNKNOWN_CALLS_PER_MONTH);
  const hard = Number(env.BUSINESS_FAIR_USE_HARD_UNKNOWN_CALLS_PER_MONTH);
  return {
    warningCallsPerMonth: Number.isFinite(warning) && warning > 0 ? warning : DEFAULT_FAIR_USE_WARNING_CALLS,
    hardCallsPerMonth: Number.isFinite(hard) && hard > 0 ? hard : DEFAULT_FAIR_USE_HARD_CALLS,
  };
}

module.exports = {
  DEFAULT_VAT_RATE,
  resolveVatRate,
  DEFAULT_USD_TO_GBP_RATE,
  resolveUsdToGbpRate,
  resolveFixedMonthlyCostsGbp,
  DEFAULT_OPENAI_WHISPER_USD_PER_MINUTE,
  DEFAULT_ASSUMED_AVG_MONITORED_CALL_MINUTES,
  resolveOpenAiEstimateInputs,
  DEFAULT_FAIR_USE_WARNING_CALLS,
  DEFAULT_FAIR_USE_HARD_CALLS,
  resolveFairUseThresholds,
};
