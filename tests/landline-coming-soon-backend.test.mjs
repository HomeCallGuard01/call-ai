// Backend proof for LANDLINE_COMING_SOON (2026-09-21).
//
// New landline checkout must be impossible through the website, the current
// app, older app builds (v8/v9 and earlier) and direct API calls, and must be
// rejected BEFORE Stripe is touched. These tests do not just pattern-match
// source: they load the REAL route modules (routes/mobileApi.js,
// routes/billing.js), extract the REAL Express handlers and call them, with a
// Stripe stand-in that records any access at all and a spy on the entitlement
// lookup that follows the gate. "Blocked" therefore means: the handler
// answered 403 / redirected AND touched neither Stripe nor the database.
//
// What is proven here:
//   - the flag fails closed (only the exact string "false" opens landline)
//   - every landline provider value (supported, "other", missing, manipulated,
//     a leaked mobile key) is blocked on every route while the flag is on
//   - the state old clients understand (landline_provider_unsupported) is what
//     they receive; the real cause lives only in `reason`
//   - the exact request sequence an older app performs cannot reach Stripe
//   - Android, iPhone Coming soon and every mobile carrier are unchanged
//   - existing landline households keep the routes Turn off protection uses
//   - with the flag explicitly "false" the original landline rules are back
//     (nothing was deleted)
//
// Run with: node tests/landline-coming-soon-backend.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Offline-safe defaults so the real route modules can be loaded (nothing here
// ever reaches the network; every I/O function a handler could call is either
// unreachable behind the gate or replaced with a spy below).
for (const [k, v] of Object.entries({
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'dummy',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy',
  TWILIO_ACCOUNT_SID: 'ACdummy00000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'dummy',
})) if (!process.env[k]) process.env[k] = v;
process.env.STRIPE_PRICE_ID = 'price_dummy';

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// ---------- environment helpers ----------
function withEnv(vars, fn) {
  const previous = {};
  for (const k of Object.keys(vars)) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// ---------- load the real modules, with I/O replaced by spies ----------
const flags = require('../services/featureFlags.js');
const { evaluateHouseholdCheckoutEligibility } = require('../services/providerPolicy.js');

const stripeTouches = [];
const stripeStandIn = (label) =>
  new Proxy(function () {}, {
    get: (_t, key) => {
      stripeTouches.push(`${label}.${String(key)}`);
      return stripeStandIn(`${label}.${String(key)}`);
    },
    apply: () => {
      stripeTouches.push(`${label}()`);
      throw new Error(`STRIPE WAS CALLED: ${label}`);
    },
  });
require('../services/stripeClient.js').stripe = stripeStandIn('stripe');

const spies = { entitlementReads: 0, capturedSelections: [], entitlementResult: { id: 'active-entitlement' } };
const billingDb = require('../database/billing.js');
billingDb.getActiveEntitlement = async () => {
  spies.entitlementReads++;
  return spies.entitlementResult;
};
const householdsDb = require('../database/households.js');
householdsDb.setHouseholdCarrierCompatibility = async (...args) => {
  spies.capturedSelections.push(args);
  return new Date().toISOString();
};

const mobileRouter = require('../routes/mobileApi.js');
const webRouter = require('../routes/billing.js');

function handlerFor(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${routePath}`);
  // The LAST function in the route stack is the real handler; everything
  // before it is auth middleware that this test deliberately bypasses.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const mobile = {
  capture: handlerFor(mobileRouter, 'post', '/api/v1/onboarding/carrier-compatibility'),
  precheck: handlerFor(mobileRouter, 'get', '/api/v1/onboarding/carrier-compatibility'),
  checkout: handlerFor(mobileRouter, 'post', '/api/v1/billing/create-checkout-session'),
  activationDevice: handlerFor(mobileRouter, 'get', '/api/v1/me/activation-device'),
  instructions: handlerFor(mobileRouter, 'get', '/api/v1/activation/instructions'),
};
const web = {
  capture: handlerFor(webRouter, 'post', '/billing/carrier-compatibility'),
  precheck: handlerFor(webRouter, 'get', '/billing/carrier-compatibility'),
  checkout: handlerFor(webRouter, 'post', '/billing/create-checkout-session'),
};

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    redirectUrl: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(a, b) { this.redirectUrl = typeof a === 'number' ? b : a; return this; },
  };
}
function resetSpies({ entitlement = { id: 'active-entitlement' } } = {}) {
  stripeTouches.length = 0;
  spies.entitlementReads = 0;
  spies.capturedSelections.length = 0;
  spies.entitlementResult = entitlement;
}
async function call(handler, req) {
  const res = makeRes();
  await handler({ authUserId: 'user-1', body: {}, query: {}, ...req }, res);
  return res;
}
const household = (device_type, carrier_provider_key = null, extra = {}) => ({
  id: 'household-1', device_type, carrier_provider_key, carrier_tariff_type: null, ...extra,
});

// ============================================================
// 1. The flag fails closed
// ============================================================
withEnv({ LANDLINE_COMING_SOON: undefined }, () => check(flags.isLandlineComingSoon() === true, 'flag: unset => Coming soon (default ON)'));
withEnv({ LANDLINE_COMING_SOON: 'false' }, () => check(flags.isLandlineComingSoon() === false, 'flag: exactly "false" => landline open'));
for (const v of ['', 'False', 'FALSE', '0', 'no', ' false', 'false ', 'true', 'TRUE', '1', 'off', 'undefined', 'null']) {
  withEnv({ LANDLINE_COMING_SOON: v }, () => check(flags.isLandlineComingSoon() === true, `flag: ${JSON.stringify(v)} => still Coming soon (only the exact string "false" opens landline)`));
}

// ============================================================
// 2. The single authoritative decision (flag ON, the default)
// ============================================================
const LANDLINE_PROVIDER_VALUES = ['bt', 'sky', 'virgin', 'talktalk', 'plusnet', 'other', null, undefined, '', 'some-manipulated-value-xyz', 'o2', 'ee', 'BT', ' bt'];

await withEnv({ LANDLINE_COMING_SOON: undefined }, async () => {
  for (const provider of LANDLINE_PROVIDER_VALUES) {
    const label = JSON.stringify(provider);
    const r = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: provider });
    check(r.canProceedToPayment === false, `eligibility: landline + provider ${label} => cannot pay`);
    check(r.status === 'landline_provider_unsupported' && r.customerState === 'landline_provider_unsupported', `eligibility: landline + provider ${label} => status/customerState stay landline_provider_unsupported (the state every shipped client already understands)`);
    check(r.reason === 'landline_coming_soon', `eligibility: landline + provider ${label} => internal reason is landline_coming_soon`);
  }
  check(evaluateHouseholdCheckoutEligibility({ device_type: 'landline' }).canProceedToPayment === false, 'eligibility: landline with no provider field at all => cannot pay');
});

// ============================================================
// 3. Mobile routes — current app AND older clients AND direct calls
// ============================================================
await withEnv({ LANDLINE_COMING_SOON: undefined, IOS_COMING_SOON: undefined }, async () => {
  // 3a. Every landline provider value, straight at the payment route
  for (const provider of LANDLINE_PROVIDER_VALUES) {
    resetSpies();
    const res = await call(mobile.checkout, { household: household('landline', provider) });
    check(
      res.statusCode === 403 && res.body.error === 'carrier_incompatible' && res.body.status === 'landline_provider_unsupported' && res.body.reason === 'landline_coming_soon',
      `mobile checkout: landline + provider ${JSON.stringify(provider)} => 403 carrier_incompatible (reason landline_coming_soon)`
    );
    check(stripeTouches.length === 0 && spies.entitlementReads === 0, `mobile checkout: landline + provider ${JSON.stringify(provider)} => rejected BEFORE Stripe and before any entitlement lookup (Stripe touches: ${stripeTouches.length}, lookups: ${spies.entitlementReads})`);
  }

  // 3b. The exact sequence an older app (v8/v9) performs: capture -> pre-check -> checkout
  resetSpies();
  const capture = await call(mobile.capture, { household: household(null), body: { deviceType: 'landline', provider: 'bt' } });
  check(
    capture.body.canProceedToPayment === false && capture.body.customerState === 'landline_provider_unsupported' && capture.body.status === 'landline_provider_unsupported',
    'older client step 1 (POST carrier-compatibility, landline/BT): told cannot proceed, in the landline_provider_unsupported state its dead-end screen already handles'
  );
  check(
    spies.capturedSelections.length === 1 && spies.capturedSelections[0][1] === 'landline' && spies.capturedSelections[0][2] === 'bt',
    'older client step 1: the selection is still recorded exactly as before (device_type landline / bt) — behaviour of the capture route is unchanged, only the verdict differs'
  );
  const stored = household('landline', 'bt'); // what the capture above persisted
  const precheck = await call(mobile.precheck, { household: stored });
  check(precheck.body.canProceedToPayment === false && precheck.body.customerState === 'landline_provider_unsupported', 'older client step 2 (GET pre-check that Subscribe runs before either purchase path): cannot proceed');
  const checkout = await call(mobile.checkout, { household: stored });
  check(checkout.statusCode === 403 && checkout.body.error === 'carrier_incompatible', 'older client step 3 (POST create-checkout-session): 403 — the older app cannot reach payment');
  check(stripeTouches.length === 0 && spies.entitlementReads === 0, 'older client sequence: Stripe never touched, no entitlement lookup');

  // 3c. A direct API call cannot override server-side state through the request body
  resetSpies();
  const bodyOverride = await call(mobile.checkout, {
    household: household('landline', 'bt'),
    body: { deviceType: 'mobile', provider: 'o2', device_type: 'mobile', carrier_provider_key: 'o2' },
  });
  check(bodyOverride.statusCode === 403 && stripeTouches.length === 0, 'direct call: claiming mobile/O2 in the checkout BODY does not change the stored landline classification — still 403, Stripe untouched');

  // 3d. Android unchanged: passes the gate exactly as before
  // giffgaff label updated 2026-09-24: reclassified from 'compatible' to
  // 'provider_specific'/native_settings — this test's actual assertion
  // (statusCode/error/entitlementReads) is unaffected either way, since
  // the eligibility gate treats both statuses identically; only the
  // descriptive label here needed correcting.
  for (const [provider, why] of [['o2', 'compatible'], ['giffgaff', 'provider_specific'], ['ee', 'provider_specific']]) {
    resetSpies();
    const res = await call(mobile.checkout, { household: household('mobile', provider) });
    check(res.statusCode === 409 && res.body.error === 'already_active' && spies.entitlementReads === 1, `Android/mobile (${provider}, ${why}): still passes the eligibility gate and continues to the next step (reached the entitlement check => 409 already_active)`);
  }
  resetSpies();
  const tesco = await call(mobile.checkout, { household: household('mobile', 'tesco') });
  check(tesco.statusCode === 403 && tesco.body.reason !== 'landline_coming_soon', 'Android/mobile: an incompatible carrier (Tesco) is blocked for its OWN reason, unchanged');
  resetSpies();
  const unclassified = await call(mobile.checkout, { household: household(null, null) });
  check(unclassified.statusCode === 403 && unclassified.body.reason !== 'landline_coming_soon', 'an unclassified household (no device, no carrier) is still blocked for its own existing reason, unchanged');

  // 3e. iPhone Coming soon unchanged
  resetSpies();
  const iphone = await call(mobile.checkout, { household: household('iphone') });
  check(iphone.statusCode === 403 && iphone.body.status === 'ios_coming_soon' && iphone.body.reason === 'ios_coming_soon', 'iPhone: still blocked by the existing IOS_COMING_SOON gate with its own status/reason');
  check(stripeTouches.length === 0, 'iPhone: Stripe untouched');
});

// ============================================================
// 4. Website routes — same authoritative decision
// ============================================================
await withEnv({ LANDLINE_COMING_SOON: undefined, IOS_COMING_SOON: undefined }, async () => {
  for (const provider of LANDLINE_PROVIDER_VALUES) {
    resetSpies();
    const res = await call(web.checkout, { household: household('landline', provider) });
    check(
      res.redirectUrl === '/dashboard?checkout=carrier_incompatible' && stripeTouches.length === 0 && spies.entitlementReads === 0,
      `website checkout: landline + provider ${JSON.stringify(provider)} => redirected to carrier_incompatible BEFORE Stripe / entitlement lookup`
    );
  }
  resetSpies();
  const wcap = await call(web.capture, { household: household(null), body: { deviceType: 'landline', provider: 'sky' } });
  check(wcap.body.canProceedToPayment === false && wcap.body.customerState === 'landline_provider_unsupported', 'website capture (POST /billing/carrier-compatibility landline/Sky): cannot proceed, in the state the website page already handles');
  const wpre = await call(web.precheck, { household: household('landline', 'virgin') });
  check(wpre.body.canProceedToPayment === false && wpre.body.customerState === 'landline_provider_unsupported', 'website pre-check (GET /billing/carrier-compatibility): cannot proceed');

  resetSpies();
  const wAndroid = await call(web.checkout, { household: household('mobile', 'o2') });
  check(wAndroid.redirectUrl === '/dashboard?checkout=already_active' && spies.entitlementReads === 1, 'website checkout: Android/mobile still passes the gate unchanged');
  resetSpies();
  const wIphone = await call(web.checkout, { household: household('iphone') });
  check(wIphone.redirectUrl === '/dashboard?checkout=carrier_incompatible' && stripeTouches.length === 0, 'website checkout: iPhone still blocked by the existing IOS_COMING_SOON gate');
});

// ============================================================
// 5. The landline flag does not touch iPhone or Android (independent flags)
// ============================================================
await withEnv({ LANDLINE_COMING_SOON: 'false', IOS_COMING_SOON: undefined }, async () => {
  resetSpies();
  const iphone = await call(mobile.checkout, { household: household('iphone') });
  check(iphone.statusCode === 403 && iphone.body.status === 'ios_coming_soon', 'LANDLINE flag off, IOS flag on: iPhone is still blocked');
  resetSpies();
  const android = await call(mobile.checkout, { household: household('mobile', 'o2') });
  check(android.statusCode === 409, 'LANDLINE flag off: Android unchanged');
});
await withEnv({ LANDLINE_COMING_SOON: undefined, IOS_COMING_SOON: 'false' }, async () => {
  resetSpies();
  const iphone = await call(mobile.checkout, { household: household('iphone', null) });
  check(iphone.body && iphone.body.reason !== 'ios_coming_soon', 'IOS flag off, LANDLINE flag on: iPhone falls through to the carrier gate exactly as before (landline flag does not re-block it)');
  resetSpies();
  const landline = await call(mobile.checkout, { household: household('landline', 'bt') });
  check(landline.statusCode === 403 && landline.body.reason === 'landline_coming_soon', 'IOS flag off, LANDLINE flag on: landline is still blocked');
});

// ============================================================
// 6. Existing landline households keep Turn off protection
// ============================================================
await withEnv({ LANDLINE_COMING_SOON: undefined }, async () => {
  const existing = household('landline', 'virgin', { twilio_number: '+442071234567', phone_number: null });
  const dev = await call(mobile.activationDevice, { household: existing });
  check(dev.body && dev.body.deviceType === 'landline' && dev.body.provider === 'virgin', 'existing landline household: /api/v1/me/activation-device still returns landline + provider while Coming soon is on (how Turn off protection recovers the device after a reinstall)');
  const ins = await call(mobile.instructions, { household: existing, query: { deviceType: 'landline', provider: 'virgin' } });
  check(ins.statusCode === 200 && typeof ins.body.cancelCode === 'string' && ins.body.cancelCode.length > 0, 'existing landline household: /api/v1/activation/instructions still returns the cancel code while Coming soon is on (Turn off protection is not stranded)');
});
{
  const src = readFileSync(path.join(root, 'routes', 'mobileApi.js'), 'utf8');
  const start = src.indexOf('router.get("/api/v1/activation/instructions"');
  const end = src.indexOf('\nrouter.', start + 10);
  const block = src.slice(start, end === -1 ? undefined : end);
  check(!/evaluateHouseholdCheckoutEligibility|isLandlineComingSoon/.test(block), 'the activation-instructions route (Turn off protection) contains no reference to the checkout gate or the landline flag');
  const devStart = src.indexOf('router.get("/api/v1/me/activation-device"');
  const devBlock = src.slice(devStart, src.indexOf('\nrouter.', devStart + 10));
  check(!/evaluateHouseholdCheckoutEligibility|isLandlineComingSoon/.test(devBlock), 'the activation-device route contains no reference to the checkout gate or the landline flag');
}

// ============================================================
// 7. Nothing was deleted: flag explicitly "false" restores the original rules
// ============================================================
await withEnv({ LANDLINE_COMING_SOON: 'false', IOS_COMING_SOON: undefined }, async () => {
  for (const provider of ['bt', 'sky', 'virgin', 'talktalk', 'plusnet']) {
    resetSpies();
    const res = await call(mobile.checkout, { household: household('landline', provider) });
    check(res.statusCode === 409 && res.body.error === 'already_active', `flag "false": landline + ${provider} passes the gate again (original provider rules intact)`);
    resetSpies();
    const w = await call(web.checkout, { household: household('landline', provider) });
    check(w.redirectUrl === '/dashboard?checkout=already_active', `flag "false": website landline + ${provider} passes the gate again`);
  }
  for (const provider of ['other', null, 'some-manipulated-value-xyz', 'o2']) {
    resetSpies();
    const res = await call(mobile.checkout, { household: household('landline', provider) });
    check(res.statusCode === 403 && res.body.reason === 'landline_provider_unsupported', `flag "false": landline + ${JSON.stringify(provider)} is still blocked by the ORIGINAL provider rule (reason landline_provider_unsupported)`);
  }
});

// ============================================================
// 8. Structure: one authoritative gate, ordered before Stripe; flag published
// ============================================================
const mobileSrc = readFileSync(path.join(root, 'routes', 'mobileApi.js'), 'utf8');
const webSrc = readFileSync(path.join(root, 'routes', 'billing.js'), 'utf8');
const policySrc = readFileSync(path.join(root, 'services', 'providerPolicy.js'), 'utf8');
const serverSrc = readFileSync(path.join(root, 'server.js'), 'utf8');

for (const [name, src, anchor] of [
  ['mobile', mobileSrc, 'router.post("/api/v1/billing/create-checkout-session"'],
  ['website', webSrc, 'router.post("/billing/create-checkout-session"'],
]) {
  const start = src.indexOf(anchor);
  const body = src.slice(start, src.indexOf('\nrouter.', start + 10));
  const gate = body.indexOf('evaluateHouseholdCheckoutEligibility(req.household)');
  const firstStripeUse = body.search(/stripe\.(customers|subscriptions|checkout|billingPortal)/);
  check(gate !== -1 && firstStripeUse !== -1 && gate < firstStripeUse, `${name} checkout: the eligibility gate appears in source BEFORE the first Stripe call`);
  check(gate < body.indexOf('getActiveEntitlement('), `${name} checkout: the eligibility gate runs before the entitlement lookup`);
}

check(
  /const \{ isIosComingSoon, isLandlineComingSoon \} = require\("\.\/featureFlags"\);/.test(policySrc) &&
    policySrc.indexOf('if (isLandlineComingSoon()) {') > policySrc.indexOf('device_type === "landline"') &&
    policySrc.indexOf('if (isLandlineComingSoon()) {') < policySrc.indexOf('const provider = household.carrier_provider_key;'),
  'providerPolicy.js: the flag is read inside the landline branch BEFORE any provider is considered'
);
check(
  policySrc.includes('const LANDLINE_SUPPORTED_PROVIDERS = new Set(["bt", "sky", "virgin", "talktalk", "plusnet"]);') &&
    policySrc.includes('if (provider && LANDLINE_SUPPORTED_PROVIDERS.has(provider)) {'),
  'providerPolicy.js: the original landline provider rules are still in the source, underneath the flag'
);
check(
  serverSrc.includes('res.json({ iosComingSoon: isIosComingSoon(), landlineComingSoon: isLandlineComingSoon() });') &&
    !/requireAuth|requireAuthApi/.test(serverSrc.slice(serverSrc.indexOf('app.get("/api/v1/launch-flags"'), serverSrc.indexOf('app.get("/api/v1/launch-flags"') + 300)),
  'GET /api/v1/launch-flags publishes the live landlineComingSoon value (and iosComingSoon), unauthenticated'
);
check(existsSync(path.join(root, 'docs', 'launch', 'LANDLINE_COMING_SOON_LAUNCH_FLAG.md')), 'the flag is documented: docs/launch/LANDLINE_COMING_SOON_LAUNCH_FLAG.md');
check(
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test.includes('node tests/landline-coming-soon-backend.test.mjs'),
  'this test is part of the root `npm test` chain'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
