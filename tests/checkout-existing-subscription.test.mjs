// Unit tests for hasQualifyingStripeSubscription() in routes/billing.js —
// the pre-Checkout-Session-creation guard added after the 2026-07-18
// duplicate-subscription incident (see docs/releases/2026-07-18_RC1.md).
//
// Pure function, no Stripe API calls or network access involved. Loading
// routes/billing.js does require real-looking env vars to exist (its
// transitive requires construct the Supabase and Stripe SDK clients at
// module load time), so this loads the real .env the same way server.js
// does — no live calls are made against either service by this test.
//
// Run with: node tests/checkout-existing-subscription.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const {
  hasQualifyingStripeSubscription,
  findReusableOpenCheckoutSession,
  isSessionPaidWithSubscription,
  buildCheckoutSessionParams,
} = require('../routes/billing.js');

// The mobile/Android checkout route (routes/mobileApi.js) shares this
// separate, genuinely different implementation — see services/
// checkoutSession.js's own header for why two exist. Both need the
// same automatic_tax fix (2026-09-20), so both are checked here.
const { buildCheckoutSessionParams: buildMobileCheckoutSessionParams } = require('../services/checkoutSession.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

check(
  hasQualifyingStripeSubscription([{ status: 'active' }]) === true,
  'an active subscription prevents a new Checkout Session (treated as qualifying)'
);

check(
  hasQualifyingStripeSubscription([{ status: 'trialing' }]) === true,
  'a trialing subscription prevents a new Checkout Session (treated as qualifying)'
);

check(
  hasQualifyingStripeSubscription([]) === false,
  'no subscriptions at all allows a new Checkout Session'
);

check(
  hasQualifyingStripeSubscription([{ status: 'canceled' }]) === false,
  'only a canceled subscription allows a new Checkout Session'
);

check(
  hasQualifyingStripeSubscription([{ status: 'past_due' }]) === true,
  'a past_due subscription prevents a new Checkout Session (still a live billing relationship — see comment in routes/billing.js)'
);

check(
  hasQualifyingStripeSubscription([{ status: 'unpaid' }]) === false,
  'unpaid is deliberately not treated as qualifying by this check'
);

check(
  hasQualifyingStripeSubscription([{ status: 'canceled' }, { status: 'active' }]) === true,
  'a qualifying subscription is detected even alongside a non-qualifying one (e.g. an old canceled duplicate)'
);

// findReusableOpenCheckoutSession() — closes the abandoned/still-open
// checkout gap (docs/PROJECT_STATUS.md, "duplicate Checkout Session
// concurrency investigation"). The subscription checks above are left
// completely untouched by this addition — same assertions, same function,
// still passing — proving those existing checks remain unchanged.

const usableOpenSession = { id: 'cs_test_open_usable', status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_test_open_usable' };

check(
  findReusableOpenCheckoutSession([usableOpenSession]) === usableOpenSession,
  'an existing usable open Checkout Session is reused (returned as-is for the route to redirect to its url)'
);

check(
  findReusableOpenCheckoutSession([]) === null,
  'no open Checkout Session at all allows a new one to be created'
);

check(
  findReusableOpenCheckoutSession([{ id: 'cs_test_complete', status: 'complete' }]) === null,
  'a completed session does not block a new Checkout Session'
);

check(
  findReusableOpenCheckoutSession([{ id: 'cs_test_expired', status: 'expired' }]) === null,
  'an expired session does not block a new Checkout Session'
);

check(
  findReusableOpenCheckoutSession([
    { id: 'cs_test_complete', status: 'complete' },
    { id: 'cs_test_expired', status: 'expired' },
    usableOpenSession,
  ]) === usableOpenSession,
  'an open session is found even alongside completed/expired ones'
);

// isSessionPaidWithSubscription() and buildCheckoutSessionParams() — added
// for the payment-completion-flow rebuild (docs/PROJECT_STATUS.md). Root
// cause of that incident: no Stripe webhook endpoint was ever registered
// against production, so the dashboard never learned a payment had
// completed. isSessionPaidWithSubscription() backs the bounded
// reconciliation fallback (GET /billing/reconcile-session) that no longer
// depends on the webhook arriving at all.

check(
  isSessionPaidWithSubscription({ payment_status: 'paid', subscription: 'sub_123' }) === true,
  'a paid session with a subscription attached is treated as a completed payment'
);

check(
  isSessionPaidWithSubscription({ payment_status: 'unpaid', subscription: 'sub_123' }) === false,
  'a session that is not yet paid is not treated as a completed payment'
);

check(
  isSessionPaidWithSubscription({ payment_status: 'paid', subscription: null }) === false,
  'a paid session with no subscription attached yet is not treated as a completed payment'
);

check(
  isSessionPaidWithSubscription(null) === false,
  'a missing session is handled without throwing'
);

const sessionParams = buildCheckoutSessionParams({
  customer: 'cus_test123',
  priceId: 'price_test456',
  householdId: 'household-789',
  appUrl: 'https://www.homecallguard.co.uk',
});

check(
  sessionParams.billing_address_collection === 'required',
  'every Checkout Session created collects a full billing address (postcode included)'
);

check(
  sessionParams.success_url === 'https://www.homecallguard.co.uk/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}',
  'success_url includes {CHECKOUT_SESSION_ID} so the app can reconcile a completed session if the webhook is delayed'
);

check(
  typeof sessionParams.custom_text?.submit?.message === 'string' &&
    sessionParams.custom_text.submit.message.includes('£4.99') &&
    sessionParams.custom_text.submit.message.toLowerCase().includes('every month') &&
    sessionParams.custom_text.submit.message.toLowerCase().includes('terms'),
  'the checkout submit message states £4.99/month, that it recurs, and references Terms and Conditions'
);

check(
  sessionParams.line_items[0].price === 'price_test456' && sessionParams.line_items[0].quantity === 1,
  'the session is created against the exact price ID passed in, not a hardcoded one'
);

// 2026-09-20 VAT fix — the live Stripe Price is now VAT-inclusive and
// Stripe Tax is enabled account-wide with AFMD Ltd's UK registration on
// file, but neither takes effect on a specific session without this.
// Real production investigation confirmed £4.99 was being charged with
// zero VAT calculated/recorded despite the registration existing, purely
// because this was missing.
check(
  sessionParams.automatic_tax?.enabled === true,
  'the web checkout session requests automatic tax calculation, so the VAT-inclusive Price actually gets its VAT itemised and recorded, not just charged as a flat amount'
);

// The mobile/Android checkout builder (services/checkoutSession.js) —
// same fix, separate implementation, must not silently drift from the
// web one.
const mobileSessionParams = buildMobileCheckoutSessionParams({
  customer: 'cus_test123',
  priceId: 'price_test456',
  householdId: 'household-789',
  successUrl: 'homecallguard://checkout-success',
  cancelUrl: 'homecallguard://checkout-cancel',
});

check(
  mobileSessionParams.automatic_tax?.enabled === true,
  'the mobile/Android checkout session also requests automatic tax calculation — both platforms share one STRIPE_PRICE_ID, so both must apply VAT the same way'
);
check(
  mobileSessionParams.billing_address_collection === 'required',
  'the mobile checkout session still collects a full billing address too — needed for automatic tax to determine the customer is UK'
);
check(
  mobileSessionParams.line_items[0].price === 'price_test456',
  'the mobile checkout session is still created against the exact price ID passed in, unaffected by the automatic_tax addition'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
