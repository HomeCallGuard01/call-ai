// Customer allowance top-ups through the REAL Express routes (2026-10-03):
// Stripe webhook (genuine signature verification with a test secret) and
// RevenueCat webhook (Authorization check), with only the database layer
// replaced by an in-memory, idempotent fake. Proves: no credit before
// payment, duplicate/replayed webhooks credit once, forged/unsigned events
// credit nothing, sandbox/test-mode never credits in production, refunds
// reverse, and the customer routes accept no allowance figures.
// No network, no Supabase. Run with: node tests/customer-allowance-webhooks.test.mjs

import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test',
  STRIPE_SECRET_KEY: 'sk_test_allowance_fake', STRIPE_WEBHOOK_SECRET: 'whsec_allowance_test_secret',
  REVENUECAT_WEBHOOK_AUTHORIZATION: 'Bearer rc-test-secret',
  ALLOWANCE_TOPUPS_ENABLED: 'true',
  ALLOWANCE_TOPUP_PRODUCTS: JSON.stringify([{ code: 'topup_small', minutes: 30, priceGbpInclVat: 2.99, stripePriceId: 'price_t30', appleProductId: 'hcg.topup.30' }]),
  Resend_API_Key: '',
});
delete process.env.APP_ENV;
delete process.env.ALLOWANCE_ALLOW_SANDBOX_CREDITS;

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// --- In-memory replacements for the database modules ----------------------
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const credits = new Map();
const HOUSEHOLD = { id: '11111111-1111-1111-1111-111111111111', auth_user_id: 'auth-user-1', email: 'c@example.com', stripe_customer_id: 'cus_1' };
const ENT = { status: 'active', entitlement_type: 'paid_subscription', source: 'stripe', starts_at: '2026-09-12T09:00:00Z', ends_at: null, plan_code: 'standard' };
const realBilling = require('../database/billing.js');
stub('../database/billing.js', {
  ...realBilling,
  getActiveEntitlement: async () => ENT,
  getSubscriptionByHouseholdId: async () => ({ status: 'active', cancel_at_period_end: false, current_period_end: new Date(Date.now() + 10 * 86400000).toISOString() }),
  getHouseholdByStripeCustomerId: async () => HOUSEHOLD,
  claimWebhookEvent: async () => { throw new Error('subscription path must not run for top-up events'); },
});
const realHouseholds = require('../database/households.js');
stub('../database/households.js', { ...realHouseholds, getHouseholdByAuthUserId: async (id) => (id === HOUSEHOLD.auth_user_id ? HOUSEHOLD : null) });
const realCa = require('../database/customerAllowance.js');
stub('../database/customerAllowance.js', {
  ...realCa,
  creditAllowance: async (a) => {
    const k = `${a.source}|${a.transactionId}|${a.kind}`;
    if (credits.has(k)) return { credited: false, duplicate: true, sameHousehold: credits.get(k).householdId === a.householdId };
    if (a.environment !== 'production' && !a.allowNonProduction) return { credited: false, reason: 'non_production_purchase' };
    if (a.kind === 'topup_reversal' && !credits.has(`${a.source}|${a.transactionId}|topup`)) return { credited: false, reason: 'original_not_found' };
    credits.set(k, a);
    return { credited: true, appliedSeconds: a.seconds };
  },
  findTopUpCredit: async ({ source, transactionId }) => {
    const c = credits.get(`${source}|${transactionId}|topup`);
    return c ? { household_id: c.householdId, period_start: c.periodStart, period_end: c.periodEnd, product_code: c.productCode } : null;
  },
  setActiveEntitlementPlanCode: async () => false,
});

const express = require('express');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(require('../routes/billing.js'));
app.use(require('../routes/mobileApi.js'));
app.use(require('../routes/allowance.js'));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};
const stripeEvent = (id, type, object, livemode = true) => ({ id, object: 'event', type, livemode, created: Math.floor(Date.now() / 1000), data: { object } });
const signedStripe = (event) => {
  const payload = JSON.stringify(event);
  return post('/billing/webhook', payload, { 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET }) });
};
const session = (o = {}) => ({ id: 'cs_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_live_1', amount_total: 299, currency: 'gbp', client_reference_id: HOUSEHOLD.id,
  metadata: { hcg_purpose: 'allowance_topup', household_id: HOUSEHOLD.id, product_code: 'topup_small', topup_minutes: '30', topup_budget_gbp: '0.5637' }, ...o });

try {
  // Stripe
  const unsigned = await post('/billing/webhook', stripeEvent('evt_forged', 'checkout.session.completed', session({ payment_intent: 'pi_forged' })), { 'stripe-signature': 't=1,v1=deadbeef' });
  check(unsigned.status === 400 && !credits.has('stripe|pi_forged|topup'), 'Stripe: a forged/unsigned top-up event is rejected and credits nothing');

  const pending = await signedStripe(stripeEvent('evt_p', 'checkout.session.completed', session({ payment_status: 'unpaid', payment_intent: 'pi_delayed' })));
  check(pending.status === 200 && !credits.has('stripe|pi_delayed|topup'), 'Stripe: checkout completed but unpaid (delayed method) → 200, no credit yet');
  const asyncOk = await signedStripe(stripeEvent('evt_a', 'checkout.session.async_payment_succeeded', session({ payment_intent: 'pi_delayed' })));
  check(asyncOk.status === 200 && credits.get('stripe|pi_delayed|topup')?.seconds === 1800, 'Stripe: async_payment_succeeded → credited 30 min');
  const asyncFail = await signedStripe(stripeEvent('evt_f', 'checkout.session.async_payment_failed', session({ payment_intent: 'pi_failed' })));
  check(asyncFail.status === 200 && !credits.has('stripe|pi_failed|topup'), 'Stripe: failed top-up payment → no credit');

  const first = await signedStripe(stripeEvent('evt_1', 'checkout.session.completed', session()));
  const replay = await signedStripe(stripeEvent('evt_1', 'checkout.session.completed', session()));
  const redelivered = await signedStripe(stripeEvent('evt_1b', 'checkout.session.completed', session()));
  check(first.status === 200 && replay.status === 200 && redelivered.status === 200 && [...credits.keys()].filter((k) => k === 'stripe|pi_live_1|topup').length === 1, 'Stripe: paid top-up credits once; replayed and re-delivered events credit nothing more');
  check(credits.get('stripe|pi_live_1|topup').householdId === HOUSEHOLD.id && credits.get('stripe|pi_live_1|topup').environment === 'production', 'Stripe: credited to the household HCG stamped on the session, as production');

  const testMode = await signedStripe(stripeEvent('evt_t', 'checkout.session.completed', session({ payment_intent: 'pi_testmode' }), false));
  check(testMode.status === 200 && !credits.has('stripe|pi_testmode|topup'), 'Stripe: a test-mode (livemode false) payment never credits in production');

  const refund = await signedStripe(stripeEvent('evt_r', 'charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: 'pi_live_1', amount: 299, amount_refunded: 299, refunded: true }));
  check(refund.status === 200 && credits.has('stripe|pi_live_1|topup_reversal'), 'Stripe: a full refund reverses the top-up');
  const otherRefund = await signedStripe(stripeEvent('evt_r2', 'charge.refunded', { id: 'ch_2', object: 'charge', payment_intent: 'pi_subscription', amount: 599, amount_refunded: 599, refunded: true }));
  check(otherRefund.status === 200 && !credits.has('stripe|pi_subscription|topup_reversal'), 'Stripe: refunding a subscription invoice touches no allowance');

  // RevenueCat
  const rc = (o = {}) => ({ event: { id: 'rc_1', type: 'NON_RENEWING_PURCHASE', app_user_id: HOUSEHOLD.auth_user_id, store: 'APP_STORE', environment: 'PRODUCTION', product_id: 'hcg.topup.30', transaction_id: '2000000001', price_in_purchased_currency: 2.99, currency: 'GBP', ...o } });
  const rcNoAuth = await post('/api/v1/billing/apple/revenuecat-webhook', rc({ transaction_id: 'rc_forged' }));
  check(rcNoAuth.status === 401 && !credits.has('apple|rc_forged|topup'), 'RevenueCat: a request without the webhook secret credits nothing');
  const auth = { authorization: 'Bearer rc-test-secret' };
  // Constant-time comparison (cross-review F-4): a WRONG secret, including one
  // sharing a long prefix with the real one, is refused. (Trailing whitespace
  // is not tested: HTTP strips it from header values, so it IS the secret.)
  let wi = 0;
  for (const wrong of ['Bearer rc-test-secreX', 'Bearer rc-test-secret-and-more', 'Bearer rc', 'rc-test-secret', 'x']) {
    const txn = `rc_wrong_${wi++}`;
    const r = await post('/api/v1/billing/apple/revenuecat-webhook', rc({ id: `rcw_${wi}`, transaction_id: txn }), { authorization: wrong });
    check(r.status === 401 && !credits.has(`apple|${txn}|topup`), `RevenueCat: a wrong secret (${JSON.stringify(wrong)}) is refused and credits nothing (status ${r.status})`);
  }
  const rc1 = await post('/api/v1/billing/apple/revenuecat-webhook', rc(), auth);
  const rc2 = await post('/api/v1/billing/apple/revenuecat-webhook', rc({ id: 'rc_1_retry' }), auth);
  check(rc1.status === 200 && JSON.parse(rc1.text).topUp === 'credited' && JSON.parse(rc2.text).topUp === 'duplicate', 'RevenueCat: Apple consumable credits once; a retry is a duplicate');
  const sandbox = await post('/api/v1/billing/apple/revenuecat-webhook', rc({ id: 'rc_s', environment: 'SANDBOX', transaction_id: 'sbx_1' }), auth);
  check(JSON.parse(sandbox.text).topUp === 'rejected' && JSON.parse(sandbox.text).reason === 'non_production_purchase' && !credits.has('apple|sbx_1|topup'), 'RevenueCat: a SANDBOX (TestFlight) purchase never credits in production');
  const unmatched = await post('/api/v1/billing/apple/revenuecat-webhook', rc({ id: 'rc_u', app_user_id: 'someone-else', transaction_id: 'orphan_1' }), auth);
  check(unmatched.status === 200 && JSON.parse(unmatched.text).topUp === 'rejected' && !credits.has('apple|orphan_1|topup'), 'RevenueCat: a paid top-up with no matching household is refused (and alerted), never guessed');
  const rcRefund = await post('/api/v1/billing/apple/revenuecat-webhook', rc({ id: 'rc_c', type: 'CANCELLATION' }), auth);
  check(JSON.parse(rcRefund.text).topUp === 'reversed', 'RevenueCat: a refunded consumable reverses its credit');
  const sub = await post('/api/v1/billing/apple/revenuecat-webhook', rc({ id: 'rc_sub', type: 'CANCELLATION', product_id: 'hcg.monthly' }), auth);
  check(JSON.parse(sub.text).action === 'acknowledged_no_change', 'RevenueCat: subscription events still take the existing path unchanged');

  // Customer routes cannot credit anything without a verified session.
  const creditCountBefore = credits.size;
  const forgedCheckout = await fetch(base + '/billing/topup-checkout', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'product=topup_small&minutes=99999' });
  check(forgedCheckout.status >= 300 && forgedCheckout.status < 500 && forgedCheckout.status !== 303 && credits.size === creditCountBefore, 'web top-up checkout without a session is refused (redirect/401), no credit path exists');
  const forgedRead = await fetch(base + '/api/v1/me/allowance');
  check(forgedRead.status === 401, 'mobile allowance read requires a verified bearer token');
  const forgedAdmin = await post('/admin/api/households/' + HOUSEHOLD.id + '/allowance-adjustment', { minutes: 999, reason: 'self-service', idempotencyKey: 'aaaaaaaa-1' });
  check(forgedAdmin.status >= 300 && forgedAdmin.status !== 200 && !credits.has('admin|admin:aaaaaaaa-1|admin_adjustment'), 'admin adjustment route refuses an unauthenticated request');
} finally {
  server.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
