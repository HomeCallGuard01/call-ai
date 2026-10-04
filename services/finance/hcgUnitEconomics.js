// hcgUnitEconomics.js — the single auditable HCG unit-economics model (v1,
// 2026-10-04). Every input comes from the authoritative register
// (economicsRegister.js); nothing here is a magic number except presentation
// rounding. Pure. Decides NOTHING commercial: it computes candidates for
// Andrew (docs/finance/HCG_UNIT_ECONOMICS_V1.md).
//
// Definitions
//   net            = price ÷ (1 + VAT)
//   fee            = payment/store fee for the channel
//   leakage        = refunds/chargebacks/failed renewals (ratio of net)
//   gross margin   = (net − fee − leakage − cost of service) ÷ net
//   cost of service= number rental (+ churned-number overhang)
//                  + infrastructure allocation + RevenueCat share
//                  + usage (trusted + monitored minutes, greetings, SMS)
//
//   cost-of-service budget at margin m = net × (1 − m) − fee − leakage
//   variable budget  = that − fixed per-customer costs
//   safe variable    = variable × (1 − plan reserve) − overrun allowance
//
// "Safe variable" is what HCG can let ONE customer consume in usage per
// month and still hit the target margin with the reserve intact. It is on
// the EXPECTED-cost basis (what HCG is billed). The Financial Fortress
// charges budgets on the ENFORCEMENT basis (app leg at list, × uplift), so a
// Fortress £ figure must be converted (fortressEquivalent) to fund the same
// minutes.
'use strict';

const register = require('./economicsRegister');

const v = register.value;
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 1e4) / 1e4;

const CHANNELS = Object.freeze({
  stripe: { label: 'Stripe (web/Android today)', store: false },
  apple15: { label: 'Apple, Small Business Program 15%', store: true },
  apple30: { label: 'Apple, standard 30%', store: true },
  google15: { label: 'Google Play Billing 15% (not live)', store: true },
});

function channelFee(channel, gross, net) {
  switch (channel) {
    case 'stripe': { const s = register.stripeFeeParts(); return gross * s.pct + s.fixedGbp; }
    case 'apple15': return net * v('appleSmallBusinessRate');
    case 'apple30': return net * v('appleStandardRate');
    case 'google15': return net * v('googlePlayServiceFeeRate');
    default: throw new Error(`hcgUnitEconomics: unknown channel "${channel}"`);
  }
}

function revenue({ priceIncVatGbp = v('priceIncVatGbp'), channel = 'stripe', leakageRate = v('revenueLeakageRate') } = {}) {
  const gross = priceIncVatGbp;
  const net = gross / (1 + v('vatRate'));
  const fee = channelFee(channel, gross, net);
  const leakage = net * leakageRate;
  return { channel, gross, vat: gross - net, net, fee, leakage, afterFees: net - fee - leakage };
}

/**
 * Fixed per-customer monthly cost of service.
 * subscribers: when given, infrastructure = company-wide fixed ÷ subscribers;
 * otherwise the configured per-customer allocation.
 * revenueCatAboveThreshold: apply RevenueCat's 1% (app-store channels only).
 */
function fixedPerCustomer({ channel = 'stripe', priceIncVatGbp = v('priceIncVatGbp'), subscribers = null, revenueCatAboveThreshold = false, numberRentalGbp = v('numberRentalGbpPerMonth'), infraFixedGbpPerMonth = v('infrastructureFixedGbpPerMonth') } = {}) {
  const number = numberRentalGbp;
  const churnOverhang = numberRentalGbp * v('monthlyChurnRate') * v('numberHeldAfterChurnMonths');
  const infrastructure = subscribers ? infraFixedGbpPerMonth / subscribers : v('infrastructureAllocationGbpPerCustomer');
  const revenueCat = CHANNELS[channel].store && revenueCatAboveThreshold ? priceIncVatGbp * v('revenueCatRateAboveThreshold') : 0;
  const parts = { number, churnOverhang, infrastructure, revenueCat };
  return { parts, total: Object.values(parts).reduce((s, x) => s + x, 0) };
}

/** The usage budget one customer may consume at the target margin. */
function budget(opts = {}) {
  const m = opts.targetMargin ?? v('targetGrossMargin');
  const rev = revenue(opts);
  const fixed = fixedPerCustomer(opts);
  const costOfServiceBudget = rev.net * (1 - m) - rev.fee - rev.leakage;
  const variable = costOfServiceBudget - fixed.total;
  const reserveRatio = opts.reserveRatio ?? v('planSafetyReserveRatio');
  const overrun = opts.overrunGbp ?? v('overrunAllowanceGbp');
  const reserve = Math.max(0, variable) * reserveRatio;
  const safeVariable = Math.max(0, variable - reserve - overrun);
  return {
    ...rev,
    targetMargin: m,
    costOfServiceBudget,
    fixed,
    variableBudget: variable,
    reserve,
    overrun,
    safeVariableBudget: safeVariable,
    // Cost at which this customer drops below target (WATCH) and makes a loss (LOSS).
    watchAtTotalCostGbp: costOfServiceBudget,
    lossAtTotalCostGbp: rev.afterFees,
  };
}

/** Per-minute costs including per-call overheads spread over an average call. */
function minuteCosts({ basis = 'expected', telephony = null } = {}) {
  const r = register.rates({ basis });
  const avg = v('avgCallMinutes');
  const tel = telephony || { trustedPerMinGbp: r.connectedPerMin, unknownConnectedPerMinGbp: r.connectedPerMin, streamPerMinGbp: r.mediaStreamPerMin, incrementSec: v('twilioBillingIncrementSec') };
  const round = tel.incrementSec >= 60 ? v('roundUpMinutesPerCall') : v('roundUpMinutesPerCallPerSecondBilling');
  const up = r.uplift;
  const trusted = tel.trustedPerMinGbp * (1 + round / avg) * up;
  const monitored = (tel.unknownConnectedPerMinGbp * (1 + round / avg)
    + tel.streamPerMinGbp * (1 + v('streamRoundUpPerMonitoredCall') / avg)
    + r.transcriptionPerMin
    + r.greetingPerCall / avg) * up;
  const monitoringOnly = (tel.streamPerMinGbp * (1 + v('streamRoundUpPerMonitoredCall') / avg) + r.transcriptionPerMin + r.greetingPerCall / avg) * up;
  return { basis, trustedPerMin: trusted, monitoredPerMin: monitored, monitoringMarginalPerMin: monitoringOnly, smsPerSegment: r.smsPerSegment * up };
}

/** Usage cost of one month for a profile. */
function usageCost(usage, { basis = 'expected', telephony = null, monitoredAllowance = null } = {}) {
  const r = register.rates({ basis });
  const tel = telephony || { trustedPerMinGbp: r.connectedPerMin, unknownConnectedPerMinGbp: r.connectedPerMin, streamPerMinGbp: r.mediaStreamPerMin, incrementSec: v('twilioBillingIncrementSec') };
  const round = tel.incrementSec >= 60 ? v('roundUpMinutesPerCall') : v('roundUpMinutesPerCallPerSecondBilling');
  const up = r.uplift;
  const monitored = monitoredAllowance == null ? usage.unknownMinutes : Math.min(usage.unknownMinutes, monitoredAllowance);
  const monitoredCalls = usage.unknownMinutes > 0 ? usage.unknownCalls * (monitored / usage.unknownMinutes) : 0;
  const parts = {
    trusted: (usage.trusted + round * usage.trustedCalls) * tel.trustedPerMinGbp * up,
    unknownConnected: (usage.unknownMinutes + round * usage.unknownCalls) * tel.unknownConnectedPerMinGbp * up,
    streams: (monitored + v('streamRoundUpPerMonitoredCall') * monitoredCalls) * tel.streamPerMinGbp * up,
    transcription: monitored * r.transcriptionPerMin * up,
    greetings: monitoredCalls * r.greetingPerCall * up,
    sms: (usage.sms || 0) * v('smsSegmentsPerWarning') * r.smsPerSegment * up,
  };
  return { monitored, parts, total: Object.values(parts).reduce((s, x) => s + x, 0) };
}

/** Full P&L for one customer-month. */
function scenario({ usage, telephony = null, monitoredAllowance = null, ...opts }) {
  const b = budget({ ...opts, numberRentalGbp: telephony ? telephony.numberGbp : undefined });
  const u = usageCost(usage, { telephony, monitoredAllowance });
  // A carrier's company-wide minimum/fixed fee, spread over `subscribers` (default 1,000).
  const carrierFixed = telephony && telephony.fixedGbpPerMonth ? telephony.fixedGbpPerMonth / (opts.subscribers || 1000) : 0;
  const cost = b.fixed.total + carrierFixed + u.total;
  const contribution = b.afterFees - cost;
  return { channel: b.channel, net: b.net, fee: b.fee, leakage: b.leakage, fixed: b.fixed.total + carrierFixed, usage: u.total, usageParts: u.parts, cost, contribution, margin: contribution / b.net, meetsTarget: contribution / b.net >= b.targetMargin - 1e-9 };
}

/** How much usage a £ budget buys (expected basis unless told otherwise). */
function minutesFor(gbp, { basis = 'expected', telephony = null, trustedShareOfMinutes = null } = {}) {
  const c = minuteCosts({ basis, telephony });
  const out = {
    trustedOnly: c.trustedPerMin > 0 ? Math.floor(gbp / c.trustedPerMin) : Infinity,
    monitoredOnly: Math.floor(gbp / c.monitoredPerMin),
  };
  if (trustedShareOfMinutes != null) {
    const blended = trustedShareOfMinutes * c.trustedPerMin + (1 - trustedShareOfMinutes) * c.monitoredPerMin;
    out.blendedTotal = Math.floor(gbp / blended);
  }
  return out;
}

/** £ the Fortress (enforcement basis) must hold to fund the minutes an expected-basis £ buys. */
function fortressEquivalent(expectedGbp, { trustedShareOfSpend = 0.5 } = {}) {
  const e = minuteCosts({ basis: 'expected' });
  const f = minuteCosts({ basis: 'enforcement' });
  const factor = trustedShareOfSpend * (f.trustedPerMin / e.trustedPerMin) + (1 - trustedShareOfSpend) * (f.monitoredPerMin / e.monitoredPerMin);
  return { factor, gbp: expectedGbp * factor };
}

/** Lowest retail price (incl VAT) at which a top-up of `deliveryCostGbp` meets the margin + reserve on a channel. */
function topUpMinPrice(deliveryCostGbp, channel, { targetMargin = v('targetGrossMargin'), reserve = v('topUpSafetyReserveRatio') } = {}) {
  const requiredAfterFees = (deliveryCostGbp * (1 + reserve)) / (1 - targetMargin);
  const vat = v('vatRate');
  if (channel === 'stripe') {
    const s = register.stripeFeeParts();
    return (requiredAfterFees + s.fixedGbp) / (1 / (1 + vat) - s.pct);
  }
  const rate = { apple15: v('appleSmallBusinessRate'), apple30: v('appleStandardRate'), google15: v('googlePlayServiceFeeRate') }[channel];
  return (requiredAfterFees * (1 + vat)) / (1 - rate);
}

/** Round up to the next retail price point ending .49 or .99. */
function retailPricePoint(p) {
  const pence = Math.ceil(p * 100 - 1e-9);
  const pounds = Math.floor(pence / 100);
  const rem = pence % 100;
  if (rem <= 49) return pounds + 0.49;
  if (rem <= 99) return pounds + 0.99;
  return pounds + 1.49;
}

/** Reproduce the contradictory figures from their own formulas, for the audit trail. */
function reconcileLegacyFigures() {
  const { deriveVariableEnvelope } = require('../containment/economicPolicy');
  const env = deriveVariableEnvelope();
  const enf = register.rates({ basis: 'enforcement' });
  const minutes100 = 100 * (enf.connectedPerMin + enf.monitoringPerMin);
  const net = v('priceIncVatGbp') / (1 + v('vatRate'));
  const ceiling = net * (1 - v('targetGrossMargin'));
  const store = net * v('googlePlayServiceFeeRate');
  const rental = v('numberRentalGbpPerMonth');
  const s = register.stripeFeeParts();
  const stripeFee = v('priceIncVatGbp') * s.pct + s.fixedGbp;
  return {
    envelope086: env.variableEnvelopeGbp,
    budgetSlice050: { formula: env.suggestedProfile.periodBudgetGbp, seeded: v('fortressSeedBudgetGbp').budget },
    hundredMinutes207: { atRates: r4(minutes100), withUplift: r4(minutes100 * v('fortressEstimateUplift')) },
    candidates125: {
      storeFee_noInfra_reserve10: r4((ceiling - store - rental) * 0.9),
      storeFee_noInfra_noReserve_overrun: r4(ceiling - store - rental - v('overrunAllowanceGbp')),
      stripeFee_infra_reserve15: r4((ceiling - stripeFee - rental - v('infrastructureAllocationGbpPerCustomer')) * (1 - v('planSafetyReserveRatio'))),
      storeFee_noInfra_reserve15_overrun: r4((ceiling - store - rental) * (1 - v('planSafetyReserveRatio')) - v('overrunAllowanceGbp')),
    },
  };
}

module.exports = {
  CHANNELS,
  channelFee,
  revenue,
  fixedPerCustomer,
  budget,
  minuteCosts,
  usageCost,
  scenario,
  minutesFor,
  fortressEquivalent,
  topUpMinPrice,
  retailPricePoint,
  reconcileLegacyFigures,
  r2,
  r4,
};
