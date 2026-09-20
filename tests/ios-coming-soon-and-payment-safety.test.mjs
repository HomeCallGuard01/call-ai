// Android/landline launch — payment-safety proof (2026-09-19). This is
// the hard launch requirement from the launch instruction: prove, with
// tests, the exact ALLOW/BLOCK matrix, that IOS_COMING_SOON blocks new
// iPhone customers, and that eligible Android/landline customers can
// pay. Exercises the real evaluateHouseholdCheckoutEligibility/
// evaluateProviderCompatibility functions directly (the same ones both
// checkout routes call) — this is the "manipulated direct POST" level of
// proof: a household shaped exactly like an attacker-crafted request
// body, not just what the UI happens to send.
//
// Run with: node tests/ios-coming-soon-and-payment-safety.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// Force a clean module load per IOS_COMING_SOON value — featureFlags.js
// reads process.env at call time (not at require time), so toggling the
// env var between blocks is sufficient; no cache-busting needed. Stated
// explicitly here because getting this wrong (reading it once at import)
// would make the whole flag pointless.
function withIosComingSoon(value, fn) {
  const previous = process.env.IOS_COMING_SOON;
  if (value === undefined) delete process.env.IOS_COMING_SOON;
  else process.env.IOS_COMING_SOON = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.IOS_COMING_SOON;
    else process.env.IOS_COMING_SOON = previous;
  }
}

const { evaluateHouseholdCheckoutEligibility } = require('../services/providerPolicy.js');

// ============================================================
// The exact required matrix — BLOCK list
// ============================================================

withIosComingSoon('true', () => {
  const blockCases = [
    { label: 'Vodafone PAYG', household: { device_type: 'mobile', carrier_provider_key: 'vodafone', carrier_tariff_type: 'payg' } },
    { label: 'Tesco Mobile', household: { device_type: 'mobile', carrier_provider_key: 'tesco' } },
    { label: '1pMobile', household: { device_type: 'mobile', carrier_provider_key: '1pmobile' } },
    { label: 'VOXI', household: { device_type: 'mobile', carrier_provider_key: 'voxi' } },
    { label: 'Lyca Mobile', household: { device_type: 'mobile', carrier_provider_key: 'lyca' } },
    { label: 'ASDA Mobile', household: { device_type: 'mobile', carrier_provider_key: 'asda' } },
    { label: 'Other/unknown ("other")', household: { device_type: 'mobile', carrier_provider_key: 'other' } },
    { label: 'Other/unknown (a genuinely unrecognised key)', household: { device_type: 'mobile', carrier_provider_key: 'some-network-nobody-has-heard-of-xyz' } },
    { label: 'Other/unknown (no carrier captured at all)', household: { device_type: 'mobile', carrier_provider_key: null } },
  ];
  for (const { label, household } of blockCases) {
    const result = evaluateHouseholdCheckoutEligibility(household);
    check(result.canProceedToPayment === false, `${label}: cannot pay (canProceedToPayment === false)`);
  }
});

// ============================================================
// The exact required matrix — ALLOW list
// ============================================================

withIosComingSoon('true', () => {
  const allowCases = [
    { label: 'O2', household: { device_type: 'mobile', carrier_provider_key: 'o2' } },
    { label: 'Vodafone Pay Monthly', household: { device_type: 'mobile', carrier_provider_key: 'vodafone', carrier_tariff_type: 'pay_monthly' } },
    { label: 'giffgaff', household: { device_type: 'mobile', carrier_provider_key: 'giffgaff' } },
    { label: 'EE', household: { device_type: 'mobile', carrier_provider_key: 'ee' } },
    { label: 'Three', household: { device_type: 'mobile', carrier_provider_key: 'three' } },
    { label: 'Sky Mobile', household: { device_type: 'mobile', carrier_provider_key: 'sky' } },
    { label: 'SMARTY', household: { device_type: 'mobile', carrier_provider_key: 'smarty' } },
    { label: 'iD Mobile', household: { device_type: 'mobile', carrier_provider_key: 'id_mobile' } },
    { label: 'Talkmobile', household: { device_type: 'mobile', carrier_provider_key: 'talkmobile' } },
    { label: 'Lebara', household: { device_type: 'mobile', carrier_provider_key: 'lebara' } },
  ];
  for (const { label, household } of allowCases) {
    const result = evaluateHouseholdCheckoutEligibility(household);
    check(result.canProceedToPayment === true, `${label}: can proceed to payment`);
  }
});

// Lebara specifically: confirm the internal contradictory-documentation
// note survives, per the explicit launch requirement ("retain an
// internal note that provider documentation has been contradictory").
{
  const { PROVIDER_POLICY } = require('../services/providerPolicy.js');
  const lebaraSource = readFileSync(path.join(__dirname, '..', 'services', 'providerPolicy.js'), 'utf8');
  check(PROVIDER_POLICY.lebara.status === 'compatible', 'Lebara: PROVIDER_POLICY status is compatible (physical HCG test)');
  check(
    /conflicting secondary sources/i.test(lebaraSource) || /secondary-sourced-only entry below this comment/i.test(lebaraSource),
    'Lebara: the code retains an internal note that provider documentation was contradictory, not just a bare "compatible" with no history'
  );
}

// ============================================================
// iPhone / IOS_COMING_SOON — new customers cannot pay while the flag is on
// ============================================================

withIosComingSoon('true', () => {
  const result = evaluateHouseholdCheckoutEligibility({ device_type: 'iphone' });
  check(result.canProceedToPayment === false, 'iphone device_type, IOS_COMING_SOON=true (default): cannot pay');
  check(result.customerState === 'ios_coming_soon', 'iphone device_type, flag on: customerState is the distinct "ios_coming_soon" value, not conflated with a carrier-unsupported state');
});

withIosComingSoon(undefined, () => {
  const result = evaluateHouseholdCheckoutEligibility({ device_type: 'iphone' });
  check(result.canProceedToPayment === false, 'iphone device_type, IOS_COMING_SOON unset (default true): still blocked — fails toward "not available" by default, never accidentally open');
});

// A manipulated request that also claims a real, supported carrier must
// still be blocked while device_type is iphone — the point isn't
// carrier compatibility, it's that iPhone purchasing isn't open at all.
withIosComingSoon('true', () => {
  const result = evaluateHouseholdCheckoutEligibility({ device_type: 'iphone', carrier_provider_key: 'o2' });
  check(result.canProceedToPayment === false, 'iphone device_type with a manipulated, otherwise-supported carrier attached: still blocked — the carrier field cannot be used to bypass the iOS gate');
});

// Removal proof: once the flag is off, an iphone household falls through
// to the normal mobile-carrier evaluation, exactly as designed.
withIosComingSoon('false', () => {
  const blockedByCarrier = evaluateHouseholdCheckoutEligibility({ device_type: 'iphone', carrier_provider_key: 'tesco' });
  check(blockedByCarrier.canProceedToPayment === false, 'IOS_COMING_SOON=false: an iphone household now falls through to the real carrier gate, and an unsupported carrier is still blocked for the ordinary reason');
  const allowedByCarrier = evaluateHouseholdCheckoutEligibility({ device_type: 'iphone', carrier_provider_key: 'o2' });
  check(allowedByCarrier.canProceedToPayment === true, 'IOS_COMING_SOON=false: an iphone household with a supported carrier can now proceed — this is the entire "restore iPhone purchasing" removal step, no other code change needed');
});

// ============================================================
// Eligible Android and landline customers can pay
// ============================================================

withIosComingSoon('true', () => {
  const android = evaluateHouseholdCheckoutEligibility({ device_type: 'mobile', carrier_provider_key: 'o2' });
  check(android.canProceedToPayment === true, 'eligible Android customer (device_type mobile, supported carrier): can pay');

  const landline = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: 'bt' });
  check(landline.canProceedToPayment === true, 'eligible landline customer (a named, supported provider — 2026-09-19): can pay');
  check(landline.status === 'not_applicable', 'landline: status is not_applicable — the mobile carrier gate genuinely does not run, not merely "passed"');

  const unsupportedLandline = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: 'other' });
  check(unsupportedLandline.canProceedToPayment === false, 'landline "Other/not sure": cannot pay (2026-09-19 launch-safety correction — was previously waved through unconditionally)');
});

// ============================================================
// Landline provider matrix — the exact required proof
// ============================================================

withIosComingSoon('true', () => {
  for (const provider of ['bt', 'sky', 'virgin', 'talktalk', 'plusnet']) {
    const result = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: provider });
    check(result.canProceedToPayment === true, `landline provider "${provider}": can proceed to payment`);
  }

  const other = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: 'other' });
  check(other.canProceedToPayment === false, 'landline "Other/not sure": cannot reach Stripe');
  check(other.customerState === 'landline_provider_unsupported', 'landline "Other/not sure": customerState is landline_provider_unsupported, distinct from every other blocked state');

  const missing = evaluateHouseholdCheckoutEligibility({ device_type: 'landline' });
  check(missing.canProceedToPayment === false, 'landline with a missing provider value: cannot reach Stripe');

  const nullProvider = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: null });
  check(nullProvider.canProceedToPayment === false, 'landline with an explicit null provider: cannot reach Stripe');

  const unknown = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: 'some-manipulated-value-xyz' });
  check(unknown.canProceedToPayment === false, 'landline with a manipulated/unrecognised provider value: cannot reach Stripe');

  const mobileKeyLeaked = evaluateHouseholdCheckoutEligibility({ device_type: 'landline', carrier_provider_key: 'o2' });
  check(mobileKeyLeaked.canProceedToPayment === false, 'landline with a real mobile-carrier key ("o2", never a valid landline provider) attached: cannot reach Stripe — no cross-namespace trust between mobile and landline provider keys');
});

// An unsupported landline provider joining the waiting list must never
// create a subscription, entitlement, or Twilio provisioning — proven
// by construction: insertWaitingListSignup (the only function the
// waiting-list route calls) has no import of, or call to, Stripe,
// RevenueCat, Twilio, or any entitlement/billing function.
{
  const waitingListDbSource = readFileSync(path.join(__dirname, '..', 'database', 'waitingList.js'), 'utf8');
  check(
    !/stripe|revenuecat|twilio|entitlement|subscription/i.test(waitingListDbSource),
    'database/waitingList.js has no reference to Stripe, RevenueCat, Twilio, entitlements, or subscriptions anywhere — a waiting-list signup structurally cannot create any of them'
  );
}
{
  const serverWaitingListIdx2 = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = serverWaitingListIdx2.indexOf('app.post("/api/v1/waiting-list"');
  const routeBody = serverWaitingListIdx2.slice(routeStart, serverWaitingListIdx2.indexOf('\napp.', routeStart + 10));
  check(
    !/stripe|revenuecat|twilio|grantComplimentaryEntitlement|createCheckoutSession/i.test(routeBody),
    'the POST /api/v1/waiting-list route body itself never references Stripe/RevenueCat/Twilio/entitlement-granting — it only ever calls insertWaitingListSignup'
  );
}

// Do not infer compatibility from the underlying host network of an MVNO
// — explicit launch requirement. Proven by construction: getProviderPolicy
// only ever keys on the literal provider string supplied; there is no
// lookup table or logic anywhere mapping an MVNO to its host network.
{
  const providerPolicySource = readFileSync(path.join(__dirname, '..', 'services', 'providerPolicy.js'), 'utf8');
  check(
    !/host.?network|underlying network|mvno/i.test(providerPolicySource),
    'no code path infers compatibility from an MVNO\'s underlying host network — PROVIDER_POLICY has no such concept at all'
  );
}

// ============================================================
// Route wiring — the checkout gate runs server-side, immediately before
// Stripe, for both web and mobile; the onboarding capture routes accept
// deviceType "iphone"; the waiting-list and launch-flags routes exist,
// are unauthenticated, and validate input.
// ============================================================

const billingSource = readFileSync(path.join(__dirname, '..', 'routes', 'billing.js'), 'utf8');
const mobileApiSource = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

check(
  billingSource.includes('deviceType !== "mobile" && deviceType !== "landline" && deviceType !== "iphone"'),
  'web onboarding capture route (POST /billing/carrier-compatibility) accepts deviceType "iphone" alongside "mobile"/"landline"'
);
check(
  mobileApiSource.includes('deviceType !== "mobile" && deviceType !== "landline" && deviceType !== "iphone"'),
  'mobile onboarding capture route (POST /api/v1/onboarding/carrier-compatibility) accepts deviceType "iphone" too'
);

// The checkout gate itself (POST /billing/create-checkout-session,
// POST /api/v1/billing/create-checkout-session) already runs
// evaluateHouseholdCheckoutEligibility(req.household) before any Stripe
// call — proven in tests/billing-carrier-gate.test.mjs and
// tests/mobile-carrier-gate.test.mjs for the landline case; since the
// iphone branch lives inside that exact same function, no separate
// route change was needed there, and no separate re-proof of ordering
// is needed here — confirmed by construction (services/providerPolicy.js
// change only), and directly by the unit tests above.

check(
  serverSource.includes('app.get("/api/v1/launch-flags"'),
  'GET /api/v1/launch-flags is declared'
);
check(
  serverSource.includes('res.json({ iosComingSoon: isIosComingSoon() });'),
  'GET /api/v1/launch-flags returns the real, live isIosComingSoon() value — never a hardcoded true/false'
);
{
  const launchFlagsIdx = serverSource.indexOf('app.get("/api/v1/launch-flags"');
  const launchFlagsBlock = serverSource.slice(launchFlagsIdx, launchFlagsIdx + 300);
  check(
    !/requireAuth|requireAuthApi/.test(launchFlagsBlock),
    'GET /api/v1/launch-flags requires no authentication — a prospective, not-yet-signed-up visitor (the homepage banner) must be able to read it'
  );
}

check(
  serverSource.includes('app.post("/api/v1/waiting-list"'),
  'POST /api/v1/waiting-list is declared'
);
{
  const waitingListIdx = serverSource.indexOf('app.post("/api/v1/waiting-list"');
  const waitingListBlock = serverSource.slice(waitingListIdx, serverSource.indexOf('\napp.', waitingListIdx + 10));
  check(
    !/requireAuth|requireAuthApi/.test(waitingListBlock),
    'POST /api/v1/waiting-list requires no authentication — a prospective customer has no session yet'
  );
  check(
    waitingListBlock.includes('WAITING_LIST_REASONS.has(reason)'),
    'the waiting-list route validates reason against a known set, rejecting anything else'
  );
  check(
    waitingListBlock.includes('email.indexOf("@") === -1'),
    'the waiting-list route validates the email looks like an email before ever writing it'
  );
  check(
    waitingListBlock.includes("reason === \"unsupported_carrier\" && typeof providerKey"),
    'providerKey is only ever stored for the unsupported_carrier reason, never attached to an unrelated reason regardless of what the client sends'
  );
}
check(
  serverSource.includes('const WAITING_LIST_REASONS = new Set(["ios_coming_soon", "unsupported_carrier"]);'),
  'exactly the two required waiting-list reasons are supported — one reusable mechanism, not a bespoke table per reason'
);

// ============================================================
// Website (upload.html) — iPhone option, coming-soon panel, waiting
// list, and no path from iPhone selection to Stripe
// ============================================================

const uploadHtmlSource = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');

check(
  /<input type="radio" name="carrierDeviceType" id="carrierDeviceIphone" value="iphone">[\s\S]{0,200}?iPhone — Coming soon/.test(uploadHtmlSource),
  'upload.html\'s device-type picker retains an iPhone option (radio input unchanged: name/id/value), clearly marked "Coming soon" (2026-09-20: markup restyled into a tappable card — see .option-card CSS — but the underlying radio input and its label text are unchanged)'
);
check(
  uploadHtmlSource.includes('id="iosComingSoonMessage"') &&
    uploadHtmlSource.includes('Home Call Guard for iPhone is coming soon') &&
    uploadHtmlSource.includes("We're waiting for final approval of our iPhone app. Home Call Guard isn't currently available for new iPhone customers.") &&
    uploadHtmlSource.includes('Join the waiting list and we\'ll let you know as soon as it\'s available.'),
  'upload.html has the exact required coming-soon copy'
);
check(
  uploadHtmlSource.includes('id="iosWaitingListForm"') && uploadHtmlSource.includes('id="iosWaitingListEmail"') && uploadHtmlSource.includes('id="iosWaitingListSubmit"'),
  'upload.html has a simple email waiting-list signup form for the iPhone coming-soon state'
);

const evalFnStart = uploadHtmlSource.indexOf('async function evaluateCarrierCompatibility()');
const evalFnEnd = uploadHtmlSource.indexOf('\n  if (checkCarrierButtonEl) {', evalFnStart);
const evalFnBody = uploadHtmlSource.slice(evalFnStart, evalFnEnd);
check(
  evalFnBody.includes('if (isIphone) {') && evalFnBody.indexOf('if (isIphone) {') < evalFnBody.indexOf('const isMobile ='),
  'the iPhone branch is checked and returns before the mobile/landline carrier logic ever runs, for deviceType "iphone"'
);
check(
  evalFnBody.includes('checkCarrierButtonEl.hidden = true') && evalFnBody.indexOf("result.customerState === \"ios_coming_soon\"") !== -1,
  'selecting iPhone and confirming ios_coming_soon hides Continue — the same mechanism that already keeps every other blocked state away from Stripe'
);
check(
  !/subscribeFormEl\.submit\(\)/.test(evalFnBody),
  'the iPhone branch of evaluateCarrierCompatibility never calls subscribeFormEl.submit() — no path from here reaches the real Stripe navigation'
);

// ============================================================
// Mobile app source (not built into any binary yet — see
// docs/launch/IOS_COMING_SOON_LAUNCH_FLAG.md) — iPhone option retained
// and clearly marked, routes to a dead end, never reaches Subscribe.
// ============================================================

const devicePickerSource = readFileSync(path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'device-picker.tsx'), 'utf8');

check(
  devicePickerSource.includes('{ type: "iphone", label: "iPhone — Coming soon", iconSource: require("../../assets/iphone-device-mark.png") }'),
  'mobile device-picker.tsx retains the iPhone option, clearly marked "Coming soon" (2026-09-20: icon changed from the generic Ionicons Apple-logo glyph to a non-trademarked device silhouette — see tests/device-picker-platform-icons.test.mjs — but the option itself and its label are unchanged)'
);
check(
  devicePickerSource.includes('if (type === "iphone") {') &&
    devicePickerSource.includes('setStep({ name: "ios-coming-soon" });'),
  'selecting iPhone on mobile routes to its own dead-end step'
);
{
  const selectDeviceStart = devicePickerSource.indexOf('function selectDevice(type: DeviceType) {');
  const selectDeviceEnd = devicePickerSource.indexOf('\n  }', selectDeviceStart);
  const selectDeviceBody = devicePickerSource.slice(selectDeviceStart, selectDeviceEnd);
  check(
    !selectDeviceBody.includes('subscribe'),
    'selectDevice itself never navigates to Subscribe for any branch — landline and iphone both dead-end into their own steps, and mobile/android only ever reaches "carrier" (which has its own separate, already-tested gate) — confirms no direct iPhone-to-Subscribe path exists in this function'
  );
}

// ============================================================
// Landline provider — website and mobile UI wiring
// ============================================================

check(
  uploadHtmlSource.includes('id="carrierLandlineProviderRow"') &&
    uploadHtmlSource.includes('id="carrierLandlineProviderSelect"') &&
    ['bt', 'sky', 'virgin', 'talktalk', 'plusnet', 'other'].every(v => uploadHtmlSource.includes(`<option value="${v}">`)),
  'upload.html has a landline provider selector offering all five supported providers plus Other/not sure'
);
check(
  uploadHtmlSource.includes('id="landlineProviderUnsupportedMessage"') &&
    uploadHtmlSource.includes("We don't currently have confirmed setup instructions for your landline provider. Join our waiting list and we'll let you know when your provider is supported."),
  'upload.html has the exact required unsupported-landline-provider copy'
);
check(
  uploadHtmlSource.includes('id="landlineWaitingListForm"') && uploadHtmlSource.includes('id="landlineWaitingListEmail"') && uploadHtmlSource.includes('id="landlineWaitingListSubmit"'),
  'upload.html has a simple email waiting-list signup form for the unsupported-landline-provider state'
);

const landlineBranchStart = evalFnBody.indexOf('if (!isMobile) {');
const landlineBranchEnd = evalFnBody.indexOf('\n    }', landlineBranchStart);
const landlineBranchBody = evalFnBody.slice(landlineBranchStart, landlineBranchEnd);
check(
  landlineBranchBody.includes('if (!landlineProvider)') && landlineBranchBody.includes('Please choose your landline provider.'),
  'upload.html requires a landline provider to be chosen before ever calling the backend'
);
check(
  landlineBranchBody.includes('body: JSON.stringify({ deviceType: "landline", provider: landlineProvider })'),
  'upload.html sends the actual chosen landline provider to the backend — it used to send deviceType alone with no provider at all'
);
check(
  landlineBranchBody.includes('result.customerState === "landline_provider_unsupported"') &&
    landlineBranchBody.includes('checkCarrierButtonEl.hidden = true') &&
    landlineBranchBody.includes('landlineProviderUnsupportedMessageEl.hidden = false'),
  'upload.html hides Continue and shows the unsupported-provider panel for landline_provider_unsupported — the same mechanism as every other blocked state, never a bypass'
);
check(
  !/subscribeFormEl\.submit\(\)/.test(landlineBranchBody),
  'the landline branch of evaluateCarrierCompatibility never calls subscribeFormEl.submit() directly — no path from here reaches Stripe except through handleCarrierCheckSuccess after a real "supported" verdict'
);

check(
  devicePickerSource.includes('const result = await setHouseholdLandline(provider, session?.access_token)') &&
    devicePickerSource.includes('setStep({ name: "landline-provider-unsupported", provider });'),
  'mobile device-picker.tsx sends the chosen landline provider server-side and routes an unsupported verdict to its own dead-end step, never straight to Subscribe'
);
{
  const landlineFnStart2 = devicePickerSource.indexOf('async function selectLandlineProvider(provider: LandlineProvider) {');
  const landlineFnEnd2 = devicePickerSource.indexOf('\n  }', landlineFnStart2);
  const landlineFnBody2 = devicePickerSource.slice(landlineFnStart2, landlineFnEnd2);
  check(
    !/router\.push\("\/\(setup\)\/subscribe"\)/.test(landlineFnBody2.slice(0, landlineFnBody2.indexOf('result.customerState'))),
    'mobile selectLandlineProvider never navigates to Subscribe before the server evaluation result is checked — the persist-then-check-then-navigate ordering is real, not cosmetic'
  );
}

// ============================================================
// Raw internal provider-policy reason strings cannot appear in customer
// UI — 2026-09-19 fix found via the live walkthrough. Every PROVIDER_
// POLICY.reason value is written as an internal audit citation (e.g.
// "No network-level call forwarding (official Tesco Mobile support
// account, direct statement)") — genuinely never meant for a customer
// to read verbatim. This is a live regression test, not just a re-check
// of an already-fixed spot: it asserts against every actual reason
// string in PROVIDER_POLICY, not a hand-picked example.
// ============================================================

{
  const { PROVIDER_POLICY: policyForLeakCheck } = require('../services/providerPolicy.js');
  const notSupportedBranchStart = evalFnBody.indexOf('if (result.customerState === "needs_confirmation")');
  const notSupportedBranchBody = evalFnBody.slice(notSupportedBranchStart);
  check(
    !notSupportedBranchBody.replace(/\/\/.*$/gm, '').includes('result.reason'),
    'upload.html\'s primary carrier-check "not currently supported" branch no longer reads result.reason in actual code (comments excluded) — the single most commonly hit path for any blocked mobile carrier'
  );
  // Directly proves no real PROVIDER_POLICY reason string appears
  // anywhere in the fixed customer-facing text this branch now shows.
  const fixedMessageMatch = notSupportedBranchBody.match(/carrierNotSupportedTextEl\.textContent = "([^"]+)"/);
  check(!!fixedMessageMatch, 'a fixed (not template-built from result.reason) message string exists for this branch');
  if (fixedMessageMatch) {
    const fixedMessage = fixedMessageMatch[1];
    for (const key of Object.keys(policyForLeakCheck)) {
      const entryReason = policyForLeakCheck[key].reason;
      if (entryReason) {
        check(fixedMessage !== entryReason, `the fixed customer-facing message is not, verbatim, PROVIDER_POLICY.${key}'s internal reason string`);
      }
    }
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
