// revenue.js — real Stripe revenue (via Stripe's own balance_transactions
// API, so gross/fee/net are provider-confirmed, not estimated) plus an
// explicitly-labeled RevenueCat/Apple revenue ESTIMATE (no per-
// transaction Apple amount is stored anywhere in this schema —
// entitlements has no price field, confirmed this session — so Apple
// revenue can only ever be count-of-active-entitlements × the known
// list price, never an actual confirmed figure).
'use strict';

const { splitVatInclusive } = require('./vat');
const { resolveVatRate } = require('./config');

function startOfTodayUnix() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function startOfMonthUnix() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Sums Stripe balance_transactions into gross/fee/net GBP totals — real,
// provider-confirmed figures (Stripe computes the fee itself; this never
// estimates it). `type` filters to genuine charges vs refunds so the two
// are reported separately rather than netted silently.
async function sumBalanceTransactions(stripe, { gte, type }) {
  let totalGrossPence = 0;
  let totalFeePence = 0;
  let count = 0;
  let startingAfter;

  // Bounded pagination — a single household's worth of monthly charges
  // at this business's current scale is nowhere near Stripe's page
  // limits, but this avoids ever silently truncating a real month once
  // volume grows.
  for (let page = 0; page < 20; page += 1) {
    const params = { created: { gte }, type, limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const result = await stripe.balanceTransactions.list(params);

    for (const txn of result.data) {
      totalGrossPence += txn.amount;
      totalFeePence += txn.fee;
      count += 1;
    }

    if (!result.has_more || result.data.length === 0) break;
    startingAfter = result.data[result.data.length - 1].id;
  }

  return { grossPence: totalGrossPence, feePence: totalFeePence, count };
}

async function getStripeRevenueSnapshot({ stripe }) {
  if (!stripe) {
    return { available: false, reason: 'STRIPE_SECRET_KEY not configured' };
  }

  try {
    const [chargesToday, chargesMtd, refundsToday, refundsMtd] = await Promise.all([
      sumBalanceTransactions(stripe, { gte: startOfTodayUnix(), type: 'charge' }),
      sumBalanceTransactions(stripe, { gte: startOfMonthUnix(), type: 'charge' }),
      sumBalanceTransactions(stripe, { gte: startOfTodayUnix(), type: 'refund' }),
      sumBalanceTransactions(stripe, { gte: startOfMonthUnix(), type: 'refund' }),
    ]);

    return {
      available: true,
      // Amounts are Stripe's real, signed balance-transaction amounts in
      // the smallest currency unit (pence) — converted to £ here for
      // display only, no rounding applied to the underlying figures used
      // in further calculation.
      grossRevenueTodayGbp: chargesToday.grossPence / 100,
      grossRevenueMtdGbp: chargesMtd.grossPence / 100,
      stripeFeesTodayGbp: chargesToday.feePence / 100,
      stripeFeesMtdGbp: chargesMtd.feePence / 100,
      refundsTodayGbp: Math.abs(refundsToday.grossPence) / 100,
      refundsMtdGbp: Math.abs(refundsMtd.grossPence) / 100,
      chargeCountToday: chargesToday.count,
      chargeCountMtd: chargesMtd.count,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

// ESTIMATE only — see this file's own header. `activeAppleEntitlements`
// and `priceGbp` are both real inputs (a real count from the database, a
// real Stripe-confirmed price), but their product is not a confirmed
// Apple proceeds figure — Apple's actual commission tier (15%/30%,
// dependent on this developer account's own program enrollment and
// per-subscriber tenure) is not knowable from this codebase or from
// RevenueCat's webhook payload.
function estimateAppleRevenueGbp(activeAppleEntitlements, priceGbp) {
  return {
    estimated: true,
    activeAppleEntitlements,
    grossRevenueEstimateGbp: Number((activeAppleEntitlements * priceGbp).toFixed(2)),
    note: 'Gross customer price only — Apple\'s actual commission and confirmed net proceeds are not available from this integration. Do not treat as actual revenue.',
  };
}

// Applies the one shared VAT split (services/businessMetrics/vat.js) to
// a gross revenue figure, returning the ex-VAT figure the profitability
// calculation actually uses.
function netOfVat(grossGbp, env = process.env) {
  return splitVatInclusive(grossGbp, resolveVatRate(env));
}

module.exports = { getStripeRevenueSnapshot, estimateAppleRevenueGbp, netOfVat };
