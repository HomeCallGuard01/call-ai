// Structural + functional tests for the 2026-09-16 cancellation-safety
// fix: cancelling an HCG subscription does NOT itself turn off call
// forwarding on the customer's phone, and the previous universal (and
// confirmed-wrong) #21# fallback must never be shown again. Covers:
//   - the new GET /deactivation-instructions (web) and
//     GET /api/v1/deactivation/instructions (mobile) routes, reachable
//     WITHOUT an active entitlement (a cancelled/lapsed customer needs
//     this precisely when they no longer have one)
//   - upload.html's three explicit customer states (supported /
//     not_currently_supported / needs_confirmation)
//   - the device-type de-duplication between the pre-payment Mobile/
//     Landline question and the post-payment iPhone/Android/landline one
//   - the cancellation/lapsed-membership copy itself
//   - landline never receiving a mobile GSM/MMI code, and vice versa
//   - existing-customer backwards compatibility (no carrier captured at
//     all still resolves safely, never crashes, never invents a code)
//
// Same conventions as the rest of this project: no HTTP test tooling,
// source read directly and asserted on; pure functions exercised
// directly via require(). See tests/web-carrier-onboarding-gate.test.mjs
// for the same idiom this file extends.
//
// Run with: node tests/cancellation-deactivation-safety.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mobileApiSource = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');

const { buildDeactivationInstructions, buildActivationInstructions } = require('../services/activationInstructions.js');
const { getMobileDeactivationInstructions } = require('../services/providerPolicy.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function blockFor(source, anchor, nextAnchorPattern) {
  const idx = source.indexOf(anchor);
  if (idx === -1) return { idx: -1, block: '' };
  const end = source.search(new RegExp(nextAnchorPattern, 'g'));
  // search() only finds the FIRST match in the whole string, which may be
  // before idx — re-scan starting just after the anchor instead.
  const re = new RegExp(nextAnchorPattern, 'g');
  re.lastIndex = idx + anchor.length;
  const m = re.exec(source);
  return { idx, block: source.slice(idx, m ? m.index : undefined) };
}

// ============================================================
// New endpoints: reachable WITHOUT requireEntitlement
// ============================================================

const webRoute = blockFor(serverSource, 'app.get("/deactivation-instructions"', '\\napp\\.');
check(webRoute.idx !== -1, 'web GET /deactivation-instructions is declared');
const webRouteFirstLine = webRoute.block.split('\n')[0];
check(
  webRouteFirstLine.includes('requireAuth') && !webRouteFirstLine.includes('requireEntitlement'),
  'web /deactivation-instructions requires auth but NOT entitlement — a cancelled/lapsed customer must still be able to reach it'
);
check(
  webRoute.block.includes('buildDeactivationInstructions(') && !webRoute.block.includes('buildActivationInstructions('),
  'web /deactivation-instructions calls buildDeactivationInstructions directly — never the Twilio-number-dependent activation builder'
);
check(
  !webRoute.block.includes('req.household.twilio_number'),
  'web /deactivation-instructions never reads/requires the household\'s Twilio number — deactivation guidance never needed it'
);

const mobileRoute = blockFor(mobileApiSource, 'router.get("/api/v1/deactivation/instructions"', '\\nrouter\\.');
check(mobileRoute.idx !== -1, 'mobile GET /api/v1/deactivation/instructions is declared');
const mobileRouteFirstLine = mobileRoute.block.split('\n')[0];
check(
  mobileRouteFirstLine.includes('requireAuthApi') && !mobileRouteFirstLine.includes('requireEntitlement'),
  'mobile /api/v1/deactivation/instructions requires auth but NOT entitlement, for the same reason as web'
);
check(
  mobileRoute.block.includes('buildDeactivationInstructions('),
  'mobile /api/v1/deactivation/instructions calls buildDeactivationInstructions directly'
);

// The existing activation route, by contrast, is UNCHANGED and still
// correctly requires entitlement — this fix adds a new route, it does
// not weaken the existing one.
const webActivationRoute = blockFor(serverSource, 'app.get("/activation-instructions"', '\\napp\\.');
check(
  webActivationRoute.block.split('\n')[0].includes('requireEntitlement'),
  'web /activation-instructions is untouched — still requireEntitlement-gated, since it needs the real Twilio number'
);

// ============================================================
// Three explicit customer states in the pre-payment carrier check
// ============================================================

check(
  html.includes('id="carrierNotSupportedMessage"') && html.includes('id="carrierNeedsConfirmationMessage"'),
  'upload.html has two distinct message elements — NOT_CURRENTLY_SUPPORTED and NEEDS_CONFIRMATION are never the same element/message'
);
check(
  !html.includes('id="carrierBlockedMessage"'),
  'the old single generic "blocked" message element has been replaced, not left dangling alongside the new ones'
);

const evalFnStart = html.indexOf('async function evaluateCarrierCompatibility()');
const evalFnEnd = html.indexOf('\n  if (checkCarrierButtonEl)', evalFnStart);
const evalFnBody = html.slice(evalFnStart, evalFnEnd);
check(
  evalFnBody.includes('result.customerState === "needs_confirmation"'),
  'the frontend branches on the backend-provided customerState field to choose which message to show — never re-derives the verdict itself'
);
check(
  evalFnBody.includes('carrierNeedsConfirmationMessageEl.hidden = false') && evalFnBody.includes('carrierNotSupportedMessageEl.hidden = false'),
  'both the needs_confirmation and not_currently_supported branches actually reveal their own distinct element'
);

check(
  html.includes('contact our support team') && html.includes('mailto:support@homecallguard.co.uk'),
  'the needs_confirmation message provides a real, concrete Contact Support route, not just a mention of the word "support"'
);

// ============================================================
// Device-type de-duplication (2026-09-16)
// ============================================================

check(
  html.includes('function rememberDeviceCategory(') && html.includes('function getRememberedDeviceCategory('),
  'the pre-payment Mobile/Landline answer is captured client-side for reuse'
);
check(
  html.includes('function applyRememberedDeviceToManualForm('),
  'the post-payment device-type step has a function that applies the remembered pre-payment answer'
);

const renderActivateStepStart = html.indexOf('function renderActivateStep()');
const renderActivateStepEnd = html.indexOf('\n  }', html.indexOf('detectedMobileDeviceType = detected;', renderActivateStepStart));
const renderActivateStepBody = html.slice(renderActivateStepStart, renderActivateStepEnd);
check(
  renderActivateStepBody.includes('getRememberedDeviceCategory()') && renderActivateStepBody.includes('rememberedCategory === "landline" ? null :'),
  'a remembered "landline" answer overrides user-agent detection — a landline customer completing setup from an iPhone/Android browser is never shown the one-tap mobile dialer flow for the wrong phone'
);
check(
  renderActivateStepBody.includes('applyRememberedDeviceToManualForm(rememberedCategory)'),
  'the manual form is told about the remembered answer whenever it is shown'
);

const applyFnStart = html.indexOf('function applyRememberedDeviceToManualForm(rememberedCategory) {');
const applyFnEnd = html.indexOf('\n  }', html.indexOf('No remembered answer', applyFnStart));
const applyFnBody = html.slice(applyFnStart, applyFnEnd);
check(
  applyFnBody.includes('deviceTypeQuestionRowEl.hidden = true') && applyFnBody.includes('rememberedCategory === "landline"'),
  'a remembered landline answer hides the "what are you forwarding calls from" question entirely — it is never re-asked'
);
check(
  applyFnBody.includes('landlineOption.hidden = true') && applyFnBody.includes('rememberedCategory === "mobile"'),
  'a remembered mobile answer removes the already-ruled-out "Home landline" option, but still asks iPhone vs Android — genuinely new information, not a repeat'
);
check(
  html.includes('id="deviceTypeChangeButton"'),
  'a "Change" affordance exists — the remembered answer is never a one-way trap if it was wrong'
);

// ============================================================
// Cancellation copy — the actual safety-critical wording
// ============================================================

check(
  html.includes('Cancelling your membership stops future payments'),
  'the cancellation message still describes the billing consequence (unchanged, still true)'
);
check(
  /does NOT automatically turn off call forwarding/.test(html),
  'the cancellation message now explicitly states forwarding is NOT automatically turned off — the actual safety-critical fact that was previously entirely missing'
);
check(
  html.includes('id="membershipDeactivationHelp"') && html.includes('id="membershipShowDeactivationButton"'),
  'a real, actionable "turn off call forwarding" control exists on the membership/cancellation screen, not just a warning with nowhere to go'
);
check(
  html.includes('id="unsubscribedDeactivationHelp"') && html.includes('id="unsubscribedShowDeactivationButton"'),
  'the same help is also reachable from the lapsed/unsubscribed dashboard state — the one screen /dashboard-data\'s requireEntitlement gate would otherwise leave with no help at all'
);

// setStatus must actually reveal the lapsed help for the "unsubscribed"
// state (not just have the markup exist, unreachable).
const setStatusStart = html.indexOf('function setStatus(state) {');
const setStatusEnd = html.indexOf('// TEST-EXTRACT-END: setStatus', setStatusStart);
const setStatusBody = html.slice(setStatusStart, setStatusEnd);
check(
  setStatusBody.includes('unsubscribedDeactivationHelp.hidden = state !== "unsubscribed"'),
  'setStatus() actually wires up visibility for the lapsed-state deactivation help — not just declared in markup but genuinely shown/hidden by state'
);

// ============================================================
// Never invents a code — the core regression this whole fix exists to
// prevent. Exercised directly against the real pure functions, not
// re-implemented here.
// ============================================================

{
  const result = buildDeactivationInstructions({ deviceType: 'iphone', carrier: undefined });
  check(result.cancelCode === null, 'an iPhone customer with no captured carrier: no code is invented');
  check(result.cancelCode !== '#21#' && result.cancelCode !== '##21#', 'never the old, confirmed-wrong universal #21#/##21# fallback');
}

{
  // Cancellation -> Vodafone gets confirmed appropriate removal instructions
  const result = buildDeactivationInstructions({ deviceType: 'android', carrier: 'vodafone' });
  check(result.cancelCode === '##002#', 'Cancellation -> Vodafone: the confirmed, first-party removal code is shown');
  check(result.cancelCodeConfidence === 'high', 'Cancellation -> Vodafone: confidence is high, matching the first-party source');
}

{
  // Cancellation -> a provider with unknown deactivation method does NOT
  // receive an invented code (EE: compatibility confirmed, deactivation
  // code explicitly unresolved by the audit).
  const result = buildDeactivationInstructions({ deviceType: 'iphone', carrier: 'ee' });
  check(result.cancelCode === null, 'Cancellation -> EE: no deactivation code is invented — the audit never confirmed one');
  check(result.cancelCodeMethod !== 'native_settings', 'Cancellation -> EE: not wrongly categorised as native_settings either — it is genuinely "unknown", not "broken MMI"');
}

{
  // Cancellation -> landline never receives a mobile GSM/MMI code, and
  // the reverse — a landline provider value has zero effect on a mobile
  // deviceType.
  const landline = buildDeactivationInstructions({ deviceType: 'landline', provider: 'bt' });
  check(landline.cancelCode === '#21#', 'Cancellation -> landline (BT): the landline-specific #21# is shown');
  const mobileWithLeftoverProvider = buildDeactivationInstructions({ deviceType: 'iphone', carrier: 'bt' });
  check(
    mobileWithLeftoverProvider.cancelCode !== '#21#',
    'a landline provider key ("bt") accidentally passed as a mobile carrier has no special meaning and does not leak the landline code — it just resolves as an unrecognised network (no code)'
  );
}

{
  // Existing customer / backwards compatibility: a household from before
  // carrier capture existed has no carrier_provider_key at all — must
  // resolve safely, not throw, not invent anything.
  const result = getMobileDeactivationInstructions(undefined);
  check(result.code === null, 'existing customer with no carrier ever captured: no code is invented');
  check(typeof result.note === 'string' && result.note.length > 0, 'existing customer with no carrier ever captured: still gets an honest explanatory note, not a blank/broken response');
}

{
  // buildActivationInstructions (the full activation flow, still
  // requireEntitlement-gated and unchanged in shape) must produce the
  // exact same cancelCode fields as the new deactivation-only function —
  // they now share one implementation, not two that could drift apart.
  const full = buildActivationInstructions({ twilioNumber: '+442012345678', deviceType: 'android', carrier: 'sky' });
  const deactivationOnly = buildDeactivationInstructions({ deviceType: 'android', carrier: 'sky' });
  check(
    full.cancelCode === deactivationOnly.cancelCode && full.cancelCodeMethod === deactivationOnly.cancelCodeMethod,
    'buildActivationInstructions and buildDeactivationInstructions agree exactly — one shared implementation, not two that could silently diverge'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
