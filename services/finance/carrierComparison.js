// carrierComparison.js — turns a carrier's quoted prices into HCG's cost per
// customer and break-even usage, directly comparable with the confirmed
// Twilio baseline. Pure. A carrier with any required price missing is
// reported as UNKNOWN for the affected figures; nothing is filled in.
//
// Quote fields (per carrier), all in the quote's own currency:
//   numberMonthly        UK local number per month
//   inboundPerMin        forwarded inbound call, per minute
//   billingIncrementSec  60 = per started minute, 1 = per second
//   appLegPerMin         app/WebRTC leg when bridged to the HCG app
//   apiFeePerMin         programmable-voice/API surcharge per minute (0 if none)
//   streamPerMin         real-time media stream per minute
//   ttsPerUse            en-GB greeting per call
//   smsPerSegment        SMS from the same UK number
//   channelMonthly / channelsPerThousandHouseholds  optional channel billing
//                        (when used, inboundPerMin is the per-minute charge
//                        that still applies, often 0)
//   fxToGbp              1 for GBP quotes
'use strict';

const REQUIRED = ['numberMonthly', 'inboundPerMin', 'billingIncrementSec', 'appLegPerMin', 'apiFeePerMin', 'streamPerMin', 'ttsPerUse', 'smsPerSegment'];

// From the authoritative register (services/finance/assumptions/).
const register = require('./economicsRegister');

const DEFAULT_ASSUMPTIONS = {
  avgCallMinutes: register.value('avgCallMinutes'),                                // ASSUMPTION
  roundUpPerCallAt60s: register.value('roundUpMinutesPerCall'),                    // ASSUMPTION: extra started minute per call under 60/60 billing
  roundUpPerCallAt1s: register.value('roundUpMinutesPerCallPerSecondBilling'),     // ASSUMPTION: ring/greeting seconds under per-second billing
  warningSmsPerMonth: register.value('warningSmsPerMonth'),                        // ASSUMPTION
  smsSegmentsPerWarning: register.value('smsSegmentsPerWarning'),
  transcriptionGbpPerMonitoredMin: register.transcriptionGbpPerMin(),              // ESTIMATED (OpenAI, provider-independent)
  vatRate: register.value('vatRate'),
};

function missingFields(quote) {
  return REQUIRED.filter((k) => quote[k] === null || quote[k] === undefined || !Number.isFinite(Number(quote[k])));
}

/**
 * Monthly telephony + AI cost (GBP) for one household.
 */
function monthlyCost(quote, { totalMinutes, monitoredShare }, a = DEFAULT_ASSUMPTIONS) {
  const fx = Number(quote.fxToGbp ?? 1);
  const g = (v) => Number(v || 0) * fx;
  const calls = totalMinutes / a.avgCallMinutes;
  const monitored = totalMinutes * monitoredShare;
  const monitoredCalls = monitored / a.avgCallMinutes;
  const extra = Number(quote.billingIncrementSec) >= 60 ? a.roundUpPerCallAt60s : a.roundUpPerCallAt1s;
  const billedMinutes = totalMinutes + extra * calls;
  const billedMonitored = monitored + extra * monitoredCalls;
  const channelShare = quote.channelMonthly && quote.channelsPerThousandHouseholds
    ? g(quote.channelMonthly) * Number(quote.channelsPerThousandHouseholds) / 1000 : 0;
  return g(quote.numberMonthly)
    + (g(quote.inboundPerMin) + g(quote.appLegPerMin) + g(quote.apiFeePerMin)) * billedMinutes
    + g(quote.streamPerMin) * billedMonitored
    + g(quote.ttsPerUse) * monitoredCalls
    + g(quote.smsPerSegment) * a.warningSmsPerMonth * a.smsSegmentsPerWarning
    + a.transcriptionGbpPerMonitoredMin * monitored
    + channelShare;
}

function netRevenue(priceGbp, channel, a = DEFAULT_ASSUMPTIONS) {
  const net = priceGbp / (1 + a.vatRate);
  const fee = channel === 'stripe' ? priceGbp * 0.027 + 0.2 : channel === 'store15' ? net * 0.15 : channel === 'apple30' ? net * 0.3 : NaN;
  return net - fee;
}

function breakEvenMinutes(quote, { priceGbp, channel, monitoredShare }, a = DEFAULT_ASSUMPTIONS) {
  const budget = netRevenue(priceGbp, channel, a);
  if (monthlyCost(quote, { totalMinutes: 0, monitoredShare }, a) >= budget) return 0;
  let lo = 0;
  let hi = 100000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (monthlyCost(quote, { totalMinutes: mid, monitoredShare }, a) < budget) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo);
}

/**
 * @param {Array<object>} quotes - first entry is the baseline (Twilio, CONFIRMED)
 * @param {object} scenario - { priceGbp, monitoredShare, usageLevels: number[] }
 */
function compareCarriers(quotes, scenario) {
  const baseline = quotes[0];
  const baseCosts = Object.fromEntries(scenario.usageLevels.map((m) => [m, monthlyCost(baseline, { totalMinutes: m, monitoredShare: scenario.monitoredShare })]));
  return quotes.map((q) => {
    const missing = missingFields(q);
    if (missing.length) return { name: q.name, status: q.status || 'UNKNOWN', computable: false, missing };
    const costs = {};
    for (const m of scenario.usageLevels) {
      const c = monthlyCost(q, { totalMinutes: m, monitoredShare: scenario.monitoredShare });
      costs[m] = { costGbp: Math.round(c * 100) / 100, vsBaselineGbp: Math.round((c - baseCosts[m]) * 100) / 100 };
    }
    return {
      name: q.name,
      status: q.status,
      computable: true,
      monthlyCostByMinutes: costs,
      breakEvenMinutes: {
        stripe: breakEvenMinutes(q, { priceGbp: scenario.priceGbp, channel: 'stripe', monitoredShare: scenario.monitoredShare }),
        store15: breakEvenMinutes(q, { priceGbp: scenario.priceGbp, channel: 'store15', monitoredShare: scenario.monitoredShare }),
      },
    };
  });
}

module.exports = { compareCarriers, monthlyCost, breakEvenMinutes, netRevenue, missingFields, REQUIRED, DEFAULT_ASSUMPTIONS };
