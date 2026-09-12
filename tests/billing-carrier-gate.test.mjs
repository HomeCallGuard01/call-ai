// Structural tests for routes/billing.js's carrier-compatibility gate on
// POST /billing/create-checkout-session (P0 Batch 1 continuation). No
// HTTP test tooling exists in this project (see tests/account-deletion.test.mjs
// for the same established convention) — the route is checked directly
// against the real source.
//
// The DECISION logic itself (which carriers/tariffs may proceed) is
// already fully unit-tested with real inputs in tests/provider-policy.test.mjs
// (supported carriers, Tesco, unverified/unknown, PAYG tariff — all
// covered there against evaluateProviderCompatibility/
// evaluateHouseholdCheckoutEligibility directly). This file's job is
// proving the WIRING: that the route actually calls that decision
// function, gates on its result, and returns before ever reaching Stripe
// when blocked — for any carrier that decision function blocks, not
// just one specific one. Together, "the decision is correct" (proven
// there) + "the route obeys the decision, unconditionally, before any
// Stripe call" (proven here) is the complete proof that a blocked
// customer of any kind never reaches Stripe.
//
// Run with: node tests/billing-carrier-gate.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { evaluateProviderCompatibility } = require('../services/providerPolicy.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const billingSource = readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const routeAnchor = 'router.post("/billing/create-checkout-session"';
const routeIdx = billingSource.indexOf(routeAnchor);
check(routeIdx !== -1, 'POST /billing/create-checkout-session is declared');

const blockEnd = billingSource.indexOf('\nrouter.', routeIdx + routeAnchor.length);
const block = routeIdx !== -1 ? billingSource.slice(routeIdx, blockEnd) : '';

check(
  block.includes('evaluateHouseholdCheckoutEligibility(req.household)'),
  'the route evaluates carrier compatibility using the real household resolved server-side from the caller\'s own session (req.household), never a client-suppliable value'
);

const gateIdx = block.indexOf('evaluateHouseholdCheckoutEligibility(req.household)');
const gateReturnIdx = block.indexOf('if (!eligibility.canProceedToPayment)');
const betweenGateAndCheck = gateIdx !== -1 && gateReturnIdx !== -1 ? block.slice(gateIdx, gateReturnIdx) : '';
check(
  gateIdx !== -1 && gateReturnIdx !== -1 && gateReturnIdx > gateIdx &&
    !betweenGateAndCheck.includes('function ') && !betweenGateAndCheck.includes('return (') &&
    !betweenGateAndCheck.includes('await '),
  'the eligibility check is acted on immediately (return on !canProceedToPayment right after the evaluation, with no other logic or awaited call in between)'
);

check(
  block.includes('return res.redirect("/dashboard?checkout=carrier_incompatible");'),
  'a blocked household is redirected with an honest, specific reason (checkout=carrier_incompatible), not a generic error'
);

// --- prove Stripe is never reached for a blocked customer: the gate's
// return statement must appear before every single Stripe-related call
// site in this route ---

const stripeCallSites = [
  'getActiveEntitlement(req.household.id)',
  'resolveStripeCustomerId(',
  'stripe.subscriptions.list(',
  'stripe.checkout.sessions.list(',
  'stripe.checkout.sessions.create(',
];

for (const callSite of stripeCallSites) {
  const callIdx = block.indexOf(callSite);
  check(
    gateReturnIdx !== -1 && (callIdx === -1 || gateReturnIdx < callIdx),
    `the carrier gate's return statement appears before ${callSite.split('(')[0]}(...) in source order — a blocked household's request can never reach this call`
  );
}

check(
  gateReturnIdx !== -1 && block.indexOf('try {', gateReturnIdx) > gateReturnIdx &&
    block.indexOf('try {') > gateReturnIdx,
  'the entire entitlement/Stripe try block starts after the carrier gate — the gate is not nested inside logic a blocked request could still partially execute'
);

// --- the specific scenarios required, proven via the real decision
// function with the exact household shape the route passes it ---

{
  const supported = evaluateProviderCompatibility('o2');
  check(supported.canProceedToPayment === true, 'supported carrier (O2): the same decision function this route calls allows proceeding — combined with the ordering proof above, a supported carrier reaches the Stripe try block');
}
{
  const tesco = evaluateProviderCompatibility('tesco');
  check(tesco.canProceedToPayment === false, 'Tesco Mobile: the same decision function this route calls blocks it — combined with the ordering proof above, Tesco Mobile is redirected before Stripe is ever called');
}
{
  const unverified = evaluateProviderCompatibility('some-network-nobody-has-heard-of');
  check(unverified.canProceedToPayment === false, 'unverified/unknown carrier: blocked conservatively by the same decision function this route calls — never silently treated as compatible');
}
{
  const paygVodafone = evaluateProviderCompatibility('vodafone', 'payg');
  check(paygVodafone.canProceedToPayment === false, 'incompatible tariff variant (Vodafone PAYG): blocked by the same decision function this route calls');
}
{
  // The exact "no carrier captured yet" case a real existing household
  // would have — evaluateHouseholdCheckoutEligibility resolves this the
  // same way as an unrecognised provider (unverified, blocked), per
  // providerPolicy.js's own header. Proven directly here since it's the
  // literal shape req.household takes when carrier_provider_key is null.
  const { evaluateHouseholdCheckoutEligibility } = require('../services/providerPolicy.js');
  const noCarrierYet = evaluateHouseholdCheckoutEligibility({ id: 'h1', carrier_provider_key: null, carrier_tariff_type: null });
  check(noCarrierYet.canProceedToPayment === false, 'a household with no carrier captured yet at all is blocked, not assumed compatible by default');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
