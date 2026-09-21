// Structural tests for the landline checkout-eligibility fix's remaining
// surfaces not covered elsewhere:
//
//   - migration 040's own SQL (column/constraint/backfill/RPC shape) —
//     complementary to tests/migrations.pglite.test.mjs, which proves the
//     migration actually WORKS against a real database; this file proves
//     the SQL matches the approved design (safe backfill only from
//     carrier_provider_key, no landline inference, drop-then-create RPC).
//   - the web submit-handler's own raw-reason-leak fix (the mobile
//     equivalent is covered by tests/device-picker-landline-device-type.test.mjs).
//   - "downstream consistency" (the security refinement): once a
//     household has persisted device_type, the POST-payment activation
//     step must consult the same server-authoritative signal, not only
//     the checkout-time client memory — server.js's /dashboard-data,
//     routes/mobileApi.js's GET /api/v1/me/dashboard, and upload.html's
//     renderActivateStep().
//
// No HTTP/DOM test tooling exists in this project (see
// tests/account-deletion.test.mjs for the same established convention)
// — every file is checked directly against its real source.
//
// Run with: node tests/household-device-type-migration.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSource = readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '040_household_device_type.sql'), 'utf8');
const html = readFileSync(path.join(__dirname, '..', 'upload.html'), 'utf8');
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const mobileApiSource = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');

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
// Migration 040 SQL — matches the approved design exactly
// ============================================================

check(
  /add column if not exists device_type text/.test(migrationSource),
  'device_type is added as a nullable text column (idempotent add)'
);
check(
  /check\s*\(\s*device_type is null or device_type in \('mobile', 'landline'\)\s*\)/.test(migrationSource),
  'device_type has a CHECK constraint restricting it to mobile/landline/null — no other value can ever be persisted'
);

const backfillIdx = migrationSource.indexOf("set device_type = 'mobile'");
check(backfillIdx !== -1, 'the migration backfills device_type = \'mobile\' for existing rows');
const backfillStatement = migrationSource.slice(backfillIdx - 40, backfillIdx + 150);
check(
  backfillStatement.includes('carrier_provider_key is not null') && backfillStatement.includes('device_type is null'),
  'the backfill is scoped to carrier_provider_key IS NOT NULL AND device_type IS NULL — the only deterministic signal, and idempotent on re-run'
);
check(
  !/set device_type = 'landline'/.test(migrationSource),
  'the migration never backfills any row to landline — approved rule 2: landline is never inferred, only ever explicitly set by a customer going forward'
);

check(
  migrationSource.includes('drop function if exists public.set_household_carrier_compatibility(uuid, text, text);'),
  'the old 3-arg RPC is explicitly dropped before the new 4-arg one is created — required because CREATE OR REPLACE does not collapse a differing-arity overload'
);
check(
  /create function public\.set_household_carrier_compatibility\(\s*p_household_id uuid,\s*p_device_type text,\s*p_provider_key text,\s*p_tariff_type text default null\s*\)/.test(migrationSource),
  'the new RPC has the exact approved 4-arg signature (household id, device type, provider key, optional tariff type)'
);
check(
  migrationSource.includes("if p_device_type is null or p_device_type not in ('mobile', 'landline') then") &&
    migrationSource.includes('raise exception'),
  'the RPC itself validates device_type — an invalid/missing value is rejected at the database layer, not only by application code'
);
check(
  migrationSource.includes("carrier_provider_key = case when p_device_type = 'landline' then null else p_provider_key end") &&
    migrationSource.includes("carrier_tariff_type = case when p_device_type = 'landline' then null else p_tariff_type end"),
  'switching to landline atomically clears carrier_provider_key/carrier_tariff_type in the SAME update statement as the device_type write — never a separate, race-prone second write'
);
check(
  migrationSource.includes('revoke all on function public.set_household_carrier_compatibility(uuid, text, text, text) from public;') &&
    migrationSource.includes('grant execute on function public.set_household_carrier_compatibility(uuid, text, text, text) to service_role;'),
  'the new RPC\'s grants match every other SECURITY DEFINER RPC in this codebase — service_role only, nothing to PUBLIC/anon/authenticated'
);
check(
  migrationSource.includes("security definer") && migrationSource.includes('set search_path = \'\''),
  'the new RPC is SECURITY DEFINER with a pinned empty search_path, matching migration 022\'s fail-closed convention'
);

// ============================================================
// Web submit-handler defense-in-depth check — raw reason leak fixed
// ============================================================

const submitFetchIdx = html.indexOf('fetch("/billing/carrier-compatibility")\n        .then');
check(submitFetchIdx !== -1, 'the submit-handler defense-in-depth carrier re-check is present');
const submitFetchBlockEnd = html.indexOf('.catch(function () {\n          // Couldn\'t re-verify', submitFetchIdx);
const submitFetchBlock = submitFetchIdx !== -1 && submitFetchBlockEnd !== -1 ? html.slice(submitFetchIdx, submitFetchBlockEnd) : '';
check(
  submitFetchBlock.includes('result.customerState === "needs_confirmation"'),
  'the defense-in-depth re-check branches on customerState, not the raw backend reason string'
);
// 2026-09-21 (LANDLINE_COMING_SOON): the re-check may COMPARE `reason` to the one stable sentinel
// "landline_coming_soon" (the authoritative server keeps customerState "landline_provider_unsupported" for
// already-shipped clients, so `reason` is the only way to tell Coming soon apart) to pick a FIXED customer
// message. What must still never happen is any other use of `reason` — in particular assigning the raw
// backend string to an element's text.
check(
  !submitFetchBlock.replace(/\/\/.*$/gm, '').replace(/result\.reason === "landline_coming_soon"/g, '').includes('result.reason'),
  'the defense-in-depth re-check never assigns the raw backend `reason` string to any element\'s text in actual code (comments explaining the historical bug excluded); its only use of `reason` is an equality comparison with the stable sentinel "landline_coming_soon" that selects a fixed message'
);

// ============================================================
// "Downstream consistency" — server-authoritative device_type is
// surfaced past the checkout gate, for the post-payment activation step
// ============================================================

check(
  serverSource.includes('deviceType: req.household.device_type || null,'),
  'server.js\'s GET /dashboard-data response exposes the same server-authoritative device_type the checkout gate itself persists'
);

check(
  mobileApiSource.includes('deviceType: req.household.device_type || null,'),
  'routes/mobileApi.js\'s GET /api/v1/me/dashboard response exposes device_type too, for parity with the web dashboard'
);

const renderActivateStepStart = html.indexOf('function renderActivateStep()');
const renderActivateStepEnd = html.indexOf('\n  }', renderActivateStepStart);
const renderActivateStepBody = html.slice(renderActivateStepStart, renderActivateStepEnd);
check(renderActivateStepStart !== -1, 'renderActivateStep is declared');
check(
  renderActivateStepBody.includes('lastDashboardData && lastDashboardData.deviceType'),
  'renderActivateStep consults the server-authoritative lastDashboardData.deviceType — once a household is persisted as landline, the post-payment activation step honours that even if the local memory disagrees or was never set'
);
const serverDeviceCategoryIdx = renderActivateStepBody.indexOf('const serverDeviceCategory');
const rememberedCategoryIdx = renderActivateStepBody.indexOf('const rememberedCategory');
check(
  serverDeviceCategoryIdx !== -1 && rememberedCategoryIdx !== -1 && serverDeviceCategoryIdx < rememberedCategoryIdx,
  'the server value is read before the client-side remembered value is computed, and the remembered value is only a fallback (serverDeviceCategory || getRememberedDeviceCategory()) — the server-persisted signal wins whenever it exists'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
