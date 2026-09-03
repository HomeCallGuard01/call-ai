// openaiCosts.js — OpenAI/Whisper cost visibility for the business
// dashboard. Every figure this module produces is an ESTIMATE, never an
// actual provider-confirmed cost — confirmed this session that the
// OPENAI_API_KEY configured for this app is a project-scoped key
// (`sk-proj-...`), and a direct probe of
// `GET /v1/organization/costs` returns 403 with it. Getting real,
// provider-confirmed OpenAI spend requires a separate **Admin API key**
// (created by the account owner under platform.openai.com's
// organization settings, with the `api.usage.read`/billing scope) — a
// credential this app does not have and this change does not create,
// per the explicit instruction not to weaken or replace production
// credentials. Until that key exists, this module derives an estimate
// from HCG's own call records instead.
//
// The estimate itself has two independent sources of imprecision, both
// stated plainly rather than hidden in a single confident number:
//   1. Production's `calls` table has no duration column (this build's
//      own audit) — so the real driver of Whisper cost (minutes of
//      audio actually transcribed) cannot be measured, only assumed via
//      a configurable average-call-length constant
//      (BUSINESS_ASSUMED_AVG_MONITORED_CALL_MINUTES).
//   2. The per-minute Whisper rate itself is OpenAI's published public
//      price (BUSINESS_OPENAI_WHISPER_USD_PER_MINUTE), not this
//      account's confirmed billed rate (no cost API access — see above).
'use strict';

const { resolveOpenAiEstimateInputs, resolveUsdToGbpRate } = require('./config');

// Pure — the actual estimate arithmetic, directly unit-testable.
function estimateOpenAiCostGbp(unknownCallCount, { env = process.env } = {}) {
  const { perMinuteUsd, avgMinutesPerMonitoredCall } = resolveOpenAiEstimateInputs(env);
  const fxRate = resolveUsdToGbpRate(env);
  const estimatedMinutes = unknownCallCount * avgMinutesPerMonitoredCall;
  const estimatedUsd = estimatedMinutes * perMinuteUsd;
  return {
    estimated: true,
    unknownCallCount,
    assumedAvgMinutesPerCall: avgMinutesPerMonitoredCall,
    estimatedMonitoredMinutes: estimatedMinutes,
    estimatedCostUsd: Number(estimatedUsd.toFixed(4)),
    estimatedCostGbp: Number((estimatedUsd * fxRate).toFixed(4)),
    fxRateUsdToGbp: fxRate,
  };
}

// Presence-only check — never reads or logs the key's value. Matches
// this codebase's existing convention (services/serverConfig.js) of
// reporting configuration state by name only.
function isOpenAiKeyConfigured(env = process.env) {
  return Boolean(env.OPENAI_API_KEY);
}

module.exports = { estimateOpenAiCostGbp, isOpenAiKeyConfigured };
