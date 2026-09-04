// profitability.js — the one transparent profitability calculation the
// whole dashboard is built around. Every input is either a real,
// provider-confirmed figure (Stripe gross/fees, Twilio spend) or an
// explicitly-labeled estimate (Apple revenue, OpenAI cost) — this module
// never blurs the two, and always returns the full breakdown so the UI
// can show its working, not just a final number.
'use strict';

const { resolveOpenAiEstimateInputs, resolveUsdToGbpRate } = require('./config');

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {object} inputs
 * @param {number} inputs.stripeGrossRevenueGbp - real, from Stripe balance_transactions
 * @param {number} inputs.stripeFeesGbp - real, from Stripe balance_transactions
 * @param {number} inputs.appleRevenueEstimateGbp - ESTIMATE (count x price)
 * @param {number} inputs.twilioCostGbp - real, from Twilio usage.records
 * @param {number} inputs.openaiCostEstimateGbp - ESTIMATE
 * @param {number} inputs.fixedMonthlyCostsGbp - operator-configured (Railway/Supabase/Resend)
 * @param {number} inputs.vatRateAppliedToGross - the VAT rate already backed out of the gross figures upstream (services/businessMetrics/revenue.js's netOfVat) — passed through only for display
 * @param {number} inputs.activeCustomerCount
 */
function computeProfitabilitySnapshot({
  stripeGrossRevenueGbp,
  stripeFeesGbp,
  appleRevenueEstimateGbp,
  twilioCostGbp,
  openaiCostEstimateGbp,
  fixedMonthlyCostsGbp,
  vatRateAppliedToGross,
  activeCustomerCount,
}) {
  const totalGrossRevenueGbp = stripeGrossRevenueGbp + appleRevenueEstimateGbp;
  const vatElementGbp = (stripeGrossRevenueGbp * vatRateAppliedToGross) / (1 + vatRateAppliedToGross)
    + (appleRevenueEstimateGbp * vatRateAppliedToGross) / (1 + vatRateAppliedToGross);
  const netRevenueExVatGbp = totalGrossRevenueGbp - vatElementGbp;

  const totalVariableCostsGbp = stripeFeesGbp + twilioCostGbp + openaiCostEstimateGbp;
  const contributionGbp = netRevenueExVatGbp - totalVariableCostsGbp;
  const operatingProfitGbp = contributionGbp - fixedMonthlyCostsGbp;

  const grossMarginPercent = netRevenueExVatGbp > 0 ? round2((contributionGbp / netRevenueExVatGbp) * 100) : null;

  const avgRevenuePerCustomerGbp = activeCustomerCount > 0 ? round2(netRevenueExVatGbp / activeCustomerCount) : null;
  const avgVariableCostPerCustomerGbp = activeCustomerCount > 0 ? round2(totalVariableCostsGbp / activeCustomerCount) : null;
  const avgContributionPerCustomerGbp =
    avgRevenuePerCustomerGbp !== null && avgVariableCostPerCustomerGbp !== null
      ? round2(avgRevenuePerCustomerGbp - avgVariableCostPerCustomerGbp)
      : null;

  return {
    revenue: {
      totalGrossRevenueGbp: round2(totalGrossRevenueGbp),
      stripeGrossRevenueGbp: round2(stripeGrossRevenueGbp),
      appleRevenueEstimateGbp: round2(appleRevenueEstimateGbp),
      vatElementGbp: round2(vatElementGbp),
      netRevenueExVatGbp: round2(netRevenueExVatGbp),
    },
    costs: {
      stripeFeesGbp: round2(stripeFeesGbp),
      twilioCostGbp: round2(twilioCostGbp),
      openaiCostEstimateGbp: round2(openaiCostEstimateGbp),
      totalVariableCostsGbp: round2(totalVariableCostsGbp),
      fixedMonthlyCostsGbp: round2(fixedMonthlyCostsGbp),
    },
    profit: {
      contributionGbp: round2(contributionGbp),
      operatingProfitGbp: round2(operatingProfitGbp),
      grossMarginPercent,
    },
    perCustomer: {
      avgRevenuePerCustomerGbp,
      avgVariableCostPerCustomerGbp,
      avgContributionPerCustomerGbp,
    },
  };
}

// Business Dashboard V2 (2026-09): the CONFIRMED counterpart to
// computeProfitabilitySnapshot above, which stays exactly as it was —
// it's the full, labeled-ESTIMATE view (blends the Apple revenue
// estimate and the OpenAI cost estimate in) and remains available as
// that. This function only ever uses provider-confirmed inputs — real
// Stripe gross/fees (balance_transactions), real Twilio spend
// (usage.records) — and deliberately never includes the Apple estimate
// or the OpenAI estimate, so its own output can honestly be labeled
// CONFIRMED rather than blended.
//
// Contribution (revenue minus the variable costs we're actually sure
// of) is always computable from these inputs alone. Operating profit
// additionally needs the fixed monthly costs (Railway/Supabase/Resend)
// — when those aren't configured (services/businessMetrics/config.js's
// resolveFixedMonthlyCostsStatus), operating profit is reported as
// unavailable/INCOMPLETE with the exact missing inputs named, rather
// than silently treating an unset cost as £0. Per the explicit brief:
// "Do not show a precise operating-profit/margin figure as confirmed
// when material costs are unknown."
function computeConfirmedContribution({
  stripeGrossRevenueGbp,
  stripeFeesGbp,
  twilioCostGbp,
  vatRateAppliedToGross,
  fixedCostsStatus,
  genuinePayingCustomerCount,
}) {
  const vatElementGbp = (stripeGrossRevenueGbp * vatRateAppliedToGross) / (1 + vatRateAppliedToGross);
  const netRevenueExVatGbp = stripeGrossRevenueGbp - vatElementGbp;

  const totalVariableCostsGbp = stripeFeesGbp + twilioCostGbp;
  const contributionGbp = netRevenueExVatGbp - totalVariableCostsGbp;
  const contributionMarginPercent = netRevenueExVatGbp > 0 ? round2((contributionGbp / netRevenueExVatGbp) * 100) : null;

  const missingCostInputs = [];
  if (!fixedCostsStatus.railway.configured) missingCostInputs.push('railway_fixed_cost');
  if (!fixedCostsStatus.supabase.configured) missingCostInputs.push('supabase_fixed_cost');
  if (!fixedCostsStatus.resend.configured) missingCostInputs.push('resend_fixed_cost');

  const operatingProfitAvailable = fixedCostsStatus.allConfigured;
  const operatingProfitGbp = operatingProfitAvailable ? contributionGbp - fixedCostsStatus.totalGbp : null;
  const operatingMarginPercent =
    operatingProfitAvailable && netRevenueExVatGbp > 0 ? round2((operatingProfitGbp / netRevenueExVatGbp) * 100) : null;

  return {
    label: 'CONFIRMED',
    revenue: {
      stripeGrossRevenueGbp: round2(stripeGrossRevenueGbp),
      vatElementGbp: round2(vatElementGbp),
      netRevenueExVatGbp: round2(netRevenueExVatGbp),
    },
    costs: {
      stripeFeesGbp: round2(stripeFeesGbp),
      twilioCostGbp: round2(twilioCostGbp),
      totalVariableCostsGbp: round2(totalVariableCostsGbp),
      fixedMonthlyCostsGbp: operatingProfitAvailable ? round2(fixedCostsStatus.totalGbp) : null,
      fixedCostsConfigured: operatingProfitAvailable,
    },
    profit: {
      contributionGbp: round2(contributionGbp),
      contributionMarginPercent,
      operatingProfitGbp: operatingProfitAvailable ? round2(operatingProfitGbp) : null,
      operatingProfitStatus: operatingProfitAvailable ? 'CONFIRMED' : 'INCOMPLETE',
      missingCostInputs,
      operatingMarginPercent,
    },
    perCustomer: {
      costPerGenuinePayingCustomerGbp:
        genuinePayingCustomerCount > 0 ? round2(totalVariableCostsGbp / genuinePayingCustomerCount) : null,
    },
  };
}

// Break-even monitored (Unknown-caller) minutes for a single £4.99
// subscriber — pure, uses the SAME OpenAI/Twilio-per-minute assumptions
// the rest of this module labels as estimates. See
// services/businessMetrics/config.js for each input's own caveat.
function computeBreakEvenMonitoredMinutes({ netRevenuePerCustomerGbp, fixedCostPerCustomerGbp, costPerMonitoredMinuteGbp }) {
  if (!(costPerMonitoredMinuteGbp > 0)) return null;
  const available = netRevenuePerCustomerGbp - fixedCostPerCustomerGbp;
  if (available <= 0) return 0;
  return round2(available / costPerMonitoredMinuteGbp);
}

// Pure — the estimated £/monitored-minute figure used above, built from
// the same configurable, labeled-estimate inputs as openaiCosts.js plus
// Twilio's confirmed inbound-minute rate (passed in, not hardcoded here,
// so this stays free of any Twilio-specific pricing assumption of its
// own).
function estimateCostPerMonitoredMinuteGbp({ twilioInboundPerMinuteGbp, env = process.env }) {
  const { perMinuteUsd } = resolveOpenAiEstimateInputs(env);
  const fxRate = resolveUsdToGbpRate(env);
  return round2(twilioInboundPerMinuteGbp + perMinuteUsd * fxRate);
}

module.exports = {
  computeProfitabilitySnapshot,
  computeConfirmedContribution,
  computeBreakEvenMonitoredMinutes,
  estimateCostPerMonitoredMinuteGbp,
};
