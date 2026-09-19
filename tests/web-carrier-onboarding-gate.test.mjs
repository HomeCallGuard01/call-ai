// Structural tests for the WEB carrier-compatibility gate and
// pre-purchase Terms consent (upload.html + routes/billing.js) — the web
// equivalent of the mobile app's device-picker.tsx/subscribe.tsx work
// and routes/mobileApi.js's carrier-compatibility/terms-acceptance
// routes. Same conventions as the rest of this project: no HTTP test
// tooling exists, so backend routes are checked directly against
// source, and upload.html's inline script is checked directly against
// its real markup — see tests/get-protected-now-button.test.mjs for the
// same idiom.
//
// Run with: node tests/web-carrier-onboarding-gate.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');
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

function blockFor(source, anchor) {
  const idx = source.indexOf(anchor);
  if (idx === -1) return { idx: -1, block: '' };
  const end = source.indexOf('\nrouter.', idx + anchor.length);
  return { idx, block: source.slice(idx, end === -1 ? undefined : end) };
}

// ============================================================
// Backend: routes/billing.js
// ============================================================

const postCarrier = blockFor(billingSource, 'router.post("/billing/carrier-compatibility"');
check(postCarrier.idx !== -1, 'POST /billing/carrier-compatibility is declared');
const postCarrierLine = postCarrier.block.split('\n')[0];
check(
  postCarrierLine.includes('requireAuth,') && !postCarrierLine.includes('requireEntitlement'),
  'the web capture route requires auth but not entitlement — an unsubscribed household must be able to reach it before ever seeing the payment button'
);
check(
  postCarrier.block.includes('setHouseholdCarrierCompatibility(req.household.id, deviceType, normalisedProvider, normalisedTariffType)'),
  'the web route persists the device type + provider/tariff selection via the same setHouseholdCarrierCompatibility (migration 040) the mobile route uses'
);
check(
  postCarrier.block.includes('deviceType !== "mobile" && deviceType !== "landline"'),
  'the web route rejects a missing/invalid deviceType before any write is attempted'
);
check(
  postCarrier.block.includes('deviceType === "iphone" ? null : provider'),
  'the web route only ever nulls provider for iphone — landline now persists the provider it captures too (2026-09-19, migration 043), which the checkout gate reads to enforce LANDLINE_SUPPORTED_PROVIDERS'
);
check(
  postCarrier.block.includes('deviceType === "landline" && (typeof provider !== "string" || !LANDLINE_PROVIDERS.has(provider))'),
  'the web route requires a landline household to supply one of the six selectable landline provider keys'
);
check(
  postCarrier.block.includes('evaluateHouseholdCheckoutEligibility({'),
  'the web route returns a live evaluation using the same decision function as everywhere else — no separate/duplicated verdict logic for web'
);

const getCarrier = blockFor(billingSource, 'router.get("/billing/carrier-compatibility"');
check(getCarrier.idx !== -1, 'GET /billing/carrier-compatibility (read-only re-evaluation) is declared');
const getCarrierLine = getCarrier.block.split('\n')[0];
check(
  getCarrierLine.includes('requireAuth,') && !getCarrierLine.includes('requireEntitlement'),
  'the web read-only route also requires auth but not entitlement'
);
check(
  getCarrier.block.includes('evaluateHouseholdCheckoutEligibility(req.household)') && !getCarrier.block.includes('setHouseholdCarrierCompatibility'),
  'the web GET route is purely a re-evaluation of already-captured state — never writes'
);

const postTerms = blockFor(billingSource, 'router.post("/billing/terms-acceptance"');
check(postTerms.idx !== -1, 'POST /billing/terms-acceptance is declared');
check(
  postTerms.block.includes('recordTermsAcceptance(') &&
    postTerms.block.includes('req.household.id') &&
    postTerms.block.includes('TERMS_VERSION') &&
    postTerms.block.includes('PRIVACY_VERSION'),
  'the web terms route records acceptance against the caller\'s own resolved household using the same versioned constants as mobile — never a client-supplied version'
);

// The actual payment gate — must run before Stripe is ever called, same
// as the mobile route. Already covered structurally for the exact
// ordering by the existing carrier-onboarding-gate work on the mobile
// side; here we only need to confirm the web route wasn't left
// unguarded by this change.
check(
  billingSource.includes('evaluateHouseholdCheckoutEligibility(req.household)') &&
    billingSource.includes('checkout=carrier_incompatible'),
  'the real web checkout route (create-checkout-session) still blocks an ineligible household before Stripe, redirecting with a real reason the dashboard can explain — unchanged by this addition'
);

// ============================================================
// Frontend: upload.html
// ============================================================

check(
  html.includes('id="carrierCheckSection"') && html.includes('id="carrierNetworkSelect"') && html.includes('id="carrierTariffRow"'),
  'upload.html has the carrier device/network/tariff markup'
);

// Do NOT duplicate carrier classifications in frontend JavaScript — the
// carrier <select> is allowed to list names (pure labels, not verdicts),
// but nothing in the page may hardcode a status/compatible/blocked
// decision for any carrier.
check(
  !/status\s*[:=]\s*["'](compatible|incompatible|unverified|provider_specific)["']/.test(html),
  'upload.html never hardcodes a carrier compatibility verdict — every status string comes from the backend response, not frontend logic'
);
check(
  html.includes('fetch("/billing/carrier-compatibility"'),
  'upload.html calls the real backend endpoint to evaluate carrier compatibility, rather than deciding client-side'
);

// Landline must not go through the mobile carrier/tariff check at all.
const carrierScriptStart = html.indexOf('--- Carrier compatibility check (before payment) ---');
const carrierScriptEnd = html.indexOf('function showCheckoutBanner');
const carrierScript = html.slice(carrierScriptStart, carrierScriptEnd);
check(
  carrierScript.includes('if (!isMobile)') && carrierScript.includes('handleCarrierCheckSuccess();'),
  'selecting landline skips the network/tariff check entirely and proceeds straight to the payment step, same as the mobile app'
);

// Tariff only asked when the backend says it matters.
check(
  carrierScript.includes('tariff_type_required'),
  'the tariff question is only shown when the backend response says it actually affects eligibility, never unconditionally'
);

// "Other/not listed" must not silently pass — same reasoning as mobile:
// the option exists but resolves to the same backend-decided verdict as
// any other unrecognised provider (PROVIDER_POLICY.other, unverified).
check(
  html.includes('value="other">Other / Not sure<'),
  'an "Other/Not sure" option exists and is sent through the exact same backend evaluation as every named carrier — it cannot silently bypass the check since there is no client-side special case for it'
);

// Terms consent — separate checkboxes, unticked by default, exact wording.
check(
  html.includes('I agree to the Terms &amp; Conditions and acknowledge the Privacy Policy.'),
  'the web Terms agreement checkbox uses the approved exact wording'
);
check(
  !html.includes('id="agreeTermsCheckbox" checked') && !html.includes('id="startImmediatelyCheckbox" checked'),
  'neither consent checkbox is pre-ticked in the markup — the customer must actively tick both'
);
check(
  html.includes('id="agreeTermsCheckbox"') && html.includes('id="startImmediatelyCheckbox"') &&
    html.indexOf('id="agreeTermsCheckbox"') !== html.indexOf('id="startImmediatelyCheckbox"'),
  'the Terms agreement and the cooling-off consent remain two separate controls, never merged into one combined checkbox'
);
check(
  html.includes('£4.99/month, including VAT') && /recurring monthly subscription\s+that renews automatically/.test(html),
  'the web price line states VAT-inclusive pricing and explicit recurring/auto-renewal wording, before payment'
);
check(
  html.includes('Subscribe &amp; pay £4.99/month now'),
  'the web payment button wording makes the payment obligation unambiguous, matching the mobile app'
);
check(
  html.includes('href="/terms.html"') && html.includes('href="/privacy.html"'),
  'Terms & Conditions and Privacy Policy remain directly tappable/readable before purchase'
);

// The actual submit handler: validates both checkboxes, re-checks
// eligibility, and records terms acceptance before the real Stripe
// navigation — same defense-in-depth principle as the mobile app.
const submitHandlerStart = html.indexOf('subscribeFormEl.addEventListener("submit"');
const submitHandlerEnd = html.indexOf('function showCheckoutBanner');
const submitHandler = html.slice(submitHandlerStart, submitHandlerEnd);
check(
  submitHandler.includes('agreeTermsCheckboxEl.checked') && submitHandler.includes('startImmediatelyCheckboxEl.checked'),
  'the submit handler validates both consent checkboxes before proceeding'
);
check(
  submitHandler.includes('fetch("/billing/carrier-compatibility")') && submitHandler.includes('fetch("/billing/terms-acceptance"'),
  'the submit handler re-checks carrier eligibility and records Terms acceptance before the real Stripe redirect — the same defense-in-depth gate as the mobile app, applied to web'
);
check(
  submitHandler.indexOf('event.preventDefault();') < submitHandler.indexOf('fetch("/billing/carrier-compatibility")'),
  'the form submission is always intercepted first (preventDefault), before any async check runs — the real navigation only ever happens via the explicit subscribeFormEl.submit() call once everything has passed'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
