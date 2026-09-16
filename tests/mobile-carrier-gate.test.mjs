// Structural tests for routes/mobileApi.js's carrier-compatibility gate
// on POST /api/v1/billing/create-checkout-session, and the onboarding
// capture route POST /api/v1/onboarding/carrier-compatibility (P0 Batch
// 1 continuation). No HTTP test tooling exists in this project (see
// tests/account-deletion.test.mjs for the same established convention)
// — both routes are checked directly against the real source.
//
// The DECISION logic (which carriers/tariffs may proceed) is already
// fully unit-tested with real inputs in tests/provider-policy.test.mjs.
// This file proves the WIRING for both routes.
//
// Run with: node tests/mobile-carrier-gate.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { evaluateProviderCompatibility, evaluateHouseholdCheckoutEligibility } = require('../services/providerPolicy.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileApiSource = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// ============================================================
// POST /api/v1/billing/create-checkout-session — the payment gate
// ============================================================

const checkoutAnchor = 'router.post("/api/v1/billing/create-checkout-session"';
const checkoutIdx = mobileApiSource.indexOf(checkoutAnchor);
check(checkoutIdx !== -1, 'POST /api/v1/billing/create-checkout-session is declared');

const checkoutBlockEnd = mobileApiSource.indexOf('\nrouter.', checkoutIdx + checkoutAnchor.length);
const checkoutBlock = checkoutIdx !== -1 ? mobileApiSource.slice(checkoutIdx, checkoutBlockEnd) : '';

check(
  checkoutIdx !== -1 && mobileApiSource.slice(checkoutIdx, checkoutIdx + checkoutAnchor.length + 30).includes('requireAuthApi'),
  'the checkout route is gated behind requireAuthApi — an unauthenticated request never reaches the handler'
);

check(
  checkoutBlock.includes('evaluateHouseholdCheckoutEligibility(req.household)'),
  'the route evaluates carrier compatibility using the real household resolved server-side from the caller\'s own session (req.household)'
);

const checkoutGateIdx = checkoutBlock.indexOf('evaluateHouseholdCheckoutEligibility(req.household)');
const checkoutGateReturnIdx = checkoutBlock.indexOf('if (!eligibility.canProceedToPayment)');
check(
  checkoutGateIdx !== -1 && checkoutGateReturnIdx !== -1 && checkoutGateReturnIdx > checkoutGateIdx,
  'the eligibility result is acted on'
);

check(
  checkoutBlock.includes('res.status(403).json({') && checkoutBlock.includes('error: "carrier_incompatible"'),
  'a blocked household receives the intended 403 carrier_incompatible response, not a generic error'
);

// --- prove payment/provisioning code is not reached when blocked ---

const checkoutStripeCallSites = [
  'getActiveEntitlement(req.household.id)',
  'resolveStripeCustomerId(',
  'stripe.subscriptions.list(',
  'stripe.checkout.sessions.list(',
  'stripe.checkout.sessions.create(',
];

for (const callSite of checkoutStripeCallSites) {
  const callIdx = checkoutBlock.indexOf(callSite);
  check(
    checkoutGateReturnIdx !== -1 && (callIdx === -1 || checkoutGateReturnIdx < callIdx),
    `the carrier gate's return statement appears before ${callSite.split('(')[0]}(...) in source order — a blocked household's request can never reach this call`
  );
}

check(
  !checkoutBlock.includes('updateTwilioNumberForEntitlementChange') &&
    !checkoutBlock.includes('ensureTwilioNumberProvisioned'),
  'no Twilio provisioning call exists anywhere in this route at all — provisioning only ever happens later, from the webhook once a real payment completes, never from the checkout-session request itself'
);

// --- specific scenarios, via the real decision function ---

{
  const supported = evaluateProviderCompatibility('giffgaff');
  check(supported.canProceedToPayment === true, 'supported carrier (giffgaff): the same decision function this route calls allows proceeding');
}
{
  const incompatible = evaluateProviderCompatibility('tesco');
  check(incompatible.canProceedToPayment === false, 'incompatible carrier (Tesco): the same decision function this route calls blocks it — combined with the ordering proof, the route returns its intended 403 before Stripe');
}
{
  const unverified = evaluateProviderCompatibility(undefined);
  check(unverified.canProceedToPayment === false, 'unverified/unknown carrier (no carrier at all): blocked conservatively');
}
{
  const paygVodafone = evaluateProviderCompatibility('vodafone', 'payg');
  check(paygVodafone.canProceedToPayment === false, 'incompatible tariff variant (Vodafone PAYG): blocked');
}

// ============================================================
// POST /api/v1/onboarding/carrier-compatibility — the capture route
// ============================================================

const captureAnchor = 'router.post("/api/v1/onboarding/carrier-compatibility"';
const captureIdx = mobileApiSource.indexOf(captureAnchor);
check(captureIdx !== -1, 'POST /api/v1/onboarding/carrier-compatibility is declared');

const captureBlockEnd = mobileApiSource.indexOf('\nrouter.', captureIdx + captureAnchor.length);
const captureBlock = captureIdx !== -1 ? mobileApiSource.slice(captureIdx, captureBlockEnd) : '';

// --- authentication required ---
check(
  captureIdx !== -1 && mobileApiSource.slice(captureIdx, captureIdx + captureAnchor.length + 30).includes('requireAuthApi'),
  'the capture route is gated behind requireAuthApi — an unauthenticated request is rejected before the handler runs'
);
check(
  captureIdx !== -1 && !mobileApiSource.slice(captureIdx, captureIdx + captureAnchor.length + 60).includes('requireEntitlement'),
  'the capture route is deliberately NOT gated behind requireEntitlement — an unsubscribed household must be able to reach this before ever seeing a Subscribe button'
);

// --- provider/tariff are persisted (structural — the actual RPC write
// behaviour is proven directly against a real database in
// tests/migrations.pglite.test.mjs's migration 038 section) ---
check(
  captureBlock.includes('setHouseholdCarrierCompatibility(req.household.id, provider, normalisedTariffType)'),
  'the route persists the provider/tariff via setHouseholdCarrierCompatibility, using the real household id (req.household.id) and the exact validated inputs'
);

// --- malformed/invalid payloads fail safely ---
check(
  captureBlock.includes('typeof provider !== "string" || !provider.trim()'),
  'a missing/non-string/empty provider is rejected'
);
const validationIdx = captureBlock.indexOf('typeof provider !== "string"');
const persistIdx = captureBlock.indexOf('setHouseholdCarrierCompatibility(');
check(
  validationIdx !== -1 && persistIdx !== -1 && validationIdx < persistIdx,
  'the provider validation happens before any persistence call — a malformed payload never reaches the database'
);
check(
  captureBlock.includes('res.status(400).json({ error: "invalid_input"'),
  'a malformed payload gets a 400 invalid_input response, not a 500 or a silent success'
);
check(
  captureBlock.includes('typeof tariffType === "string" && tariffType.trim() ? tariffType : null'),
  'a malformed/missing tariffType is normalised to null rather than persisted as-is or crashing — evaluateProviderCompatibility already treats a missing/invalid tariff as unverified/blocked, never assumed compatible'
);

// --- capture itself cannot grant entitlement or provision a Twilio number ---
check(
  !captureBlock.includes('updateTwilioNumberForEntitlementChange') &&
    !captureBlock.includes('ensureTwilioNumberProvisioned') &&
    !captureBlock.includes('grantComplimentaryEntitlement') &&
    !captureBlock.includes('stripe.'),
  'the capture route never touches entitlement-granting or Twilio-provisioning logic — it only ever writes the raw carrier/tariff selection and returns the current evaluation, nothing else'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
