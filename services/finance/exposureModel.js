// exposureModel.js — worst-case cost exposure for one household (and the
// company) under a given set of controls, from any carrier quote. Pure.
// Used to answer "what is the most a household can cost us in a day/month"
// before and after a proposed control, without assuming trusted calls are
// free (they are not: the forwarded inbound leg is billed for the whole
// conversation — Twilio Support, 2026-09).
//
// A "channel" is one simultaneous call. Worst case assumes channels are
// kept busy around the clock; each call lasts until the per-call limit and
// is immediately redialled. Monitoring runs for min(call, monitoring cap).
'use strict';

const { DEFAULT_ASSUMPTIONS } = require('./carrierComparison');

// Controls that exist on origin/main today (2026-09-28).
const MAIN_TODAY = {
  label: 'main today',
  perCallMaxMinutes: 240,           // <Dial> has no timeLimit → Twilio default 4 h
  monitoringCapMinutes: 30,         // MONITORING_MAX_DURATION_MINUTES (stream closes; call continues)
  channelsPerHousehold: null,       // no HCG limit (null = unbounded; pass `channels` to evaluate)
  monitoringDailyCapGbp: null,
  companyMaxConcurrentStreams: 200, // MEDIA_STREAM_MAX_CONCURRENT_STREAMS
};

// The unmerged allowance branch + a proposed <Dial timeLimit>. Illustrative
// until approved; none of these is live.
const PROPOSED = {
  label: 'proposed (allowance branch + 120-min Dial timeLimit)',
  perCallMaxMinutes: 120,
  monitoringCapMinutes: 30,
  channelsPerHousehold: 4,
  monitoringDailyCapGbp: 2,
  companyMaxConcurrentStreams: 20,
};

function perMinuteRates(quote, a = DEFAULT_ASSUMPTIONS) {
  const fx = Number(quote.fxToGbp ?? 1);
  const g = (v) => Number(v || 0) * fx;
  return {
    carried: g(quote.inboundPerMin) + g(quote.appLegPerMin) + g(quote.apiFeePerMin), // every connected minute
    monitoringOnly: g(quote.streamPerMin) + a.transcriptionGbpPerMonitoredMin,        // extra per monitored minute
    perCall: g(quote.ttsPerUse),                                                       // greeting (unknown callers)
    number: g(quote.numberMonthly),
    started60: Number(quote.billingIncrementSec) >= 60,
  };
}

/**
 * Worst-case cost of one household for `hours` with `channels` simultaneous
 * calls, all from unknown callers (the most expensive shape) or all trusted.
 */
function channelExposure(quote, controls, { channels, hours = 24, callerType = 'unknown' }, a = DEFAULT_ASSUMPTIONS) {
  const r = perMinuteRates(quote, a);
  const n = controls.channelsPerHousehold != null ? Math.min(channels, controls.channelsPerHousehold) : channels;
  const minutes = hours * 60;
  const callLen = controls.perCallMaxMinutes;
  const callsPerChannel = Math.ceil(minutes / callLen);
  const carried = n * minutes * r.carried;
  let monitored = 0; let greetings = 0;
  if (callerType === 'unknown') {
    const monitoredMinutes = n * callsPerChannel * Math.min(callLen, controls.monitoringCapMinutes);
    monitored = monitoredMinutes * r.monitoringOnly;
    if (controls.monitoringDailyCapGbp != null) monitored = Math.min(monitored, controls.monitoringDailyCapGbp * (hours / 24));
    greetings = n * callsPerChannel * r.perCall;
  }
  return { channels: n, hours, callerType, carriedGbp: r6(carried), monitoringGbp: r6(monitored), greetingsGbp: r6(greetings), totalGbp: r6(carried + monitored + greetings) };
}

// Shortest calls maximise monitoring (every call is monitored from the start);
// this is the monitoring-maximising shape an attacker would use.
function monitoringMaxExposure(quote, controls, { channels, hours = 24 }, a = DEFAULT_ASSUMPTIONS) {
  return channelExposure(quote, { ...controls, perCallMaxMinutes: Math.min(controls.perCallMaxMinutes, controls.monitoringCapMinutes) }, { channels, hours, callerType: 'unknown' }, a);
}

// Company-wide monitoring ceiling from the global concurrent-stream cap.
function companyMonitoringCeiling(quote, controls, a = DEFAULT_ASSUMPTIONS) {
  const r = perMinuteRates(quote, a);
  const perDay = controls.companyMaxConcurrentStreams * 1440 * r.monitoringOnly;
  return { streams: controls.companyMaxConcurrentStreams, perDayGbp: r6(perDay), perMonthGbp: r6(perDay * 30) };
}

// Realistic-but-extreme genuine usage: a household whose line is in use for
// `hoursPerDay` every day of a 30-day month, `monitoredShare` of it unknown.
function heavyGenuineMonth(quote, { hoursPerDay, monitoredShare = 0.15, avgCallMinutes = DEFAULT_ASSUMPTIONS.avgCallMinutes }, a = DEFAULT_ASSUMPTIONS) {
  const r = perMinuteRates(quote, a);
  const minutes = hoursPerDay * 60 * 30;
  const calls = minutes / avgCallMinutes;
  const extra = r.started60 ? a.roundUpPerCallAt60s : a.roundUpPerCallAt1s;
  const billed = minutes + calls * extra;
  const monitoredCalls = calls * monitoredShare;
  const cost = r.number + billed * r.carried + minutes * monitoredShare * r.monitoringOnly + monitoredCalls * r.perCall;
  return { hoursPerDay, minutes, monitoredShare, totalGbp: r6(cost) };
}

function r6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

module.exports = { MAIN_TODAY, PROPOSED, perMinuteRates, channelExposure, monitoringMaxExposure, companyMonitoringCeiling, heavyGenuineMonth };
