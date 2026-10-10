// Agent 1 (2026-10-11) — runtime credential isolation (containment P6) and
// OpenAI project-key checks in services/config/launchConfig.js, plus the
// pure classifier services/config/twilioCredentials.js and its use by
// services/twilioClient.js. No client makes a network call.
// Run: node tests/agent1-launch-config-credentials.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evaluateLaunchConfig, enforceLaunchConfig } = require('../services/config/launchConfig.js');
const { classifyTwilioRuntimeCredentials, twilioRestCredentialMode } = require('../services/config/twilioCredentials.js');
const tc = require('../services/twilioClient.js');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const PARENT = `AC${'a'.repeat(32)}`;
const SUB = `AC${'b'.repeat(32)}`;
const KEY = `SK${'c'.repeat(32)}`;
// A complete production env (synthetic values) that passes every rule.
const GOOD = {
  HCG_DEPLOYMENT: 'production', APP_URL: 'https://homecallguard.co.uk', SUPABASE_URL: 'https://psbzynxplxfbyrbdidmn.supabase.co',
  SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', ABUSE_AUDIT_HASH_SECRET: 'a'.repeat(40), SAFETY_CALLER_KEY_SECRET: 'b'.repeat(40),
  TRUST_PROXY_HOPS: '1', STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_WEBHOOK_SECRET: 'x', STRIPE_PRICE_ID: 'price_x', REVENUECAT_WEBHOOK_AUTHORIZATION: 'c'.repeat(24),
  TWILIO_ACCOUNT_SID: SUB, TWILIO_AUTH_TOKEN: 'sub-token', TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: 'secret', HCG_TWILIO_PARENT_ACCOUNT_SID: PARENT,
  TWILIO_VOICE_API_KEY_SID: KEY, TWILIO_VOICE_API_KEY_SECRET: 'x', TWILIO_VOICE_TWIML_APP_SID: 'APx', TWILIO_VOICE_FALLBACK_URL: 'https://handler.twilio.com/twiml/EHx',
  PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS: 'UTx', HCG_SUPPORT_VERIFICATION_CALLERS: '+447700900000', OPENAI_API_KEY: 'sk-proj-abc',
  Resend_API_Key: 're_x', OPS_EVENTS_SCHEDULE_ENABLED: 'true', ALLOWANCE_SOURCE: 'fortress',
};
const ids = (list) => list.map((f) => f.id);
const ev = (patch) => evaluateLaunchConfig({ ...GOOD, ...patch });

{
  const r = evaluateLaunchConfig(GOOD);
  check(r.deployment === 'production' && r.fatal.length === 0 && r.warnings.length === 0, `isolated production config: 0 fatal, 0 warnings (got ${ids(r.fatal)} / ${ids(r.warnings)})`);
}
// Auth-token REST client (no API key): WARNING in production, FATAL once the migration is declared done.
{
  const r = ev({ TWILIO_API_KEY_SID: '', TWILIO_API_KEY_SECRET: '' });
  check(ids(r.warnings).includes('twilio_rest_api_key') && r.fatal.length === 0, 'production REST client on the account auth token → WARNING twilio_rest_api_key');
  const f = ev({ TWILIO_API_KEY_SID: '', TWILIO_API_KEY_SECRET: '', HCG_TWILIO_SUBACCOUNT_REQUIRED: 'true' });
  check(ids(f.fatal).includes('twilio_rest_api_key'), 'with HCG_TWILIO_SUBACCOUNT_REQUIRED=true the same config is FATAL');
  const exits = [];
  enforceLaunchConfig({ env: { ...GOOD, TWILIO_API_KEY_SID: '', TWILIO_API_KEY_SECRET: '', HCG_TWILIO_SUBACCOUNT_REQUIRED: 'true' }, log: () => {}, exit: (c) => exits.push(c) });
  check(exits[0] === 1, 'enforceLaunchConfig refuses to start (exit 1)');
  const st = evaluateLaunchConfig({ ...GOOD, HCG_DEPLOYMENT: 'staging', APP_URL: 'https://staging.example.com', SUPABASE_URL: 'https://tigwgmayeuisrxjjykqd.supabase.co', STRIPE_SECRET_KEY: 'sk_test_x', TWILIO_API_KEY_SID: '', TWILIO_API_KEY_SECRET: '' });
  check(!ids(st.warnings).includes('twilio_rest_api_key') && !ids(st.fatal).includes('twilio_rest_api_key'), 'staging: auth-token REST client is optional (no finding)');
}
// Half an API key silently falls back to the auth token → FATAL.
{
  check(ids(ev({ TWILIO_API_KEY_SECRET: '' }).fatal).includes('twilio_api_key_complete'), 'API key SID without secret → FATAL twilio_api_key_complete (client would silently use the auth token)');
  check(ids(ev({ TWILIO_API_KEY_SID: '' }).fatal).includes('twilio_api_key_complete'), 'API key secret without SID → FATAL');
  check(ids(ev({ TWILIO_API_KEY_SID: 'AC123' }).fatal).includes('twilio_api_key_complete'), 'API key SID that is not an SK… SID → FATAL');
}
// Master credentials in the runtime.
{
  const r = ev({ TWILIO_ACCOUNT_SID: PARENT });
  check(ids(r.fatal).includes('twilio_runtime_not_parent'), 'TWILIO_ACCOUNT_SID == HCG_TWILIO_PARENT_ACCOUNT_SID → FATAL (master in runtime)');
  check(ids(ev({ TWILIO_ACCOUNT_SID: PARENT.toUpperCase().replace(/^AC/, 'AC') }).fatal).includes('twilio_runtime_not_parent'), 'comparison is case-insensitive');
  check(ids(ev({ HCG_TWILIO_PARENT_ACCOUNT_SID: 'not-a-sid' }).fatal).includes('twilio_runtime_not_parent'), 'malformed parent SID → FATAL (a typo must not disable the check)');
  const w = ev({ HCG_TWILIO_PARENT_ACCOUNT_SID: '' });
  check(ids(w.warnings).includes('twilio_parent_declared') && !ids(w.fatal).includes('twilio_runtime_not_parent'), 'parent not declared → WARNING twilio_parent_declared (cannot detect master-in-runtime)');
  check(ids(ev({ HCG_TWILIO_PARENT_ACCOUNT_SID: '', HCG_TWILIO_SUBACCOUNT_REQUIRED: 'true' }).fatal).includes('twilio_parent_declared'), 'parent not declared after migration (REQUIRED=true) → FATAL');
  for (const k of ['HCG_TWILIO_PARENT_AUTH_TOKEN', 'TWILIO_MASTER_AUTH_TOKEN', 'TWILIO_PARENT_API_KEY_SECRET', 'HCG_TWILIO_MASTER_TOKEN']) {
    check(ids(ev({ [k]: 'x' }).fatal).includes('twilio_no_parent_secret_in_runtime'), `${k} present → FATAL twilio_no_parent_secret_in_runtime`);
  }
  check(!ids(ev({ HCG_TWILIO_PARENT_ACCOUNT_SID: PARENT }).fatal).includes('twilio_no_parent_secret_in_runtime'), 'the parent SID (identifier) itself is not a secret and is allowed');
}
// The signing token stays required.
check(ids(ev({ TWILIO_AUTH_TOKEN: '' }).fatal).includes('twilio_core'), 'TWILIO_AUTH_TOKEN (the runtime subaccount\'s, for webhook signatures) is still REQUIRED');
// OpenAI project key.
{
  check(ids(ev({ OPENAI_API_KEY: 'sk-legacykey' }).warnings).includes('openai_project_key'), 'legacy (non-project) OpenAI key → WARNING openai_project_key');
  check(!ids(ev({ OPENAI_API_KEY: 'sk-svcacct-abc' }).warnings).includes('openai_project_key'), 'service-account key (project-scoped) accepted');
  check(!ids(ev({ OPENAI_API_KEY: 'sk-legacykey', OPENAI_PROJECT_ID: 'proj_abc123' }).warnings).includes('openai_project_key'), 'legacy key + OPENAI_PROJECT_ID accepted');
  check(ids(ev({ OPENAI_API_KEY: 'sk-legacykey', OPENAI_PROJECT_ID: 'abc' }).warnings).includes('openai_project_key'), 'malformed OPENAI_PROJECT_ID does not satisfy the rule');
}
// No secret values in findings.
{
  const r = ev({ TWILIO_ACCOUNT_SID: PARENT, TWILIO_API_KEY_SECRET: '', HCG_TWILIO_PARENT_AUTH_TOKEN: 'PARENTSECRETVALUE', OPENAI_API_KEY: 'sk-LEAKME' });
  const text = JSON.stringify(r);
  check(!/sub-token|PARENTSECRETVALUE|sk-LEAKME/.test(text), 'findings carry key names and codes only, never a secret value');
}
// Classifier ↔ client agree.
{
  const env = { TWILIO_ACCOUNT_SID: SUB, TWILIO_AUTH_TOKEN: 't', TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: 's' };
  check(twilioRestCredentialMode(env) === 'api_key' && tc.twilioRestCredentialMode === twilioRestCredentialMode, 'twilioClient re-exports the same pure mode function');
  const c = tc.createTwilioRestClient(env);
  check(c && c.username === KEY && c.accountSid === SUB, 'api_key mode: client authenticates with the SK key on the runtime account');
  const c2 = tc.createTwilioRestClient({ TWILIO_ACCOUNT_SID: SUB, TWILIO_AUTH_TOKEN: 't', TWILIO_API_KEY_SID: '  ', TWILIO_API_KEY_SECRET: 's' });
  check(twilioRestCredentialMode({ TWILIO_ACCOUNT_SID: SUB, TWILIO_AUTH_TOKEN: 't', TWILIO_API_KEY_SID: '  ', TWILIO_API_KEY_SECRET: 's' }) === 'auth_token' && c2.username === SUB, 'whitespace-only key SID: mode and client agree (auth_token) — the report never disagrees with the client');
  check(tc.createTwilioRestClient({}) === null && twilioRestCredentialMode({}) === 'none', 'no account SID → no client, mode none');
  const k = classifyTwilioRuntimeCredentials({ ...env, HCG_TWILIO_PARENT_ACCOUNT_SID: SUB });
  check(k.runtimeIsParent && k.signingTokenPresent && !k.apiKeyIncomplete, 'classifier: runtimeIsParent / signingTokenPresent / apiKeyIncomplete');
}

console.log(failures === 0 ? '\nAgent 1 launch-config credential checks: all hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
