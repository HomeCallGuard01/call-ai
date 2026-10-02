// Phone-Settings call forwarding wording per platform (2026-10-02,
// release/ios-1.0.2). giffgaff/Three (and Sky's cancellation) use phone
// Settings; the backend note covers both platforms, so the iOS app must show
// iPhone-only steps (App Review 2.3.10) while Android/web keep the server text.
//
// Run with: node tests/forwarding-settings-copy.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const copy = await import(pathToFileURL(path.join(root, 'mobile', 'lib', 'forwardingSettingsCopy.ts')).href);
const { buildActivationInstructions } = require('../services/activationInstructions');

for (const carrier of ['giffgaff', 'three']) {
  const ins = buildActivationInstructions({ twilioNumber: '+447700900123', deviceType: 'iphone', carrier });
  check(ins.activationMethod === 'native_settings' && /Android/.test(ins.activationNote), `${carrier}: the server's Settings note covers both platforms (shared with web/Android)`);
  const iosActivate = copy.settingsForwardingNote('activate', ins.activationNote, 'ios');
  const iosCancel = copy.settingsForwardingNote('deactivate', ins.cancelCodeNote, 'ios');
  check(!/android/i.test(iosActivate) && !/android/i.test(iosCancel), `${carrier}: the iOS app never names Android (2.3.10)`);
  check(/Settings > Apps > Phone > Call Forwarding/.test(iosActivate) && /Forward To/.test(iosActivate) && /Home Call Guard number/.test(iosActivate), `${carrier}: iOS activation steps (iOS 18+ path, older path, Forward To, the HCG number)`);
  check(/turn Call Forwarding off/.test(iosCancel), `${carrier}: iOS cancellation steps`);
  check(copy.settingsForwardingNote('activate', ins.activationNote, 'android') === ins.activationNote &&
    copy.settingsForwardingNote('deactivate', ins.cancelCodeNote, 'android') === ins.cancelCodeNote, `${carrier}: Android keeps the server's text unchanged`);
}
check(copy.settingsForwardingNote('activate', null, 'android') === null, 'no server note on Android -> null (screen keeps its own fallback)');

const screens = {
  activate: read('mobile', 'app', '(setup)', 'activate.tsx'),
  setUp: read('mobile', 'app', '(tabs)', 'account', 'set-up-call-forwarding.tsx'),
  turnOff: read('mobile', 'app', '(tabs)', 'account', 'turn-off-protection.tsx'),
};
check(screens.activate.includes('settingsForwardingNote("activate", instructions.activationNote, Platform.OS)') &&
  screens.activate.includes('settingsForwardingNote("deactivate", cancelCodeNote, Platform.OS)'), 'activate.tsx: Settings activation + undo notes are platform-aware');
check(screens.setUp.includes('settingsForwardingNote("activate", instructions.activationNote, Platform.OS)'), 'set-up-call-forwarding.tsx: Settings note is platform-aware');
check(screens.turnOff.includes('settingsForwardingNote("deactivate", cancelCodeNote, Platform.OS)'), 'turn-off-protection.tsx: Settings cancellation note is platform-aware');
for (const [name, src] of Object.entries(screens)) {
  check(!/=\{instructions\.activationNote \|\|/.test(src) && !/\{cancelCodeNote \|\| "Use your phone's native/.test(src),
    `${name}: no native-Settings branch renders the raw server note`);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
