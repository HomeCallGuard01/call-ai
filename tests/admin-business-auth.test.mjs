// Security tests for the business/profitability dashboard (2026-09
// build) — routes/adminBusiness.js, admin-business.html.
//
// Deliberately does NOT boot the real server.js: this repo's own .env is
// production configuration (real Supabase/Stripe/Twilio credentials),
// and requireAuth (middleware/requireAuth.js) genuinely calls
// supabase.auth.getUser() against whatever project is configured — a
// real HTTP integration test here would mean either faking a production
// session (not possible/desirable) or accidentally exercising real
// production auth calls from a test run, which this codebase's own
// established caution around touching production explicitly rules out.
//
// Instead: (1) requireAdmin's actual authorization DECISION is unit-
// tested directly, with fake req/res objects — this is the real,
// production code path, not a reimplementation of it; (2) every new
// route is checked structurally to confirm it is actually wired through
// requireAuth + requireAdmin in the source, not just that the functions
// exist somewhere; (3) the dashboard's server and client source are
// scanned to confirm no provider secret is ever placed in a JSON
// response or sent to the browser.
//
// Run with: node tests/admin-business-auth.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { requireAdmin } = require('../middleware/requireAdmin.js');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function fakeRes() {
  return {
    redirected: null,
    redirect(url) { this.redirected = url; },
  };
}

// --- requireAdmin: the real, unmodified authorization function ---

{
  const res = fakeRes();
  let nextCalled = false;
  requireAdmin({ role: 'household' }, res, () => { nextCalled = true; });
  check(nextCalled === false, 'requireAdmin: a normal customer (role "household") never reaches the protected route handler');
  check(res.redirected === '/dashboard', 'requireAdmin: a non-admin is redirected away, never shown even an error page that reveals the route exists');
}
{
  const res = fakeRes();
  let nextCalled = false;
  requireAdmin({}, res, () => { nextCalled = true; });
  check(nextCalled === false, 'requireAdmin: a request with no role at all (should never happen post-requireAuth, but checked anyway) is denied, not defaulted to allowed');
}
{
  const res = fakeRes();
  let nextCalled = false;
  requireAdmin({ role: 'admin' }, res, () => { nextCalled = true; });
  check(nextCalled === true, 'requireAdmin: a genuine admin reaches the protected route handler');
  check(res.redirected === null, 'requireAdmin: a genuine admin is never redirected');
}

// --- structural: every new business-dashboard route is actually wired
// through requireAuth + requireAdmin, not just that those functions
// exist somewhere in the file ---

const routeSource = readFileSync(path.join(__dirname, '..', 'routes', 'adminBusiness.js'), 'utf8');

check(
  routeSource.includes('const { requireAuth } = require("../middleware/requireAuth")') &&
    routeSource.includes('const { requireAdmin } = require("../middleware/requireAdmin")'),
  'routes/adminBusiness.js imports the real, existing requireAuth/requireAdmin middleware — no new/parallel auth mechanism was invented'
);

const routeDeclarations = [...routeSource.matchAll(/router\.(get|post)\("([^"]+)",\s*([^)]*)\)/g)];
check(routeDeclarations.length >= 2, 'sanity check: the expected number of routes is found in routes/adminBusiness.js');
for (const [, method, urlPath, middlewareArgs] of routeDeclarations) {
  check(
    middlewareArgs.includes('requireAuth') && middlewareArgs.includes('requireAdmin'),
    `route ${method.toUpperCase()} ${urlPath} is gated by both requireAuth and requireAdmin directly in its own declaration — never relying on middleware applied elsewhere`
  );
}

// --- no provider secret is ever placed in a response body or sent to the browser ---

const SECRET_ENV_VAR_NAMES = [
  'STRIPE_SECRET_KEY',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VOICE_API_KEY_SECRET',
  'OPENAI_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'Resend_API_Key',
];

for (const varName of SECRET_ENV_VAR_NAMES) {
  // The only legitimate reference to a secret env var name in this
  // module is a presence CHECK (Boolean(...)/`if (!x)`) — never as a
  // value assigned into the JSON response. This regex specifically
  // looks for the dangerous shape (the var used as a value, e.g. inside
  // res.json({...}) or a returned object), not merely its name
  // appearing anywhere (a presence check legitimately mentions the name
  // too).
  const dangerousPattern = new RegExp(`:\\s*process\\.env\\.${varName}\\b(?!\\s*\\))`);
  check(
    !dangerousPattern.test(routeSource),
    `routes/adminBusiness.js never assigns process.env.${varName}'s actual value into a response field`
  );
}

// The business-metrics modules themselves — same check, since the route
// file assembles its response from these.
const moduleFiles = [
  'config.js', 'vat.js', 'twilioCosts.js', 'openaiCosts.js', 'revenue.js',
  'callStats.js', 'systemHealth.js', 'profitability.js', 'fairUse.js', 'releaseInfo.js',
  'accountClassification.js', 'customerClassificationOverview.js',
];
for (const file of moduleFiles) {
  const src = readFileSync(path.join(__dirname, '..', 'services', 'businessMetrics', file), 'utf8');
  for (const varName of SECRET_ENV_VAR_NAMES) {
    const dangerousPattern = new RegExp(`:\\s*process\\.env\\.${varName}\\b(?!\\s*\\))`);
    check(!dangerousPattern.test(src), `services/businessMetrics/${file} never assigns process.env.${varName}'s value into a returned field`);
  }
}

// The client-side HTML/JS never references a secret env var name at all
// (it shouldn't need to — it only ever reads the already-sanitised JSON
// this API returns).
const htmlSource = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
for (const varName of SECRET_ENV_VAR_NAMES) {
  check(!htmlSource.includes(varName), `admin-business.html never references ${varName} at all — the browser has no way to even ask for it`);
}

// The dashboard reports OpenAI/Twilio-key "configured" status as a
// boolean, confirming the intended safe pattern is actually used
// somewhere, not just that the dangerous pattern is absent.
check(
  routeSource.includes('isOpenAiKeyConfigured()') || /businessMetrics\/openaiCosts.*isOpenAiKeyConfigured/.test(routeSource),
  'the dashboard reports OpenAI configuration as a boolean via isOpenAiKeyConfigured(), never the key value itself'
);

console.log(failures === 0 ? '\nAll admin-business-auth checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
