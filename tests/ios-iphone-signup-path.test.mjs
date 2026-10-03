// iOS 1.0.2 iPhone signup path (2026-09-30).
//
// Proves that inside the iOS app the iPhone card continues to the normal
// carrier -> Subscribe (Apple IAP) flow, while on Android the existing
// "iPhone — Coming soon" step, its waiting list and the server-side
// device_type="iphone" write are unchanged. The backend IOS_COMING_SOON
// flag is not read or changed by this path.
//
// Run with: node tests/ios-iphone-signup-path.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const lib = await import(pathToFileURL(path.join(root, 'mobile', 'lib', 'iphoneAvailability.ts')).href);
check(lib.isIphoneOnboardingAvailable('ios') === true, 'iOS app: iPhone signup is open on this device');
check(['android', 'web', '', undefined].every((p) => lib.isIphoneOnboardingAvailable(p) === false), 'Android/web/unknown: iPhone signup stays Coming soon');
check(lib.iphoneCardLabel('ios') === 'iPhone', 'iOS app: the iPhone card reads "iPhone"');
check(lib.iphoneCardLabel('android') === 'iPhone — Coming soon', 'Android app: the iPhone card still reads "iPhone — Coming soon"');
check(lib.carrierDeviceTypeFor('iphone') === 'mobile',
  'the carrier check records an iPhone as a UK mobile line (deviceType "mobile"), so its Apple purchase is not blocked by the Stripe-side IOS_COMING_SOON gate');

const picker = read('mobile', 'app', '(setup)', 'device-picker.tsx');
const selectFn = picker.slice(picker.indexOf('function selectDevice(type: DeviceType)'), picker.indexOf('async function submitWaitingList'));
check(selectFn.includes('if (type === "iphone" && !isIphoneOnboardingAvailable(Platform.OS)) {') &&
  selectFn.includes('setStep({ name: "ios-coming-soon" });') && selectFn.includes('setHouseholdIphone(session?.access_token)'),
  'selectDevice: the Coming-soon step and the device_type="iphone" write happen only outside the iOS app');
check(/return;\s*\}\s*setStep\(\{ name: "carrier" \}\);/.test(selectFn),
  'selectDevice: otherwise (including iPhone inside the iOS app) the flow continues to the carrier check');
check(picker.includes('label: iphoneCardLabel(Platform.OS)') && picker.includes('accessibilityLabel={label}'),
  'device cards render the platform-aware label (visible text and accessibility label)');
check(picker.includes('checkCarrierCompatibility(provider, tariffType, session?.access_token, carrierDeviceTypeFor(deviceType))'),
  'the carrier step sends carrierDeviceTypeFor(...) (always "mobile")');
check(!/IOS_COMING_SOON|isIosComingSoon|fetchLaunchFlags/.test(read('mobile', 'lib', 'iphoneAvailability.ts').replace(/^\s*\/\/.*$/gm, '')),
  'the iOS path neither reads nor changes the backend IOS_COMING_SOON flag');

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
