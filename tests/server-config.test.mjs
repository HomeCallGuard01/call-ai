// Unit tests for services/serverConfig.js — added as part of the
// production-readiness fixes (docs/PROJECT_STATUS.md,
// docs/LAUNCH_READINESS.md). Pure functions, no server started, no
// network access.
//
// Run with: node tests/server-config.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolvePort,
  validateProductionEnv,
  REQUIRED_IN_PRODUCTION,
  validateStagingEnv,
  REQUIRED_IN_STAGING,
  STAGING_SUPABASE_REF,
  PRODUCTION_SUPABASE_REF,
} = require('../services/serverConfig.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// A complete, valid production-shaped env, used as a baseline that later
// tests remove one field from at a time.
function validEnv(overrides = {}) {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    APP_URL: 'https://homecallguard.example.com',
    STRIPE_SECRET_KEY: 'sk_live_example',
    STRIPE_PRICE_ID: 'price_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    ...overrides,
  };
}

// --- resolvePort ---

check(
  resolvePort({ PORT: '8080' }) === '8080',
  'resolvePort uses process.env.PORT when set (Railway/most PaaS providers assign this dynamically)'
);

check(
  resolvePort({}) === 3000,
  'resolvePort falls back to 3000 when PORT is not set (local dev)'
);

check(
  resolvePort({ PORT: undefined }) === 3000,
  'resolvePort falls back to 3000 when PORT is explicitly undefined'
);

// --- validateProductionEnv: happy path ---

check(
  validateProductionEnv(validEnv()).length === 0,
  'a fully-configured production env reports no problems'
);

// --- validateProductionEnv: missing required vars ---

for (const name of REQUIRED_IN_PRODUCTION) {
  const env = validEnv();
  delete env[name];
  const problems = validateProductionEnv(env);
  check(
    problems.some((p) => p.includes(name)),
    `missing ${name} is reported as a problem`
  );
}

// --- validateProductionEnv: never leaks a secret value ---

const envWithSecrets = validEnv();
delete envWithSecrets.STRIPE_SECRET_KEY;
const problemsText = validateProductionEnv(envWithSecrets).join(' ');
check(
  !problemsText.includes('sk_live_example') && !problemsText.includes('service-role-key'),
  'problem messages never include any actual env var value, only names'
);

// --- validateProductionEnv: the specific "must not be localhost" requirement ---

check(
  validateProductionEnv(validEnv({ APP_URL: 'http://localhost:3000' })).some((p) =>
    p.toLowerCase().includes('localhost')
  ),
  'APP_URL still resolving to localhost is reported as a problem, even though the var is set'
);

check(
  validateProductionEnv(validEnv({ APP_URL: 'http://127.0.0.1:3000' })).some((p) =>
    p.includes('127.0.0.1')
  ),
  'APP_URL resolving to 127.0.0.1 is also reported as a problem'
);

check(
  validateProductionEnv(validEnv({ APP_URL: 'not a url' })).some((p) =>
    p.includes('not a valid URL')
  ),
  'a malformed APP_URL is reported as a problem rather than throwing'
);

// --- validateStagingEnv ---
//
// Added after a real incident (2026-08-02 RC1 staging E2E test) where the
// staging backend's Stripe config silently fell through to the sandbox
// repo's default .env — which also carried a live-prefixed Stripe key —
// because nothing checked that an explicitly-selected non-production
// environment actually pointed at non-production services.

// A complete, valid staging-shaped env, mirroring validEnv() above's role
// for the production checks.
function validStagingEnv(overrides = {}) {
  return {
    APP_URL: 'http://192.168.1.237:3099',
    PORT: '3099',
    SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co`,
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    STRIPE_SECRET_KEY: 'sk_test_example',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
    STRIPE_PRICE_ID: 'price_example',
    STRIPE_WEBHOOK_SECRET: 'whsec_example',
    ...overrides,
  };
}

check(
  validateStagingEnv(validStagingEnv()).length === 0,
  'a fully-configured staging env (staging Supabase ref, test-mode Stripe keys) reports no problems'
);

for (const name of REQUIRED_IN_STAGING) {
  const env = validStagingEnv();
  delete env[name];
  const problems = validateStagingEnv(env);
  check(
    problems.some((p) => p.includes(name)),
    `staging: missing ${name} is reported as a problem`
  );
}

check(
  validateStagingEnv(validStagingEnv({ SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co` })).some((p) =>
    p.toLowerCase().includes('production')
  ),
  'staging: SUPABASE_URL resolving to the known production project ref is reported as a problem'
);

check(
  validateStagingEnv(validStagingEnv({ SUPABASE_URL: 'https://some-other-project.supabase.co' })).some((p) =>
    p.includes(STAGING_SUPABASE_REF)
  ),
  'staging: SUPABASE_URL resolving to neither staging nor the known production ref is still reported as a problem'
);

check(
  validateStagingEnv(validStagingEnv({ STRIPE_SECRET_KEY: 'sk_live_example' })).some((p) =>
    p.toLowerCase().includes('live')
  ),
  'staging: a live-prefixed STRIPE_SECRET_KEY is reported as a problem'
);

check(
  validateStagingEnv(validStagingEnv({ STRIPE_SECRET_KEY: 'not-a-recognizable-key' })).some((p) =>
    p.includes('STRIPE_SECRET_KEY')
  ),
  'staging: a STRIPE_SECRET_KEY without a recognizable sk_test_ prefix is reported as a problem'
);

check(
  validateStagingEnv(validStagingEnv({ STRIPE_PUBLISHABLE_KEY: 'pk_live_example' })).some((p) =>
    p.includes('STRIPE_PUBLISHABLE_KEY')
  ),
  'staging: a live-prefixed STRIPE_PUBLISHABLE_KEY is reported as a problem'
);

check(
  validateStagingEnv(validStagingEnv({ STRIPE_PUBLISHABLE_KEY: 'ppk_live_example' })).some((p) =>
    p.includes('STRIPE_PUBLISHABLE_KEY')
  ),
  'staging: an oddly-prefixed but still _live_-containing STRIPE_PUBLISHABLE_KEY (the exact shape found in the sandbox .env incident) is reported as a problem'
);

const stagingEnvWithSecrets = validStagingEnv();
delete stagingEnvWithSecrets.STRIPE_SECRET_KEY;
const stagingProblemsText = validateStagingEnv(stagingEnvWithSecrets).join(' ');
check(
  !stagingProblemsText.includes('service-role-key') && !stagingProblemsText.includes('sk_test_example'),
  'staging: problem messages never include any actual env var value, only names'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
