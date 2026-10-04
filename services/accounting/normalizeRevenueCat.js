// RevenueCat webhook event → accounting facts (pure; no I/O).
//
// RevenueCat is an EVENT FEED, not a payment channel. It reports money that
// Apple (APP_STORE), Google (PLAY_STORE) or Stripe (STRIPE) collected. So:
//
//   store=STRIPE       → superseded_by_primary. The Stripe webhook is the
//                        authoritative source of that money; recording it
//                        again here would double-count revenue.
//   store=PROMOTIONAL  → complimentary. RevenueCat-granted access, no money.
//   environment≠PRODUCTION (SANDBOX, missing) → sandbox, never revenue
//                        (same rule as services/revenuecatWebhook.js).
//
// For App Store / Play Store money the economic key is the STORE transaction
// id, never the RevenueCat event id:
//   sale    app_store:sale:<transaction_id>
//   refund  app_store:refund:<transaction_id>
// so a RevenueCat redelivery, a replay with a new event id, or a future direct
// App Store Server Notification for the same transaction all land on the same
// accounting transaction.
//
// Amounts from RevenueCat are ESTIMATES (tax_percentage/commission_percentage
// are RevenueCat's estimates). The store's financial report is the settlement
// truth; store transactions are kept as a sub-ledger and posted to Xero only
// as reconciled settlement summaries.

'use strict';

const { CHANNELS, KINDS, SOURCES } = require('./constants');
const { toMinor, normaliseCurrency } = require('./money');

const STORE_CHANNEL = Object.freeze({ APP_STORE: CHANNELS.APP_STORE, MAC_APP_STORE: CHANNELS.APP_STORE, PLAY_STORE: CHANNELS.PLAY_STORE });

const SALE_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE']);
const NON_ECONOMIC = Object.freeze({
  CANCELLATION: 'cancellation',
  UNCANCELLATION: 'uncancellation',
  EXPIRATION: 'expiration',
  BILLING_ISSUE: 'payment_failed',
  PRODUCT_CHANGE: 'product_change_no_charge', // the charge, if any, arrives as its own RENEWAL/INITIAL_PURCHASE
  TRANSFER: 'transfer',
  SUBSCRIPTION_PAUSED: 'subscription_lifecycle',
  SUBSCRIPTION_EXTENDED: 'subscription_lifecycle',
  TEMPORARY_ENTITLEMENT_GRANT: 'subscription_lifecycle',
  INVOICE_ISSUANCE: 'subscription_lifecycle',
  TEST: 'test_event',
});

const iso = (ms) => (Number.isFinite(Number(ms)) && ms !== null ? new Date(Number(ms)).toISOString() : null);
const pct = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function isProduction(event) {
  return typeof event.environment === 'string' && event.environment.toUpperCase() === 'PRODUCTION';
}

// A refund is reported by RevenueCat as CANCELLATION with
// cancel_reason=CUSTOMER_SUPPORT (Apple/Google refunded the customer).
function isRefund(event) {
  return event.type === 'CANCELLATION' && String(event.cancel_reason || '').toUpperCase() === 'CUSTOMER_SUPPORT';
}

function estimateAmounts(event) {
  const priceMinor = toMinor(event.price_in_purchased_currency, { label: 'price_in_purchased_currency' });
  if (priceMinor === null) return { grossMinor: null, taxMinor: null, feeMinor: null, proceedsMinor: null };
  const gross = Math.abs(priceMinor);
  const taxPct = pct(event.tax_percentage);
  const commissionPct = pct(event.commission_percentage);
  const taxMinor = taxPct === null ? null : Math.round(gross * taxPct);
  const feeMinor = commissionPct === null ? null : Math.round(gross * commissionPct);
  const proceedsMinor = taxMinor === null || feeMinor === null ? null : gross - taxMinor - feeMinor;
  return { grossMinor: gross, taxMinor, feeMinor, proceedsMinor };
}

function normalizeRevenueCatEvent(body) {
  const event = body && body.event ? body.event : body;
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
    throw new Error('not a RevenueCat event');
  }
  const out = {
    source: SOURCES.REVENUECAT_WEBHOOK,
    sourceEventId: event.id,
    eventType: event.type,
    environment: isProduction(event) ? 'production' : 'sandbox',
    occurredAt: iso(event.event_timestamp_ms || event.purchased_at_ms),
    store: event.store || null,
    facts: [],
    nonEconomicReason: null,
    supersededBy: null,
    complimentary: false,
  };

  if (event.type === 'TEST') { out.nonEconomicReason = 'test_event'; return out; }
  if (String(event.store || '').toUpperCase() === 'STRIPE') { out.supersededBy = 'stripe_webhook'; return out; }
  if (String(event.store || '').toUpperCase() === 'PROMOTIONAL') { out.complimentary = true; return out; }

  const channel = STORE_CHANNEL[String(event.store || '').toUpperCase()] || null;
  const refund = isRefund(event);
  if (!SALE_TYPES.has(event.type) && !refund) {
    out.nonEconomicReason = NON_ECONOMIC[event.type] || 'unhandled_event_type';
    return out;
  }
  if (!channel) { out.nonEconomicReason = `unsupported_store:${event.store || 'missing'}`; return out; }

  const amounts = estimateAmounts(event);
  if (!refund && (amounts.grossMinor === 0 || String(event.period_type || '').toUpperCase() === 'TRIAL')) {
    out.nonEconomicReason = 'free_trial_or_zero_price';
    return out;
  }
  const txId = event.transaction_id || null;
  if (!txId) { out.nonEconomicReason = 'missing_store_transaction_id'; return out; }
  out.facts.push({
    channel,
    kind: refund ? KINDS.REFUND : KINDS.SALE,
    economicKey: `${channel}:${refund ? 'refund' : 'sale'}:${txId}`,
    providerTransactionId: txId,
    providerRefs: { transaction: txId, original_transaction: event.original_transaction_id || null, product: event.product_id || null, revenuecat_app_user_id: event.app_user_id || null },
    originalRefs: refund ? { transaction: txId } : null,
    product: event.type === 'NON_RENEWING_PURCHASE' ? 'one_off' : 'subscription',
    productCode: event.product_id || null,
    grossMinor: amounts.grossMinor,
    taxMinor: amounts.taxMinor,
    feeMinor: amounts.feeMinor,
    proceedsMinor: amounts.proceedsMinor,
    amountQuality: 'estimated',
    currency: normaliseCurrency(event.currency),
    customerCountry: event.country_code || null,
    occurredAt: iso(event.purchased_at_ms || event.event_timestamp_ms),
    servicePeriodStart: iso(event.purchased_at_ms),
    servicePeriodEnd: iso(event.expiration_at_ms),
    householdHint: null,
    authUserId: event.app_user_id || null,
  });
  return out;
}

module.exports = { normalizeRevenueCatEvent, isRefund: (e) => isRefund(e), estimateAmounts };
