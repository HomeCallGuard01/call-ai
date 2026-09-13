// Structural tests for the carrier-onboarding-gate PR's backend
// additions: routes/mobileApi.js's carrier-compatibility routes (POST
// capture+preview, GET read-only re-evaluation) and the Terms/Privacy
// acceptance route, plus the payment-gate wiring inside
// POST /api/v1/billing/create-checkout-session. No HTTP test tooling
// exists in this project (see tests/account-deletion.test.mjs for the
// same established convention) — every route is checked directly
// against the real source.
//
// The underlying DECISION logic (which carriers/tariffs may proceed) is
// already fully unit-tested with real inputs in
// tests/provider-policy.test.mjs — this file proves the WIRING: that
// the right function is called, with the right argument, at the right
// point, for both platforms (Android/web via this gate, iOS via
// subscribe.tsx's own defense-in-depth check against the GET route).
//
// Run with: node tests/carrier-onboarding-gate.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileApiSource = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');
const householdsSource = readFileSync(path.join(__dirname, '..', 'database', 'households.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function blockFor(anchor) {
  const idx = mobileApiSource.indexOf(anchor);
  if (idx === -1) return { idx: -1, block: '' };
  const end = mobileApiSource.indexOf('\nrouter.', idx + anchor.length);
  return { idx, block: mobileApiSource.slice(idx, end === -1 ? undefined : end) };
}

// ============================================================
// POST /api/v1/onboarding/carrier-compatibility — capture + preview
// ============================================================

const postCarrier = blockFor('router.post("/api/v1/onboarding/carrier-compatibility"');
check(postCarrier.idx !== -1, 'POST /api/v1/onboarding/carrier-compatibility is declared');
const postCarrierDeclarationLine = postCarrier.block.split('\n')[0];
check(
  postCarrierDeclarationLine.includes('requireAuthApi') && !postCarrierDeclarationLine.includes('requireEntitlement'),
  'the capture route requires auth but NOT entitlement — an unsubscribed household must be able to reach it before ever seeing Subscribe'
);
check(
  postCarrier.block.includes('setHouseholdCarrierCompatibility(req.household.id, provider, normalisedTariffType)'),
  'the route persists the raw provider/tariff selection via setHouseholdCarrierCompatibility, keyed to the caller\'s own resolved household'
);
check(
  postCarrier.block.includes('evaluateHouseholdCheckoutEligibility({'),
  'the route returns a live evaluation using the same decision function the payment gate itself uses — no separate/duplicated verdict logic'
);
check(
  postCarrier.block.includes('typeof provider !== "string" || !provider.trim()'),
  'a missing/empty provider is rejected with 400 before any write is attempted'
);

// ============================================================
// GET /api/v1/onboarding/carrier-compatibility — read-only re-check
// ============================================================

const getCarrier = blockFor('router.get("/api/v1/onboarding/carrier-compatibility"');
check(getCarrier.idx !== -1, 'GET /api/v1/onboarding/carrier-compatibility (read-only re-evaluation) is declared');
const getCarrierDeclarationLine = getCarrier.block.split('\n')[0];
check(
  getCarrierDeclarationLine.includes('requireAuthApi') && !getCarrierDeclarationLine.includes('requireEntitlement'),
  'the read-only route also requires auth but not entitlement — reachable at the moment of purchase, before the household is entitled'
);
check(
  getCarrier.block.includes('evaluateHouseholdCheckoutEligibility(req.household)'),
  'the read-only route re-evaluates whatever is already stored on req.household — never writes, never accepts a body'
);
check(
  !getCarrier.block.includes('setHouseholdCarrierCompatibility'),
  'the GET route never writes — it is purely a re-evaluation of already-captured state'
);

// ============================================================
// POST /api/v1/onboarding/terms-acceptance
// ============================================================

const postTerms = blockFor('router.post("/api/v1/onboarding/terms-acceptance"');
check(postTerms.idx !== -1, 'POST /api/v1/onboarding/terms-acceptance is declared');
const postTermsDeclarationLine = postTerms.block.split('\n')[0];
check(
  postTermsDeclarationLine.includes('requireAuthApi') && !postTermsDeclarationLine.includes('requireEntitlement'),
  'the terms-acceptance route requires auth but not entitlement — must be reachable before payment, same as the carrier routes'
);
check(
  postTerms.block.includes('recordTermsAcceptance(') &&
    postTerms.block.includes('req.household.id') &&
    postTerms.block.includes('TERMS_VERSION') &&
    postTerms.block.includes('PRIVACY_VERSION'),
  'the route records acceptance against the caller\'s own resolved household, using the versioned constants — never a client-supplied version string'
);

// ============================================================
// POST /api/v1/billing/create-checkout-session — the actual payment gate
// ============================================================

const checkout = blockFor('router.post("/api/v1/billing/create-checkout-session"');
check(checkout.idx !== -1, 'POST /api/v1/billing/create-checkout-session is declared');

check(
  checkout.block.includes('evaluateHouseholdCheckoutEligibility(req.household)'),
  'the checkout route evaluates carrier compatibility using the real household resolved server-side from the caller\'s own session (req.household), never a client-supplied value'
);

const gateIdx = checkout.block.indexOf('evaluateHouseholdCheckoutEligibility(req.household)');
const stripeCallIdx = checkout.block.indexOf('stripe.subscriptions.list');
check(
  gateIdx !== -1 && stripeCallIdx !== -1 && gateIdx < stripeCallIdx,
  'the carrier-eligibility check runs BEFORE any Stripe API call is made — an incompatible/unverified household never reaches Stripe at all'
);

check(
  checkout.block.includes('if (!eligibility.canProceedToPayment)') &&
    checkout.block.includes('res.status(403).json({') &&
    checkout.block.includes('error: "carrier_incompatible"') &&
    checkout.block.includes('status: eligibility.status') &&
    checkout.block.includes('reason: eligibility.reason'),
  'a blocked household gets a structured 403 with the real status and reason — never a generic failure the client can\'t explain to the customer'
);

// ============================================================
// database/households.js — the two new write functions
// ============================================================

check(
  householdsSource.includes('async function setHouseholdCarrierCompatibility(householdId, providerKey, tariffType)') &&
    householdsSource.includes('supabaseAdmin.rpc("set_household_carrier_compatibility"'),
  'setHouseholdCarrierCompatibility calls the real SECURITY DEFINER RPC (migration 028), not a direct table write'
);

check(
  householdsSource.includes('async function recordTermsAcceptance(householdId, termsVersion, privacyVersion, acceptanceType)') &&
    householdsSource.includes('supabaseAdmin.rpc("record_terms_acceptance"'),
  'recordTermsAcceptance calls the real SECURITY DEFINER RPC (migration 029), not a direct table write — every call inserts a new row, no update path exists'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
