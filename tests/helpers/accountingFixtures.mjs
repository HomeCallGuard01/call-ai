// Fixtures for the accounting automation tests. Shapes follow the Stripe and
// RevenueCat webhook payloads HCG receives (only the fields accounting reads).
// All ids are fake; nothing here is a real customer or transaction.

export const T = (iso) => Math.floor(Date.parse(iso) / 1000);
export const H1 = '11111111-1111-4111-8111-111111111111';
export const H2 = '22222222-2222-4222-8222-222222222222';
export const H3 = '33333333-3333-4333-8333-333333333333';
export const HNOACCT = '44444444-4444-4444-8444-444444444444';
export const AUTH1 = 'aaaaaaaa-1111-4111-8111-111111111111';
export const AUTH2 = 'aaaaaaaa-2222-4222-8222-222222222222';

// TEST VALUES ONLY — not accountant-approved codes (AD-7). They exist so the
// posting path can be exercised; production has no defaults.
export const TEST_ACCOUNT_CODES = {
  subscription_revenue: 'T200', topup_revenue: 'T201', stripe_clearing: 'T610', vat_output_tax_type: 'TEST_OUTPUT',
  chargebacks: 'T480', chargeback_tax_type: 'TEST_OUTPUT', stripe_fees: 'T404', stripe_fee_tax_type: 'TEST_EXEMPT',
  store_revenue: 'T202', store_commission: 'T405', store_tax_type: 'TEST_STORE', apple_contact_name: 'TEST Apple contact',
  google_contact_name: 'TEST Google contact',
};
export const ALL_DECISIONS = ['AD-1', 'AD-2', 'AD-3', 'AD-4', 'AD-5', 'AD-6', 'AD-7', 'AD-8', 'AD-9', 'AD-10', 'AD-11'];

export function invoicePaid({ eventId, invoice, amount = 499, tax = 83, livemode = true, household = H1, customer = 'cus_h1', charge, pi, sub = 'sub_h1', paidAt = '2026-10-01T10:00:00Z', periodStart = '2026-10-01T10:00:00Z', periodEnd = '2026-11-01T10:00:00Z', country = 'GB', taxShape = 'tax' }) {
  const obj = {
    id: invoice, object: 'invoice', amount_paid: amount, currency: 'gbp', customer, charge: charge || `ch_${invoice}`, payment_intent: pi || `pi_${invoice}`,
    subscription: sub, billing_reason: 'subscription_cycle', customer_address: country ? { country } : null,
    status_transitions: { paid_at: T(paidAt) }, subscription_details: { metadata: household ? { household_id: household } : {} },
    lines: { data: [{ period: { start: T(periodStart), end: T(periodEnd) } }] },
  };
  if (taxShape === 'tax') obj.tax = tax;
  if (taxShape === 'total_tax_amounts') obj.total_tax_amounts = tax === null ? [] : [{ amount: tax }];
  return { id: eventId, type: 'invoice.paid', livemode, created: T(paidAt), data: { object: obj } };
}

export function chargeRefunded({ eventId, invoice, refunds, livemode = true, customer = 'cus_h1', at = '2026-10-05T10:00:00Z' }) {
  return {
    id: eventId, type: 'charge.refunded', livemode, created: T(at),
    data: { object: { id: `ch_${invoice}`, object: 'charge', payment_intent: `pi_${invoice}`, invoice, customer, currency: 'gbp', metadata: {},
      refunds: { data: refunds.map((r) => ({ id: r.id, amount: r.amount, currency: 'gbp', status: r.status || 'succeeded', created: T(at) })) } } },
  };
}

export function dispute({ eventId, id, invoice, amount = 499, reinstated = false, at = '2026-10-10T10:00:00Z', livemode = true }) {
  return {
    id: eventId, type: reinstated ? 'charge.dispute.funds_reinstated' : 'charge.dispute.funds_withdrawn', livemode, created: T(at),
    data: { object: { id, object: 'dispute', amount, currency: 'gbp', charge: `ch_${invoice}`, payment_intent: `pi_${invoice}`, reason: 'fraudulent',
      balance_transactions: [{ id: `txn_${id}_${reinstated ? 'in' : 'out'}`, amount: reinstated ? amount : -amount, fee: reinstated ? 0 : 1500, reporting_category: 'dispute' }] } },
  };
}

export function stripeEvent(type, eventId, object = {}, { livemode = true, at = '2026-10-02T10:00:00Z' } = {}) {
  return { id: eventId, type, livemode, created: T(at), data: { object } };
}

export function topupSession({ eventId, session, pi, amount = 300, tax = 50, household = H1, mode = 'payment', paymentStatus = 'paid', livemode = true }) {
  return stripeEvent('checkout.session.completed', eventId, {
    id: session, object: 'checkout.session', mode, payment_status: paymentStatus, amount_total: amount, currency: 'gbp', payment_intent: pi,
    customer: 'cus_h1', client_reference_id: household, total_details: { amount_tax: tax },
    metadata: { hcg_purpose: 'allowance_topup', household_id: household, product_code: 'topup_60' },
    customer_details: { address: { country: 'GB' } },
  }, { livemode });
}

export function rc({ id, type = 'RENEWAL', store = 'APP_STORE', environment = 'PRODUCTION', transaction_id, original_transaction_id = 'otx_1', price = 4.99, currency = 'GBP',
  tax_percentage = 0.1667, commission_percentage = 0.125, app_user_id = AUTH1, cancel_reason, purchased = '2026-10-01T09:00:00Z', expires = '2026-11-01T09:00:00Z', period_type = 'NORMAL', product_id = 'co.uk.homecallguard.app.monthly' }) {
  return { api_version: '1.0', event: {
    id, type, store, environment, transaction_id, original_transaction_id, price_in_purchased_currency: price, currency, tax_percentage, commission_percentage,
    app_user_id, cancel_reason, purchased_at_ms: Date.parse(purchased), expiration_at_ms: Date.parse(expires), event_timestamp_ms: Date.parse(purchased),
    period_type, product_id, country_code: 'GB',
  } };
}

// Resolver over a mutable directory (tests change it to simulate backfills).
export function directoryResolver(dir) {
  return {
    async resolve(fact) {
      const byId = (id) => (dir.households[id] ? { householdId: id, accountNumber: dir.households[id].account || null } : null);
      if (fact.householdHint && byId(fact.householdHint)) return byId(fact.householdHint);
      if (fact.stripeCustomerId && dir.stripe[fact.stripeCustomerId]) return byId(dir.stripe[fact.stripeCustomerId]);
      if (fact.authUserId && dir.auth[fact.authUserId]) return byId(dir.auth[fact.authUserId]);
      return null;
    },
  };
}

export function defaultDirectory() {
  return {
    households: { [H1]: { account: 'HCG-00010017' }, [H2]: { account: 'HCG-00010025' }, [H3]: { account: 'HCG-00010033' }, [HNOACCT]: { account: null } },
    stripe: { cus_h1: H1, cus_h2: H2, cus_h3: H3, cus_noacct: HNOACCT },
    auth: { [AUTH1]: H1, [AUTH2]: H2 },
  };
}

export function policyWith({ confirmed = ALL_DECISIONS, codes = TEST_ACCOUNT_CODES } = {}) {
  return { confirmed: new Set(confirmed), accountCodes: { ...codes } };
}

export function fixedClock(iso = '2026-10-15T12:00:00Z') {
  let t = Date.parse(iso);
  const clock = () => new Date(t);
  clock.advance = (seconds) => { t += seconds * 1000; };
  clock.set = (s) => { t = Date.parse(s); };
  return clock;
}
