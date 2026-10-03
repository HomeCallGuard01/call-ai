// productCatalog.js — which store/Stripe products map to which HCG plan,
// and which allowance top-ups may be sold (customer allowance workstream,
// 2026-10-03). Pure; every value is backend configuration, so quantities
// and prices change with an env update, never an app release.
//
// NOTHING IS ON SALE BY DEFAULT. Commercial values (top-up minutes and
// prices, a higher tier's product ids) are Andrew's decision and the cost
// data is still incomplete (carrier economics under investigation), so the
// defaults are empty and every unknown product id resolves to nothing.
//
//   ALLOWANCE_TOPUP_PRODUCTS  JSON array, e.g.
//     [{"code":"topup_small","minutes":30,"priceGbpInclVat":2.99,
//       "stripePriceId":"price_…","appleProductId":"hcg.topup.small",
//       "googleProductId":"hcg_topup_small"}]
//   PLAN_PRODUCT_MAP          JSON object, provider product/price id → plan
//     code, e.g. {"hcg.plus.monthly":"plus","price_…":"plus"}. Any id not
//     listed is the default plan (Standard) — never a larger allowance.
//
// ECONOMICS GUARD (fail closed). A top-up is only offered on a channel if
// what HCG keeps covers its delivery cost at the target margin plus a
// safety reserve:
//
//   net            = price incl VAT ÷ (1 + VAT)
//   afterFees      = net − channel fee (Stripe / store commission)
//   deliveryCost   = minutes × cost per top-up minute
//   required       = deliveryCost ÷ (1 − target margin) × (1 + reserve)
//   offered only if afterFees ≥ required
//
// e.g. £1 of delivery cost at 40% margin needs ≥ £1.67 net (£2.00 incl VAT)
// BEFORE fees and reserve — the rule in the workstream brief.
//
// Cost per top-up minute defaults to a monitored minute PLUS a connected
// minute (costModel.js). That is deliberately conservative: an unknown
// call connects (and is billed) whether or not it is monitored, so the
// strictly marginal cost is the monitoring rate alone. ASSUMPTION — set
// ALLOWANCE_TOPUP_COST_GBP_PER_MIN once carrier economics are settled.
'use strict';

const { resolveCostRates } = require('../usage/costModel');
const { CHANNELS } = require('../finance/unitEconomics');

const SALES_CHANNELS = ['stripe', 'apple', 'google'];
// Which unitEconomics fee model each sales channel uses. Apple defaults to
// the 15% Small Business Programme rate ONLY if enrolment is confirmed;
// until then 30% (the conservative choice). ALLOWANCE_APPLE_FEE_MODEL=store15
// once enrolment is verified.
const DEFAULT_FEE_MODEL = { stripe: 'stripe', apple: 'apple30', google: 'store15' };

const DEFAULTS = {
  vatRate: 0.2,
  targetMargin: 0.4,
  safetyReserve: 0.1,
  // Don't sell a top-up that would expire almost immediately: top-up
  // minutes belong to the current allowance period (see topUpCredit.js).
  minHoursBeforeReset: 24,
};

function num(value, fallback, { min = 0, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function resolveEconomics(env = process.env) {
  const rates = resolveCostRates(env);
  return {
    vatRate: num(env.ALLOWANCE_VAT_RATE, DEFAULTS.vatRate, { max: 1 }),
    targetMargin: num(env.ALLOWANCE_TARGET_MARGIN, DEFAULTS.targetMargin, { max: 0.95 }),
    safetyReserve: num(env.ALLOWANCE_SAFETY_RESERVE, DEFAULTS.safetyReserve, { max: 5 }),
    costPerMinuteGbp: num(env.ALLOWANCE_TOPUP_COST_GBP_PER_MIN, rates.monitoringPerMinGbp + rates.connectedPerMinGbp),
    costPerMinuteIsAssumption: env.ALLOWANCE_TOPUP_COST_GBP_PER_MIN === undefined || env.ALLOWANCE_TOPUP_COST_GBP_PER_MIN === '',
    minHoursBeforeReset: num(env.ALLOWANCE_TOPUP_MIN_HOURS_BEFORE_RESET, DEFAULTS.minHoursBeforeReset),
    feeModel: {
      ...DEFAULT_FEE_MODEL,
      ...(CHANNELS[env.ALLOWANCE_APPLE_FEE_MODEL] ? { apple: env.ALLOWANCE_APPLE_FEE_MODEL } : {}),
    },
  };
}

/** Margin check for one product on one sales channel. Pure. */
function evaluateTopUpEconomics({ minutes, priceGbpInclVat, channel }, economics) {
  const gross = Number(priceGbpInclVat);
  const net = gross / (1 + economics.vatRate);
  const feeModel = CHANNELS[economics.feeModel[channel]];
  const fee = feeModel ? feeModel.fee(gross, net) : Infinity;
  const afterFees = net - fee;
  const deliveryCost = Number(minutes) * economics.costPerMinuteGbp;
  const required = (deliveryCost / (1 - economics.targetMargin)) * (1 + economics.safetyReserve);
  const round = (v) => Math.round(v * 10000) / 10000;
  return {
    channel,
    gross: round(gross),
    net: round(net),
    fee: round(fee),
    afterFees: round(afterFees),
    deliveryCost: round(deliveryCost),
    required: round(required),
    marginOfNet: net > 0 ? round((afterFees - deliveryCost) / net) : null,
    viable: Number.isFinite(afterFees) && deliveryCost > 0 && afterFees >= required,
  };
}

function validProduct(p) {
  return p && typeof p.code === 'string' && /^[a-z0-9_]{1,40}$/.test(p.code)
    && Number.isInteger(p.minutes) && p.minutes > 0 && p.minutes <= 10000
    && Number.isFinite(Number(p.priceGbpInclVat)) && Number(p.priceGbpInclVat) > 0;
}

const CHANNEL_ID_FIELD = { stripe: 'stripePriceId', apple: 'appleProductId', google: 'googleProductId' };

/**
 * Every configured top-up with its per-channel economics. Malformed entries
 * are dropped (and reported) rather than guessed at.
 */
function resolveTopUpProducts(env = process.env) {
  const economics = resolveEconomics(env);
  const raw = parseJson(env.ALLOWANCE_TOPUP_PRODUCTS, []);
  const list = Array.isArray(raw) ? raw : [];
  const products = [];
  const rejected = [];
  const seen = new Set();
  for (const p of list) {
    if (!validProduct(p) || seen.has(p.code)) { rejected.push(p && p.code ? p.code : '(invalid)'); continue; }
    seen.add(p.code);
    const channels = {};
    for (const channel of SALES_CHANNELS) {
      const providerProductId = p[CHANNEL_ID_FIELD[channel]] || null;
      if (!providerProductId) continue;
      channels[channel] = { providerProductId, ...evaluateTopUpEconomics({ minutes: p.minutes, priceGbpInclVat: p.priceGbpInclVat, channel }, economics) };
    }
    products.push({ code: p.code, minutes: p.minutes, priceGbpInclVat: Number(p.priceGbpInclVat), active: p.active !== false, channels });
  }
  return { products, rejected, economics };
}

/** Top-up whose provider product id (on that channel) matches, or null. */
function findTopUpByProviderProduct({ channel, providerProductId }, env = process.env) {
  if (!providerProductId) return null;
  const { products } = resolveTopUpProducts(env);
  return products.find((p) => p.channels[channel] && p.channels[channel].providerProductId === providerProductId) || null;
}

/**
 * Plan code for a subscription product / price id. Unknown → null (callers
 * keep the default plan). Only plan codes plans.js defines are returned.
 */
function planCodeForProduct(providerProductId, env = process.env, knownPlanCodes = ['standard', 'plus']) {
  if (!providerProductId) return null;
  const map = parseJson(env.PLAN_PRODUCT_MAP, {});
  const code = map && typeof map === 'object' ? map[providerProductId] : null;
  return typeof code === 'string' && knownPlanCodes.includes(code) ? code : null;
}

module.exports = {
  SALES_CHANNELS,
  DEFAULTS,
  resolveEconomics,
  evaluateTopUpEconomics,
  resolveTopUpProducts,
  findTopUpByProviderProduct,
  planCodeForProduct,
};
