// BYOC configuration contract (WS7, 2026-10-11) — pure, no server, no network.
//
// Describes the configuration surface the Magrathea → Twilio BYOC code (WS6,
// branch launch/ws6-magrathea-byoc) must expose, so the launch lead can check
// it the moment ws6 merges. Names are aligned with ws6's working tree as read
// on 2026-10-11 (uncommitted there at the time):
//
//   NUMBER_PROVIDER                    unset|'twilio' (default) | 'magrathea'; anything else
//                                      ⇒ invalid, provisioning HELD (fail closed, never a
//                                      silent fallback to buying a Twilio number)
//                                      — services/telephony/numberProviders/config.js
//                                        resolveNumberProvider(env)
//   NUMBER_INVENTORY_COOLING_OFF_DAYS  integer 0..365, default 30 (inventoryCoolingOffDays)
//   TWILIO_BYOC_ACCOUNT_SID            optional SECOND account (both-or-neither with
//   TWILIO_BYOC_AUTH_TOKEN             the token); invalid/incomplete/same-as-primary pair is
//                                      IGNORED (webhooks from it stay 403)
//                                      — services/telephony/twilioAccounts.js
//                                        resolveAdditionalTwilioAccounts / acceptedAccountSids /
//                                        signingTokensFor
//   TWILIO_BYOC_TRUNK_SID              documentation only (BY + 32 hex), recommended when
//                                      NUMBER_PROVIDER=magrathea
//   launch-config rules                byoc_twilio_account_pair, number_provider_known,
//                                      number_provider_magrathea_production (production:
//                                      forbidden until Andrew approves), byoc_trunk_sid_recorded
//
// ASSUMPTIONS (documented because ws6 was still in progress when this was
// written): ws6 chose ONE additional account (not a token LIST such as
// TWILIO_AUTH_TOKENS); if the merged code changes a name, update the
// constants below and docs/launch/2026-10-11-BYOC-E2E-TEST-REPORT.md.
//
// CORE checks hold today AND after ws6 (they constrain the existing
// signature guard / integrity layer and must not regress). WS6 checks are
// EXPECTED-FAIL-UNTIL-WS6 (reported only) unless BYOC_E2E_STRICT=1.
//
// Run: node tests/byoc-config-contract.test.mjs   (strict: BYOC_E2E_STRICT=1 …)

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReporter } from './helpers/byoc/harness.mjs';

const require = createRequire(import.meta.url);
const twilio = require('twilio');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = createReporter();
const { check, expectWs6, section } = R;

const ENV = Object.freeze({
  NUMBER_PROVIDER: 'NUMBER_PROVIDER',
  COOLING_OFF: 'NUMBER_INVENTORY_COOLING_OFF_DAYS',
  BYOC_SID: 'TWILIO_BYOC_ACCOUNT_SID',
  BYOC_TOKEN: 'TWILIO_BYOC_AUTH_TOKEN',
  TRUNK_SID: 'TWILIO_BYOC_TRUNK_SID',
});
const MODULES = Object.freeze({
  numberProviderConfig: 'services/telephony/numberProviders/config.js',
  twilioAccounts: 'services/telephony/twilioAccounts.js',
  ukNumber: 'services/telephony/ukNumber.js',
});
const LAUNCH_RULES = Object.freeze(['byoc_twilio_account_pair', 'number_provider_known', 'number_provider_magrathea_production', 'byoc_trunk_sid_recorded']);

const PRIMARY_SID = 'AC00000000000000000000000000000000';
const PRIMARY_TOKEN = 'test_primary_token';
const BYOC_SID = `AC${'b7c0'.repeat(8)}`;
const BYOC_TOKEN = 'test_byoc_token';
const APP_URL = 'https://hcg.test';

function load(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return null;
  try { return require(abs); } catch (err) { console.log(`  (could not load ${rel}: ${err.message})`); return null; }
}
const safe = (fn) => { try { return fn(); } catch { return undefined; } };

// ── Signature guard / integrity harness (existing modules) ───────────────
const { createTwilioWebhookGuard } = require('../services/twilioWebhookGuard.js');
const { createTwilioWebhookIntegrity } = require('../services/abuse/webhookIntegrity.js');

function withEnv(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) { saved[k] = process.env[k]; if (over[k] === undefined) delete process.env[k]; else process.env[k] = over[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const voiceParams = (accountSid) => ({ AccountSid: accountSid, CallSid: `CA${'1'.repeat(32)}`, From: '07700900123', To: '+443069990101', Direction: 'inbound' });
function guardVerdict({ env, primaryToken = PRIMARY_TOKEN, params, signWith }) {
  return withEnv(env, () => {
    const additional = env[ENV.BYOC_SID] && env[ENV.BYOC_TOKEN] ? [{ accountSid: env[ENV.BYOC_SID], authToken: env[ENV.BYOC_TOKEN] }] : [];
    // additionalAccounts is ws6's explicit option; today's guard ignores it.
    const guard = createTwilioWebhookGuard({ authToken: primaryToken, appUrl: APP_URL, log: () => {}, additionalAccounts: additional });
    const sig = twilio.getExpectedTwilioSignature(signWith, `${APP_URL}/voice`, params);
    let status = null; let next = false;
    const req = { body: params, originalUrl: '/voice', path: '/voice', get: (h) => (h.toLowerCase() === 'x-twilio-signature' ? sig : undefined), socket: { remoteAddress: '203.0.113.9' } };
    const res = { status: (c) => { status = c; return { end: () => {} }; } };
    guard(req, res, () => { next = true; });
    return next ? 200 : status;
  });
}
function integrityVerdict({ env, primarySid = PRIMARY_SID, params }) {
  return withEnv(env, () => {
    const mw = createTwilioWebhookIntegrity({
      config: { twilioAccountSid: primarySid, webhookReplayWindowMs: 60_000 },
      audit: { record: () => {} },
      env: { TWILIO_ACCOUNT_SID: primarySid, TWILIO_AUTH_TOKEN: PRIMARY_TOKEN, ...env },
    }).middleware;
    let status = null; let next = false;
    const req = { body: params, path: '/voice', get: () => undefined, socket: {} };
    const res = { status: (c) => { status = c; return { type: () => ({ send: () => {} }), send: () => {}, end: () => {}, json: () => {} }; }, type: () => res, send: () => {} };
    try { mw(req, res, () => { next = true; }); } catch (err) { return `threw:${err.message}`; }
    return next ? 200 : status;
  });
}

section('CORE — existing signature guard and integrity layer (must hold before and after WS6)');
const noByoc = { [ENV.BYOC_SID]: undefined, [ENV.BYOC_TOKEN]: undefined };
check(guardVerdict({ env: noByoc, params: voiceParams(PRIMARY_SID), signWith: PRIMARY_TOKEN }) === 200, 'C1 primary-account request signed with TWILIO_AUTH_TOKEN → accepted');
check(guardVerdict({ env: noByoc, params: voiceParams(BYOC_SID), signWith: BYOC_TOKEN }) === 403, 'C2 no BYOC account configured: a BYOC-token signature → 403');
check(guardVerdict({ env: { [ENV.BYOC_SID]: BYOC_SID, [ENV.BYOC_TOKEN]: BYOC_TOKEN }, params: voiceParams(PRIMARY_SID), signWith: BYOC_TOKEN }) === 403, 'C3 BYOC account configured: a request CLAIMING the primary account but signed with the BYOC token → 403');
check(guardVerdict({ env: { [ENV.BYOC_SID]: BYOC_SID, [ENV.BYOC_TOKEN]: BYOC_TOKEN }, params: voiceParams(BYOC_SID), signWith: 'some_other_token' }) === 403, 'C4 BYOC account configured: BYOC AccountSid with a wrong token → 403');
check(guardVerdict({ env: { [ENV.BYOC_SID]: BYOC_SID, [ENV.BYOC_TOKEN]: BYOC_TOKEN }, params: voiceParams(`AC${'9'.repeat(32)}`), signWith: BYOC_TOKEN }) === 403, 'C5 BYOC token never validates a request naming a THIRD account');
check(guardVerdict({ env: { [ENV.BYOC_SID]: BYOC_SID }, params: voiceParams(BYOC_SID), signWith: BYOC_TOKEN }) === 403, 'C6 incomplete pair (SID without token) → BYOC request refused (fail closed)');
check(guardVerdict({ env: noByoc, primaryToken: undefined, params: voiceParams(PRIMARY_SID), signWith: '' }) === 403, 'C7 no TWILIO_AUTH_TOKEN at all → refused (fail closed)');
check(integrityVerdict({ env: noByoc, params: voiceParams(PRIMARY_SID) }) === 200, 'C8 integrity layer: primary AccountSid passes');
check(integrityVerdict({ env: noByoc, params: voiceParams(BYOC_SID) }) === 403, 'C9 integrity layer, no BYOC account configured: foreign AccountSid → 403');
check(integrityVerdict({ env: { [ENV.BYOC_SID]: BYOC_SID }, params: voiceParams(BYOC_SID) }) === 403, 'C10 integrity layer, incomplete BYOC pair: BYOC AccountSid still → 403');
// Single-account BYOC (ws6's recommended topology) needs no new code: the
// subaccount simply IS the primary account.
check(guardVerdict({ env: noByoc, primaryToken: BYOC_TOKEN, params: voiceParams(BYOC_SID), signWith: BYOC_TOKEN }) === 200
  && integrityVerdict({ env: noByoc, primarySid: BYOC_SID, params: voiceParams(BYOC_SID) }) === 200, 'C11 single-account topology (TWILIO_ACCOUNT_SID/TOKEN = BYOC subaccount): accepted by guard and integrity');
check(guardVerdict({ env: noByoc, primaryToken: BYOC_TOKEN, params: voiceParams(BYOC_SID), signWith: PRIMARY_TOKEN }) === 403, 'C12 single-account topology: a PARENT-token signature → 403');

section('WS6 — EXPECTED-FAIL-UNTIL-WS6: two-account signatures');
const pair = { [ENV.BYOC_SID]: BYOC_SID, [ENV.BYOC_TOKEN]: BYOC_TOKEN };
expectWs6('K1', guardVerdict({ env: pair, params: voiceParams(BYOC_SID), signWith: BYOC_TOKEN }) === 200, `${ENV.BYOC_SID}+${ENV.BYOC_TOKEN} configured: BYOC-account request signed with the BYOC token → guard accepts`);
expectWs6('K2', integrityVerdict({ env: pair, params: voiceParams(BYOC_SID) }) === 200, 'BYOC pair configured: integrity layer accepts the BYOC AccountSid');
expectWs6('K3', integrityVerdict({ env: { ...pair, [ENV.BYOC_SID]: PRIMARY_SID }, params: voiceParams(`AC${'9'.repeat(32)}`) }) === 403, 'BYOC SID equal to the primary is ignored and adds no account');

section('WS6 — EXPECTED-FAIL-UNTIL-WS6: NUMBER_PROVIDER contract');
const npc = load(MODULES.numberProviderConfig);
expectWs6('K4', Boolean(npc && typeof npc.resolveNumberProvider === 'function'), `${MODULES.numberProviderConfig} exports resolveNumberProvider(env)`);
const rnp = (v) => safe(() => npc.resolveNumberProvider(v === undefined ? {} : { [ENV.NUMBER_PROVIDER]: v })) || {};
expectWs6('K5', rnp(undefined).provider === 'twilio' && rnp(undefined).valid === true && rnp(undefined).inventory === false, 'NUMBER_PROVIDER unset → twilio (unchanged behaviour)');
expectWs6('K6', rnp('twilio').provider === 'twilio' && rnp('  TWILIO ').provider === 'twilio', "NUMBER_PROVIDER='twilio' (trim, case-insensitive) → twilio");
expectWs6('K7', rnp('magrathea').provider === 'magrathea' && rnp('magrathea').inventory === true && rnp('Magrathea').valid === true, "NUMBER_PROVIDER='magrathea' → inventory provider (assign a DDI, never buy)");
expectWs6('K8', rnp('telnyx').valid === false && rnp('telnyx').provider === null && Boolean(rnp('telnyx').problem), 'unknown NUMBER_PROVIDER → invalid, provider null (provisioning held; never a silent Twilio purchase)');
const cool = (v) => safe(() => npc.inventoryCoolingOffDays(v === undefined ? {} : { [ENV.COOLING_OFF]: v }));
expectWs6('K9', cool(undefined) === 30 && cool('0') === 0 && cool('365') === 365 && cool('366') === 30 && cool('-1') === 30 && cool('abc') === 30, `${ENV.COOLING_OFF}: default 30, accepts 0..365, anything else → 30`);

section('WS6 — EXPECTED-FAIL-UNTIL-WS6: BYOC account helpers');
const ta = load(MODULES.twilioAccounts);
expectWs6('K10', Boolean(ta && ta.resolveAdditionalTwilioAccounts && ta.acceptedAccountSids && ta.signingTokensFor), `${MODULES.twilioAccounts} exports resolveAdditionalTwilioAccounts / acceptedAccountSids / signingTokensFor`);
const res = (env) => safe(() => ta.resolveAdditionalTwilioAccounts(env)) || { accounts: null, problem: 'n/a' };
const base = { TWILIO_ACCOUNT_SID: PRIMARY_SID, TWILIO_AUTH_TOKEN: PRIMARY_TOKEN };
expectWs6('K11', JSON.stringify(res(base)) === JSON.stringify({ accounts: [], problem: null }), 'neither BYOC variable set → no additional account, no problem');
expectWs6('K12', res({ ...base, [ENV.BYOC_SID]: BYOC_SID, [ENV.BYOC_TOKEN]: BYOC_TOKEN }).accounts?.length === 1, 'valid pair → exactly one additional account');
expectWs6('K13', res({ ...base, [ENV.BYOC_SID]: BYOC_SID }).problem === 'incomplete_pair' && res({ ...base, [ENV.BYOC_TOKEN]: BYOC_TOKEN }).problem === 'incomplete_pair', 'SID or token alone → incomplete_pair, ignored');
expectWs6('K14', res({ ...base, [ENV.BYOC_SID]: 'ACnothex', [ENV.BYOC_TOKEN]: BYOC_TOKEN }).problem === 'invalid_account_sid', 'malformed SID → invalid_account_sid, ignored');
expectWs6('K15', res({ ...base, [ENV.BYOC_SID]: PRIMARY_SID, [ENV.BYOC_TOKEN]: BYOC_TOKEN }).problem === 'same_as_primary_account' && res({ ...base, [ENV.BYOC_SID]: BYOC_SID, [ENV.BYOC_TOKEN]: PRIMARY_TOKEN }).problem === 'same_token_as_primary', 'same SID or same token as the primary → refused as misconfiguration');
const toks = (accountSid) => safe(() => ta.signingTokensFor({ primaryToken: PRIMARY_TOKEN, accountSid, additionalAccounts: [{ accountSid: BYOC_SID, authToken: BYOC_TOKEN }] })) || [];
expectWs6('K16', JSON.stringify(toks(BYOC_SID)) === JSON.stringify([PRIMARY_TOKEN, BYOC_TOKEN]) && JSON.stringify(toks(PRIMARY_SID)) === JSON.stringify([PRIMARY_TOKEN]) && JSON.stringify(toks(undefined)) === JSON.stringify([PRIMARY_TOKEN]),
  'signingTokensFor: BYOC token offered ONLY when the request names the BYOC account; primary token always (back-compatible)');

section('WS6 — EXPECTED-FAIL-UNTIL-WS6: launch-config rules');
const lc = require('../services/config/launchConfig.js');
const rule = (id) => lc.RULES.find((r) => r.id === id);
expectWs6('K17', LAUNCH_RULES.every((id) => Boolean(rule(id))), `launchConfig RULES include ${LAUNCH_RULES.join(', ')}`);
expectWs6('K18', rule('number_provider_magrathea_production')?.levels?.production === 'forbidden' && rule('number_provider_magrathea_production')?.test({ [ENV.NUMBER_PROVIDER]: 'magrathea' }) && !rule('number_provider_magrathea_production')?.test({}), 'NUMBER_PROVIDER=magrathea is FORBIDDEN in production (needs HCG_CONFIG_ACKNOWLEDGE) and fine when unset');
expectWs6('K19', Boolean(rule('number_provider_known')?.test({ [ENV.NUMBER_PROVIDER]: 'bogus' })) && !rule('number_provider_known')?.test({ [ENV.NUMBER_PROVIDER]: 'magrathea' }), 'unknown NUMBER_PROVIDER is a launch-config problem; magrathea is a known value');
expectWs6('K20', Boolean(rule('byoc_twilio_account_pair')?.test({ ...base, [ENV.BYOC_SID]: BYOC_SID })) && !rule('byoc_twilio_account_pair')?.test(base), 'incomplete BYOC pair is a launch-config problem; absent pair is fine');
expectWs6('K21', Boolean(rule('byoc_trunk_sid_recorded')?.test({ [ENV.NUMBER_PROVIDER]: 'magrathea' })) && !rule('byoc_trunk_sid_recorded')?.test({ [ENV.NUMBER_PROVIDER]: 'magrathea', [ENV.TRUNK_SID]: `BY${'a'.repeat(32)}` }), `${ENV.TRUNK_SID} recommended (BY + 32 hex) when NUMBER_PROVIDER=magrathea`);

section('WS6 — EXPECTED-FAIL-UNTIL-WS6: number canonicalisation module');
const uk = load(MODULES.ukNumber);
const e164 = (v) => safe(() => uk.toE164(v));
expectWs6('K22', Boolean(uk) && ['07700900123', '+447700900123', '00447700900123', '447700900123', 'sip:07700900123@hcg.sip.ie1.twilio.com;user=phone', 'tel:+447700900123'].every((v) => e164(v) === '+447700900123'), `${MODULES.ukNumber} toE164: 07…, +44…, 0044…, 44…, sip:…@host-with-digit, tel: → +447700900123`);
expectWs6('K23', Boolean(uk) && e164('+33612345678') === '+33612345678' && e164('anonymous') === null && e164('sip:anonymous@x.invalid') === null, 'international stays itself (never collapsed onto UK last-10); withheld → null');

const s = R.summary();
console.log(`\n${s.failures === 0 ? 'BYOC config contract: all strict checks passed' : `BYOC config contract: ${s.failures} strict check(s) FAILED`}`);
process.exitCode = s.failures === 0 ? 0 : 1;
