// Structural tests for the "Turn Off Protection" backend-fallback fix
// (2026-09-19, real-device finding): mobile/app/(tabs)/account/
// turn-off-protection.tsx previously relied ENTIRELY on a local,
// device-only record (mobile/lib/activationDeviceStorage.ts,
// expo-secure-store) of which device/provider a household activated
// with — wiped by an app uninstall/reinstall or a device change, at
// which point the screen had no way to recover it at all, even though
// the same information is durable server-side (households.device_type,
// migration 040/041; households.carrier_provider_key, migration 043).
//
// This proves the WIRING: a new GET /api/v1/me/activation-device route
// exposes that server-side state under the vocabulary
// services/activationInstructions.js already expects, the mobile client
// falls back to it only when the local record is empty, re-caches
// whatever it finds, and existing behaviour when the local record
// already exists is completely unchanged.
//
// The actual translation logic (households.device_type's "mobile" ->
// activation-instructions' "android", etc.) is a pure function
// (toActivationDeviceType) already exercised with real inputs in
// tests/activation-instructions.test.mjs — this file does not duplicate
// those cases, only the wiring around them.
//
// No HTTP/RN test tooling exists in this project (see
// tests/device-picker-landline-device-type.test.mjs for the same
// established convention) — every file is checked directly against its
// real source.
//
// Run with: node tests/turn-off-protection-backend-fallback.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const mobileRoot = path.join(root, 'mobile');

const mobileApiSource = readFileSync(path.join(root, 'routes', 'mobileApi.js'), 'utf8');
const activationInstructionsSource = readFileSync(path.join(root, 'services', 'activationInstructions.js'), 'utf8');
const apiTsSource = readFileSync(path.join(mobileRoot, 'lib', 'api.ts'), 'utf8');
const typesSource = readFileSync(path.join(mobileRoot, 'lib', 'types.ts'), 'utf8');
const activationDeviceStorageSource = readFileSync(path.join(mobileRoot, 'lib', 'activationDeviceStorage.ts'), 'utf8');
const turnOffProtectionSource = readFileSync(
  path.join(mobileRoot, 'app', '(tabs)', 'account', 'turn-off-protection.tsx'),
  'utf8'
);

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
// services/activationInstructions.js
// ============================================================

check(
  activationInstructionsSource.includes('function toActivationDeviceType('),
  'services/activationInstructions.js defines toActivationDeviceType'
);
check(
  activationInstructionsSource.includes('toActivationDeviceType,') &&
    activationInstructionsSource.slice(activationInstructionsSource.indexOf('module.exports')).includes('toActivationDeviceType'),
  'toActivationDeviceType is exported from services/activationInstructions.js'
);

// ============================================================
// routes/mobileApi.js — GET /api/v1/me/activation-device
// ============================================================

check(
  mobileApiSource.includes('toActivationDeviceType') &&
    mobileApiSource.match(/require\(["']\.\.\/services\/activationInstructions["']\)/),
  'routes/mobileApi.js imports toActivationDeviceType from services/activationInstructions'
);

const activationDeviceRouteMatch = mobileApiSource.match(
  /router\.get\("\/api\/v1\/me\/activation-device",\s*requireAuthApi,\s*requireEntitlement,\s*async \(req, res\) => \{([\s\S]*?)\n\}\);/
);

check(
  !!activationDeviceRouteMatch,
  'routes/mobileApi.js defines GET /api/v1/me/activation-device gated by requireAuthApi + requireEntitlement, in that order — the same gate as /api/v1/activation/instructions, which it exists purely to feed'
);

const activationDeviceRouteBody = activationDeviceRouteMatch ? activationDeviceRouteMatch[1] : '';

check(
  activationDeviceRouteBody.includes('toActivationDeviceType(req.household.device_type)'),
  'the route derives deviceType from toActivationDeviceType(req.household.device_type) — server-authoritative, never client-supplied'
);
check(
  /provider:\s*deviceType === "landline" \? req\.household\.carrier_provider_key \|\| null : null/.test(activationDeviceRouteBody),
  'provider is only ever returned for deviceType "landline" — a mobile network key belongs to a different vocabulary and is never leaked under this field'
);
check(
  !activationDeviceRouteBody.includes('req.body') && !activationDeviceRouteBody.includes('req.query'),
  'the route reads nothing from the client-supplied request body/query — household identity and its device/provider both come only from req.household, resolved server-side by requireAuthApi'
);

// ============================================================
// mobile/lib/types.ts — ActivationDeviceResponse
// ============================================================

check(
  typesSource.includes('export interface ActivationDeviceResponse'),
  'mobile/lib/types.ts defines ActivationDeviceResponse'
);
check(
  /ActivationDeviceResponse[\s\S]{0,200}deviceType: DeviceType \| null/.test(typesSource),
  'ActivationDeviceResponse.deviceType is typed DeviceType | null'
);
check(
  /ActivationDeviceResponse[\s\S]{0,200}provider: LandlineProvider \| null/.test(typesSource),
  'ActivationDeviceResponse.provider is typed LandlineProvider | null'
);

// ============================================================
// mobile/lib/api.ts — fetchActivationDevice
// ============================================================

check(
  apiTsSource.includes('export async function fetchActivationDevice('),
  'mobile/lib/api.ts exports fetchActivationDevice'
);
check(
  apiTsSource.includes('"/api/v1/me/activation-device"'),
  'fetchActivationDevice calls GET /api/v1/me/activation-device'
);
check(
  /fetchActivationDevice[\s\S]{0,400}parseJsonOrThrow<ActivationDeviceResponse>\(response, true\)/.test(apiTsSource),
  'fetchActivationDevice parses its response as ActivationDeviceResponse with allow402 (same as fetchActivationInstructions, which shares its entitlement gate)'
);

// ============================================================
// mobile/lib/activationDeviceStorage.ts — unchanged local-storage shape
// ============================================================

check(
  activationDeviceStorageSource.includes('export interface StoredActivationDevice'),
  'StoredActivationDevice is still exported for turn-off-protection.tsx to type its resolved (local-or-backend) device against'
);

// ============================================================
// mobile/app/(tabs)/account/turn-off-protection.tsx
// ============================================================

check(
  turnOffProtectionSource.includes('fetchActivationInstructions, fetchActivationDevice') ||
    (turnOffProtectionSource.includes('fetchActivationInstructions') && turnOffProtectionSource.includes('fetchActivationDevice')),
  'turn-off-protection.tsx imports both fetchActivationInstructions and the new fetchActivationDevice fallback'
);
check(
  turnOffProtectionSource.includes('saveActivationDevice') && turnOffProtectionSource.includes('loadActivationDevice'),
  'turn-off-protection.tsx imports both saveActivationDevice (to re-cache) and loadActivationDevice (existing local read)'
);

check(
  turnOffProtectionSource.includes('function showInstructionsFor(device: StoredActivationDevice)'),
  'the fetchActivationInstructions call is factored into one shared helper, called identically whether the device came from local storage or the backend fallback — no duplicated/diverging logic between the two paths'
);

const loadThenBlock = turnOffProtectionSource.slice(
  turnOffProtectionSource.indexOf('loadActivationDevice()'),
  turnOffProtectionSource.indexOf('return () => {')
);

check(
  /if \(device\) return showInstructionsFor\(device\);/.test(loadThenBlock),
  'when the local record exists, behaviour is completely unchanged: showInstructionsFor is called directly on it, with no backend round trip'
);
check(
  loadThenBlock.includes('fetchActivationDevice(session?.access_token)'),
  'when the local record is absent, the screen calls the new backend fallback'
);
check(
  /if \(!backendDevice\.deviceType\) \{\s*setState\("no_device_on_record"\);/.test(loadThenBlock),
  'a household with genuinely no device on record either locally or server-side still shows "no_device_on_record" — the fallback does not fabricate a device'
);
check(
  loadThenBlock.includes('saveActivationDevice(resolved)'),
  'a device recovered from the backend is re-cached locally (saveActivationDevice) so this only round-trips once per reinstall'
);
check(
  /saveActivationDevice\(resolved\)\.catch\(\(\) => \{\}\);\s*return showInstructionsFor\(resolved\);/.test(loadThenBlock),
  're-caching is best-effort (a save failure never blocks showing the real instructions this same request already fetched) and the recovered device is still shown via the same shared helper as the local-storage path'
);
check(
  /fetchActivationDevice\(session\?\.access_token\)[\s\S]*?\.catch\(\(\) => \{\s*if \(!cancelled\) setState\("unavailable"\);/.test(loadThenBlock),
  'a genuine failure to reach the backend fallback (e.g. network error) shows "unavailable" (try again), distinct from the definitive "no_device_on_record" state — the two are never conflated'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
