// pricingScenarios.js — contribution and margin per household for candidate
// prices, monitored-minute allowances and usage shapes. Pure; changes no
// price and activates no allowance. Evidence for Andrew's pricing decision.
//
// Cost per household per month (provider rates from a carrier quote, the
// confirmed Twilio baseline by default; `stress` scales every provider and
// AI rate, e.g. 0.25 = +25%):
//
//   number rental
// + connected minutes × (inbound + app leg + API fee)      every call, trusted or not
//     connected = trusted + monitored + unmonitored-unknown
//                 + started-minute rounding (0.55 min/call at 60/60 billing)
// + monitored minutes × (Media Stream + transcription)    only while monitored
//     (+0.5 stream minute per monitored call: per-started-minute stream billing)
// + greeting per unknown call
// + SMS segments
//
// Margin is contribution ÷ net revenue (price ex-VAT), i.e. the share of
// what HCG keeps after VAT that is left once payment fees and every
// variable provider cost are paid. Fixed overheads (hosting, staff, ads)
// are NOT in contribution.
'use strict';

const { CHANNELS } = require('./unitEconomics');
const register = require('./economicsRegister');

// From the authoritative register (services/finance/assumptions/).
const ASSUMPTIONS = {
  vatRate: register.value('vatRate'),
  roundUpMinutesPerCall: register.value('roundUpMinutesPerCall'),                 // ASSUMPTION (60/60 billing, observed calls)
  streamRoundUpPerMonitoredCall: register.value('streamRoundUpPerMonitoredCall'), // ASSUMPTION
  transcriptionGbpPerMin: register.transcriptionGbpPerMin(),                     // ESTIMATED: OpenAI whisper list × FX
  smsSegmentsPerWarning: register.value('smsSegmentsPerWarning'),
};

// Illustrative monthly usage shapes (ASSUMPTIONS — no real distribution exists
// yet: 0 genuine paying customers as of 2026-09-27). `monitored: 'allowance'`
// means the household uses its whole monitored allowance; any unknown-caller
// minutes beyond it continue UNMONITORED (still billed inbound).
const PROFILES = {
  light: { label: 'Light', trusted: 60, unknownMinutes: 15, trustedCalls: 20, unknownCalls: 6, sms: 0 },
  typical: { label: 'Typical', trusted: 150, unknownMinutes: 40, trustedCalls: 45, unknownCalls: 15, sms: 1 },
  heavy: { label: 'Heavy family', trusted: 400, unknownMinutes: 80, trustedCalls: 100, unknownCalls: 30, sms: 2 },
  veryHeavy: { label: 'Very heavy', trusted: 800, unknownMinutes: 200, trustedCalls: 200, unknownCalls: 60, sms: 3 },
  business: { label: 'Business user (e.g. plumber)', trusted: 200, unknownMinutes: 1200, trustedCalls: 50, unknownCalls: 300, sms: 5 },
  trustedOnly1h: { label: 'Trusted-only, 1 h/day', trusted: 1800, unknownMinutes: 0, trustedCalls: 450, unknownCalls: 0, sms: 0 },
};

function rates(quote, { stress = 0, appLegBilled = false } = {}, a = ASSUMPTIONS) {
  const fx = Number(quote.fxToGbp ?? 1);
  const k = (1 + stress) * fx;
  const appLeg = appLegBilled ? Math.max(Number(quote.appLegPerMin || 0), register.appLegListGbpPerMin()) : Number(quote.appLegPerMin || 0);
  return {
    number: Number(quote.numberMonthly) * k,
    connected: (Number(quote.inboundPerMin) + appLeg + Number(quote.apiFeePerMin || 0)) * k,
    streamPerMin: Number(quote.streamPerMin) * k,
    transcriptionPerMin: a.transcriptionGbpPerMin * (1 + stress),
    greeting: Number(quote.ttsPerUse) * k,
    smsSegment: Number(quote.smsPerSegment) * k,
  };
}

// Monitored minute cost (everything a monitored minute adds on top of nothing).
function monitoredMinuteCost(r) {
  return r.connected + r.streamPerMin + r.transcriptionPerMin;
}

function revenue(priceGbp, channel, a = ASSUMPTIONS) {
  const net = priceGbp / (1 + a.vatRate);
  const fee = CHANNELS[channel].fee(priceGbp, net);
  return { gross: priceGbp, vat: priceGbp - net, net, fee, afterFees: net - fee };
}

/**
 * @param {object} usage { trusted, unknownMinutes, trustedCalls, unknownCalls, sms }
 * @param {number|null} allowanceMinutes  monitored allowance (null = unlimited)
 */
function householdCost(quote, usage, allowanceMinutes, opts = {}, a = ASSUMPTIONS) {
  const r = rates(quote, opts, a);
  const monitored = allowanceMinutes == null ? usage.unknownMinutes : Math.min(usage.unknownMinutes, allowanceMinutes);
  const unmonitoredUnknown = usage.unknownMinutes - monitored;
  const calls = usage.trustedCalls + usage.unknownCalls;
  const monitoredCalls = usage.unknownMinutes > 0 ? usage.unknownCalls * (monitored / usage.unknownMinutes) : 0;
  const parts = {
    number: r.number,
    trustedCalls: (usage.trusted + a.roundUpMinutesPerCall * usage.trustedCalls) * r.connected,
    unknownConnected: (usage.unknownMinutes + a.roundUpMinutesPerCall * usage.unknownCalls) * r.connected,
    mediaStreams: (monitored + a.streamRoundUpPerMonitoredCall * monitoredCalls) * r.streamPerMin,
    transcription: monitored * r.transcriptionPerMin,
    greetings: monitoredCalls * r.greeting,
    sms: usage.sms * a.smsSegmentsPerWarning * r.smsSegment,
  };
  const total = Object.values(parts).reduce((s, v) => s + v, 0);
  return { monitored, unmonitoredUnknown, calls, parts, total };
}

function contribution(quote, { priceGbp, channel, usage, allowanceMinutes, ...opts }, a = ASSUMPTIONS) {
  const rev = revenue(priceGbp, channel, a);
  const cost = householdCost(quote, usage, allowanceMinutes, opts, a);
  const c = rev.afterFees - cost.total;
  return { ...rev, cost, contribution: c, margin: c / rev.net };
}

// Largest monitored allowance (minutes, fully used) that still leaves
// `targetMargin` of net revenue, for a household that also has `trusted`
// trusted minutes. Negative → no allowance can reach the target.
function maxAllowanceForMargin(quote, { priceGbp, channel, targetMargin, trusted, trustedCalls = Math.round(trusted / 4), avgUnknownCallMinutes = 4, ...opts }, a = ASSUMPTIONS) {
  const rev = revenue(priceGbp, channel, a);
  const r = rates(quote, opts, a);
  const budget = rev.net * (1 - targetMargin) - rev.fee;
  const fixed = r.number + (trusted + a.roundUpMinutesPerCall * trustedCalls) * r.connected;
  // per monitored minute, including per-call rounding/stream/greeting spread over an average call
  const perMin = monitoredMinuteCost(r) + (a.roundUpMinutesPerCall * r.connected + a.streamRoundUpPerMonitoredCall * r.streamPerMin + r.greeting) / avgUnknownCallMinutes;
  return Math.floor((budget - fixed) / perMin);
}

// Trusted minutes at which the margin falls to `targetMargin`, given a fully
// used monitored allowance. This is the "trusted usage alone destroys the
// margin" boundary.
function trustedMinutesAtMargin(quote, { priceGbp, channel, targetMargin, allowanceMinutes = 0, avgTrustedCallMinutes = 4, avgUnknownCallMinutes = 4, ...opts }, a = ASSUMPTIONS) {
  const rev = revenue(priceGbp, channel, a);
  const r = rates(quote, opts, a);
  const budget = rev.net * (1 - targetMargin) - rev.fee;
  const monitoredCost = allowanceMinutes > 0
    ? householdCost(quote, { trusted: 0, unknownMinutes: allowanceMinutes, trustedCalls: 0, unknownCalls: allowanceMinutes / avgUnknownCallMinutes, sms: 0 }, allowanceMinutes, opts, a).total - r.number
    : 0;
  const perTrustedMin = r.connected * (1 + a.roundUpMinutesPerCall / avgTrustedCallMinutes);
  return Math.floor((budget - r.number - monitoredCost) / perTrustedMin);
}

// Monthly cost at which a household's margin falls below target (WATCH) and
// at which it becomes loss-making (ALERT), for a price/channel.
function householdCostThresholds({ priceGbp, channel, targetMargin }, a = ASSUMPTIONS) {
  const rev = revenue(priceGbp, channel, a);
  return {
    afterFees: rev.afterFees,
    watchAtCostGbp: rev.net * (1 - targetMargin) - rev.fee,
    lossAtCostGbp: rev.afterFees,
  };
}

module.exports = { ASSUMPTIONS, PROFILES, rates, monitoredMinuteCost, revenue, householdCost, contribution, maxAllowanceForMargin, trustedMinutesAtMargin, householdCostThresholds };
