// Regression tests for the mobile app's LANDLINE "COMING SOON" state
// (2026-09-21). The BACKEND flag LANDLINE_COMING_SOON is authoritative
// (services/featureFlags.js, published as `landlineComingSoon` by
// GET /api/v1/launch-flags, enforced at every server-side checkout gate — see
// tests/landline-coming-soon-backend.test.mjs). The app holds no independent
// availability decision: it follows the server and FAILS CLOSED.
//
// Proven here:
//   - the fail-closed rule and the flag store are EXECUTED (not just
//     pattern-matched) against failing, hanging, malformed and field-less
//     launch-flags responses: landline is only ever open after an explicit
//     `landlineComingSoon === false`
//   - every screen that offers or gates landline is wired to that one shared
//     state (device picker, Subscribe, Activate, Account -> Set up call
//     forwarding), each with its own guard so a stale stored "landline" device
//     cannot reach payment/instructions
//   - the underlying landline implementation is KEPT, Turn off protection is
//     never gated, and the iPhone Coming soon / Android flows are untouched
//
// Same convention as the rest of this project (no RN test tooling): screens
// are checked as source; the pure logic is executed.
//
// Run with: node tests/mobile-landline-coming-soon.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, '..', 'mobile');
const read = (...p) => readFileSync(path.join(mobileRoot, ...p), 'utf8');

const gateSource = read('lib', 'landlineAvailability.ts');
const flagSource = read('lib', 'landlineFlag.ts');
const componentSource = read('components', 'LandlineComingSoon.tsx');
const pickerSource = read('app', '(setup)', 'device-picker.tsx');
const subscribeSource = read('app', '(setup)', 'subscribe.tsx');
const activateSource = read('app', '(setup)', 'activate.tsx');
const verifySource = read('app', '(setup)', 'verify.tsx');
const forwardingSource = read('app', '(tabs)', 'account', 'set-up-call-forwarding.tsx');
const turnOffSource = read('app', '(tabs)', 'account', 'turn-off-protection.tsx');
const supportSource = read('app', '(tabs)', 'account', 'support.tsx');
const homeSource = read('app', '(tabs)', 'index.tsx');
const apiSource = read('lib', 'api.ts');
const rootPackage = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

// ============================================================
// 1. The fail-closed rule (executed)
// ============================================================
const gate = await import(pathToFileURL(path.join(mobileRoot, 'lib', 'landlineAvailability.ts')).href);

check(gate.resolveLandlineComingSoon({ iosComingSoon: true, landlineComingSoon: false }) === false, 'only an explicit landlineComingSoon === false opens landline');
check(gate.resolveLandlineComingSoon({ landlineComingSoon: true }) === true, 'landlineComingSoon: true => Coming soon');
for (const [label, value] of [
  ['null', null], ['undefined', undefined], ['{}', {}], ['[]', []], ['a string', 'false'], ['a number', 0],
  ['{ iosComingSoon: false } — an older server that does not send the field', { iosComingSoon: false }],
  ['landlineComingSoon: "false" (string)', { landlineComingSoon: 'false' }],
  ['landlineComingSoon: 0', { landlineComingSoon: 0 }],
  ['landlineComingSoon: null', { landlineComingSoon: null }],
  ['landlineComingSoon: undefined', { landlineComingSoon: undefined }],
  ['landlineComingSoon: "FALSE"', { landlineComingSoon: 'FALSE' }],
]) {
  check(gate.resolveLandlineComingSoon(value) === true, `fail closed: ${label} => still Coming soon`);
}

check(gate.LANDLINE_CARD_LABEL_COMING_SOON === 'Landline — Coming soon', 'the marked card label reads exactly "Landline — Coming soon"');
check(gate.LANDLINE_CARD_LABEL_AVAILABLE === 'Landline', 'the un-marked label is only the original "Landline" (used only if the server opens landline)');
check(/coming soon/i.test(gate.LANDLINE_COMING_SOON_TITLE), 'the Coming-soon title says "coming soon"');
check(
  !/available now for landline|set up your landline|protect your landline/i.test(gate.LANDLINE_COMING_SOON_BODY) && /Android/.test(gate.LANDLINE_COMING_SOON_BODY),
  'the Coming-soon body never presents landline as available, and points to Android as what is available now'
);

// ============================================================
// 2. The flag store (executed) — failure, timeout, malformed, caching
// ============================================================
const makeStore = (fetchFlags, extra = {}) => gate.createLandlineFlagStore({ fetchFlags, timeoutMs: 40, ...extra });

{
  const store = makeStore(async () => ({ landlineComingSoon: false }));
  check(store.get() === true, 'store: before any answer, landline is Coming soon (fail closed from the very first frame)');
  const seen = [];
  store.subscribe((v) => seen.push(v));
  const value = await store.refresh();
  check(value === false && store.get() === false, 'store: after an explicit landlineComingSoon:false answer, landline opens');
  check(seen.length === 1 && seen[0] === false, 'store: subscribers are told when it opens');
}
{
  const store = makeStore(async () => { throw new Error('network down'); });
  check((await store.refresh()) === true && store.get() === true, 'store: launch-flags REQUEST FAILS => stays Coming soon');
}
{
  const store = makeStore(() => { throw new Error('sync throw'); });
  check((await store.refresh()) === true, 'store: a synchronous throw inside the fetch => Coming soon');
}
{
  const store = makeStore(() => new Promise(() => {})); // never answers
  const started = Date.now();
  const value = await store.refresh();
  check(value === true && store.get() === true && Date.now() - started < 1500, 'store: a HUNG request times out => Coming soon (never left open, never left waiting forever)');
}
{
  let release;
  const store = makeStore(() => new Promise((resolve) => { release = () => resolve({ landlineComingSoon: false }); }));
  const first = await store.refresh(); // times out at 40ms
  release(); // the answer arrives late, after the timeout already failed closed
  await new Promise((r) => setTimeout(r, 20));
  check(first === true && store.get() === true, 'store: an answer that arrives AFTER the timeout is ignored (stays Coming soon)');
}
{
  const store = makeStore(async () => '<html>502 Bad Gateway</html>');
  check((await store.refresh()) === true, 'store: a malformed / non-JSON-shaped response => Coming soon');
}
{
  const store = makeStore(async () => ({ iosComingSoon: true }));
  check((await store.refresh()) === true, 'store: an older backend that does not send landlineComingSoon => Coming soon');
}
{
  let calls = 0;
  let answer = { landlineComingSoon: false };
  const store = makeStore(async () => { calls++; if (answer === null) throw new Error('down'); return answer; });
  await store.refresh();
  check(store.get() === false, 'store: opened by an explicit false');
  await store.refresh();
  check(calls === 1, 'store: a second refresh inside the TTL reuses the answer (one request, not one per screen)');
  answer = null;
  const value = await store.refresh(true);
  check(value === true && store.get() === true, 'store: once open, a later FAILED refresh closes it again (fail closed, never sticks open)');
  answer = { landlineComingSoon: true };
  check((await store.refresh(true)) === true, 'store: the server re-closing landline (landlineComingSoon:true) is honoured');
}
{
  let calls = 0;
  const store = makeStore(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { landlineComingSoon: false }; });
  await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  check(calls === 1, 'store: concurrent refreshes share ONE in-flight request');
}

// ============================================================
// 3. No independent decision in the app; wired to launch-flags
// ============================================================
check(!/export const LANDLINE_COMING_SOON\b/.test(gateSource) && !/export const LANDLINE_COMING_SOON\b/.test(flagSource), 'the app has NO compile-time availability constant — the only decision comes from the server flag');
check(/return true;\s*\n\}/.test(slice(gateSource, 'export function resolveLandlineComingSoon', '\nexport interface')), 'source: resolveLandlineComingSoon returns true (Coming soon) by default');
check(gateSource.includes('let comingSoon = true; // fail closed'), 'source: the store starts Coming soon');
check(
  flagSource.includes('createLandlineFlagStore({ fetchFlags: fetchLaunchFlags })') && flagSource.includes('from "./api"'),
  'the shared store is fed by fetchLaunchFlags (GET /api/v1/launch-flags)'
);
check(
  /export async function fetchLaunchFlags\(\): Promise<\{ iosComingSoon: boolean; landlineComingSoon\?: boolean \}>/.test(apiSource) &&
    apiSource.includes('/api/v1/launch-flags'),
  'api.ts: fetchLaunchFlags exposes landlineComingSoon (optional in the type, so an older backend reads as Coming soon)'
);
check(
  flagSource.includes('export function useLandlineComingSoon(): boolean') &&
    flagSource.includes('useState<boolean>(landlineFlagStore.get())') &&
    flagSource.includes('export function isLandlineComingSoon(deviceType?: string | null): boolean') &&
    flagSource.includes('deviceType === "landline" && landlineFlagStore.get()'),
  'landlineFlag.ts: the hook starts from the fail-closed store value; isLandlineComingSoon is true only for the exact "landline" type while Coming soon'
);
check(componentSource.includes('LANDLINE_COMING_SOON_TITLE') && componentSource.includes('LANDLINE_COMING_SOON_BODY'), 'the shared LandlineComingSoon component renders the single source of Coming-soon copy');

// ============================================================
// 4. Device picker (onboarding)
// ============================================================
check(
  pickerSource.includes('from "../../lib/landlineFlag"') && pickerSource.includes('const landlineComingSoon = useLandlineComingSoon();'),
  'device picker: driven by the shared server-flag state'
);
check(
  pickerSource.includes('{ type: "landline", label: LANDLINE_CARD_LABEL_AVAILABLE, icon: "call" }') &&
    pickerSource.includes('option.type === "landline" && landlineComingSoon ? { ...option, label: LANDLINE_CARD_LABEL_COMING_SOON } : option') &&
    pickerSource.includes('{deviceOptions.map('),
  'device picker: the Landline card is KEPT (same "call" glyph) and marked "— Coming soon" whenever the flag is on — including while the answer is still unknown'
);

const selectDeviceBody = slice(pickerSource, 'function selectDevice(type: DeviceType) {', '\n  }\n');
check(
  selectDeviceBody.includes('setStep(isLandlineComingSoon("landline") ? { name: "landline-coming-soon" } : { name: "landline-provider" });'),
  'selecting Landline routes to the dead-end "landline-coming-soon" step (the provider list is only reachable if the server opens landline)'
);
check(!slice(selectDeviceBody, 'if (type === "landline") {', 'if (type === "iphone") {').includes('setHouseholdLandline'), 'selecting the Landline card writes nothing server-side');

const selectLandlineBody = slice(pickerSource, 'async function selectLandlineProvider(', '\n  }\n');
const guardIdx = selectLandlineBody.indexOf('if (isLandlineComingSoon("landline")) {');
check(
  guardIdx !== -1 && guardIdx < selectLandlineBody.indexOf('setHouseholdLandline(') && guardIdx < selectLandlineBody.indexOf('router.push("/(setup)/subscribe")') && selectLandlineBody.slice(guardIdx).includes('return;'),
  'defence in depth: selectLandlineProvider returns to Coming soon BEFORE persisting the provider or navigating to Subscribe'
);

const comingSoonBranch = slice(pickerSource, 'if (step.name === "landline-coming-soon") {', 'if (step.name === "landline-provider-unsupported") {');
check(comingSoonBranch.includes('<LandlineComingSoon'), 'the landline-coming-soon step renders the shared Coming-soon content');
check(
  !/setHouseholdLandline|router\.push|submitWaitingList|joinWaitingList|TextInput/.test(comingSoonBranch) && comingSoonBranch.includes('setStep({ name: "device" })'),
  'the landline-coming-soon step has no payment/setup path (no provider save, no navigation onward, no form) — its only exits lead back to the device choice'
);

check(
  pickerSource.includes('const LANDLINE_PROVIDERS:') && pickerSource.includes('{ provider: "bt", label: "BT" }') &&
    pickerSource.includes('if (step.name === "landline-provider") {') && pickerSource.includes('if (step.name === "landline-provider-unsupported") {') &&
    pickerSource.includes('const result = await setHouseholdLandline(provider, session?.access_token)'),
  'the landline implementation is preserved: provider list, provider step, unsupported-provider step and setHouseholdLandline are all still in the source'
);
check(apiSource.includes('export async function setHouseholdLandline(') && apiSource.includes('deviceType: "landline"'), 'lib/api.ts still exports setHouseholdLandline unchanged');

check(
  pickerSource.includes('{ type: "iphone", label: "iPhone — Coming soon", iconSource: require("../../assets/iphone-device-mark.png") }') &&
    pickerSource.includes('setStep({ name: "ios-coming-soon" });') && pickerSource.includes('setHouseholdIphone(session?.access_token)') &&
    pickerSource.includes('submitWaitingList("ios_coming_soon", { deviceType: "iphone" })'),
  'iPhone Coming soon is unchanged: same card, dead-end step, server-side iPhone marker and waiting list (still hard-coded, still independent of the landline flag)'
);
check(
  pickerSource.includes('{ type: "android", label: "Android phone", iconSource: require("../../assets/android-device-mark.png") }') &&
    /if \(type === "iphone"\) \{[\s\S]{0,200}return;\s*\}\s*setStep\(\{ name: "carrier" \}\);/.test(selectDeviceBody),
  'Android is unchanged: same card, and it still proceeds to the mobile-network check'
);

// ============================================================
// 5. Subscribe / payment
// ============================================================
check(subscribeSource.includes('useLandlineComingSoon') && subscribeSource.includes('from "../../lib/landlineFlag"') && subscribeSource.includes('loadActivationDevice'), 'Subscribe: wired to the shared server-flag state and the stored-device lookup');
const handleSubscribeBody = slice(subscribeSource, 'async function handleSubscribe() {', '\n  return (\n');
const subGuard = handleSubscribeBody.indexOf('isLandlineComingSoon(storedDevice?.deviceType)');
check(
  subGuard !== -1 &&
    subGuard < handleSubscribeBody.indexOf('await fetchCarrierCompatibility(') && subGuard < handleSubscribeBody.indexOf('await acceptTerms(') &&
    subGuard < handleSubscribeBody.indexOf('handleSubscribeStripe();') && subGuard < handleSubscribeBody.indexOf('handleSubscribeIOS();'),
  'Subscribe: the landline guard runs at the moment of purchase, BEFORE the carrier check, terms acceptance and either purchase path (Stripe or iOS)'
);
check(
  subscribeSource.includes('const landlineBlocked = landlineComingSoon && storedDeviceType === "landline";') &&
    /if \(landlineBlocked\) \{[\s\S]{0,300}<LandlineComingSoon/.test(subscribeSource) &&
    subscribeSource.indexOf('if (landlineBlocked) {') < subscribeSource.indexOf('<SetupProgress currentStep={1} />'),
  'Subscribe: a stored landline device shows Coming soon instead of the price and Subscribe button'
);

// ============================================================
// 6. Activate (setup step after payment)
// ============================================================
const loadBody = slice(activateSource, 'function load() {', '\n  }\n');
check(
  activateSource.includes('const landlineComingSoon = useLandlineComingSoon();') &&
    loadBody.includes('isLandlineComingSoon(resolvedDevice.deviceType)') && loadBody.indexOf('isLandlineComingSoon(') < loadBody.indexOf('fetchActivationInstructions('),
  'Activate: never fetches landline dialling instructions while Coming soon'
);
{
  const renderGuard = activateSource.indexOf('if (landlineComingSoon && resolvedDevice?.deviceType === "landline") {');
  check(
    renderGuard !== -1 && renderGuard < activateSource.indexOf('if (resolvedDevice === null) {') && renderGuard < activateSource.indexOf('Go to your landline phone'),
    'Activate: a landline device shows Coming soon before any dial-the-code instructions or Activate/verify controls render'
  );
}
check(activateSource.includes('useEffect(load, [resolvedDevice, session?.access_token, landlineComingSoon]);'), 'Activate: re-evaluates when the flag answer arrives, so it can never stay stale');

// ============================================================
// 7. Account -> Set up call forwarding
// ============================================================
check(
  forwardingSource.includes('const landlineComingSoon = useLandlineComingSoon();') && forwardingSource.includes('| "landline_coming_soon"') &&
    forwardingSource.indexOf('isLandlineComingSoon(device.deviceType)') !== -1 &&
    forwardingSource.indexOf('isLandlineComingSoon(device.deviceType)') < forwardingSource.indexOf('fetchActivationInstructions(device.deviceType') &&
    forwardingSource.includes('[session?.access_token, landlineComingSoon]'),
  'Set up call forwarding: a landline household sees Coming soon and no landline instructions are fetched (re-evaluated when the flag answer arrives)'
);
check(
  forwardingSource.indexOf('if (state === "landline_coming_soon") {') !== -1 &&
    forwardingSource.indexOf('if (state === "landline_coming_soon") {') < forwardingSource.indexOf('Go to your landline phone'),
  'Set up call forwarding: the Coming-soon state renders before the "Go to your landline phone" steps'
);

// ============================================================
// 8. Turn off protection is deliberately NOT gated
// ============================================================
check(
  !turnOffSource.includes('landlineFlag') && !turnOffSource.includes('landlineAvailability') && !turnOffSource.includes('isLandlineComingSoon') && !turnOffSource.includes('useLandlineComingSoon'),
  'Turn off protection is deliberately NOT gated — a household that already diverted a landline can always see its cancel code'
);

// ============================================================
// 9. Help / FAQ / wording, and no stray landline mentions
// ============================================================
check(
  /question: "Does Home Call Guard work on a landline\?",\s*answer: "Not yet — landline support is coming soon\./.test(supportSource),
  'Support FAQ answers the landline question honestly: not yet, coming soon'
);
check(!/Sky and Virgin|Call Divert add-on/.test(verifySource), 'Verify screen no longer shows Sky/Virgin landline Call Divert troubleshooting to everyone');
check(!/home phone/i.test(homeSource), 'Home "Not protected yet" text no longer says "home phone" (which implied a landline)');

const ALLOWED_LANDLINE_MENTIONS = new Set(['device-picker.tsx', 'subscribe.tsx', 'activate.tsx', 'set-up-call-forwarding.tsx', 'support.tsx', 'LandlineComingSoon.tsx']);
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : [];
  });
}
const screensAndComponents = [...walk(path.join(mobileRoot, 'app')), ...walk(path.join(mobileRoot, 'components'))];
const unexpected = screensAndComponents.filter((f) => /landline/i.test(readFileSync(f, 'utf8')) && !ALLOWED_LANDLINE_MENTIONS.has(path.basename(f)));
check(unexpected.length === 0, `no other screen or component mentions landline outside the gated set${unexpected.length ? ' — found: ' + unexpected.map((f) => path.basename(f)).join(', ') : ''}`);
for (const f of ['device-picker.tsx', 'subscribe.tsx', 'activate.tsx', 'set-up-call-forwarding.tsx']) {
  const src = screensAndComponents.find((x) => path.basename(x) === f);
  check(src && readFileSync(src, 'utf8').includes('landlineFlag'), `${f} is wired to the shared landline flag state`);
}

// ============================================================
// 10. Wiring
// ============================================================
check(rootPackage.scripts.test.includes('node tests/mobile-landline-coming-soon.test.mjs'), 'this test is part of the root `npm test` chain');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
