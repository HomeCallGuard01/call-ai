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
check(lib.iphoneSignupOpenOnThisDevice('ios') === true, 'iOS app: iPhone signup is open on this device');
check(['android', 'web', '', undefined].every((p) => lib.iphoneSignupOpenOnThisDevice(p) === false), 'Android/web/unknown: iPhone signup stays Coming soon');
check(lib.deviceOptionLabel('iphone', 'iPhone — Coming soon', 'ios') === 'iPhone', 'iOS app: the iPhone card reads "iPhone"');
check(lib.deviceOptionLabel('iphone', 'iPhone — Coming soon', 'android') === 'iPhone — Coming soon', 'Android app: the iPhone card still reads "iPhone — Coming soon"');
check(lib.deviceOptionLabel('android', 'Android phone', 'ios') === 'Android phone', 'other cards keep their own labels');

const picker = read('mobile', 'app', '(setup)', 'device-picker.tsx');
const selectFn = picker.slice(picker.indexOf('function selectDevice(type: DeviceType)'), picker.indexOf('async function submitWaitingList'));
check(selectFn.includes('if (type === "iphone" && !iphoneSignupOpenOnThisDevice(Platform.OS)) {') &&
  selectFn.includes('setStep({ name: "ios-coming-soon" });') && selectFn.includes('setHouseholdIphone(session?.access_token)'),
  'selectDevice: the Coming-soon step and the device_type="iphone" write happen only when iPhone signup is not open on this device');
check(/return;\s*\}\s*setStep\(\{ name: "carrier" \}\);/.test(selectFn),
  'selectDevice: otherwise (including iPhone inside the iOS app) the flow continues to the carrier check');
check(picker.includes('const label = deviceOptionLabel(type, defaultLabel, Platform.OS);') && picker.includes('accessibilityLabel={label}'),
  'device cards render the platform-aware label (visible text and accessibility label)');
check(read('mobile', 'lib', 'api.ts').includes('body: JSON.stringify({ deviceType: "mobile", provider, tariffType })'),
  'the carrier check records an iPhone as a UK mobile line (deviceType "mobile"), so its Apple purchase is not blocked by the Stripe-side IOS_COMING_SOON gate');
check(!/IOS_COMING_SOON|isIosComingSoon|fetchLaunchFlags/.test(read('mobile', 'lib', 'iphoneAvailability.ts').replace(/^\s*\/\/.*$/gm, '')),
  'the iOS path neither reads nor changes the backend IOS_COMING_SOON flag');

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
