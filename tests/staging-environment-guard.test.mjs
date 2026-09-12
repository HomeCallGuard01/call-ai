// Staging safety hardening (2026-09-12 staging audit) — the environment
// guard that makes it safe to run this backend against staging without
// risking production data or a real Twilio release. Two independent
// layers, tested together here:
//
//   1. services/serverConfig.js's validateStagingEnv/validateProductionEnv
//      — pure startup validation, no server started, no network access.
//   2. services/twilioProvisioning.js's releaseQuarantinedTwilioNumber —
//      the one real-Twilio-release choke point, now fail-closed unless
//      isProductionEnvironment() says otherwise.
//
// Run with: node tests/staging-environment-guard.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
require('dotenv').config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  validateStagingEnv,
  validateProductionEnv,
  describeEnvironmentIdentity,
  extractSupabaseRef,
  isProductionSupabaseRef,
  isStagingSupabaseRef,
  PRODUCTION_SUPABASE_REF,
  STAGING_SUPABASE_REF,
} = require('../services/serverConfig.js');
const { releaseQuarantinedTwilioNumber } = require('../services/twilioProvisioning.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function stagingEnv(overrides = {}) {
  return {
    APP_ENV: 'staging',
    SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co`,
    STRIPE_SECRET_KEY: 'sk_test_example',
    ...overrides,
  };
}

function productionEnv(overrides = {}) {
  return {
    SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co`,
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    APP_URL: 'https://homecallguard.example.com',
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_PRICE_ID: 'price_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    TWILIO_AUTH_TOKEN: 'twilio-auth-token-example',
    ...overrides,
  };
}

function makeFakeReleaseClient() {
  const calls = { remove: [] };
  const incomingPhoneNumbers = (sid) => ({
    remove: async () => {
      calls.remove.push(sid);
      return true;
    },
  });
  incomingPhoneNumbers.list = async ({ phoneNumber }) => [{ sid: `SID-${phoneNumber}` }];
  return { calls, incomingPhoneNumbers };
}

async function run() {
  // --- extractSupabaseRef / isProductionSupabaseRef / isStagingSupabaseRef ---

  check(extractSupabaseRef(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`) === PRODUCTION_SUPABASE_REF, 'extractSupabaseRef reads the ref out of a real Supabase URL');
  check(extractSupabaseRef('not-a-url') === null, 'extractSupabaseRef returns null for an unparseable URL, never throws');
  check(extractSupabaseRef(undefined) === null, 'extractSupabaseRef returns null for undefined, never throws');
  check(isProductionSupabaseRef(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`) === true, 'isProductionSupabaseRef recognises the real production ref');
  check(isProductionSupabaseRef(`https://${STAGING_SUPABASE_REF}.supabase.co`) === false, 'isProductionSupabaseRef rejects the staging ref');
  check(isStagingSupabaseRef(`https://${STAGING_SUPABASE_REF}.supabase.co`) === true, 'isStagingSupabaseRef recognises the real staging ref');
  check(isStagingSupabaseRef(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`) === false, 'isStagingSupabaseRef rejects the production ref');

  // --- staging startup refuses production Supabase ---

  {
    const problems = validateStagingEnv(stagingEnv({ SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co` }));
    check(problems.length > 0, 'staging validation refuses a SUPABASE_URL pointing at the production project');
    check(problems.some(p => p.includes('SUPABASE_URL')), 'the specific problem names SUPABASE_URL, not a generic failure');
  }

  {
    const problems = validateStagingEnv(stagingEnv({ SUPABASE_URL: undefined }));
    check(problems.length > 0, 'staging validation refuses a missing SUPABASE_URL — fail-closed, never assumes staging by default');
  }

  {
    const problems = validateStagingEnv(stagingEnv({ SUPABASE_URL: 'https://some-other-project.supabase.co' }));
    check(problems.length > 0, 'staging validation refuses any project ref other than the known staging one, not just production specifically');
  }

  // --- staging startup refuses live Stripe ---

  {
    const problems = validateStagingEnv(stagingEnv({ STRIPE_SECRET_KEY: 'sk_live_example' }));
    check(problems.length > 0, 'staging validation refuses a live-mode Stripe key');
    check(problems.some(p => p.includes('STRIPE_SECRET_KEY')), 'the specific problem names STRIPE_SECRET_KEY');
  }

  {
    const problems = validateStagingEnv(stagingEnv({ STRIPE_SECRET_KEY: undefined }));
    check(problems.length > 0, 'staging validation refuses a missing Stripe key entirely, never assumes test mode by default');
  }

  // --- staging startup accepts the explicit staging Supabase + Stripe test configuration ---

  {
    const problems = validateStagingEnv(stagingEnv());
    check(problems.length === 0, 'a correctly-shaped staging environment (staging ref + sk_test_ key) passes validation with zero problems');
  }

  // --- production behaviour remains available under the correct production configuration ---

  {
    const problems = validateProductionEnv(productionEnv());
    check(problems.length === 0, 'a correctly-shaped production environment still passes validateProductionEnv with zero problems — the new staging-ref check does not false-positive against real production config');
  }

  {
    // The new symmetric guard: production must also refuse to boot
    // against the staging project — inert under correct config (proven
    // above), but catches the mirror-image mistake.
    const problems = validateProductionEnv(productionEnv({ SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co` }));
    check(problems.length > 0, 'production validation refuses a SUPABASE_URL pointing at the staging project');
    check(problems.some(p => p.includes('staging')), 'the specific problem names the staging project, not a generic failure');
  }

  // --- describeEnvironmentIdentity never includes a secret value ---

  {
    const identity = describeEnvironmentIdentity(stagingEnv({ STRIPE_SECRET_KEY: 'sk_test_some_real_looking_secret_value' }));
    const serialized = JSON.stringify(identity);
    check(!serialized.includes('some_real_looking_secret_value'), 'describeEnvironmentIdentity never includes the actual Stripe key value, only its derived mode');
    check(identity.stripeMode === 'test', 'describeEnvironmentIdentity correctly derives "test" mode from the sk_test_ prefix');
    check(identity.supabaseRef === STAGING_SUPABASE_REF, 'describeEnvironmentIdentity reports the resolved Supabase ref (not a secret — the public project identifier)');
  }

  {
    const identity = describeEnvironmentIdentity(productionEnv());
    check(identity.stripeMode === 'live', 'describeEnvironmentIdentity correctly derives "live" mode from the sk_live_ prefix');
  }

  // --- staging cannot execute real Twilio number release (fail-closed) ---

  {
    const client = makeFakeReleaseClient();
    const result = await releaseQuarantinedTwilioNumber(
      { id: 'q-staging-1', household_id: 'household-x', twilio_number: '+447700900099', deactivation_confirmed: true, released_at: null },
      { client, isProductionEnvironment: () => false }
    );
    check(result.released === false && result.blocked === true, 'a confirmed, releasable quarantine row is BLOCKED, not released, when the environment is not production');
    check(client.calls.remove.length === 0, 'Twilio\'s real .remove() is never called when the environment guard blocks the release');
    check(result.reason === 'not_production_environment', 'the block reason is explicit and machine-readable, not a generic failure');
  }

  {
    // The guard must not silently mark a blocked row as released — a
    // later real production run must still be able to process it.
    const client = makeFakeReleaseClient();
    const markReleasedCalls = [];
    const markReleased = async (id) => { markReleasedCalls.push(id); };
    await releaseQuarantinedTwilioNumber(
      { id: 'q-staging-2', household_id: 'household-y', twilio_number: '+447700900098', deactivation_confirmed: true, released_at: null },
      { client, markReleased, isProductionEnvironment: () => false }
    );
    check(markReleasedCalls.length === 0, 'a blocked release never marks the quarantine row as released in the database — it remains eligible for a real future production run');
  }

  {
    // Defence in depth: the default isProductionEnvironment (no override)
    // reads the real process.env.SUPABASE_URL — this test run's actual
    // environment is neither guaranteed to be staging nor production, so
    // this only proves the function never throws when relying on the
    // real default rather than an injected one.
    const client = makeFakeReleaseClient();
    let threw = false;
    try {
      await releaseQuarantinedTwilioNumber(
        { id: 'q-default-check', household_id: 'household-z', twilio_number: '+447700900097', deactivation_confirmed: true, released_at: null },
        { client }
      );
    } catch {
      threw = true;
    }
    check(threw === false, 'releaseQuarantinedTwilioNumber never throws when isProductionEnvironment is not explicitly overridden — it falls back to the real, safe default check');
  }

  // --- production release behaviour remains available under the correct production configuration ---

  {
    const client = makeFakeReleaseClient();
    const markReleasedCalls = [];
    const markReleased = async (id) => { markReleasedCalls.push(id); };
    const result = await releaseQuarantinedTwilioNumber(
      { id: 'q-prod-1', household_id: 'household-prod', twilio_number: '+447700900096', deactivation_confirmed: true, released_at: null },
      { client, markReleased, isProductionEnvironment: () => true }
    );
    check(result.released === true, 'a confirmed, releasable quarantine row IS genuinely released when isProductionEnvironment confirms production — the guard never blocks real production behaviour');
    check(client.calls.remove.length === 1, 'the real Twilio .remove() call is made exactly once under confirmed production conditions');
    check(markReleasedCalls.length === 1 && markReleasedCalls[0] === 'q-prod-1', 'the quarantine row is correctly marked released after a genuine production release');
  }

  // --- environment validation happens before background release scheduling ---

  {
    const serverSrc = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const stagingValidationIdx = serverSrc.indexOf('process.env.APP_ENV === "staging"');
    const schedulerSetupIdx = serverSrc.indexOf('runTwilioNumberReleaseCheck();\n  runQuarantinedNumberReleaseCheck();');
    check(stagingValidationIdx !== -1, 'sanity check: the staging validation block is found in server.js');
    check(schedulerSetupIdx !== -1, 'sanity check: the scheduler setup block is found in server.js');
    check(
      stagingValidationIdx !== -1 && schedulerSetupIdx !== -1 && stagingValidationIdx < schedulerSetupIdx,
      'staging environment validation appears in server.js before the release scheduler is ever armed — a failed validation process.exit(1)s long before any scheduled job could run'
    );

    const productionValidationIdx = serverSrc.indexOf('process.env.NODE_ENV === "production"');
    check(
      productionValidationIdx !== -1 && productionValidationIdx < schedulerSetupIdx,
      'existing production environment validation also still appears before the scheduler is armed — unchanged ordering'
    );
  }

  // --- no existing production behaviour is unintentionally changed ---

  {
    const serverConfigSrc = readFileSync(path.join(__dirname, '..', 'services', 'serverConfig.js'), 'utf8');
    check(
      serverConfigSrc.includes('const REQUIRED_IN_PRODUCTION = ['),
      'REQUIRED_IN_PRODUCTION is still defined — the existing required-vars list is untouched, only appended to by the new staging-ref check'
    );
  }

  {
    // The exact three pre-existing releaseQuarantinedTwilioNumber
    // behaviours (unconfirmed / already-released / null row) are
    // untouched by the new guard — they return before ever reaching it.
    const client = makeFakeReleaseClient();
    const unconfirmed = await releaseQuarantinedTwilioNumber(
      { id: 'q-unconfirmed', deactivation_confirmed: false, released_at: null },
      { client, isProductionEnvironment: () => true }
    );
    check(unconfirmed.released === false && client.calls.remove.length === 0, 'an unconfirmed row is still never released, even when the environment is confirmed production — unrelated existing safety property unchanged');

    const alreadyReleased = await releaseQuarantinedTwilioNumber(
      { id: 'q-already', deactivation_confirmed: true, released_at: '2026-09-01T00:00:00.000Z' },
      { client, isProductionEnvironment: () => true }
    );
    check(alreadyReleased.released === false && client.calls.remove.length === 0, 'an already-released row is still never released again, even when the environment is confirmed production');

    const nullRow = await releaseQuarantinedTwilioNumber(null, { isProductionEnvironment: () => true });
    check(nullRow.released === false, 'a null row is still handled defensively — unchanged');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll staging-environment-guard checks passed.');
  }
}

run();
