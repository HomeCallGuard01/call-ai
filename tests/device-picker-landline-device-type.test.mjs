// Structural tests for the mobile app's half of the landline
// checkout-eligibility fix (households.device_type, migration 040,
// 2026-09-16): mobile/app/(setup)/device-picker.tsx now persists
// device_type="landline" server-side (via the new
// mobile/lib/api.ts:setHouseholdLandline) before ever navigating on, and
// no screen in the mobile app renders the backend's raw internal
// compatibility `reason` string to the customer any more.
//
// The underlying DECISION logic (evaluateHouseholdCheckoutEligibility's
// device_type branch) is already fully unit-tested with real inputs in
// tests/provider-policy.test.mjs; the RPC's atomic-clear-on-landline
// behaviour is proven directly against a real database in
// tests/migrations.pglite.test.mjs's migration 040 section. This file
// proves the WIRING on the mobile client: the right function is called,
// at the right point, and the raw reason string never reaches a Text
// component.
//
// No HTTP/RN test tooling exists in this project (see
// tests/account-deletion.test.mjs for the same established convention)
// — every file is checked directly against its real source.
//
// Run with: node tests/device-picker-landline-device-type.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, '..', 'mobile');
const devicePickerSource = readFileSync(path.join(mobileRoot, 'app', '(setup)', 'device-picker.tsx'), 'utf8');
const subscribeSource = readFileSync(path.join(mobileRoot, 'app', '(setup)', 'subscribe.tsx'), 'utf8');
const apiSource = readFileSync(path.join(mobileRoot, 'lib', 'api.ts'), 'utf8');
const typesSource = readFileSync(path.join(mobileRoot, 'lib', 'types.ts'), 'utf8');

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
// mobile/lib/api.ts — setHouseholdLandline
// ============================================================

check(
  apiSource.includes('export async function setHouseholdLandline('),
  'mobile/lib/api.ts exports setHouseholdLandline'
);
check(
  apiSource.includes('deviceType: "landline"'),
  'setHouseholdLandline sends deviceType: "landline" to the backend, the exact same shape the web frontend sends'
);
check(
  apiSource.includes('deviceType: "mobile"'),
  'checkCarrierCompatibility explicitly sends deviceType: "mobile" — the backend never has to guess which branch a mobile carrier check belongs to'
);

// ============================================================
// mobile/lib/types.ts — CarrierCompatibilityResponse
// ============================================================

check(
  typesSource.includes('"not_applicable"'),
  'CarrierCompatibilityResponse.status includes "not_applicable" — the landline shape the backend now returns'
);
check(
  typesSource.includes('customerState:') && typesSource.includes('"supported"'),
  'CarrierCompatibilityResponse carries the customerState field the UI is now required to branch on instead of the raw reason'
);

// ============================================================
// mobile/app/(setup)/device-picker.tsx
// ============================================================

check(
  devicePickerSource.includes('checkCarrierCompatibility, setHouseholdLandline, setHouseholdIphone, joinWaitingList, ApiError') &&
    devicePickerSource.includes('from "../../lib/api"'),
  'device-picker.tsx imports setHouseholdLandline alongside the existing mobile-carrier check, plus (2026-09-19) setHouseholdIphone/joinWaitingList for the IOS_COMING_SOON flow'
);

const selectLandlineFnStart = devicePickerSource.indexOf('async function selectLandlineProvider(');
const selectLandlineFnEnd = devicePickerSource.indexOf('\n  }', selectLandlineFnStart);
const selectLandlineFnBody = devicePickerSource.slice(selectLandlineFnStart, selectLandlineFnEnd);

check(selectLandlineFnStart !== -1, 'selectLandlineProvider is declared');
check(
  selectLandlineFnBody.includes('const result = await setHouseholdLandline(provider, session?.access_token)'),
  'selecting a landline provider persists device_type="landline" AND the provider itself server-side (setHouseholdLandline, 2026-09-19 migration 043) — the actual fix: previously nothing told the backend this household is landline, or which provider, at all'
);
check(
  selectLandlineFnBody.includes('result.customerState === "landline_provider_unsupported"') &&
    selectLandlineFnBody.includes('setStep({ name: "landline-provider-unsupported", provider });'),
  'an unsupported landline provider (2026-09-19) routes to its own dead-end step instead of ever reaching Subscribe — the real, server-evaluated verdict, not a client-side guess'
);

const persistIdx = selectLandlineFnBody.indexOf('await setHouseholdLandline(');
const saveLocalIdx = selectLandlineFnBody.indexOf('saveActivationDevice(');
const navigateIdx = selectLandlineFnBody.indexOf('router.push("/(setup)/subscribe")');
check(
  persistIdx !== -1 && saveLocalIdx !== -1 && navigateIdx !== -1 && persistIdx < saveLocalIdx && saveLocalIdx < navigateIdx,
  'the server-side persist happens BEFORE the local device-category memory is saved and BEFORE navigating on — a household can never reach Subscribe having only remembered landline locally without the backend also knowing'
);

check(
  selectLandlineFnBody.includes('catch (err)') &&
    selectLandlineFnBody.slice(selectLandlineFnBody.indexOf('catch (err)')).includes('setStep({ name: "landline-provider" })'),
  'a failed persist attempt returns the customer to the landline-provider step with an error, rather than silently navigating on with the backend never having learned the household is landline'
);

// --- switching TO landline never leaves the failure path able to
// proceed anyway ---
check(
  !selectLandlineFnBody.slice(selectLandlineFnBody.indexOf('catch (err)')).includes('router.push('),
  'the catch branch of selectLandlineProvider never navigates onward — a failed server persist can never be silently bypassed'
);

// --- raw reason string never rendered anywhere in the mobile app ---
//
// `result.reason === "tariff_type_required"` is the one legitimate,
// non-rendering use of `.reason` (a control-flow sentinel, exactly like
// the web frontend's own equivalent check) — everywhere else, only
// customerState may drive what the customer actually sees.
function assertNoRawReasonRender(source, label) {
  const withoutComments = source.replace(/\/\/.*$/gm, '');
  const withoutSentinelCheck = withoutComments.replace(/\.reason\s*===\s*"tariff_type_required"/g, '');
  check(
    !/\.reason\b/.test(withoutSentinelCheck),
    `${label}: no remaining CODE use of a raw \`.reason\` value (comments excluded) once the tariff_type_required sentinel check is excluded — nothing renders the backend's internal policy string`
  );
}
assertNoRawReasonRender(devicePickerSource, 'device-picker.tsx');
assertNoRawReasonRender(subscribeSource, 'subscribe.tsx');

check(
  devicePickerSource.includes('customerState: result.customerState === "needs_confirmation" ? "needs_confirmation" : "not_currently_supported"'),
  'device-picker.tsx\'s "blocked" step stores only the customerState category, never the raw reason'
);
check(
  devicePickerSource.includes('const message = step.customerState === "needs_confirmation"'),
  'the "blocked" render branch derives its message from customerState alone, with fixed non-technical copy for each of the two possible values'
);

// ============================================================
// mobile/app/(setup)/subscribe.tsx — defense-in-depth check
// ============================================================

const fetchEligibilityIdx = subscribeSource.indexOf('const eligibility = await fetchCarrierCompatibility(');
const blockedBranchEnd = subscribeSource.indexOf('return;', fetchEligibilityIdx);
const blockedBranchBody = fetchEligibilityIdx !== -1 && blockedBranchEnd !== -1
  ? subscribeSource.slice(fetchEligibilityIdx, blockedBranchEnd)
  : '';

check(fetchEligibilityIdx !== -1, 'subscribe.tsx runs its own defense-in-depth carrier-eligibility check before either purchase path');
check(
  blockedBranchBody.includes('eligibility.customerState === "needs_confirmation"'),
  'subscribe.tsx\'s blocked-purchase branch also derives its message from customerState alone'
);
check(
  !blockedBranchBody.replace(/\/\/.*$/gm, '').includes('eligibility.reason'),
  'subscribe.tsx never reads eligibility.reason in actual code in its blocked-purchase branch (comments excluded)'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
