// Environment isolation for provider telephony resources (2026-09-29).
//
// Extends tests/provisioning-guard.test.mjs (purchases) to everything else
// a non-production process could do to PRODUCTION numbers:
//   - releasing a number (.remove()) — the confirmed-quarantine release
//     job runs on a timer in ANY running server;
//   - running the number-lifecycle jobs at all from a mixed environment
//     (a laptop on localhost with the default .env points at the
//     PRODUCTION database);
//   - bypassing the guard by passing the real client (including the
//     `{ client: undefined }` shape existing tests use, which falls back to
//     the real client through a default parameter).
// Everything fails closed: if the environment cannot be identified, the
// answer is "no".
//
// Safety of this file: the "real" Twilio client below is built from
// deliberately invalid credentials AND its request method is replaced, so
// even a guard failure could never reach the provider.
//
// Run with: node tests/telephony-environment-isolation.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Must be set before twilioClient.js is first required.
process.env.TWILIO_ACCOUNT_SID = 'ACinvalid_test_only_never_real';
process.env.TWILIO_AUTH_TOKEN = 'invalid_test_only';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';

const { twilioRestClient } = require('../services/twilioClient.js');
const providerRequests = [];
twilioRestClient.request = async (opts) => { providerRequests.push(opts && opts.uri); throw new Error('test: provider must never be called'); };

const { resolveEnvironment, decideTelephonyMutation, decideLifecycleJobs, decideNumberPurchase } = require('../services/telephony/provisioningGuard.js');
const { ensureTwilioNumberProvisioned, releaseQuarantinedTwilioNumber } = require('../services/twilioProvisioning.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const PROD_SUPABASE = 'https://psbzynxplxfbyrbdidmn.supabase.co';
const STAGING_SUPABASE = 'https://tigwgmayeuisrxjjykqd.supabase.co';
const PROD_SID = 'AC_production_example';

// The three real configurations found on 2026-09-28 (identity only).
const PRODUCTION = { APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: PROD_SUPABASE, TWILIO_ACCOUNT_SID: PROD_SID };
// Default .env on a developer machine: localhost + PRODUCTION database + production Twilio.
const LOCAL_DEFAULT_ENV = { APP_URL: 'http://localhost:3000', SUPABASE_URL: PROD_SUPABASE, TWILIO_ACCOUNT_SID: PROD_SID };
// Staging: its own database, but no Twilio credentials of its own → the
// default .env's production credentials fill in (dotenv fallthrough).
const STAGING_FALLTHROUGH = { APP_URL: 'http://staging-host.example', SUPABASE_URL: STAGING_SUPABASE, TWILIO_ACCOUNT_SID: PROD_SID, NODE_ENV: 'development' };
const STAGING_SUBACCOUNT = { ...STAGING_FALLTHROUGH, NUMBER_PROVISIONING_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC_staging_sub', PRODUCTION_TWILIO_ACCOUNT_SID: PROD_SID };

// ---------- 1. environment identity ----------
check(resolveEnvironment(PRODUCTION).kind === 'production', 'identity: production signature');
check(resolveEnvironment(LOCAL_DEFAULT_ENV).kind === 'mixed', 'identity: a laptop on the default .env (localhost + production database) is MIXED, never production');
check(resolveEnvironment(STAGING_FALLTHROUGH).kind === 'nonproduction', 'identity: staging (own database) is non-production even while holding production Twilio credentials');
check(resolveEnvironment({ APP_URL: 'http://localhost:3000' }).kind === 'unknown', 'identity: no SUPABASE_URL → unknown');
check(resolveEnvironment({ SUPABASE_URL: 'not a url' }).kind === 'unknown', 'identity: unparseable SUPABASE_URL → unknown');
check(resolveEnvironment({ SUPABASE_URL: PROD_SUPABASE }).kind === 'mixed', 'identity: production database with no APP_URL → mixed');
check(resolveEnvironment({}).kind === 'unknown', 'identity: empty environment → unknown');

// ---------- 2. purchases (existing guard) under the real configurations ----------
check(decideNumberPurchase(LOCAL_DEFAULT_ENV).action === 'block', 'purchase: default .env on a laptop cannot buy');
check(decideNumberPurchase(STAGING_FALLTHROUGH).action === 'block', 'purchase: staging on the production account cannot buy');
check(decideNumberPurchase({ ...STAGING_FALLTHROUGH, NUMBER_PROVISIONING_MODE: 'live' }).action === 'block', 'purchase: staging cannot buy even in live mode while on the production account');
check(decideNumberPurchase({}).action === 'block', 'purchase: unknown environment cannot buy');
check(decideNumberPurchase({ NUMBER_PROVISIONING_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC_a', PRODUCTION_TWILIO_ACCOUNT_SID: 'AC_b' }).action === 'block', 'purchase: unknown environment cannot buy even in live mode on a declared-different account (fail closed)');

// ---------- 3. mutations of existing numbers (release / update) ----------
check(decideTelephonyMutation(PRODUCTION, { operation: 'release' }).action === 'allow', 'mutation: production may release');
for (const [name, env] of [
  ['default .env on a laptop', LOCAL_DEFAULT_ENV],
  ['staging on the production account', STAGING_FALLTHROUGH],
  ['staging in live mode on the production account', { ...STAGING_FALLTHROUGH, NUMBER_PROVISIONING_MODE: 'live', PRODUCTION_TWILIO_ACCOUNT_SID: PROD_SID }],
  ['staging in live mode without PRODUCTION_TWILIO_ACCOUNT_SID declared', { ...STAGING_FALLTHROUGH, NUMBER_PROVISIONING_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC_other' }],
  ['unknown environment', {}],
  ['unknown environment in live mode', { NUMBER_PROVISIONING_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC_a', PRODUCTION_TWILIO_ACCOUNT_SID: 'AC_b' }],
  ['production in fake mode', { ...PRODUCTION, NUMBER_PROVISIONING_MODE: 'fake' }],
  ['production in disabled mode', { ...PRODUCTION, NUMBER_PROVISIONING_MODE: 'disabled' }],
  ['production with an unknown mode', { ...PRODUCTION, NUMBER_PROVISIONING_MODE: 'yolo' }],
  ['mixed in live mode on a different account', { ...LOCAL_DEFAULT_ENV, NUMBER_PROVISIONING_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC_a', PRODUCTION_TWILIO_ACCOUNT_SID: 'AC_b' }],
]) {
  const d = decideTelephonyMutation(env, { operation: 'release' });
  check(d.action === 'block' && /refusing to release/.test(d.reason), `mutation: ${name} → blocked`);
}
check(decideTelephonyMutation(STAGING_SUBACCOUNT, { operation: 'release' }).action === 'allow', 'mutation: a declared, dedicated non-production sub-account in live mode may release its own numbers');

// ---------- 4. lifecycle jobs ----------
check(decideLifecycleJobs(PRODUCTION).run === true, 'jobs: production runs the number-lifecycle jobs');
check(decideLifecycleJobs(LOCAL_DEFAULT_ENV).run === false, 'jobs: a laptop on the default .env does NOT run them (would quarantine production households from localhost)');
check(decideLifecycleJobs({}).run === false, 'jobs: unknown environment does not run them');
check(decideLifecycleJobs(STAGING_FALLTHROUGH).run === true, 'jobs: staging runs them against its own database (provider mutations inside are still blocked)');
check(decideLifecycleJobs({ ...PRODUCTION, NUMBER_LIFECYCLE_JOBS: 'disabled' }).run === false, 'jobs: NUMBER_LIFECYCLE_JOBS=disabled stops them anywhere');

// ---------- 5. release hook ----------
function fakeClient() {
  const calls = [];
  return { calls, incomingPhoneNumbers: Object.assign((sid) => ({ remove: async () => calls.push(`remove:${sid}`) }), { list: async () => { calls.push('list'); return [{ sid: 'PN_found' }]; } }) };
}
const row = { id: 'q1', household_id: 'h1', twilio_number: '+447000000001', twilio_sid: 'PN_row', deactivation_confirmed: true, released_at: null };

{
  const client = fakeClient();
  const marked = [];
  const r = await releaseQuarantinedTwilioNumber(row, { client, enforceGuard: true, guardEnv: STAGING_FALLTHROUGH, markReleased: async (id) => marked.push(id), sendAlert: async () => {} });
  check(r.blocked === true && client.calls.length === 0 && marked.length === 0, 'release: staging on the production account — no provider call AND the row is not marked released');
}
{
  const client = fakeClient();
  const marked = [];
  const r = await releaseQuarantinedTwilioNumber(row, { client, enforceGuard: true, guardEnv: LOCAL_DEFAULT_ENV, markReleased: async (id) => marked.push(id), sendAlert: async () => {} });
  check(r.blocked === true && client.calls.length === 0 && marked.length === 0, 'release: laptop on the default .env — blocked');
}
{
  const client = fakeClient();
  const marked = [];
  const r = await releaseQuarantinedTwilioNumber(row, { client, enforceGuard: true, guardEnv: PRODUCTION, markReleased: async (id) => marked.push(id), sendAlert: async () => {} });
  check(r.released === true && client.calls.includes('remove:PN_row') && marked[0] === 'q1', 'release: production behaves exactly as before');
}
{
  const alerts = [];
  const r = await releaseQuarantinedTwilioNumber(row, { client: fakeClient(), enforceGuard: true, guardEnv: { NODE_ENV: 'production', APP_URL: 'https://preview.up.railway.app', SUPABASE_URL: PROD_SUPABASE }, markReleased: async () => {}, sendAlert: async (t) => alerts.push(t) });
  check(r.blocked === true && alerts.includes('twilio_release_blocked_by_guard'), 'release: a NODE_ENV=production process failing the signature raises a critical alert');
}
{
  const client = fakeClient();
  const r = await releaseQuarantinedTwilioNumber({ ...row, deactivation_confirmed: false }, { client, enforceGuard: true, guardEnv: PRODUCTION, markReleased: async () => {} });
  check(r.released === false && !r.blocked && client.calls.length === 0, 'release: the existing confirmed-only rule still applies before the guard');
}

// ---------- 6. the REAL client can never bypass the guard ----------
providerRequests.length = 0;
{
  const marked = [];
  const r = await releaseQuarantinedTwilioNumber(row, { guardEnv: LOCAL_DEFAULT_ENV, markReleased: async (id) => marked.push(id), sendAlert: async () => {} });
  check(r.blocked === true && marked.length === 0, 'real client (default parameter): release is guarded without any opt-in');
}
{
  const r = await releaseQuarantinedTwilioNumber(row, { client: undefined, guardEnv: STAGING_FALLTHROUGH, markReleased: async () => {}, sendAlert: async () => {} });
  check(r.blocked === true, 'real client via `{ client: undefined }` (the shape existing tests use): release is guarded');
}
{
  const r = await ensureTwilioNumberProvisioned({ id: 'hh', twilio_provisioning_attempts: 0 }, { client: twilioRestClient, guardEnv: LOCAL_DEFAULT_ENV, assign: async () => { throw new Error('must not assign'); }, recordFailure: async () => {}, sendAlert: async () => {} });
  check(r.blocked === true, 'real client passed explicitly: purchase is guarded (previously `"client" in deps` skipped the guard)');
}
{
  const r = await ensureTwilioNumberProvisioned({ id: 'hh', twilio_provisioning_attempts: 0 }, { client: undefined, guardEnv: STAGING_FALLTHROUGH, assign: async () => { throw new Error('must not assign'); }, recordFailure: async () => {}, sendAlert: async () => {} });
  check(r.blocked === true, 'real client via `{ client: undefined }`: purchase is guarded');
}
check(providerRequests.length === 0, 'the real client made zero provider requests across every guarded call');

// ---------- 7. wiring ----------
const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const gate = server.indexOf('const numberLifecycleJobsDecision = decideLifecycleJobs(process.env);');
const firstInterval = server.indexOf('setInterval(runQuarantinedNumberReleaseCheck');
check(gate !== -1 && firstInterval > gate && /if \(numberLifecycleJobsDecision\.run\) \{\s*setTimeout\(\(\) => \{\s*runTwilioNumberReleaseCheck\(\);/.test(server), 'server.js starts the number-lifecycle jobs only when decideLifecycleJobs allows it');
check((server.match(/setInterval\(runQuarantinedNumberReleaseCheck/g) || []).length === 1 && (server.match(/runQuarantinedNumberReleaseCheck\(\);/g) || []).length === 1, 'server.js has no second, ungated start of the release job');
const prov = readFileSync(path.join(__dirname, '..', 'services', 'twilioProvisioning.js'), 'utf8');
const code = prov.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const removeCalls = code.match(/incomingPhoneNumbers\([^)]*\)\.remove\(\)/g) || [];
check(removeCalls.length === 2, 'exactly two .remove() call sites exist (guarded quarantine release; duplicate cleanup right after a guarded purchase) — a new one must add a guard and update this test');
check(!/incomingPhoneNumbers\([^)]*\)\.update\(/.test(code), 'no provider number .update() exists (if one is added it must use decideTelephonyMutation)');

console.log(failures === 0 ? '\nAll telephony environment isolation checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
