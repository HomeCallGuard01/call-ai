// WS6 Magrathea → Twilio BYOC (2026-10-11): webhook signature validation with
// an optional second (BYOC sub)account token, the integrity layer's accepted
// AccountSids, and the launchConfig BYOC rule block.
//
// Uses Twilio's REAL validateRequest / getExpectedTwilioSignature (HMAC-SHA1,
// compared with scmp — constant time) — no network.
//
// Run: node tests/byoc-webhook-signature.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const twilio = require('twilio');
const { createTwilioWebhookGuard } = require('../services/twilioWebhookGuard.js');
const { createTwilioWebhookIntegrity } = require('../services/abuse/webhookIntegrity.js');
const { resolveAdditionalTwilioAccounts, acceptedAccountSids, signingTokensFor } = require('../services/telephony/twilioAccounts.js');
const { evaluateLaunchConfig } = require('../services/config/launchConfig.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const PRIMARY_SID = 'AC' + 'a'.repeat(32);
const PRIMARY_TOKEN = 'primary-token-0123456789abcdef';
const BYOC_SID = 'AC' + 'b'.repeat(32);
const BYOC_TOKEN = 'byoc-token-fedcba9876543210';
const OTHER_SID = 'AC' + 'c'.repeat(32);
const APP_URL = 'https://hcg.example';

// ── 1. account resolution ─────────────────────────────────────────────────
check(resolveAdditionalTwilioAccounts({}).accounts.length === 0 && resolveAdditionalTwilioAccounts({}).problem === null, 'no BYOC env → no extra account, no problem (default)');
const ok = resolveAdditionalTwilioAccounts({ TWILIO_ACCOUNT_SID: PRIMARY_SID, TWILIO_AUTH_TOKEN: PRIMARY_TOKEN, TWILIO_BYOC_ACCOUNT_SID: BYOC_SID, TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN });
check(ok.accounts.length === 1 && ok.accounts[0].accountSid === BYOC_SID && ok.problem === null, 'valid pair → one extra account');
for (const [env, problem] of [
  [{ TWILIO_BYOC_ACCOUNT_SID: BYOC_SID }, 'incomplete_pair'],
  [{ TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN }, 'incomplete_pair'],
  [{ TWILIO_BYOC_ACCOUNT_SID: 'ACnothex', TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN }, 'invalid_account_sid'],
  [{ TWILIO_ACCOUNT_SID: PRIMARY_SID, TWILIO_BYOC_ACCOUNT_SID: PRIMARY_SID, TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN }, 'same_as_primary_account'],
  [{ TWILIO_AUTH_TOKEN: PRIMARY_TOKEN, TWILIO_BYOC_ACCOUNT_SID: BYOC_SID, TWILIO_BYOC_AUTH_TOKEN: PRIMARY_TOKEN }, 'same_token_as_primary'],
]) {
  const r = resolveAdditionalTwilioAccounts(env);
  check(r.accounts.length === 0 && r.problem === problem, `invalid pair (${problem}) is ignored — fail closed`);
}
const extra = ok.accounts;
check(JSON.stringify(signingTokensFor({ primaryToken: PRIMARY_TOKEN, accountSid: PRIMARY_SID, additionalAccounts: extra })) === JSON.stringify([PRIMARY_TOKEN]), 'primary-account request → primary token only');
check(JSON.stringify(signingTokensFor({ primaryToken: PRIMARY_TOKEN, accountSid: BYOC_SID, additionalAccounts: extra })) === JSON.stringify([PRIMARY_TOKEN, BYOC_TOKEN]), 'BYOC-account request → BYOC token also tried');
check(JSON.stringify(signingTokensFor({ primaryToken: PRIMARY_TOKEN, accountSid: undefined, additionalAccounts: extra })) === JSON.stringify([PRIMARY_TOKEN]), 'request without AccountSid → primary token only (back-compatible)');
check(JSON.stringify(acceptedAccountSids(PRIMARY_SID, { TWILIO_BYOC_ACCOUNT_SID: BYOC_SID, TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN })) === JSON.stringify([PRIMARY_SID, BYOC_SID]), 'accepted AccountSids = primary + BYOC');
check(JSON.stringify(acceptedAccountSids(PRIMARY_SID, { TWILIO_BYOC_ACCOUNT_SID: BYOC_SID })) === JSON.stringify([PRIMARY_SID]), 'incomplete pair adds no accepted AccountSid');

// ── 2. signature guard with real HMAC ─────────────────────────────────────
function signedReq(token, params, path = '/voice') {
  const sig = twilio.getExpectedTwilioSignature(token, `${APP_URL}${path}`, params);
  return { body: params, originalUrl: path, path, socket: { remoteAddress: '203.0.113.9' }, get: (h) => (h.toLowerCase() === 'x-twilio-signature' ? sig : undefined) };
}
function mkRes() { const r = { code: 200, status(c) { r.code = c; return r; }, end() { return r; } }; return r; }
function run(guard, req) { const res = mkRes(); let passed = false; guard(req, res, () => { passed = true; }); return { passed, code: res.code, verified: req.twilioVerified }; }

const quiet = () => {};
const singleGuard = createTwilioWebhookGuard({ authToken: PRIMARY_TOKEN, appUrl: APP_URL, log: quiet, additionalAccounts: [] });
const multiGuard = createTwilioWebhookGuard({ authToken: PRIMARY_TOKEN, appUrl: APP_URL, log: quiet, additionalAccounts: extra });
const byocParams = { AccountSid: BYOC_SID, CallSid: 'CA' + '1'.repeat(32), From: '07700900123', To: '443300884327' };
const primaryParams = { AccountSid: PRIMARY_SID, CallSid: 'CA' + '2'.repeat(32), From: '+447700900123', To: '+441615550201' };

check(run(singleGuard, signedReq(PRIMARY_TOKEN, primaryParams)).passed, 'single-token guard: primary-signed request passes (unchanged)');
check(run(singleGuard, signedReq(BYOC_TOKEN, byocParams)).code === 403, 'single-token guard: BYOC-signed request refused 403 (no BYOC account configured)');
check(run(multiGuard, signedReq(PRIMARY_TOKEN, primaryParams)).passed, 'multi guard: primary-signed request passes');
const rb = run(multiGuard, signedReq(BYOC_TOKEN, byocParams));
check(rb.passed && rb.verified === true, 'multi guard: BYOC-signed request with AccountSid=BYOC passes (twilioVerified=true)');
check(run(multiGuard, signedReq(BYOC_TOKEN, { ...byocParams, AccountSid: PRIMARY_SID })).code === 403, 'BYOC token can NOT validate a request claiming the primary account');
check(run(multiGuard, signedReq(BYOC_TOKEN, { ...byocParams, AccountSid: OTHER_SID })).code === 403, 'BYOC token can NOT validate a request claiming an unknown account');
check(run(multiGuard, signedReq(BYOC_TOKEN, { ...byocParams, AccountSid: undefined })).code === 403, 'BYOC token can NOT validate a request without AccountSid');
{
  const req = signedReq(BYOC_TOKEN, byocParams); req.body = { ...byocParams, From: '07700900999' };
  check(run(multiGuard, req).code === 403, 'tampered params under a BYOC signature → 403');
}
check(run(multiGuard, signedReq('wrong-token', byocParams)).code === 403, 'wrong token → 403');
{
  const req = signedReq(BYOC_TOKEN, byocParams); req.get = () => undefined;
  check(run(multiGuard, req).code === 403, 'missing signature → 403');
}
check(run(createTwilioWebhookGuard({ authToken: '', appUrl: APP_URL, log: quiet, additionalAccounts: extra }), signedReq(BYOC_TOKEN, byocParams)).code === 403, 'no primary token configured → everything refused (fail closed, even with a BYOC token)');
{
  // default: additional accounts come from process.env (none in the test env) → unchanged behaviour
  const prev = { s: process.env.TWILIO_BYOC_ACCOUNT_SID, t: process.env.TWILIO_BYOC_AUTH_TOKEN };
  delete process.env.TWILIO_BYOC_ACCOUNT_SID; delete process.env.TWILIO_BYOC_AUTH_TOKEN;
  const g = createTwilioWebhookGuard({ authToken: PRIMARY_TOKEN, appUrl: APP_URL, log: quiet });
  check(run(g, signedReq(BYOC_TOKEN, byocParams)).code === 403, 'default guard with no BYOC env refuses BYOC-signed requests');
  process.env.TWILIO_BYOC_ACCOUNT_SID = BYOC_SID; process.env.TWILIO_BYOC_AUTH_TOKEN = BYOC_TOKEN;
  const g2 = createTwilioWebhookGuard({ authToken: PRIMARY_TOKEN, appUrl: APP_URL, log: quiet });
  check(run(g2, signedReq(BYOC_TOKEN, byocParams)).passed, 'default guard picks up TWILIO_BYOC_ACCOUNT_SID/TOKEN from env');
  if (prev.s === undefined) delete process.env.TWILIO_BYOC_ACCOUNT_SID; else process.env.TWILIO_BYOC_ACCOUNT_SID = prev.s;
  if (prev.t === undefined) delete process.env.TWILIO_BYOC_AUTH_TOKEN; else process.env.TWILIO_BYOC_AUTH_TOKEN = prev.t;
}

// ── 3. integrity layer AccountSid set ─────────────────────────────────────
{
  const audit = { record: () => {} };
  const mkReq = (body) => ({ body, path: '/voice', get: () => 'sig' });
  const integ = (env) => createTwilioWebhookIntegrity({ config: { twilioAccountSid: PRIMARY_SID, webhookReplayWindowMs: 60000 }, audit, env });
  const pass = (wi, body) => { const res = { code: 200, status(c) { res.code = c; return res; }, end() { return res; } }; let n = false; wi.middleware(mkReq(body), res, () => { n = true; }); return n ? 200 : res.code; };
  const withByoc = integ({ TWILIO_BYOC_ACCOUNT_SID: BYOC_SID, TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN });
  check(pass(withByoc, { CallSid: 'CA' + '3'.repeat(32), AccountSid: BYOC_SID }) === 200, 'integrity: configured BYOC AccountSid accepted');
  check(pass(withByoc, { CallSid: 'CA' + '4'.repeat(32), AccountSid: PRIMARY_SID }) === 200, 'integrity: primary AccountSid accepted');
  check(pass(withByoc, { CallSid: 'CA' + '5'.repeat(32), AccountSid: OTHER_SID }) === 403, 'integrity: any other AccountSid → 403');
  const noByoc = integ({});
  check(pass(noByoc, { CallSid: 'CA' + '6'.repeat(32), AccountSid: BYOC_SID }) === 403, 'integrity without BYOC env: BYOC AccountSid → 403 (unchanged)');
  const halfByoc = integ({ TWILIO_BYOC_ACCOUNT_SID: BYOC_SID });
  check(pass(halfByoc, { CallSid: 'CA' + '7'.repeat(32), AccountSid: BYOC_SID }) === 403, 'integrity with an incomplete pair: BYOC AccountSid → 403 (fail closed)');
}

// ── 4. launchConfig BYOC rules ────────────────────────────────────────────
{
  const base = { HCG_DEPLOYMENT: 'staging', NODE_ENV: 'production', SUPABASE_URL: 'https://tigwgmayeuisrxjjykqd.supabase.co', TWILIO_ACCOUNT_SID: PRIMARY_SID, TWILIO_AUTH_TOKEN: PRIMARY_TOKEN };
  const ids = (env, key) => evaluateLaunchConfig(env)[key].map((f) => f.id);
  check(!ids(base, 'fatal').some((id) => id.startsWith('byoc_') || id.startsWith('number_provider')) && !ids(base, 'warnings').some((id) => id.startsWith('byoc_') || id.startsWith('number_provider')), 'default config: no BYOC finding');
  check(ids({ ...base, TWILIO_BYOC_ACCOUNT_SID: BYOC_SID }, 'fatal').includes('byoc_twilio_account_pair'), 'incomplete BYOC pair is fatal');
  check(!ids({ ...base, TWILIO_BYOC_ACCOUNT_SID: BYOC_SID, TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN }, 'fatal').includes('byoc_twilio_account_pair'), 'valid BYOC pair passes');
  check(ids({ ...base, NUMBER_PROVIDER: 'telnyx' }, 'fatal').includes('number_provider_known'), 'unknown NUMBER_PROVIDER is fatal');
  check(ids({ ...base, NUMBER_PROVIDER: 'magrathea' }, 'warnings').includes('byoc_trunk_sid_recorded'), 'staging magrathea without a BYOC trunk SID → warning');
  check(!ids({ ...base, NUMBER_PROVIDER: 'magrathea', TWILIO_BYOC_TRUNK_SID: 'BY' + 'd'.repeat(32) }, 'warnings').includes('byoc_trunk_sid_recorded'), 'staging magrathea with a trunk SID → no warning');
  check(!ids({ ...base, NUMBER_PROVIDER: 'magrathea' }, 'fatal').includes('number_provider_magrathea_production'), 'magrathea allowed in staging');
  const prod = { ...base, HCG_DEPLOYMENT: 'production', NUMBER_PROVIDER: 'magrathea' };
  check(ids(prod, 'fatal').includes('number_provider_magrathea_production'), 'magrathea in production is FORBIDDEN until approved');
  check(!ids({ ...prod, HCG_CONFIG_ACKNOWLEDGE: 'number_provider_magrathea_production' }, 'fatal').includes('number_provider_magrathea_production'), 'explicit acknowledgement (Andrew approval) moves it out of fatal');
}

console.log(failures === 0 ? '\nAll BYOC signature/config checks passed.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
