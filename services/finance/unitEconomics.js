// unitEconomics.js — HCG's per-customer monthly economics, component by
// component, from a carrier quote (the confirmed Twilio baseline in
// docs/finance/carrier-quotes.json by default). Pure; used by the dashboard
// and business planning. Changes no price.
//
//   price (inc VAT) → VAT → payment/store fee → net
//   − number rental − inbound calls − app leg − Media Streams − TTS − SMS  (provider, CONFIRMED for Twilio)
//   − transcription/AI                                                     (ESTIMATED)
//   = contribution per customer
'use strict';

const { DEFAULT_ASSUMPTIONS } = require('./carrierComparison');
const register = require('./economicsRegister');

// Fee models from the authoritative register (PROVIDER CONFIRMATION REQUIRED
// for every rate; see docs/finance/HCG_UNIT_ECONOMICS_V1.md §3).
const STRIPE = register.stripeFeeParts();                 // 1.5% + 20p + Billing 0.7% + Tax 0.5%
const STORE15 = register.value('googlePlayServiceFeeRate'); // Google Play subs / Apple SBP: 15% of ex-VAT
const APPLE30 = register.value('appleStandardRate');        // Apple standard: 30% of ex-VAT
const CHANNELS = {
  stripe: { label: 'Stripe (web)', fee: (gross) => gross * STRIPE.pct + STRIPE.fixedGbp },
  store15: { label: 'Google Play / Apple SBP 15%', fee: (gross, net) => net * STORE15 },
  apple30: { label: 'Apple 30% (no SBP)', fee: (gross, net) => net * APPLE30 },
};

function componentCosts(quote, { totalMinutes, monitoredShare }, a = DEFAULT_ASSUMPTIONS) {
  const fx = Number(quote.fxToGbp ?? 1);
  const g = (v) => Number(v || 0) * fx;
  const calls = totalMinutes / a.avgCallMinutes;
  const monitored = totalMinutes * monitoredShare;
  const monitoredCalls = monitored / a.avgCallMinutes;
  const extra = Number(quote.billingIncrementSec) >= 60 ? a.roundUpPerCallAt60s : a.roundUpPerCallAt1s;
  const billedMinutes = totalMinutes + extra * calls;
  const billedMonitored = monitored + extra * monitoredCalls;
  const provider = {
    numberRental: g(quote.numberMonthly),
    inboundCalls: g(quote.inboundPerMin) * billedMinutes,
    appLeg: g(quote.appLegPerMin) * billedMinutes,
    apiFees: g(quote.apiFeePerMin) * billedMinutes,
    mediaStreams: g(quote.streamPerMin) * billedMonitored,
    tts: g(quote.ttsPerUse) * monitoredCalls,
    sms: g(quote.smsPerSegment) * a.warningSmsPerMonth * a.smsSegmentsPerWarning,
    channelShare: quote.channelMonthly && quote.channelsPerThousandHouseholds ? g(quote.channelMonthly) * Number(quote.channelsPerThousandHouseholds) / 1000 : 0,
  };
  const estimated = { transcription: a.transcriptionGbpPerMonitoredMin * monitored };
  const providerTotal = Object.values(provider).reduce((s, v) => s + v, 0);
  return { provider, estimated, providerTotal, estimatedTotal: estimated.transcription, total: providerTotal + estimated.transcription };
}

function economics(quote, { priceGbp, channel, totalMinutes, monitoredShare }, a = DEFAULT_ASSUMPTIONS) {
  const gross = priceGbp;
  const net = gross / (1 + a.vatRate);
  const vat = gross - net;
  const fee = CHANNELS[channel].fee(gross, net);
  const costs = componentCosts(quote, { totalMinutes, monitoredShare }, a);
  const contribution = net - fee - costs.total;
  return { gross, vat, net, fee, afterFees: net - fee, costs, contribution, marginOfNet: contribution / net };
}

function breakEven(quote, { priceGbp, channel, monitoredShare }, a = DEFAULT_ASSUMPTIONS) {
  const at = (m) => economics(quote, { priceGbp, channel, totalMinutes: m, monitoredShare }, a).contribution;
  if (at(0) <= 0) return 0;
  let lo = 0;
  let hi = 100000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > 0) lo = mid; else hi = mid;
  }
  return Math.floor(lo);
}

function grid(quote, { priceGbp, channels = Object.keys(CHANNELS), minutes, monitoredShares }, a = DEFAULT_ASSUMPTIONS) {
  const rows = [];
  for (const channel of channels) {
    for (const share of monitoredShares) {
      for (const m of minutes) rows.push({ channel, monitoredShare: share, totalMinutes: m, ...economics(quote, { priceGbp, channel, totalMinutes: m, monitoredShare: share }, a) });
    }
  }
  return rows;
}

module.exports = { CHANNELS, componentCosts, economics, breakEven, grid };
