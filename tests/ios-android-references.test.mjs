// Apple Guideline 2.3.10 (Build 11 review, 2026-09-18): "Revise the
// app's binary to remove Android references." This file proves two
// things structurally (no React Native Testing Library/Jest harness
// exists in this project — see tests/get-protected-now-button.test.mjs
// for the same established source-string-assertion convention):
//
//   1. The one known customer-visible, unconditional Android reference
//      found by the forensic investigation (mobile/app/(setup)/
//      device-picker.tsx's "Android phone" option + logo-android icon)
//      is now excluded from the iOS build specifically, via a runtime
//      Platform.OS check, while remaining fully present and reachable
//      for Android.
//   2. No OTHER customer-visible "Android"/"Google Play"/"Play
//      Store"/"APK" text exists anywhere else in the mobile app that
//      isn't either (a) a source comment (stripped before this app
//      ever bundles, never shipped), (b) Platform.OS logic (a runtime
//      string comparison, never rendered as text), or (c) the
//      DeviceType union's internal "android" tag value (never itself
//      displayed — only the labels mapped from it are).
//
// Run with: node tests/ios-android-references.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, '..', 'mobile');
const devicePickerPath = path.join(mobileRoot, 'app', '(setup)', 'device-picker.tsx');
const devicePickerSource = readFileSync(devicePickerPath, 'utf8');

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
// 1. device-picker.tsx — iOS excludes the option, Android keeps it
// ============================================================

check(
  devicePickerSource.includes('import { Text, View, Pressable, StyleSheet, Platform } from "react-native";'),
  'Platform is imported for the runtime iOS/Android split'
);

const optionsBlockStart = devicePickerSource.indexOf('const DEVICE_OPTIONS');
const optionsBlockEnd = devicePickerSource.indexOf('];', optionsBlockStart);
const optionsBlock = devicePickerSource.slice(optionsBlockStart, optionsBlockEnd);

check(
  optionsBlock.includes('Platform.OS === "ios" ? [] : [{ type: "android" as const, label: "Android phone", icon: "logo-android" as const }]'),
  'DEVICE_OPTIONS excludes the Android entry entirely when Platform.OS === "ios", and includes it (unchanged label + icon) otherwise'
);

check(
  optionsBlock.includes('{ type: "iphone", label: "iPhone", icon: "logo-apple" }') &&
    optionsBlock.includes('{ type: "landline", label: "Landline", icon: "call" }'),
  'iPhone and Landline options are unconditional on every platform — only the Android option is ever excluded'
);

// --- downstream Android-specific copy (phone-number confirmation step)
// is untouched — proves Android functionality itself was not removed,
// only iOS's ability to ever reach it (since deviceType can never
// become "android" via any UI action once the option above is absent).
check(
  devicePickerSource.includes('if (deviceType === "iphone" || deviceType === "android")') &&
    devicePickerSource.includes('{deviceType === "iphone" ? "iPhone" : "Android phone"}'),
  'the downstream "what\'s this phone\'s number" step still fully supports and labels the Android case, unchanged — Android builds are unaffected'
);

// ============================================================
// 2. No other unguarded customer-visible Android/Google Play/Play
// Store/APK text exists anywhere else in the mobile app
// ============================================================

function listFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.expo' || entry === 'build-output') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out = out.concat(listFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source) {
  // Line comments only — sufficient here since this codebase's own
  // convention is line comments for prose (confirmed by inspection);
  // a block-comment stripper would risk silently eating real code if
  // this assumption is ever wrong, which is a worse failure mode than
  // this test occasionally needing a manual look.
  return source
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const ANDROID_TEXT_PATTERN = /android|google play|play store|\bapk\b/i;
// Legitimate, non-customer-visible occurrences that remain after
// stripping comments — each is either Platform.OS logic (a runtime
// comparison, never displayed) or the DeviceType union's internal tag
// value (a string used only as a lookup key, e.g. deviceType ===
// "android" — never itself rendered; only a mapped *label* is, and
// every such label is covered by its own explicit check above or
// individually allow-listed here with the exact reason).
const KNOWN_SAFE_PATTERNS = [
  /Platform\.OS\s*===?\s*["']android["']/,
  /Platform\.OS\s*!==?\s*["']android["']/,
  /deviceType\s*===?\s*["']android["']/,
  /deviceType:\s*["']android["']/,
  /"android"\s*\|/, // DeviceType = "iphone" | "android" | "landline" union declaration
  /type DeviceType/,
  /canAutoOpenDialer\(/, // lib/dialerLink.ts: pure function, "android" is an input value, never rendered
  /Contacts\.getContactsAsync/, // unrelated expo-contacts API name coincidence guard, see below
];

const devicePickerRelativePath = path.relative(mobileRoot, devicePickerPath);
const allowedInDevicePicker = [
  'Platform.OS === "ios" ? [] : [{ type: "android" as const, label: "Android phone", icon: "logo-android" as const }]',
  'if (deviceType === "iphone" || deviceType === "android")',
  '{deviceType === "iphone" ? "iPhone" : "Android phone"}',
];

let unexpectedHits = [];
for (const file of listFiles(mobileRoot)) {
  const relative = path.relative(mobileRoot, file);
  const stripped = stripComments(readFileSync(file, 'utf8'));
  const lines = stripped.split('\n');
  lines.forEach((line, idx) => {
    if (!ANDROID_TEXT_PATTERN.test(line)) return;
    if (relative === devicePickerRelativePath && allowedInDevicePicker.some(allowed => line.includes(allowed) || (line.trim() === '' ))) {
      // Handled precisely by the dedicated checks above — but still
      // verify it's actually one of the three known, approved lines
      // rather than trusting the file name alone.
      const isKnown = allowedInDevicePicker.some(allowed => (stripped).includes(allowed));
      if (isKnown) return;
    }
    if (KNOWN_SAFE_PATTERNS.some(p => p.test(line))) return;
    unexpectedHits.push(`${relative}:${idx + 1}: ${line.trim()}`);
  });
}

check(
  unexpectedHits.length === 0,
  'no unexpected Android/Google Play/Play Store/APK text exists anywhere else in the mobile app (outside comments, Platform.OS logic, and the one explicitly-verified, now-iOS-gated device-picker option)'
);
if (unexpectedHits.length > 0) {
  console.error('  Unexpected hits:\n' + unexpectedHits.map(h => `    ${h}`).join('\n'));
}

// --- app.config.js: android-specific build config is Android-build-
// tooling only (icon assets, permissions under the `android:` key),
// never read by any app code at runtime (Constants.expoConfig is never
// imported anywhere in this app — checked directly), so it can never
// surface in any customer-visible iOS screen regardless of its
// presence in the shared config file.
const appConfigSource = readFileSync(path.join(mobileRoot, 'app.config.js'), 'utf8');
check(
  !listFiles(mobileRoot).some(f => readFileSync(f, 'utf8').includes('expoConfig')),
  'no app code reads Constants.expoConfig — the app.config.js android: block (icons/permissions) can never surface in any rendered iOS screen'
);
check(appConfigSource.includes('android: {'), 'sanity check: app.config.js does still define the android block (config, not customer-visible content) — confirms the check above is testing something real, not a vacuous absence');

// --- support.tsx FAQ: already fixed before this change; re-verified
// here (via direct substring checks, not a fragile regex, since the
// real strings contain escaped quotes) so a future edit to that file
// can't silently reintroduce the leak this test would otherwise miss
// by only looking at device-picker.
const supportSource = readFileSync(path.join(mobileRoot, 'app', '(tabs)', 'account', 'support.tsx'), 'utf8');
const iosFaqBranch =
  ' — on iPhone this is called Limited Access, and you can add more at any time by tapping \\"Add more contacts\\" on the sync screen, or later via Settings > Home Call Guard > Contacts > Edit Selected Contacts.';
const androidFaqBranch =
  ', and you can add more at any time by tapping \\"Add more contacts\\" on the sync screen, or later via Settings > Apps > Home Call Guard > Permissions > Contacts to change access.';
check(
  supportSource.includes('Platform.OS === "android"') &&
    supportSource.includes(androidFaqBranch) &&
    supportSource.includes(iosFaqBranch),
  'the contacts-permission FAQ answer still branches on Platform.OS, with both the Android and iOS variants present verbatim'
);
check(
  !ANDROID_TEXT_PATTERN.test(iosFaqBranch),
  'the iOS branch of that FAQ answer contains no Android/Google Play/Play Store/APK text (re-verifying the fix already made for Build 11, not part of this change)'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
