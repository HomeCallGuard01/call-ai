// iOS technical parity (2026-09-30): iPhone onboarding path from the current
// codebase, iOS microphone permission, platform-aware copy, and the iPhone
// carrier fix that made "IOS_COMING_SOON=false" actually able to take payment.
//
// Run with: node tests/ios-parity.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ts = require('../mobile/node_modules/typescript');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

function loadTs(relPath, fakeModules = {}) {
  const js = ts.transpileModule(read(...relPath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  const fakeRequire = name => {
    if (name in fakeModules) return fakeModules[name];
    throw new Error(`unexpected require: ${name}`);
  };
  new Function('module', 'exports', 'require', 'setTimeout', 'clearTimeout', js)(mod, mod.exports, fakeRequire, setTimeout, clearTimeout);
  return mod.exports;
}

// --- iPhone availability (pure) ---
const ia = loadTs(['mobile', 'lib', 'iphoneAvailability.ts']);
check(ia.resolveIosComingSoon({ iosComingSoon: false }) === false, 'explicit iosComingSoon:false → available');
check(ia.resolveIosComingSoon({ iosComingSoon: true }) && ia.resolveIosComingSoon({}) && ia.resolveIosComingSoon(null) && ia.resolveIosComingSoon('x'), 'anything else → coming soon (fail closed)');
check(ia.isIphoneOnboardingAvailable('ios', false), 'iOS app + flag off → iPhone onboarding available');
check(!ia.isIphoneOnboardingAvailable('ios', true), 'iOS app + flag on → still coming soon');
check(!ia.isIphoneOnboardingAvailable('android', false), 'the Android app never onboards an iPhone');
check(JSON.stringify(ia.deviceOptionTypesFor('ios')) === '["iphone"]', 'iOS app shows only the iPhone card (no Android — App Review 2.3.10)');
check(JSON.stringify(ia.deviceOptionTypesFor('android')) === '["iphone","android"]', 'Android device picker unchanged');
check(ia.iphoneCardLabel('ios', false) === 'iPhone' && ia.iphoneCardLabel('ios', true) === 'iPhone — Coming soon' && ia.iphoneCardLabel('android', false) === 'iPhone — Coming soon', 'iPhone card label follows platform + flag');
check(ia.carrierDeviceTypeFor('iphone') === 'iphone' && ia.carrierDeviceTypeFor('android') === 'mobile' && ia.carrierDeviceTypeFor(null) === 'mobile', 'carrier request device type');
{
  const la0 = loadTs(['mobile', 'lib', 'landlineAvailability.ts']);
  check(!/android/i.test(la0.LANDLINE_COMING_SOON_BODY_IOS) && /Android/.test(la0.LANDLINE_COMING_SOON_BODY), 'landline copy mentions Android only in the Android app');
}
check(!/android/i.test(ia.contactsPermissionHelp('ios')) && /Limited Access/.test(ia.contactsPermissionHelp('ios')), 'iOS contacts help: iPhone steps only');
check(!/iphone|limited access/i.test(ia.contactsPermissionHelp('android')) && /Permissions > Contacts/.test(ia.contactsPermissionHelp('android')), 'Android contacts help: Android steps only');

// --- flag store reuse (fail closed) ---
{
  const la = loadTs(['mobile', 'lib', 'landlineAvailability.ts']);
  const iosStore = la.createLandlineFlagStore({ fetchFlags: async () => ({ iosComingSoon: false, landlineComingSoon: true }), resolve: ia.resolveIosComingSoon });
  check(iosStore.get() === true, 'iOS flag store starts closed');
  check((await iosStore.refresh()) === false, 'iOS flag store reads iosComingSoon, not the landline flag');
  const landStore = la.createLandlineFlagStore({ fetchFlags: async () => ({ iosComingSoon: false, landlineComingSoon: true }) });
  check((await landStore.refresh()) === true, 'landline store unchanged by default');
  const failing = la.createLandlineFlagStore({ fetchFlags: async () => { throw new Error('offline'); }, resolve: ia.resolveIosComingSoon });
  check((await failing.refresh()) === true, 'network failure → iPhone stays coming soon');
}

// --- iOS microphone permission ---
{
  const calls = [];
  const fakeAudio = {
    getRecordingPermissionsAsync: async () => { calls.push('get'); return { status: 'undetermined', granted: false }; },
    requestRecordingPermissionsAsync: async () => { calls.push('request'); return { status: 'granted', granted: true }; },
  };
  const iosMic = loadTs(['mobile', 'lib', 'microphonePermission.ts'], { 'react-native': { Platform: { OS: 'ios' } }, 'expo-audio': fakeAudio });
  check((await iosMic.getIosMicrophoneStatus()) === 'undetermined', 'iOS: reads microphone status via expo-audio');
  check((await iosMic.requestIosMicrophonePermission()) === 'granted' && calls.join() === 'get,request', 'iOS: request shows the system prompt');
  const androidMic = loadTs(['mobile', 'lib', 'microphonePermission.ts'], { 'react-native': { Platform: { OS: 'android' } } });
  check((await androidMic.getIosMicrophoneStatus()) === 'unavailable', 'Android: expo-audio is never required (it is not linked on Android)');
  check(iosMic.toMicrophoneStatus({ status: 'denied' }) === 'denied' && iosMic.toMicrophoneStatus(null) === 'unavailable', 'status mapping');
  const brokenMic = loadTs(['mobile', 'lib', 'microphonePermission.ts'], { 'react-native': { Platform: { OS: 'ios' } } });
  check((await brokenMic.getIosMicrophoneStatus()) === 'unavailable', 'iOS without the native module (old build) → unavailable, no crash');
}
{
  const model = loadTs(['mobile', 'lib', 'callReadinessModel.ts']);
  const denied = model.buildIosReadiness(18, 'denied');
  check(denied.platform === 'ios' && denied.microphone === 'denied' && denied.notifications === 'not_required', 'iOS readiness: CallKit needs no notification permission; mic from expo-audio');
  check(model.buildIosReadiness(18, 'undetermined').microphone === 'unknown', 'undetermined is reported as unknown, never as blocked');
  check(/won't be able to hear you/.test(model.readinessMessage('microphone', 'ios')) && /can't ring/.test(model.readinessMessage('microphone', 'android')), 'microphone message is accurate per platform (iPhone still rings; Android does not)');
  check(/Continue/.test(model.IOS_MICROPHONE_EXPLAINER) && !/allow|not now|skip/i.test(model.IOS_MICROPHONE_EXPLAINER), 'explainer is neutral and leads to the prompt (App Review 5.1.1(iv))');
}

// --- wiring (source) ---
const pkg = JSON.parse(read('mobile', 'package.json'));
check(pkg.dependencies['expo-audio'] && JSON.stringify(pkg.expo.autolinking.android.exclude) === '["expo-audio"]', 'expo-audio is a dependency but excluded from Android autolinking (no new Play-declared foreground-service permissions)');
const appConfig = read('mobile', 'app.config.js');
check(!appConfig.includes('"expo-audio"'), 'expo-audio config plugin NOT added (it would add Android permissions); NSMicrophoneUsageDescription already present');
check(/NSMicrophoneUsageDescription/.test(appConfig), 'iOS microphone usage description present');
const mobileSources = ['lib/callReadiness.ts', 'components/CallReadinessBanner.tsx', 'lib/voiceClient.ts', 'app/(tabs)/index.tsx'].map(f => read('mobile', ...f.split('/'))).join('\n');
check(!/from ["']expo-audio["']/.test(mobileSources) && !/from ["']expo-audio["']/.test(read('mobile', 'lib', 'microphonePermission.ts')), 'no module-scope import of expo-audio anywhere (would crash Android)');
const banner = read('mobile', 'components', 'CallReadinessBanner.tsx');
check(/label="Continue"/.test(banner) && /requestIosMicrophonePermission\(\)/.test(banner), 'iOS banner: Continue → system prompt');
const picker = read('mobile', 'app', '(setup)', 'device-picker.tsx');
check(/deviceOptionTypesFor\(Platform\.OS\)/.test(picker) && /deviceOptions\.map\(/.test(picker) && !/DEVICE_OPTIONS\.map\(/.test(picker), 'device picker renders platform-filtered options');
check(/async function selectIphone\(\)/.test(picker) && /await refreshIosComingSoon\(\)/.test(picker) && /isIphoneOnboardingAvailable\(Platform\.OS, comingSoon\)/.test(picker), 'iPhone selection decides from a fresh, fail-closed flag read');
check(/checkCarrierCompatibility\(provider, tariffType, session\?\.access_token, carrierDeviceTypeFor\(deviceType\)\)/.test(picker), 'carrier step sends deviceType iphone for iPhone');
check(/setStep\(\{ name: "ios-coming-soon" \}\);\s*setHouseholdIphone/.test(picker), 'coming-soon path unchanged when not available');
const api = read('mobile', 'lib', 'api.ts');
check(/deviceType: "mobile" \| "iphone" = "mobile"/.test(api) && /JSON\.stringify\(\{ deviceType, provider, tariffType \}\)/.test(api), 'api sends the device type (default mobile: Android behaviour unchanged)');
const support = read('mobile', 'app', '(tabs)', 'account', 'support.tsx');
check(support.includes('contactsPermissionHelp(Platform.OS)'), 'support FAQ uses platform-specific contacts help');
check(read('mobile', 'components', 'LandlineComingSoon.tsx').includes('Platform.OS === "ios" ? LANDLINE_COMING_SOON_BODY_IOS : LANDLINE_COMING_SOON_BODY'), 'landline coming-soon copy is platform-aware');
for (const f of [['app', '(setup)', 'activate.tsx'], ['app', '(tabs)', 'account', 'set-up-call-forwarding.tsx']]) {
  check(/canAutoDial && Platform\.OS === "ios" && <Text[^>]*>\{IOS_MANUAL_DIAL_HINT\}/.test(read('mobile', ...f)), `${f[f.length - 1]}: iOS keypad fallback hint under the dial button`);
}

// --- backend: iPhone households keep their carrier ---
const mobileApi = read('routes', 'mobileApi.js');
check(/const iphoneProvider = deviceType === "iphone" && typeof provider === "string" && provider\.trim\(\) \? provider : null;/.test(mobileApi), 'carrier-compatibility route stores the iPhone carrier when sent');
const m061 = read('supabase', 'migrations', '061_household_iphone_carrier.sql');
check(/carrier_provider_key = p_provider_key,/.test(m061) && /carrier_tariff_type = case when p_device_type = 'landline' then null else p_tariff_type end/.test(m061), 'migration 061: iphone keeps provider/tariff; landline behaviour (043) unchanged');
{
  process.env.IOS_COMING_SOON = 'false';
  const { evaluateHouseholdCheckoutEligibility } = require('../services/providerPolicy');
  const shapeWrittenBy061 = { device_type: 'iphone', carrier_provider_key: 'o2', carrier_tariff_type: 'pay_monthly' };
  check(evaluateHouseholdCheckoutEligibility(shapeWrittenBy061).canProceedToPayment === true, 'with the flag off, an iPhone household as the route now writes it can pay');
  check(evaluateHouseholdCheckoutEligibility({ device_type: 'iphone', carrier_provider_key: null }).canProceedToPayment === false, 'as the route wrote it BEFORE this fix (no carrier) it could never pay — the bug');
  process.env.IOS_COMING_SOON = 'true';
  check(evaluateHouseholdCheckoutEligibility(shapeWrittenBy061).canProceedToPayment === false, 'with the flag on, still blocked (the gate is unchanged)');
  delete process.env.IOS_COMING_SOON;
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
