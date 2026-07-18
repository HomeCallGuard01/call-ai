// Unit tests for services/serverConfig.js — added as part of the
// production-readiness fixes (docs/PROJECT_STATUS.md,
// docs/LAUNCH_READINESS.md). Pure functions, no server started, no
// network access.
//
// Run with: node tests/server-config.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolvePort, validateProductionEnv, REQUIRED_IN_PRODUCTION } = require('../services/serverConfig.js');

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

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
