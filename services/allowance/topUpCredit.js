// topUpCredit.js — turns a VERIFIED provider payment event into at most one
// allowance credit (customer allowance workstream, 2026-10-03).
//
// Rules (all enforced here AND/OR in credit_allowance, migration 063):
//   * Credit only when the payment is authoritative:
//       Stripe   checkout.session.completed with payment_status 'paid', or
//                checkout.session.async_payment_succeeded (delayed methods).
//                'unpaid' completions and async_payment_failed credit nothing.
//       Store    RevenueCat NON_RENEWING_PURCHASE (consumable) for a
//                configured top-up product.
//   * The caller has already verified the event (Stripe signature /
//     RevenueCat Authorization). Nothing here trusts a client.
//   * Idempotent per (source, transaction id, kind) in the database:
//     webhook replays, retries and duplicate deliveries credit once.
//   * Non-production purchases (Stripe livemode=false, store SANDBOX or a
//     missing environment) never credit in production. They can credit on
//     staging only with APP_ENV=staging AND ALLOWANCE_ALLOW_SANDBOX_CREDITS=true.
//   * The credited quantity comes from HCG's own data — the minutes stamped
//     on the Stripe session by HCG's server when it was created, or the
//     catalogue for a store product — never from anything the customer sent.
//   * Refunds reverse the credit (clamped at 0; a top-up whose period has
//     already reset reverses nothing — its minutes already expired).
//   * Credited to the allowance period current when the payment is
//     CONFIRMED (a delayed payment confirmed after a reset lands in the new
//     period, which is the one the customer can still use).
'use strict';

const { findTopUpByProviderProduct, resolveEconomics, maxBudgetForPrice, MAX_TOPUP_BUDGET_GBP } = require('./productCatalog');
const { resolveEntitlementPeriod } = require('../usage/billingPeriod');

const TOPUP_PURPOSE = 'allowance_topup';
const MAX_TOPUP_MINUTES = 10000;

function allowNonProduction(env) {
  return env.APP_ENV === 'staging' && env.ALLOWANCE_ALLOW_SANDBOX_CREDITS === 'true';
}

/**
 * Classify a verified Stripe event. Returns null when the event is not
 * about an allowance top-up (the caller then handles it as before).
 */
function interpretStripeTopUpEvent(event) {
  if (!event || !event.data || !event.data.object) return null;
  const obj = event.data.object;
  const environment = event.livemode === true ? 'production' : 'sandbox';

  if (event.type === 'charge.refunded') {
    // Matched by PaymentIntent against allowance_credits (not by charge
    // metadata): a refund of anything that isn't a credited top-up finds
    // no original and changes nothing.
    if (!obj.payment_intent) return null;
    // Only a FULL refund reverses; partial refunds are a manual decision.
    const full = obj.refunded === true || (obj.amount_refunded >= obj.amount && obj.amount > 0);
    return { action: full ? 'reverse' : 'ignore', reason: full ? null : 'partial_refund', source: 'stripe', environment,
      transactionId: obj.payment_intent, eventId: event.id };
  }

  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) return null;
  const md = obj.metadata || {};
  if (obj.mode !== 'payment' || md.hcg_purpose !== TOPUP_PURPOSE) return null;

  const base = {
    source: 'stripe', environment, eventId: event.id,
    householdId: md.household_id || obj.client_reference_id || null,
    productCode: md.product_code || null,
    transactionId: obj.payment_intent || null,
    minutes: Number(md.topup_minutes),
    // Integration 2026-10-03: the £ capacity stamped server-side at checkout.
    budgetGbp: md.topup_budget_gbp !== undefined ? Number(md.topup_budget_gbp) : null,
    channel: 'stripe',
    amountMinor: Number.isInteger(obj.amount_total) ? obj.amount_total : null,
    currency: obj.currency || null,
  };
  if (event.type === 'checkout.session.async_payment_failed') return { ...base, action: 'ignore', reason: 'payment_failed' };
  if (event.type === 'checkout.session.completed' && obj.payment_status !== 'paid') {
    return { ...base, action: 'ignore', reason: 'payment_pending' };
  }
  return { ...base, action: 'credit' };
}

/** Classify a verified RevenueCat event. null = not a top-up event. */
function interpretRevenueCatTopUpEvent(event, env = process.env) {
  if (!event || !['NON_RENEWING_PURCHASE', 'CANCELLATION'].includes(event.type)) return null;
  const channel = event.store === 'PLAY_STORE' ? 'google' : event.store === 'APP_STORE' ? 'apple' : null;
  if (!channel) return null;
  const product = findTopUpByProviderProduct({ channel, providerProductId: event.product_id }, env);
  if (!product) return null;
  const environment = String(event.environment || '').toUpperCase() === 'PRODUCTION' ? 'production' : 'sandbox';
  const base = {
    source: channel, environment, eventId: event.id || null,
    productCode: product.code, minutes: product.minutes, budgetGbp: product.budgetGbp, channel,
    configuredPriceGbp: product.priceGbpInclVat,
    transactionId: event.transaction_id || null,
    amountMinor: Number.isFinite(event.price_in_purchased_currency) ? Math.round(event.price_in_purchased_currency * 100) : null,
    currency: event.currency || null,
  };
  if (event.type === 'CANCELLATION') {
    // For a consumable, CANCELLATION means the store refunded it.
    return { ...base, action: 'reverse' };
  }
  return { ...base, action: 'credit' };
}

/**
 * Apply an interpreted top-up event.
 * @param {object} deps { creditAllowance, findTopUpCredit, getActiveEntitlement, getSubscriptionByHouseholdId, alert? }
 * @returns {Promise<{outcome: string, ...}>}
 */
async function applyTopUpEvent(intent, { householdId = intent.householdId, deps, now = new Date(), env = process.env }) {
  const alert = deps.alert || (async () => {});
  if (!intent || intent.action === 'ignore') return { outcome: 'ignored', reason: intent ? intent.reason : null };
  if (!intent.transactionId) return { outcome: 'rejected', reason: 'missing_transaction_id' };
  const nonProdOk = allowNonProduction(env);
  if (intent.environment !== 'production' && !nonProdOk) {
    return { outcome: 'rejected', reason: 'non_production_purchase' };
  }

  if (intent.action === 'reverse') {
    const original = await deps.findTopUpCredit({ source: intent.source, transactionId: intent.transactionId });
    if (!original) return { outcome: 'ignored', reason: 'original_not_found' };
    const result = await deps.creditAllowance({
      householdId: original.household_id, periodStart: original.period_start, periodEnd: original.period_end,
      kind: 'topup_reversal', seconds: -1, source: intent.source, environment: intent.environment,
      transactionId: intent.transactionId, eventId: intent.eventId, productCode: original.product_code,
      amountMinor: intent.amountMinor, currency: intent.currency, actor: null, reason: 'provider_refund',
      allowNonProduction: nonProdOk,
    });
    return { outcome: result.credited ? 'reversed' : (result.duplicate ? 'duplicate' : 'ignored'), ...result };
  }

  if (!householdId) {
    await alert('ALLOWANCE TOP-UP UNMATCHED', { source: intent.source, transactionId: intent.transactionId });
    return { outcome: 'rejected', reason: 'no_household' };
  }
  if (!Number.isInteger(intent.minutes) || intent.minutes <= 0 || intent.minutes > MAX_TOPUP_MINUTES
      || !Number.isFinite(intent.budgetGbp) || intent.budgetGbp <= 0 || intent.budgetGbp > MAX_TOPUP_BUDGET_GBP) {
    await alert('ALLOWANCE TOP-UP INVALID QUANTITY', { source: intent.source, transactionId: intent.transactionId });
    return { outcome: 'rejected', reason: 'invalid_quantity' };
  }
  // Integration 2026-10-03 — margin guard at CREDIT time. The £ added to the
  // Fortress budget never exceeds what the price actually paid permits on
  // this channel (afterFees × (1 − margin) ÷ (1 + reserve)); the minute
  // equivalent never exceeds what that £ funds. A cap is alerted for a
  // manual decision (the customer paid), never silently over-credited.
  const economics = resolveEconomics(env);
  const paidGbp = intent.currency && String(intent.currency).toLowerCase() === 'gbp' && Number.isInteger(intent.amountMinor)
    ? intent.amountMinor / 100
    : (Number.isFinite(intent.configuredPriceGbp) ? intent.configuredPriceGbp : 0);
  const maxBudget = maxBudgetForPrice({ priceGbpInclVat: paidGbp, channel: intent.channel || intent.source }, economics);
  const budgetGbp = Math.floor(Math.min(intent.budgetGbp, maxBudget) * 1e4) / 1e4;
  const creditMinutes = Math.min(intent.minutes, Math.floor(budgetGbp / economics.costPerMinuteGbp));
  if (budgetGbp < intent.budgetGbp) {
    await alert('ALLOWANCE TOP-UP CAPPED BY MARGIN GUARD', { householdId, transactionId: intent.transactionId, requestedGbp: intent.budgetGbp, creditedGbp: budgetGbp });
  }
  if (!(budgetGbp > 0) || creditMinutes <= 0) {
    await alert('ALLOWANCE TOP-UP NOT CREDITABLE UNDER MARGIN GUARD', { householdId, transactionId: intent.transactionId, paidGbp });
    return { outcome: 'rejected', reason: 'margin_guard' };
  }

  // A paid top-up for a household with no current entitlement is still
  // recorded (the customer paid) against the fallback period, and alerted
  // for a manual refund decision — it is never silently dropped.
  const entitlement = await deps.getActiveEntitlement(householdId);
  const subscription = entitlement && entitlement.source === 'stripe' ? await deps.getSubscriptionByHouseholdId(householdId) : null;
  const period = resolveEntitlementPeriod({ entitlement, subscription, now });
  if (!entitlement) await alert('ALLOWANCE TOP-UP WITHOUT ENTITLEMENT', { householdId, transactionId: intent.transactionId });

  const result = await deps.creditAllowance({
    householdId, periodStart: period.periodStart, periodEnd: period.periodEnd,
    kind: 'topup', seconds: creditMinutes * 60, budgetGbp, source: intent.source, environment: intent.environment,
    transactionId: intent.transactionId, eventId: intent.eventId, productCode: intent.productCode,
    amountMinor: intent.amountMinor, currency: intent.currency, actor: null, reason: null,
    allowNonProduction: nonProdOk,
  });
  if (result.duplicate && result.sameHousehold === false) {
    await alert('ALLOWANCE TOP-UP TRANSACTION REUSED BY ANOTHER HOUSEHOLD', { householdId, transactionId: intent.transactionId });
  }
  return { outcome: result.credited ? 'credited' : (result.duplicate ? 'duplicate' : 'rejected'), ...result };
}

/**
 * Stripe Checkout params for a web top-up (mode 'payment'). HCG stamps the
 * household, product and minutes into metadata HERE, server-side; the
 * webhook credits exactly those minutes.
 */
function buildTopUpCheckoutParams({ householdId, stripeCustomerId, product, appUrl }) {
  const metadata = { hcg_purpose: TOPUP_PURPOSE, household_id: householdId, product_code: product.code, topup_minutes: String(product.minutes), topup_budget_gbp: String(product.budgetGbp) };
  return {
    mode: 'payment',
    customer: stripeCustomerId || undefined,
    client_reference_id: householdId,
    line_items: [{ price: product.channels.stripe.providerProductId, quantity: 1 }],
    automatic_tax: { enabled: true },
    ...(stripeCustomerId ? { customer_update: { address: 'auto' } } : {}),
    metadata,
    // Copied onto the PaymentIntent and its Charge so a refund event can be
    // matched back to the credit.
    payment_intent_data: { metadata },
    success_url: `${appUrl}/dashboard?topup=success`,
    cancel_url: `${appUrl}/dashboard?topup=cancelled`,
  };
}

module.exports = {
  TOPUP_PURPOSE,
  interpretStripeTopUpEvent,
  interpretRevenueCatTopUpEvent,
  applyTopUpEvent,
  buildTopUpCheckoutParams,
  allowNonProduction,
};
