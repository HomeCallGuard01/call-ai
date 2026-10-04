// Launch-required configuration (soft-launch integration 2026-10-04, brief
// §6 A5/A6/E20): production/staging never SILENTLY start unsafe. Unit cases on
// services/config/launchConfig.js, then black-box boots of the REAL server.js.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { evaluateLaunchConfig, enforceLaunchConfig, resolveDeployment, RULES } = require('../services/config/launchConfig');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const S32 = (c) => c.repeat(40);
// A complete, SAFE production-shaped configuration (all values fake).
const SAFE = {
  HCG_DEPLOYMENT: 'production', NODE_ENV: 'production', APP_URL: 'https://hcg.test',
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  ABUSE_AUDIT_HASH_SECRET: S32('a'), SAFETY_CALLER_KEY_SECRET: S32('b'), TRUST_PROXY_HOPS: '1',
  STRIPE_SECRET_KEY: 'sk_live_FAKEFAKEFAKE', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_PRICE_ID: 'price_fake',
  REVENUECAT_WEBHOOK_AUTHORIZATION: 'Bearer fake-revenuecat-1234',
  TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'fake-token', TWILIO_VOICE_API_KEY_SID: 'SKfake', TWILIO_VOICE_API_KEY_SECRET: 'fake', TWILIO_VOICE_TWIML_APP_SID: 'APfake',
  OPENAI_API_KEY: 'sk-fake-openai',
};
const ev = (over) => evaluateLaunchConfig({ ...SAFE, ...over });
const fatalIds = (r) => r.fatal.map((f) => f.id);

// ── Deployment resolution ────────────────────────────────────────────────
check(resolveDeployment({ NODE_ENV: 'test' }).deployment === 'test', 'NODE_ENV=test → test (no enforcement)');
check(resolveDeployment({ APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: 'https://psbzynxplxfbyrbdidmn.supabase.co' }).deployment === 'production', 'production signature → production rules');
check(resolveDeployment({ APP_URL: 'http://localhost:3000', SUPABASE_URL: 'https://psbzynxplxfbyrbdidmn.supabase.co' }).deployment === 'production', 'MIXED (laptop on the production DB) → production rules');
check(resolveDeployment({ SUPABASE_URL: 'https://tigwgmayeuisrxjjykqd.supabase.co' }).deployment === 'staging', 'staging Supabase project → staging rules');
check(resolveDeployment({ HCG_DEPLOYMENT: 'development', APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: 'https://psbzynxplxfbyrbdidmn.supabase.co' }).deployment === 'production', 'a weaker declaration can never relax detected production');
check(resolveDeployment({ HCG_DEPLOYMENT: 'production', NODE_ENV: 'test' }).deployment === 'production', 'declared production is enforced even on non-production URLs');

// ── Safe baseline ────────────────────────────────────────────────────────
{
  const r = ev({});
  check(r.ok && r.fatal.length === 0, `a complete safe production config passes (fatal: ${fatalIds(r).join(',') || 'none'})`);
  check(r.warnings.some((w) => w.id === 'twilio_voice_fallback_url') && r.warnings.some((w) => w.id === 'provider_usage_alert_trip'), 'recommended-but-absent provider safety settings are warned, not silent');
}

// ── A5 secrets, A6 proxy, signature/D3/process, Stripe mode, Xero scoping ─
const fatalCases = [
  ['ABUSE_AUDIT_HASH_SECRET absent', { ABUSE_AUDIT_HASH_SECRET: undefined }, 'abuse_audit_hash_secret'],
  ['ABUSE_AUDIT_HASH_SECRET too short', { ABUSE_AUDIT_HASH_SECRET: 'short' }, 'abuse_audit_hash_secret'],
  ['SAFETY_CALLER_KEY_SECRET absent', { SAFETY_CALLER_KEY_SECRET: '' }, 'safety_caller_key_secret'],
  ['SAFETY_CALLER_KEY_SECRET = audit secret', { SAFETY_CALLER_KEY_SECRET: S32('a') }, 'safety_caller_key_secret'],
  ['TRUST_PROXY_HOPS absent', { TRUST_PROXY_HOPS: undefined }, 'trust_proxy_hops'],
  ['TRUST_PROXY_HOPS = 0', { TRUST_PROXY_HOPS: '0' }, 'trust_proxy_hops'],
  ['TRUST_PROXY_HOPS = "true"', { TRUST_PROXY_HOPS: 'true' }, 'trust_proxy_hops'],
  ['TWILIO_WEBHOOK_AUTH_MODE=report', { TWILIO_WEBHOOK_AUTH_MODE: 'report' }, 'twilio_webhook_auth_enforced'],
  ['SAFETY_ADMISSION_REQUIRES_SIGNATURE=false', { SAFETY_ADMISSION_REQUIRES_SIGNATURE: 'false' }, 'admission_requires_signature'],
  ['FC_DEGRADED_MODE=bounded', { FC_DEGRADED_MODE: 'bounded' }, 'fortress_degraded_mode_reject'],
  ['FC_ALLOW_BOUNDED_DEGRADED_MODE=true', { FC_ALLOW_BOUNDED_DEGRADED_MODE: 'true' }, 'fortress_degraded_mode_reject'],
  ['ABUSE_FINANCIAL_UNAVAILABLE_POLICY=unmonitored', { ABUSE_FINANCIAL_UNAVAILABLE_POLICY: 'unmonitored' }, 'abuse_financial_unavailable_policy'],
  ['PROCESS_ROUTE_ENABLED=true', { PROCESS_ROUTE_ENABLED: 'true' }, 'process_route_disabled'],
  ['test Stripe key in production', { STRIPE_SECRET_KEY: 'sk_test_x' }, 'stripe_key_mode_production'],
  ['Stripe webhook secret absent', { STRIPE_WEBHOOK_SECRET: undefined }, 'stripe'],
  ['RevenueCat webhook auth absent', { REVENUECAT_WEBHOOK_AUTHORIZATION: undefined }, 'revenuecat_webhook_auth'],
  ['Twilio auth token absent', { TWILIO_AUTH_TOKEN: undefined }, 'twilio_core'],
  ['OPENAI_API_KEY absent (server.js would crash at boot)', { OPENAI_API_KEY: undefined }, 'openai'],
  ['APP_URL not https', { APP_URL: 'http://hcg.test' }, 'app_url_https'],
  ['fake provisioning in production', { NUMBER_PROVISIONING_MODE: 'fake' }, 'number_provisioning_not_fake'],
  ['sandbox store credits in production', { ALLOWANCE_ALLOW_SANDBOX_CREDITS: 'true' }, 'allowance_sandbox_credits'],
  ['top-ups on without products', { ALLOWANCE_TOPUPS_ENABLED: 'true' }, 'allowance_topups_configured'],
  ['Xero posting on without credentials', { ACCOUNTING_XERO_POSTING_ENABLED: 'true', ACCOUNTING_CONFIRMED_DECISIONS: 'AD-1' }, 'xero_posting_credentials'],
  ['Xero posting on without accountant decisions', { ACCOUNTING_XERO_POSTING_ENABLED: 'true', XERO_CLIENT_ID: 'x', XERO_CLIENT_SECRET: 'y', XERO_TENANT_ID: 'z' }, 'xero_posting_decisions'],
];
for (const [name, over, id] of fatalCases) check(fatalIds(ev(over)).includes(id), `production FATAL: ${name} → ${id}`);
check(ev({ ACCOUNTING_XERO_POSTING_ENABLED: undefined, XERO_CLIENT_ID: undefined }).ok, 'Xero credentials NOT required while posting is disabled');
check(ev({ ACCOUNTING_CAPTURE_ENABLED: 'false' }).ok, 'accounting capture off is fine');
{
  const st = evaluateLaunchConfig({ ...SAFE, HCG_DEPLOYMENT: 'staging', STRIPE_SECRET_KEY: 'sk_live_x' });
  check(st.deployment === 'staging' && fatalIds(st).includes('stripe_key_mode_staging'), 'staging FATAL: a LIVE Stripe key in staging');
  check(evaluateLaunchConfig({ ...SAFE, HCG_DEPLOYMENT: 'staging', STRIPE_SECRET_KEY: 'sk_test_x' }).ok, 'staging with a test Stripe key and the same safety settings passes');
  check(fatalIds(evaluateLaunchConfig({ ...SAFE, HCG_DEPLOYMENT: 'staging', STRIPE_SECRET_KEY: 'sk_test_x', TRUST_PROXY_HOPS: undefined, ABUSE_AUDIT_HASH_SECRET: undefined })).join() === 'abuse_audit_hash_secret,trust_proxy_hops', 'staging requires the same secrets and proxy config');
}
check(evaluateLaunchConfig({ NODE_ENV: 'test' }).ok, 'test/dev: nothing enforced (local development unaffected)');

// ── Acknowledgement escape hatch, never silent ───────────────────────────
{
  const r = ev({ TWILIO_WEBHOOK_AUTH_MODE: 'report', HCG_CONFIG_ACKNOWLEDGE: 'twilio_webhook_auth_enforced' });
  check(r.ok && r.acknowledgedFatal.some((f) => f.id === 'twilio_webhook_auth_enforced'), 'a named acknowledgement lets an emergency setting start …');
  const logs = []; const alerts = []; let code = null;
  enforceLaunchConfig({ env: { ...SAFE, TWILIO_WEBHOOK_AUTH_MODE: 'report', HCG_CONFIG_ACKNOWLEDGE: 'twilio_webhook_auth_enforced' }, log: (l) => logs.push(l), exit: (c) => { code = c; }, alert: async (t) => alerts.push(t) });
  await new Promise((r2) => setTimeout(r2, 10));
  check(code === null && alerts.includes('launch_config_unsafe_acknowledged') && logs.some((l) => /UNSAFE BUT ACKNOWLEDGED/.test(l)), '… but still logs and raises a critical alert');
  check(!ev({ TRUST_PROXY_HOPS: undefined, HCG_CONFIG_ACKNOWLEDGE: 'some_other_rule' }).ok, 'acknowledging a different rule does not bypass this one');
}
{
  const logs = []; let code = null;
  enforceLaunchConfig({ env: { ...SAFE, ABUSE_AUDIT_HASH_SECRET: undefined, STRIPE_SECRET_KEY: 'sk_test_SENTINEL_SECRET_VALUE' }, log: (l) => logs.push(l), exit: (c) => { code = c; } });
  check(code === 1 && logs.some((l) => /REFUSING TO START/.test(l)), 'enforce: unacknowledged fatal → exit(1)');
  check(!logs.join('\n').includes('SENTINEL_SECRET_VALUE') && !logs.join('\n').includes(S32('b')), 'enforce output never contains a secret value');
}
check(RULES.every((r) => r.id && r.keys.length && r.why), 'every rule names its keys and explains why');

// ── Comms OFF (brief §6 B10): the planner has no send path ─────────────
{
  const src = readFileSync(path.join(ROOT, 'services/lifecycle/communicationsPlan.js'), 'utf8');
  check(!/require\(['"][^'"]*(alerting|resend|email|twilio|smsBudget|messages)[^'"]*['"]\)/i.test(src) && !/messages\.create|fetch\(|https\.request/.test(src), 'lifecycle communications planner cannot send (no email/SMS/HTTP dependency)');
}

// ── Black box: the REAL server.js ────────────────────────────────────────
function boot(env, ms = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { child.kill('SIGKILL'); } catch {} resolve({ ...r, out }); };
    child.stdout.on('data', (d) => { out += d; if (/Server running on port/.test(out)) finish({ started: true, code: null }); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => finish({ started: false, code }));
    const t = setTimeout(() => finish({ started: false, code: 'timeout' }), ms);
  });
}
{
  const r = await boot({ ...SAFE, PORT: '0', ABUSE_AUDIT_HASH_SECRET: '', TRUST_PROXY_HOPS: '', STRIPE_SECRET_KEY: 'sk_test_SENTINEL_SECRET_VALUE' });
  check(!r.started && r.code === 1, `real server.js, production with missing hash secret + proxy hops → refuses to start (exit ${r.code})`);
  check(/abuse_audit_hash_secret/.test(r.out) && /trust_proxy_hops/.test(r.out) && /stripe_key_mode_production/.test(r.out), 'refusal names every failing rule');
  check(!r.out.includes('SENTINEL_SECRET_VALUE'), 'refusal output contains no secret value');
  check(!/Server running/.test(r.out), 'it never listened');
}
{
  const r = await boot({ ...SAFE, PORT: '0' });
  check(r.started, 'real server.js, complete safe production-shaped config → starts');
  check(/LAUNCH CONFIG WARNING \(production\): twilio_voice_fallback_url/.test(r.out), 'and visibly warns about recommended provider settings');
}

console.log(failures === 0 ? '\nLaunch config safety: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
