// Business control centre — genuine revenue and MRR from Stripe.
//
// Replaces "entitlement count × list price" (which reported £34.93 MRR
// from 7 complimentary accounts) with figures read from Stripe itself and
// restricted to GENUINE customers:
//   - Recognised MRR: active/past_due Stripe subscriptions whose customer
//     maps (households.stripe_customer_id) to a genuine_customer household,
//     priced from the subscription's own items, normalised to a month.
//   - Collected this month: succeeded charges since the 1st (UTC) from
//     genuine customers, minus amounts refunded.
// Both are shown VAT-inclusive (as charged) and ex-VAT at the configured
// rate (labelled estimated VAT treatment).
//
// Stripe TEST mode is detected (object.livemode === false, or a test key)
// and reported as such — test figures are never presented as revenue.
// Read-only: subscriptions.list and charges.list only. Other currencies
// are totalled separately, never added to GBP.
'use strict';

const INTERVAL_TO_MONTH = { month: 1, year: 1 / 12, week: 52 / 12, day: 365 / 12 };

function monthlyAmountMinor(sub) {
  let total = 0;
  for (const item of (sub.items && sub.items.data) || []) {
    const price = item.price || item.plan || {};
    const unit = Number(price.unit_amount ?? price.amount ?? 0);
    const interval = (price.recurring && price.recurring.interval) || price.interval || 'month';
    const count = Number((price.recurring && price.recurring.interval_count) || price.interval_count || 1);
    const qty = Number(item.quantity || 1);
    const perMonth = (INTERVAL_TO_MONTH[interval] || 0) / count;
    total += unit * qty * perMonth;
  }
  return total;
}

function currencyOf(obj) {
  return String(obj.currency || (obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price && obj.items.data[0].price.currency) || 'gbp').toUpperCase();
}

function addTo(map, currency, minor) {
  map[currency] = (map[currency] || 0) + minor;
}

function toMajor(map) {
  return Object.fromEntries(Object.entries(map).map(([c, v]) => [c, Math.round(v) / 100]));
}

// Pure. `genuineByCustomer`: Map stripe_customer_id → household id for
// genuine_customer households only. Returns per-currency totals.
function computeRecognisedMrr(subscriptions, genuineByCustomer) {
  const genuine = {};
  const excluded = {};
  let genuineCount = 0;
  let excludedCount = 0;
  let livemode = null;
  for (const s of subscriptions || []) {
    if (!['active', 'past_due', 'trialing'].includes(s.status)) continue;
    if (typeof s.livemode === 'boolean') livemode = livemode === null ? s.livemode : livemode && s.livemode;
    const minor = s.status === 'trialing' ? 0 : monthlyAmountMinor(s);
    if (genuineByCustomer.has(s.customer)) {
      addTo(genuine, currencyOf(s), minor);
      genuineCount += 1;
    } else {
      addTo(excluded, currencyOf(s), minor);
      excludedCount += 1;
    }
  }
  return { genuine: toMajor(genuine), genuineSubscriptions: genuineCount, excludedNonGenuine: toMajor(excluded), excludedSubscriptions: excludedCount, livemode };
}

// Pure. Charges since the period start: succeeded + paid, net of refunds.
function computeCollectedRevenue(charges, genuineByCustomer) {
  const genuine = {};
  const other = {};
  const genuineFees = {};
  let genuineCount = 0;
  let feesMissing = 0;
  let livemode = null;
  for (const c of charges || []) {
    if (!c.paid || c.status !== 'succeeded') continue;
    if (typeof c.livemode === 'boolean') livemode = livemode === null ? c.livemode : livemode && c.livemode;
    const net = Number(c.amount || 0) - Number(c.amount_refunded || 0);
    const cur = String(c.currency || 'gbp').toUpperCase();
    if (genuineByCustomer.has(c.customer)) {
      addTo(genuine, cur, net);
      genuineCount += 1;
      // The fee Stripe actually charged on this payment (expanded balance
      // transaction). Missing → counted, never assumed zero.
      const bt = c.balance_transaction;
      if (bt && typeof bt === 'object' && Number.isFinite(Number(bt.fee))) addTo(genuineFees, String(bt.currency || cur).toUpperCase(), Number(bt.fee));
      else feesMissing += 1;
    } else {
      addTo(other, cur, net);
    }
  }
  return { genuine: toMajor(genuine), genuineCharges: genuineCount, genuineFees: toMajor(genuineFees), feesMissing, otherNonGenuine: toMajor(other), livemode };
}

function exVat(amountsByCurrency, vatRate) {
  return Object.fromEntries(Object.entries(amountsByCurrency).map(([c, v]) => [c, Math.round((v / (1 + vatRate)) * 100) / 100]));
}

// 'live' | 'test' | 'unknown' — from the objects themselves, else the key
// prefix. The key itself is never returned or logged.
function stripeMode(livemodeFromObjects, secretKey) {
  if (livemodeFromObjects === true) return 'live';
  if (livemodeFromObjects === false) return 'test';
  if (typeof secretKey === 'string') {
    if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
    if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  }
  return 'unknown';
}

async function listAll(listFn, params, max = 2000) {
  const out = [];
  let startingAfter;
  for (let page = 0; page < Math.ceil(max / 100); page += 1) {
    const res = await listFn({ ...params, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    out.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return out;
}

// Read-only fetch. `genuineByCustomer` is built by the caller from
// households + classifications (so this module never reads the DB).
async function getGenuineStripeRevenue({ stripe, genuineByCustomer, vatRate, now = new Date(), env = process.env }) {
  if (!stripe) return { available: false, reason: 'STRIPE_SECRET_KEY not configured' };
  try {
    const periodStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const [subscriptions, charges] = await Promise.all([
      listAll((p) => stripe.subscriptions.list(p), { status: 'all' }),
      listAll((p) => stripe.charges.list(p), { created: { gte: periodStart }, expand: ['data.balance_transaction'] }),
    ]);
    const mrr = computeRecognisedMrr(subscriptions, genuineByCustomer);
    const collected = computeCollectedRevenue(charges, genuineByCustomer);
    const liveFlags = [mrr.livemode, collected.livemode].filter((v) => v !== null);
    const mode = stripeMode(liveFlags.length ? liveFlags.every(Boolean) : null, env.STRIPE_SECRET_KEY);
    return {
      available: true,
      mode,
      vatRate,
      mrr: { ...mrr, genuineExVat: exVat(mrr.genuine, vatRate) },
      collectedThisMonth: { ...collected, genuineExVat: exVat(collected.genuine, vatRate), periodStart: new Date(periodStart * 1000).toISOString() },
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

module.exports = { monthlyAmountMinor, computeRecognisedMrr, computeCollectedRevenue, exVat, stripeMode, getGenuineStripeRevenue };
