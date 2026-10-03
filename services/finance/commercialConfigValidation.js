'use strict';

// commercialConfigValidation.js — integration 2026-10-03 (Launch Fortress §9/§10).
//
// One place that checks the commercial configuration is ECONOMICALLY POSSIBLE
// before anything customer-facing relies on it. It decides NOTHING commercial:
// the price, the included allowance, the £ budget and every top-up are
// Andrew's decisions (listed in `decisionsRequired`). It reports, so
// impossible economics cannot be enabled by accident:
//
//   errors   — the configuration would let HCG spend more than the margin
//              model allows (a profile above the variable envelope; a top-up
//              that is not a valid product). server.js logs them at boot and,
//              in production, raises a critical alert; top-up sales are
//              refused while any top-up error exists.
//   warnings — inconsistent but not dangerous (e.g. an included-minutes figure
//              the £ budget cannot fund: Fortress enforces £, so the minutes
//              promise is the thing that would be broken, not HCG's money).
//
// Inputs come from env (economics, minutes, top-ups) and the database
// (fc_budget_profiles, which are authoritative and changed only through the
// audited fc_set_budget_profile).

const { deriveVariableEnvelope, DEFAULT_ECONOMICS } = require('../containment/economicPolicy');
const { resolveTopUpProducts } = require('../allowance/productCatalog');
const { resolveCostRates } = require('../usage/costModel');

const PAID_PROFILES = ['standard', 'plus'];

function num(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const n = Number(env[name]);
  return Number.isFinite(n) ? n : NaN;
}

/** Economic inputs from env (HCG_ECONOMICS_*), defaulting to the 2026-10 evidence values. */
function resolveEconomicInputs(env = process.env) {
  return {
    priceIncVatGbp: num(env, 'HCG_ECONOMICS_PRICE_INC_VAT_GBP', DEFAULT_ECONOMICS.priceIncVatGbp),
    vatRate: num(env, 'HCG_ECONOMICS_VAT_RATE', DEFAULT_ECONOMICS.vatRate),
    deliveryCostCeilingRatio: num(env, 'HCG_ECONOMICS_DELIVERY_COST_CEILING_RATIO', DEFAULT_ECONOMICS.deliveryCostCeilingRatio),
    includePlatformFeeInCeiling: env.HCG_ECONOMICS_INCLUDE_PLATFORM_FEE !== 'false',
    platformFeeRate: num(env, 'HCG_ECONOMICS_PLATFORM_FEE_RATE', DEFAULT_ECONOMICS.platformFeeRate),
    numberRentalGbp: num(env, 'HCG_ECONOMICS_NUMBER_RENTAL_GBP', DEFAULT_ECONOMICS.numberRentalGbp),
    infrastructureGbp: num(env, 'HCG_ECONOMICS_INFRASTRUCTURE_GBP', DEFAULT_ECONOMICS.infrastructureGbp),
    safetyReserveRatio: num(env, 'HCG_ECONOMICS_SAFETY_RESERVE_RATIO', DEFAULT_ECONOMICS.safetyReserveRatio),
    overrunAllowanceGbp: num(env, 'HCG_ECONOMICS_OVERRUN_ALLOWANCE_GBP', DEFAULT_ECONOMICS.overrunAllowanceGbp),
  };
}

/**
 * @param {object} args
 * @param {object} [args.env]
 * @param {Array<{profile, period_budget_gbp, delivery_reserve_gbp, essential_reserve_gbp}>} [args.profiles]
 *        fc_budget_profiles rows; omitted → profile checks reported as unverified
 */
function validateCommercialConfiguration({ env = process.env, profiles = null } = {}) {
  const errors = [];
  const warnings = [];
  const inputs = resolveEconomicInputs(env);
  let envelope = null;
  try {
    envelope = deriveVariableEnvelope(inputs);
  } catch (err) {
    errors.push({ code: 'economic_inputs_invalid', detail: err.message });
  }

  // Target margin coherence: the delivery-cost ceiling IS (1 − target margin).
  const targetMargin = num(env, 'ALLOWANCE_TARGET_MARGIN', 0.4);
  if (envelope && Math.abs((1 - targetMargin) - inputs.deliveryCostCeilingRatio) > 1e-9) {
    warnings.push({ code: 'margin_inputs_disagree', detail: `ALLOWANCE_TARGET_MARGIN ${targetMargin} implies a delivery-cost ceiling of ${1 - targetMargin}, but the plan envelope uses ${inputs.deliveryCostCeilingRatio}` });
  }

  // Plan profiles vs the variable envelope (authoritative £, in the database).
  const profileReport = [];
  if (!Array.isArray(profiles)) {
    warnings.push({ code: 'profiles_unverified', detail: 'fc_budget_profiles not readable (migration 067 not applied, or database unavailable)' });
  } else if (envelope) {
    for (const name of PAID_PROFILES) {
      const p = profiles.find((r) => r.profile === name);
      if (!p) { warnings.push({ code: 'profile_missing', detail: name }); continue; }
      const total = Number(p.period_budget_gbp) + Number(p.delivery_reserve_gbp) + Number(p.essential_reserve_gbp);
      const ok = Number.isFinite(total) && total <= envelope.variableEnvelopeGbp + 1e-9;
      profileReport.push({ profile: name, totalAuthorisationGbp: Math.round(total * 1e4) / 1e4, envelopeGbp: envelope.variableEnvelopeGbp, ok });
      if (!ok) errors.push({ code: 'profile_exceeds_envelope', detail: `${name}: £${total.toFixed(4)} of HCG-funded variable spend per period > the £${envelope.variableEnvelopeGbp} the margin model allows at £${inputs.priceIncVatGbp}` });
    }
  }

  // The included-minutes promise vs the £ budget that funds it.
  const rates = resolveCostRates(env);
  const perMonitoredMinute = rates.monitoringPerMinGbp + rates.connectedPerMinGbp;
  const minutesReport = [];
  for (const [name, envName, fallback] of [['standard', 'PLAN_STANDARD_ALLOWANCE_MINUTES', 100], ['plus', 'PLAN_PLUS_ALLOWANCE_MINUTES', 200]]) {
    const minutes = num(env, envName, fallback);
    const cost = Math.round(minutes * perMonitoredMinute * 1.1 * 1e4) / 1e4; // Fortress estimate uplift 1.10
    const p = Array.isArray(profiles) ? profiles.find((r) => r.profile === name) : null;
    const budget = p ? Number(p.period_budget_gbp) : null;
    minutesReport.push({ plan: name, includedMinutes: minutes, estimatedCostGbp: cost, budgetGbp: budget });
    if (budget !== null && cost > budget + 1e-9) {
      warnings.push({ code: 'minutes_promise_exceeds_budget', detail: `${name}: ${minutes} monitored minutes cost ≈ £${cost} but the Fortress budget is £${budget}; Fortress enforces £, so the minutes promise would not be met` });
    }
  }

  // Top-ups: invalid products and channels not viable under the margin model.
  const { products, rejected, economics } = resolveTopUpProducts(env);
  const topUpsEnabled = env.ALLOWANCE_TOPUPS_ENABLED === 'true';
  for (const code of rejected) errors.push({ code: 'topup_invalid', detail: `top-up "${code}" is malformed or promises more minutes than its £ funds` });
  for (const p of products) {
    for (const [channel, c] of Object.entries(p.channels)) {
      if (!c.viable) warnings.push({ code: 'topup_not_viable', detail: `${p.code} on ${channel}: £${p.budgetGbp} capacity needs ≥ £${c.required} after fees; £${c.afterFees} available — NOT offered on ${channel}` });
    }
  }
  if (topUpsEnabled && products.length === 0) warnings.push({ code: 'topups_enabled_without_products', detail: 'ALLOWANCE_TOPUPS_ENABLED=true but no valid ALLOWANCE_TOPUP_PRODUCTS' });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    envelope: envelope ? { variableEnvelopeGbp: envelope.variableEnvelopeGbp, netRevenueGbp: envelope.netRevenueGbp, fixedPerCustomerGbp: envelope.fixedPerCustomerGbp, suggestedProfile: envelope.suggestedProfile } : null,
    profiles: profileReport,
    includedMinutes: minutesReport,
    topUps: { enabled: topUpsEnabled, costPerMinuteGbp: economics.costPerMinuteGbp, costPerMinuteIsAssumption: economics.costPerMinuteIsAssumption, products: products.map((p) => ({ code: p.code, budgetGbp: p.budgetGbp, minutes: p.minutes, priceGbpInclVat: p.priceGbpInclVat, channels: Object.fromEntries(Object.entries(p.channels).map(([k, c]) => [k, { viable: c.viable, maxBudgetGbp: c.maxBudgetGbp }])) })) },
    decisionsRequired: [
      'D1 per-plan £ budget / delivery reserve / essential pool (fc_budget_profiles; placeholders £0.50 / £0.25 / £0.10)',
      'Included monitored minutes per plan (PLAN_*_ALLOWANCE_MINUTES; 100/200 are placeholders)',
      'Top-up quantities (£ capacity) and retail prices per channel; whether top-ups roll over (today: expire at reset)',
      'Higher-tier retail price and its £ budget',
      'Delivery-reserve scope (default trusted_only; reversible via fc_set_budget_profile)',
      'Economic inputs: price £5.99 (not yet approved for release), VAT, platform fee, rental, infrastructure, safety reserve, overrun allowance, target margin 40%',
    ],
  };
}

module.exports = { validateCommercialConfiguration, resolveEconomicInputs };
