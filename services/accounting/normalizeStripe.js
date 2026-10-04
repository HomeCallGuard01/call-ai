// Stripe webhook event → accounting facts (pure; no I/O).
//
// ONE event type is the source of each piece of money, so the same payment
// can never be counted twice from two Stripe events:
//
//   subscription sale  ← invoice.paid                (key stripe:sale:invoice:<in_…>)
//   top-up sale        ← checkout.session.completed (payment_status=paid) /
//                        checkout.session.async_payment_succeeded
//                                                    (key stripe:sale:pi:<pi_…>)
//   refund             ← charge.refunded, one fact per refund object
//                                                    (key stripe:refund:<re_…>)
//   chargeback         ← charge.dispute.funds_withdrawn  (key stripe:chargeback:<dp_…>)
//   chargeback won     ← charge.dispute.funds_reinstated (key stripe:chargeback_reversal:<dp_…>)
//
// charge.succeeded / payment_intent.succeeded / invoice.payment_succeeded are
// deliberately NON-economic here: they describe money already represented by
// invoice.paid or the Checkout Session. Cancellations, payment failures and
// subscription status changes are non-economic too (entitlement is decided by
// the existing canonical webhook path, never by accounting).
//
// A subscription Checkout Session (mode=subscription) is non-economic: its
// first payment arrives as invoice.paid. Only mode=payment sessions (top-ups)
// are sales.

'use strict';

const { CHANNELS, KINDS, SOURCES } = require('./constants');
const { normaliseCurrency } = require('./money');

const NON_ECONOMIC = Object.freeze({
  'invoice.payment_failed': 'payment_failed',
  'invoice.payment_action_required': 'payment_action_required',
  'invoice.payment_succeeded': 'represented_by_invoice_paid',
  'invoice.finalized': 'invoice_lifecycle',
  'invoice.created': 'invoice_lifecycle',
  'invoice.upcoming': 'invoice_lifecycle',
  'invoice.voided': 'invoice_lifecycle',
  'charge.succeeded': 'represented_by_invoice_or_session',
  'charge.failed': 'payment_failed',
  'payment_intent.succeeded': 'represented_by_invoice_or_session',
  'payment_intent.payment_failed': 'payment_failed',
  'customer.subscription.created': 'subscription_lifecycle',
  'customer.subscription.updated': 'subscription_lifecycle',
  'customer.subscription.deleted': 'cancellation',
  'customer.subscription.paused': 'subscription_lifecycle',
  'customer.subscription.resumed': 'subscription_lifecycle',
  'customer.subscription.trial_will_end': 'subscription_lifecycle',
  'charge.dispute.created': 'dispute_opened_no_funds_moved',
  'charge.dispute.updated': 'dispute_lifecycle',
  'charge.dispute.closed': 'dispute_closed_funds_handled_by_funds_events',
  'checkout.session.async_payment_failed': 'payment_failed',
  'checkout.session.expired': 'checkout_abandoned',
});

const idOf = (v) => (v && typeof v === 'object' ? v.id : v) || null;
const iso = (unixSeconds) => (Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null);

function environmentOf(event) {
  // Only an explicit livemode:true is production. Missing/false is sandbox —
  // the subscription webhook path ignores livemode today; accounting does not.
  return event && event.livemode === true ? 'production' : 'sandbox';
}

// Tax actually charged, as Stripe reports it (invoice.tax, older API;
// total_tax_amounts / total_taxes, newer API; total_details.amount_tax on a
// Checkout Session). null = Stripe reported none, which is NOT zero.
function sumTax(obj) {
  const sum = (list) => list.reduce((s, t) => s + (Number.isSafeInteger(t.amount) ? t.amount : 0), 0);
  if (Number.isSafeInteger(obj.tax)) return obj.tax;
  if (Array.isArray(obj.total_tax_amounts)) return sum(obj.total_tax_amounts);
  if (Array.isArray(obj.total_taxes)) return sum(obj.total_taxes);
  if (obj.total_details && Number.isSafeInteger(obj.total_details.amount_tax)) return obj.total_details.amount_tax;
  return null;
}

function householdHintOf(obj) {
  const md = (obj && obj.metadata) || {};
  const sub = (obj && obj.subscription_details && obj.subscription_details.metadata) || {};
  const parent = (obj && obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.metadata) || {};
  return md.household_id || sub.household_id || parent.household_id || (obj && obj.client_reference_id) || null;
}

function base(event) {
  return {
    source: SOURCES.STRIPE_WEBHOOK,
    sourceEventId: event.id,
    eventType: event.type,
    environment: environmentOf(event),
    occurredAt: iso(event.created),
  };
}

function normalizeStripeEvent(event) {
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
    throw new Error('not a Stripe event');
  }
  const out = { ...base(event), facts: [], nonEconomicReason: null };
  const obj = (event.data && event.data.object) || {};

  if (event.type === 'invoice.paid') {
    const gross = Number.isSafeInteger(obj.amount_paid) ? obj.amount_paid : null;
    if (!gross) { out.nonEconomicReason = 'zero_amount_invoice'; return out; }
    const line = obj.lines && Array.isArray(obj.lines.data) ? obj.lines.data[0] : null;
    out.facts.push({
      channel: CHANNELS.STRIPE,
      kind: KINDS.SALE,
      economicKey: `stripe:sale:invoice:${obj.id}`,
      providerTransactionId: obj.id,
      providerRefs: {
        invoice: obj.id,
        charge: idOf(obj.charge),
        payment_intent: idOf(obj.payment_intent),
        subscription: idOf(obj.subscription) || (obj.parent && obj.parent.subscription_details && idOf(obj.parent.subscription_details.subscription)) || null,
        customer: idOf(obj.customer),
      },
      product: 'subscription',
      billingReason: obj.billing_reason || null,
      grossMinor: gross,
      taxMinor: sumTax(obj),
      currency: normaliseCurrency(obj.currency),
      customerCountry: (obj.customer_address && obj.customer_address.country) || null,
      occurredAt: iso((obj.status_transitions && obj.status_transitions.paid_at) || event.created),
      servicePeriodStart: line && line.period ? iso(line.period.start) : iso(obj.period_start),
      servicePeriodEnd: line && line.period ? iso(line.period.end) : iso(obj.period_end),
      householdHint: householdHintOf(obj),
      stripeCustomerId: idOf(obj.customer),
    });
    return out;
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (obj.mode !== 'payment') { out.nonEconomicReason = 'subscription_checkout_paid_via_invoice'; return out; }
    if (obj.payment_status !== 'paid') { out.nonEconomicReason = 'payment_pending'; return out; }
    const gross = Number.isSafeInteger(obj.amount_total) ? obj.amount_total : null;
    if (!gross) { out.nonEconomicReason = 'zero_amount_session'; return out; }
    const pi = idOf(obj.payment_intent);
    out.facts.push({
      channel: CHANNELS.STRIPE,
      kind: KINDS.SALE,
      economicKey: pi ? `stripe:sale:pi:${pi}` : `stripe:sale:session:${obj.id}`,
      providerTransactionId: pi || obj.id,
      providerRefs: { checkout_session: obj.id, payment_intent: pi, customer: idOf(obj.customer) },
      product: (obj.metadata && obj.metadata.hcg_purpose) || 'one_off',
      productCode: (obj.metadata && obj.metadata.product_code) || null,
      grossMinor: gross,
      taxMinor: sumTax(obj),
      currency: normaliseCurrency(obj.currency),
      customerCountry: (obj.customer_details && obj.customer_details.address && obj.customer_details.address.country) || null,
      occurredAt: iso(event.created),
      householdHint: householdHintOf(obj),
      stripeCustomerId: idOf(obj.customer),
    });
    return out;
  }

  if (event.type === 'charge.refunded' || event.type === 'charge.refund.updated' || event.type === 'refund.created' || event.type === 'refund.updated') {
    // Normalise both shapes: a Charge carrying refunds.data, or a bare Refund.
    const isRefundObject = obj.object === 'refund';
    const charge = isRefundObject ? { id: idOf(obj.charge), payment_intent: idOf(obj.payment_intent), currency: obj.currency, metadata: obj.metadata } : obj;
    const refunds = isRefundObject ? [obj] : ((obj.refunds && Array.isArray(obj.refunds.data)) ? obj.refunds.data : []);
    for (const r of refunds) {
      if (r.status && r.status !== 'succeeded') continue; // pending/failed/canceled refunds move no money yet
      out.facts.push({
        channel: CHANNELS.STRIPE,
        kind: KINDS.REFUND,
        economicKey: `stripe:refund:${r.id}`,
        providerTransactionId: r.id,
        providerRefs: { refund: r.id, charge: charge.id, payment_intent: idOf(charge.payment_intent), invoice: idOf(charge.invoice), customer: idOf(charge.customer) },
        originalRefs: { charge: charge.id, payment_intent: idOf(charge.payment_intent), invoice: idOf(charge.invoice) },
        grossMinor: r.amount,
        taxMinor: null, // Stripe does not split refund VAT on the refund object; derived from the original pro rata
        currency: normaliseCurrency(r.currency || charge.currency),
        occurredAt: iso(r.created || event.created),
        householdHint: householdHintOf(charge),
        stripeCustomerId: idOf(charge.customer),
      });
    }
    if (!out.facts.length) out.nonEconomicReason = 'no_succeeded_refund';
    return out;
  }

  if (event.type === 'charge.dispute.funds_withdrawn' || event.type === 'charge.dispute.funds_reinstated') {
    const withdrawn = event.type === 'charge.dispute.funds_withdrawn';
    const bts = Array.isArray(obj.balance_transactions) ? obj.balance_transactions : [];
    const matching = bts.filter((bt) => (withdrawn ? bt.amount < 0 : bt.amount > 0) && bt.reporting_category !== 'dispute_fee');
    const amount = Number.isSafeInteger(obj.amount) ? obj.amount : null;
    const disputeFee = bts.reduce((s, bt) => s + (Number.isSafeInteger(bt.fee) ? bt.fee : 0), 0) || null;
    out.facts.push({
      channel: CHANNELS.STRIPE,
      kind: withdrawn ? KINDS.CHARGEBACK : KINDS.CHARGEBACK_REVERSAL,
      economicKey: `stripe:${withdrawn ? 'chargeback' : 'chargeback_reversal'}:${obj.id}`,
      providerTransactionId: obj.id,
      providerRefs: { dispute: obj.id, charge: idOf(obj.charge), payment_intent: idOf(obj.payment_intent), balance_transactions: matching.map((b) => b.id) },
      originalRefs: { charge: idOf(obj.charge), payment_intent: idOf(obj.payment_intent) },
      grossMinor: amount,
      taxMinor: null,
      feeMinor: disputeFee,
      currency: normaliseCurrency(obj.currency),
      disputeReason: obj.reason || null,
      occurredAt: iso(event.created),
      householdHint: null,
      stripeCustomerId: null,
    });
    return out;
  }

  out.nonEconomicReason = NON_ECONOMIC[event.type] || 'unhandled_event_type';
  return out;
}

module.exports = { normalizeStripeEvent, environmentOf, NON_ECONOMIC_STRIPE_EVENTS: NON_ECONOMIC };
