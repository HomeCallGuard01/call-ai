// services/monitoringTestBypass.js — TEST-ONLY diagnostic bypass for the
// Media Streams A/B/C audio-quality experiment (2026-09-12 launch-critical
// investigation). This is the entire decision logic for whether one
// explicitly-designated test household's live monitoring is skipped;
// see server.js's attachLiveMonitoring for the one call site, and
// tests/live-monitoring-test-bypass-integration.test.mjs for structural
// proof that call site is wired correctly.
//
// Run with: node tests/monitoring-test-bypass.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldBypassMonitoringForTest, parseHouseholdAllowlist } = require('../services/monitoringTestBypass.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const TEST_HOUSEHOLD = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const OTHER_HOUSEHOLD = 'ffffffff-ffff-4fff-afff-ffffffffffff';

function enabledEnv(overrides = {}) {
  return {
    DIAGNOSTIC_MONITORING_BYPASS_ENABLED: 'true',
    DISABLE_MONITORING_FOR_HOUSEHOLD_IDS: TEST_HOUSEHOLD,
    ...overrides,
  };
}

function run() {
  // --- variable absent / empty -> monitoring behaves exactly as today ---

  check(
    shouldBypassMonitoringForTest(TEST_HOUSEHOLD, {}) === false,
    'both env vars entirely absent -> never bypasses, even for what would otherwise be an allowlisted household'
  );

  check(
    shouldBypassMonitoringForTest(TEST_HOUSEHOLD, { DIAGNOSTIC_MONITORING_BYPASS_ENABLED: 'true', DISABLE_MONITORING_FOR_HOUSEHOLD_IDS: '' }) === false,
    'enable flag set but allowlist empty string -> never bypasses'
  );

  check(
    shouldBypassMonitoringForTest(TEST_HOUSEHOLD, { DIAGNOSTIC_MONITORING_BYPASS_ENABLED: 'true' }) === false,
    'enable flag set but allowlist var entirely missing -> never bypasses'
  );

  check(
    shouldBypassMonitoringForTest(TEST_HOUSEHOLD, { DISABLE_MONITORING_FOR_HOUSEHOLD_IDS: TEST_HOUSEHOLD }) === false,
    'allowlist set but enable flag entirely missing -> never bypasses (the enable flag is NOT optional)'
  );

  // --- the enable flag must be exactly "true" — fail closed on anything else ---

  for (const badFlag of ['false', 'TRUE', '1', 'yes', 'True', '']) {
    check(
      shouldBypassMonitoringForTest(TEST_HOUSEHOLD, enabledEnv({ DIAGNOSTIC_MONITORING_BYPASS_ENABLED: badFlag })) === false,
      `enable flag value ${JSON.stringify(badFlag)} (not the exact string "true") -> never bypasses`
    );
  }

  // --- different household -> stream starts normally (never bypassed) ---

  check(
    shouldBypassMonitoringForTest(OTHER_HOUSEHOLD, enabledEnv()) === false,
    'a household NOT in the allowlist is never bypassed, even with the enable flag on and a valid allowlist present'
  );

  // --- exact allowlisted test household -> bypass applies ---

  check(
    shouldBypassMonitoringForTest(TEST_HOUSEHOLD, enabledEnv()) === true,
    'the exact allowlisted household, with the enable flag also on, is correctly bypassed'
  );

  check(
    shouldBypassMonitoringForTest(TEST_HOUSEHOLD.toUpperCase(), enabledEnv()) === true,
    'household id comparison is case-insensitive (Postgres UUIDs and request bodies are not guaranteed to share one casing convention)'
  );

  // --- malformed UUIDs are ignored / fail closed ---

  const malformedCases = [
    'not-a-uuid',
    '12345',
    TEST_HOUSEHOLD.slice(0, -1), // one character short
    TEST_HOUSEHOLD + 'x', // one character too long
    'a1b2c3d4e5f64789a01234567890abcde', // no hyphens
  ];
  for (const malformed of malformedCases) {
    check(
      parseHouseholdAllowlist(malformed).length === 0,
      `malformed id ${JSON.stringify(malformed)} is dropped from the parsed allowlist, never matched`
    );
    check(
      shouldBypassMonitoringForTest(malformed, enabledEnv({ DISABLE_MONITORING_FOR_HOUSEHOLD_IDS: malformed })) === false,
      `a malformed allowlist entry can never bypass monitoring for itself, even if a household id happened to equal the same malformed string`
    );
  }

  // --- no wildcard / prefix / "all" mechanism ---

  for (const wildcard of ['*', 'all', 'ALL', '%', '.*', TEST_HOUSEHOLD.slice(0, 8)]) {
    check(
      shouldBypassMonitoringForTest(TEST_HOUSEHOLD, enabledEnv({ DISABLE_MONITORING_FOR_HOUSEHOLD_IDS: wildcard })) === false,
      `${JSON.stringify(wildcard)} in the allowlist cannot bypass monitoring for a real household — no wildcard/prefix/"all" mechanism exists`
    );
  }

  // --- multiple explicit UUIDs work ---

  {
    const thirdHousehold = '11111111-2222-4333-8444-555555555555';
    const multiEnv = enabledEnv({ DISABLE_MONITORING_FOR_HOUSEHOLD_IDS: `${TEST_HOUSEHOLD}, ${OTHER_HOUSEHOLD} ,${thirdHousehold}` });
    check(shouldBypassMonitoringForTest(TEST_HOUSEHOLD, multiEnv) === true, 'first of multiple comma-separated households is bypassed');
    check(shouldBypassMonitoringForTest(OTHER_HOUSEHOLD, multiEnv) === true, 'second of multiple comma-separated households (with surrounding whitespace) is bypassed');
    check(shouldBypassMonitoringForTest(thirdHousehold, multiEnv) === true, 'third of multiple comma-separated households is bypassed');
    check(shouldBypassMonitoringForTest('99999999-9999-4999-8999-999999999999', multiEnv) === false, 'a household not among the multiple listed is still never bypassed');
  }

  // --- a mix of valid and malformed entries keeps only the valid ones ---

  {
    const mixed = parseHouseholdAllowlist(`${TEST_HOUSEHOLD}, not-a-uuid, *, ${OTHER_HOUSEHOLD}`);
    check(
      mixed.length === 2 && mixed.includes(TEST_HOUSEHOLD.toLowerCase()) && mixed.includes(OTHER_HOUSEHOLD.toLowerCase()),
      'a mixed valid/malformed allowlist keeps only the genuinely well-formed UUIDs'
    );
  }

  // --- defensive: never throws on unusual input ---

  check(shouldBypassMonitoringForTest(null, enabledEnv()) === false, 'a null household id is handled defensively — never bypasses, never throws');
  check(shouldBypassMonitoringForTest(undefined, enabledEnv()) === false, 'an undefined household id is handled defensively');
  check(shouldBypassMonitoringForTest(TEST_HOUSEHOLD, null) === false, 'a null env object is handled defensively — never throws');
  check(parseHouseholdAllowlist(undefined).length === 0, 'parseHouseholdAllowlist(undefined) returns an empty array, never throws');
  check(parseHouseholdAllowlist(null).length === 0, 'parseHouseholdAllowlist(null) returns an empty array, never throws');

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll monitoring-test-bypass checks passed.');
  }
}

run();
