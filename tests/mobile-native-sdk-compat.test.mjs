// Native module / Expo SDK compatibility guard (2026-10-04).
//
// Real-device finding: iOS 1.0.2 Build 15 never left the splash screen. The
// iPhone log showed "Unhandled JS Exception: [runtime not ready]: Error:
// Cannot find native module 'ExpoAsset'". Cause: expo-audio declares the
// peer dependency `expo-asset: "*"`, so npm installed the NEWEST expo-asset
// (57.0.18, Expo SDK 57) at the top level. Its podspec needs iOS 16.4, the
// app targets iOS 15.1, so its native module was left out of the binary while
// SDK 54's JavaScript still requires it → crash before the first screen.
//
// This guard fails the suite when:
//   1. a top-level installed package that Expo SDK ships (expo/bundledNativeModules.json)
//      is not on that SDK's major(.minor for "~") line — e.g. expo-asset 57 on SDK 54;
//   2. any iOS-autolinked Expo module's podspec needs a newer iOS than the app targets;
//   3. expo-asset is not a direct dependency pinned to the SDK line, or is installed twice.
//
// Run with: node tests/mobile-native-sdk-compat.test.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(__dirname, '..', 'mobile');
const nm = path.join(mobile, 'node_modules');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const pkg = JSON.parse(readFileSync(path.join(mobile, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(mobile, 'package-lock.json'), 'utf8'));
const lockTop = (name) => lock.packages[`node_modules/${name}`] || null;
const parse = (v) => String(v).replace(/^[~^]/, '').split('.').map((n) => parseInt(n, 10));

// "~12.0.13" → same major.minor; "^1.2.3" / "1.2.3" → same major. Patch level is
// deliberately not enforced (expo install --check reports patch drift).
function onSdkLine(installed, range) {
  if (typeof range !== 'string' || !/^[~^]?\d+\.\d+/.test(range)) return true;
  const [iM, im] = parse(installed);
  const [rM, rm] = parse(range);
  return range.startsWith('~') ? iM === rM && im === rm : iM === rM;
}

// 3. expo-asset: direct, pinned, single copy.
{
  const want = pkg.dependencies && pkg.dependencies['expo-asset'];
  check(typeof want === 'string' && /^~12\.0\./.test(want), `expo-asset is a direct dependency on the SDK 54 line (${want})`);
  const copies = Object.entries(lock.packages).filter(([k]) => k.endsWith('node_modules/expo-asset'));
  check(copies.length === 1 && parse(copies[0][1].version)[0] === 12, `exactly one expo-asset in the lockfile, major 12 (found: ${copies.map(([k, v]) => `${k}@${v.version}`).join(', ')})`);
}

// 1. Every SDK-shipped package installed at top level is on the SDK's line.
const bundledPath = path.join(nm, 'expo', 'bundledNativeModules.json');
if (!existsSync(bundledPath)) {
  console.log('⚠ SKIPPED SDK-line check: mobile/node_modules not installed');
} else {
  const bundled = JSON.parse(readFileSync(bundledPath, 'utf8'));
  const off = [];
  for (const [name, range] of Object.entries(bundled)) {
    const entry = lockTop(name);
    if (entry && entry.version && !onSdkLine(entry.version, range)) off.push(`${name}@${entry.version} (SDK wants ${range})`);
  }
  check(off.length === 0, `every installed SDK-managed package is on its Expo SDK line${off.length ? ': ' + off.join('; ') : ''}`);
  check(onSdkLine('57.0.18', bundled['expo-asset']) === false, 'the guard itself rejects the Build 15 failure (expo-asset 57.0.18 on SDK 54)');
}

// 2. No iOS-linked Expo module needs a newer iOS than the app targets.
if (!existsSync(nm)) {
  console.log('⚠ SKIPPED podspec check: mobile/node_modules not installed');
} else {
  // App target: app.config ios.deploymentTarget if set, else the SDK baseline
  // (expo-modules-core's own podspec), which is what the build uses.
  const appConfig = readFileSync(path.join(mobile, 'app.config.js'), 'utf8');
  const explicit = appConfig.match(/deploymentTarget:\s*["']([\d.]+)["']/);
  const coreSpec = readFileSync(path.join(nm, 'expo-modules-core', 'ExpoModulesCore.podspec'), 'utf8');
  const target = explicit ? explicit[1] : (coreSpec.match(/:ios\s*=>\s*'([\d.]+)'/) || [])[1];
  check(!!target, `app iOS deployment target resolved (${target})`);
  const cmp = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

  const dirs = [];
  for (const d of readdirSync(nm)) {
    if (d.startsWith('@')) { for (const s of readdirSync(path.join(nm, d))) dirs.push(path.join(nm, d, s)); }
    else dirs.push(path.join(nm, d));
  }
  const tooNew = [];
  let checked = 0;
  for (const dir of dirs) {
    const cfgPath = path.join(dir, 'expo-module.config.json');
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const apple = (cfg.platforms || []).some((p) => p === 'apple' || p === 'ios');
    if (!apple) continue;
    const iosDir = ['ios', 'apple'].map((x) => path.join(dir, x)).find((x) => existsSync(x));
    if (!iosDir) continue;
    for (const f of readdirSync(iosDir).filter((x) => x.endsWith('.podspec'))) {
      const m = readFileSync(path.join(iosDir, f), 'utf8').match(/:ios\s*=>\s*'([\d.]+)'/);
      if (!m) continue;
      checked++;
      if (cmp(m[1], target) > 0) tooNew.push(`${path.basename(dir)} ${f} needs iOS ${m[1]}`);
    }
  }
  check(checked >= 10, `podspecs inspected for iOS-linked Expo modules (${checked})`);
  check(tooNew.length === 0, `no iOS-linked Expo module needs a newer iOS than the app's ${target}${tooNew.length ? ': ' + tooNew.join('; ') : ''}`);
}

console.log(failures === 0 ? '\nNative module / SDK compatibility: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
