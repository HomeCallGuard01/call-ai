// Subscription price display (2026-09-30, iOS 1.0.2 preparation).
//
// Proves:
//   1. services/subscriptionPricing.js describes only a VAT-inclusive,
//      monthly GBP Stripe Price, and returns null (show no amount) otherwise;
//   2. each household's Membership label is its OWN price (a customer on an
//      earlier Stripe Price keeps seeing that price), Apple-billed and
//      non-charged memberships never get an amount;
//   3. the offer endpoint handler returns `available: false` instead of a
//      guessed figure when Stripe can't be read;
//   4. mobile/lib/subscriptionPrice.ts shows StoreKit's own price on iOS and
//      the server's Stripe price on Android, and fails closed;
//   5. no customer-facing app/server/web-checkout source contains a
//      hard-coded subscription amount;
//   6. the Subscribe screen buys exactly the StoreKit package whose price it
//      displayed, and can't start an iOS purchase before that price loads.
//
// Run with: node tests/subscription-price-display.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const pricing = require(path.join(root, 'services', 'subscriptionPricing.js'));
const {
  formatGbpMinor, describeStripePrice, createStripePriceLookup, getCurrentStripeOffer,
  buildOfferResponse, buildMembershipPriceLabel, resolveMembershipPriceLabel,
  createOfferHandler, MEMBERSHIP_LABELS, CHECKOUT_SUBMIT_MESSAGE,
} = pricing;

// Arbitrary test amounts: deliberately NOT any real or proposed HCG price.
const price = (over = {}) => ({
  id: 'price_test_a', currency: 'gbp', unit_amount: 1234, tax_behavior: 'inclusive',
  recurring: { interval: 'month', interval_count: 1 }, ...over,
});

// ---- 1. formatting + description ----
check(formatGbpMinor(1234) === '£12.34' && formatGbpMinor(5) === '£0.05' && formatGbpMinor(123456) === '£1,234.56', 'formatGbpMinor formats pence as £ with two decimals');
check([0, -1, 12.5, NaN, '1234', null].every((v) => formatGbpMinor(v) === null), 'formatGbpMinor rejects zero, negative, fractional and non-number amounts');

const described = describeStripePrice(price());
check(described && described.amountLabel === '£12.34' && described.priceLabel === '£12.34 per month including VAT' && described.amountMinor === 1234, 'a VAT-inclusive monthly GBP price is described as "£x per month including VAT"');
check(describeStripePrice(price({ currency: 'usd' })) === null, 'a non-GBP price is not described');
check(describeStripePrice(price({ recurring: { interval: 'year', interval_count: 1 } })) === null, 'a yearly price is not described as monthly');
check(describeStripePrice(price({ recurring: { interval: 'month', interval_count: 3 } })) === null, 'a 3-monthly price is not described as monthly');
check(describeStripePrice(price({ recurring: null })) === null, 'a one-off price is not described');
check(describeStripePrice(price({ tax_behavior: 'exclusive' })) === null && describeStripePrice(price({ tax_behavior: 'unspecified' })) === null, 'a price Stripe does not treat as VAT-inclusive is never labelled "including VAT"');
check(describeStripePrice(price({ unit_amount: null })) === null && describeStripePrice(null) === null, 'a missing amount or price describes nothing');

// ---- lookup: caching and failure handling ----
{
  const calls = [];
  let fail = false;
  let t = 0;
  const stripe = { prices: { retrieve: async (id) => { calls.push(id); if (fail) throw new Error('down'); return price({ id, unit_amount: id === 'price_old' ? 1111 : 2222 }); } } };
  const lookup = createStripePriceLookup({ stripe, ttlMs: 1000, failureTtlMs: 100, now: () => t });
  const a = await lookup('price_new');
  const b = await lookup('price_new');
  check(a.amountLabel === '£22.22' && b === a && calls.length === 1, 'a successful Stripe read is cached per Price ID');
  t = 5000;
  await lookup('price_new');
  check(calls.length === 2, 'the cache expires after its TTL');
  fail = true;
  t = 10000;
  check((await lookup('price_new')) === null, 'a Stripe error returns null (no amount), never a stale or default figure');
  fail = false;
  const callsAfterFailure = calls.length;
  check((await lookup('price_new')) === null && calls.length === callsAfterFailure, 'a failure is remembered briefly, so dashboards don\'t each wait on an unhealthy Stripe');
  t = 10200;
  check((await lookup('price_new')).amountLabel === '£22.22', 'after the short failure window the next request recovers');
  check((await createStripePriceLookup({ stripe: null })('price_x')) === null && (await lookup('')) === null, 'no Stripe client or no Price ID -> null');
  const hanging = { prices: { retrieve: () => new Promise(() => {}) } };
  const started = Date.now();
  const slow = await createStripePriceLookup({ stripe: hanging, timeoutMs: 50 })('price_slow');
  check(slow === null && Date.now() - started < 1000, 'a Stripe read that never answers gives up after the timeout (dashboards are never held up)');
  check((await getCurrentStripeOffer(lookup, 'price_old')).amountLabel === '£11.11', 'getCurrentStripeOffer describes the Price ID it is given (STRIPE_PRICE_ID in production)');
}

// ---- 2. per-household membership label ----
{
  const stripePaid = { entitlement_type: 'paid_subscription', source: 'stripe' };
  const applePaid = { entitlement_type: 'paid_subscription', source: 'apple_revenuecat' };
  const lookedUp = [];
  const lookup = async (id) => { lookedUp.push(id); return id === 'price_old' ? describeStripePrice(price({ id, unit_amount: 1111 })) : id === 'price_new' ? describeStripePrice(price({ id, unit_amount: 2222 })) : null; };

  check((await resolveMembershipPriceLabel({ entitlement: stripePaid, subscription: { stripe_price_id: 'price_old' }, lookupStripePrice: lookup })) === '£11.11 per month including VAT',
    'a Stripe customer on an earlier Price sees THEIR price, even when a newer Price exists (grandfathering-safe)');
  check((await resolveMembershipPriceLabel({ entitlement: stripePaid, subscription: { stripe_price_id: 'price_new' }, lookupStripePrice: lookup })) === '£22.22 per month including VAT',
    'a Stripe customer on the current Price sees the current price');
  check((await resolveMembershipPriceLabel({ entitlement: stripePaid, subscription: { stripe_price_id: 'price_gone' }, lookupStripePrice: lookup })) === MEMBERSHIP_LABELS.stripeUnknown,
    'if a Stripe customer\'s own Price can\'t be read, the label has no amount and points to Manage membership');
  check((await resolveMembershipPriceLabel({ entitlement: stripePaid, subscription: null, lookupStripePrice: lookup })) === MEMBERSHIP_LABELS.stripeUnknown,
    'a Stripe entitlement with no subscription row gets no amount');
  lookedUp.length = 0;
  const apple = await resolveMembershipPriceLabel({ entitlement: applePaid, subscription: { stripe_price_id: 'price_new' }, lookupStripePrice: lookup });
  check(apple === MEMBERSHIP_LABELS.appleBilled && !/£\s?\d/.test(apple) && lookedUp.length === 0,
    'an Apple-billed customer is never shown a Stripe price (not even a stale Stripe row) and is pointed to Apple settings');
  for (const type of ['complimentary', 'promotion', 'partner', 'staff', 'founding_offer']) {
    check(buildMembershipPriceLabel({ entitlement: { entitlement_type: type, source: 'admin_manual' } }) === MEMBERSHIP_LABELS.noCharge, `${type} access shows "no charge", never a price`);
  }
  check(buildMembershipPriceLabel({ entitlement: { entitlement_type: 'free_trial', source: 'stripe' } }) === MEMBERSHIP_LABELS.freeTrial, 'a free trial shows no amount');
  check(Object.values(MEMBERSHIP_LABELS).every((l) => !/£\s?\d/.test(l)), 'none of the fixed membership labels contains an amount');
}

// ---- 3. offer endpoint + checkout text ----
{
  const run = async (lookupResult) => {
    const res = { headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; } };
    await createOfferHandler(() => async () => lookupResult)({}, res);
    return res;
  };
  const ok = await run(describeStripePrice(price()));
  check(ok.body.available === true && ok.body.channel === 'stripe' && ok.body.amountLabel === '£12.34' && ok.body.interval === 'month' && ok.headers['Cache-Control'] === 'no-store', 'offer handler returns the described Stripe price, not cached by clients');
  const down = await run(null);
  check(down.body.available === false && down.body.amountLabel === undefined && Object.keys(down.body).length === 2, 'offer handler returns available:false and no figure when the price is unknown');
  check(JSON.stringify(buildOfferResponse(null)) === '{"available":false,"channel":"stripe"}', 'buildOfferResponse(null) contains no amount');
  check(!/\d/.test(CHECKOUT_SUBMIT_MESSAGE) && CHECKOUT_SUBMIT_MESSAGE.includes('the amount shown on this page') && CHECKOUT_SUBMIT_MESSAGE.includes('every month') && CHECKOUT_SUBMIT_MESSAGE.includes('Terms and Conditions'),
    'Stripe Checkout disclosure contains no figure, states it recurs monthly, and references the Terms');
}

// ---- 4. app helper ----
const mobile = await import(pathToFileURL(path.join(root, 'mobile', 'lib', 'subscriptionPrice.ts')).href);
{
  const { displayPriceFromStoreProduct: fromStore, displayPriceFromServerOffer: fromServer, subscribePriceLine, subscribeButtonLabel, PRICE_PENDING_NOTE } = mobile;
  const gb = fromStore({ priceString: '£12.34', currencyCode: 'GBP', subscriptionPeriod: 'P1M', introPrice: null });
  check(gb && gb.source === 'app_store' && subscribePriceLine(gb) === '£12.34/month, including VAT', 'iOS: StoreKit\'s own priceString is shown, VAT-inclusive for the UK storefront');
  const eur = fromStore({ priceString: '12,34 €', currencyCode: 'EUR', subscriptionPeriod: 'P1M' });
  check(eur && subscribePriceLine(eur) === '12,34 €/month', 'iOS: a non-GBP storefront price is shown as-is, with no UK VAT claim');
  check(fromStore({ priceString: '£12.34', currencyCode: 'GBP', subscriptionPeriod: 'P1Y' }) === null, 'iOS: a non-monthly product is never described as "/month"');
  check(fromStore({ priceString: '£12.34', currencyCode: 'GBP', subscriptionPeriod: 'P1M', introPrice: { price: 0 } }) === null, 'iOS: an introductory offer (which this screen cannot describe) shows no amount');
  check(fromStore({ priceString: '', subscriptionPeriod: 'P1M' }) === null && fromStore(null) === null && fromStore({ priceString: 12.34, subscriptionPeriod: 'P1M' }) === null, 'iOS: a missing/invalid StoreKit price shows no amount');
  const srv = fromServer({ available: true, channel: 'stripe', interval: 'month', amountLabel: '£12.34' });
  check(srv && srv.source === 'stripe' && subscribePriceLine(srv) === '£12.34/month, including VAT', 'Android: the server\'s Stripe price is shown');
  check([
    { available: false, channel: 'stripe' },
    { available: true, channel: 'apple', interval: 'month', amountLabel: '£12.34' },
    { available: true, channel: 'stripe', interval: 'year', amountLabel: '£12.34' },
    { available: true, channel: 'stripe', interval: 'month', amountLabel: '£12.3' },
    { available: true, channel: 'stripe', interval: 'month', amountLabel: '<b>£12.34</b>' },
    null,
  ].every((o) => fromServer(o) === null), 'Android: anything but a well-formed monthly Stripe offer shows no amount');
  check(subscribeButtonLabel(gb) === 'Subscribe & pay £12.34/month now' && subscribeButtonLabel(null) === 'Subscribe & pay now', 'pay button states the obligation to pay, with the amount only when it is known');
  check(PRICE_PENDING_NOTE.includes('before you pay') && !/\d/.test(PRICE_PENDING_NOTE), 'the pending-price note contains no figure');
}

// ---- 5. no hard-coded amounts in customer-facing sources ----
{
  const files = [
    ['mobile', 'app', '(setup)', 'subscribe.tsx'], ['mobile', 'app', '(setup)', 'welcome.tsx'], ['mobile', 'app', '(setup)', 'complete.tsx'],
    ['mobile', 'app', '(setup)', 'confirmation.tsx'], ['mobile', 'app', '(tabs)', 'membership.tsx'], ['mobile', 'lib', 'purchases.ts'],
    ['mobile', 'lib', 'subscriptionPrice.ts'], ['server.js'], ['routes', 'mobileApi.js'], ['routes', 'billing.js'],
    ['services', 'checkoutSession.js'], ['services', 'subscriptionPricing.js'],
  ];
  for (const f of files) {
    check(!/£\s?\d/.test(code(read(...f))), `${f.join('/')}: no hard-coded £ amount`);
  }
  const upload = read('upload.html');
  check(!/£\s?\d/.test(upload), 'upload.html (web checkout): no hard-coded £ amount');
  check(upload.includes('fetch("/billing/offer"') && upload.includes('OFFER_AMOUNT_PATTERN.test(offer.amountLabel)'), 'upload.html fills the price only from a validated /billing/offer response');
}

// ---- 6. wiring ----
{
  const sub = read('mobile', 'app', '(setup)', 'subscribe.tsx');
  const c = code(sub);
  // 2026-10-10 (WS4, Android Option C): Android no longer shows or fetches a
  // price at all (Google Play Payments policy) — the stricter guard for that
  // is tests/android-option-c-consumption-only.test.mjs.
  check(c.includes('displayPriceFromStoreProduct(pkg.product)') && !c.includes('fetchStripeOffer') && !c.includes('displayPriceFromServerOffer'), 'Subscribe: iOS prices from StoreKit; Android fetches and shows no price (Option C)');
  check(c.includes('const pkg = iosPackage.current;') && !/handleSubscribeIOS[\s\S]*fetchHcgPackage\(\)/.test(c.slice(c.indexOf('async function handleSubscribeIOS'), c.indexOf('async function handleSubscribe()'))),
    'Subscribe: iOS buys exactly the package whose price was displayed (no second, un-displayed package fetch)');
  check(c.includes('disabled={iosPriceMissing}') && c.includes('const iosPriceMissing = Platform.OS === "ios" && priceState !== "ready";'), 'Subscribe: an iOS purchase cannot start until StoreKit\'s price is on screen');
  const billing = read('routes', 'billing.js');
  const mobileApi = read('routes', 'mobileApi.js');
  check(billing.includes('router.get("/billing/offer", requireAuth, createOfferHandler());'), 'web: GET /billing/offer requires a signed-in session');
  check(mobileApi.includes('router.get("/api/v1/billing/offer", requireAuthApi, createOfferHandler());'), 'app: GET /api/v1/billing/offer requires a bearer token');
  check(read('services', 'checkoutSession.js').includes('message: CHECKOUT_SUBMIT_MESSAGE,') && billing.includes('message: CHECKOUT_SUBMIT_MESSAGE,'), 'both Stripe Checkout builders use the price-agnostic disclosure');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
