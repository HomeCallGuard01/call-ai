// costModel.js — the per-unit £ rates the real-time safety counters use
// (migration 056). These are HCG ESTIMATES for enforcement; the supplier-
// reconciled truth is the ledger (051), and spendMonitor alerts if the
// ledger shows real cost running above these estimates.
//
// Two separate rates, so nothing is counted twice:
//   connected  — every admitted call, trusted or unknown, for its whole
//                duration: the inbound PSTN leg (Twilio Support confirmed
//                it is billable for the whole connected call, including
//                <Dial><Client>) PLUS the app leg priced CONSERVATIVELY at
//                Twilio's list price ($0.004/min ≈ £0.00316), although it
//                is billed £0 today. If Twilio starts billing it, no limit
//                is silently under-counting. (Set
//                SAFETY_COST_APP_LEG_GBP_PER_MIN=0 to price it at today's £0.)
//   monitoring — only while a call is monitored: Media Stream + transcription.
//
// Defaults: the enforcement-basis rates of the authoritative register
// (services/finance/assumptions/hcg-unit-economics.v1.json — Twilio Pricing
// API / billed usage for this account, OpenAI list price × FX; app leg at
// list). Overridable via SAFETY_COST_*.
'use strict';

const register = require('../finance/economicsRegister');

const ENFORCEMENT = register.rates({ basis: 'enforcement' });
const DEFAULT_RATES = Object.freeze({
  inboundPerMin: ENFORCEMENT.inboundPerMin,
  appLegPerMin: ENFORCEMENT.appLegPerMin,
  mediaStreamPerMin: ENFORCEMENT.mediaStreamPerMin,
  transcriptionPerMin: ENFORCEMENT.transcriptionPerMin,
  smsPerSegment: ENFORCEMENT.smsPerSegment,
});

function rate(env, key, fallback) {
  if (env[key] === undefined || env[key] === '') return fallback;
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolveCostRates(env = process.env) {
  const inboundPerMin = rate(env, 'SAFETY_COST_INBOUND_GBP_PER_MIN', DEFAULT_RATES.inboundPerMin);
  const appLegPerMin = rate(env, 'SAFETY_COST_APP_LEG_GBP_PER_MIN', DEFAULT_RATES.appLegPerMin);
  const mediaStreamPerMin = rate(env, 'SAFETY_COST_MEDIA_STREAM_GBP_PER_MIN', DEFAULT_RATES.mediaStreamPerMin);
  const transcriptionPerMin = rate(env, 'SAFETY_COST_TRANSCRIPTION_GBP_PER_MIN', DEFAULT_RATES.transcriptionPerMin);
  const smsPerSegment = rate(env, 'SAFETY_COST_SMS_GBP_PER_SEGMENT', DEFAULT_RATES.smsPerSegment);
  const connectedPerMin = inboundPerMin + appLegPerMin;
  const monitoringPerMin = mediaStreamPerMin + transcriptionPerMin;
  return {
    inboundPerMin, appLegPerMin, mediaStreamPerMin, transcriptionPerMin, smsPerSegment,
    connectedPerMinGbp: connectedPerMin,
    monitoringPerMinGbp: monitoringPerMin,
    monitoringPerSecondGbp: monitoringPerMin / 60,
  };
}

module.exports = { DEFAULT_RATES, resolveCostRates };
