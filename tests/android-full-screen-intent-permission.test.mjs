// USE_FULL_SCREEN_INTENT removal (2026-09-23) — Google Play rejected
// Android versionCode 10 solely for this permission: "Permission use is
// not directly related to your app's core purpose."
//
// Root cause (traced, not assumed): the permission is declared
// unconditionally in @twilio/voice-react-native-sdk's own
// AndroidManifest.xml (android/src/main/AndroidManifest.xml) — never by
// any HCG source file, and never injected by any Expo config plugin.
// Confirmed the ONLY contributor across every installed dependency (a
// repo-wide sweep below re-checks this on every run, so a future
// dependency update that starts declaring it too is caught here, not
// discovered again at Play Console review time).
//
// Fix: mobile/app.config.js's existing android.blockedPermissions array
// (the same mechanism already used for WRITE_CONTACTS and
// SYSTEM_ALERT_WINDOW — a real, production-verified pattern: both of
// those are confirmed absent from the actual built AAB, not just the
// config) gets one more entry. Expo's config plugin turns each entry
// into a `tools:node="remove"` directive in the app's OWN
// AndroidManifest.xml, which Android's Gradle manifest merger honours
// against every contributing library manifest, Twilio's included.
//
// What this test PROVES: the configuration is wired correctly (the
// blockedPermissions entry exists, exactly-once, and Expo's own prebuild
// genuinely emits the tools:node="remove" directive for it — checked
// directly below, not assumed) and the block is non-vacuous (Twilio's
// SDK still actually declares the permission, so this isn't blocking
// something that was never there).
//
// What this test CANNOT prove (no Android SDK/Gradle on this machine,
// and per instruction no new EAS build was made in this pass): that the
// FINAL, real Gradle-merged manifest inside a genuinely built AAB lacks
// the permission. That is the same mechanism already relied on for
// WRITE_CONTACTS/SYSTEM_ALERT_WINDOW and was confirmed working against a
// real built AAB earlier in this project's history — but the authoritative
// confirmation for THIS permission specifically still requires an actual
// build, which is a deliberate, separate, approved step.
//
// Run with: node tests/android-full-screen-intent-permission.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const mobileRoot = path.join(root, 'mobile');
const PERMISSION = 'android.permission.USE_FULL_SCREEN_INTENT';

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// ============================================================
// 1. app.config.js blocks it, alongside the two existing entries
// ============================================================
const configSource = readFileSync(path.join(mobileRoot, 'app.config.js'), 'utf8');
const blockStart = configSource.indexOf('blockedPermissions: [');
const blockEnd = configSource.indexOf('],', blockStart);
const blockedBlock = configSource.slice(blockStart, blockEnd);

check(blockStart !== -1, 'mobile/app.config.js declares android.blockedPermissions');
check(
  (blockedBlock.match(new RegExp(PERMISSION.replace(/\./g, '\\.'), 'g')) || []).length === 1,
  `${PERMISSION} appears exactly once in blockedPermissions (not zero, not duplicated)`
);
check(
  blockedBlock.includes('"android.permission.WRITE_CONTACTS"') && blockedBlock.includes('"android.permission.SYSTEM_ALERT_WINDOW"'),
  'the two pre-existing blocked permissions (WRITE_CONTACTS, SYSTEM_ALERT_WINDOW) are still present, unremoved'
);

// ============================================================
// 2. The block is non-vacuous: Twilio's SDK genuinely declares it
// ============================================================
const twilioManifestPath = path.join(mobileRoot, 'node_modules', '@twilio', 'voice-react-native-sdk', 'android', 'src', 'main', 'AndroidManifest.xml');
let twilioManifest = '';
try {
  twilioManifest = readFileSync(twilioManifestPath, 'utf8');
} catch {
  // Handled by the check below, which fails loudly rather than silently skipping.
}
check(twilioManifest.includes(PERMISSION), `@twilio/voice-react-native-sdk's own AndroidManifest.xml still declares ${PERMISSION} (proves blocking it is doing real work, not a no-op)`);

// ============================================================
// 3. Repo-wide sweep: Twilio is the ONLY contributor, today
// ============================================================
function findManifests(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...findManifests(full));
    } else if (e.name === 'AndroidManifest.xml') {
      out.push(full);
    }
  }
  return out;
}
const allManifests = findManifests(path.join(mobileRoot, 'node_modules'));
const contributors = allManifests.filter((f) => {
  try {
    return readFileSync(f, 'utf8').includes(PERMISSION);
  } catch {
    return false;
  }
});
check(allManifests.length > 0, `at least one dependency AndroidManifest.xml was found to sweep (${allManifests.length} found) — a zero result would mean this check found nothing, not that nothing exists`);
check(
  contributors.length === 1 && contributors[0] === twilioManifestPath,
  `exactly one dependency manifest declares ${PERMISSION} today (Twilio's) — blocking it once is sufficient. If this ever fails, another dependency has started declaring it too and blockedPermissions alone no longer covers every source.${contributors.length !== 1 ? ` Found: ${contributors.map((c) => path.relative(mobileRoot, c)).join(', ')}` : ''}`
);

// ============================================================
// 4. Expo's own prebuild genuinely emits the removal directive
// (proves the *mechanism*, using the same tooling Expo/EAS uses —
// not just that we wrote the right array entry)
// ============================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';

let prebuildDir = null;
try {
  const scratchParent = mkdtempSync(path.join(os.tmpdir(), 'hcg-fsi-prebuild-'));
  prebuildDir = path.join(scratchParent, 'mobile');
  // APFS copy-on-write clone (cp -cR): instant, preserves node_modules/.bin
  // symlinks correctly (unlike a filtered fs.cpSync, which broke npx's
  // ability to resolve the expo binary when .bin was excluded).
  execFileSync('cp', ['-cR', mobileRoot, prebuildDir], { stdio: 'pipe' });
  rmSync(path.join(prebuildDir, 'android'), { recursive: true, force: true });
  rmSync(path.join(prebuildDir, 'ios'), { recursive: true, force: true });
  writeFileSync(
    path.join(prebuildDir, 'google-services.json'),
    JSON.stringify({ project_info: { project_number: '1', project_id: 'test' }, client: [{ client_info: { mobilesdk_app_id: '1:1:android:1', android_client_info: { package_name: 'co.uk.homecallguard.app' } }, api_key: [{ current_key: 'test' }] }], configuration_version: '1' })
  );
  execFileSync('npx', ['--no-install', 'expo', 'prebuild', '--platform', 'android', '--no-install'], { cwd: prebuildDir, stdio: 'pipe', timeout: 120000 });
  const manifestPath = path.join(prebuildDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const generated = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  check(generated.length > 0, 'expo prebuild produced an app-level AndroidManifest.xml to inspect');
  check(
    new RegExp(`<uses-permission android:name="${PERMISSION.replace(/\./g, '\\.')}" tools:node="remove"\\s*/?>`).test(generated),
    `Expo's own prebuild emits <uses-permission ... tools:node="remove"/> for ${PERMISSION} in the app's OWN manifest — this is the directive Android's Gradle manifest merger will apply against Twilio's contributed declaration in a real build`
  );
} catch (err) {
  check(false, `expo prebuild sanity check ran without error (${String(err && err.message).slice(0, 200)})`);
} finally {
  if (prebuildDir) rmSync(prebuildDir, { recursive: true, force: true });
}

console.log(
  '\nNOTE: this proves the configuration and the merger mechanism, using the same tooling Expo/EAS builds with. ' +
  'The authoritative proof — the permission genuinely absent from a real, fully Gradle-built production AAB — ' +
  'still requires an actual EAS build, which is a separate, later, explicitly approved step.'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
