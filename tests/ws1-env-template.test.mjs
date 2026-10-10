// WS1 2026-10-10 — scripts/production/env-template.production stays in step
// with services/config/launchConfig.js and never carries a secret.
//
// Run: node tests/ws1-env-template.test.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { RULES, evaluateLaunchConfig } = require('../services/config/launchConfig.js');
const { REQUIRED_IN_PRODUCTION } = require('../services/serverConfig.js');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const text = readFileSync(path.join(ROOT, 'scripts', 'production', 'env-template.production'), 'utf8');
const active = new Map();   // KEY -> value (uncommented lines)
const mentioned = new Set(); // KEY (commented or not)
for (const line of text.split('\n')) {
  const m = /^(#\s*)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (!m) continue;
  mentioned.add(m[2]);
  if (!m[1]) {
    check(!active.has(m[2]), `${m[2]} is set only once`);
    active.set(m[2], m[3]);
  }
}

// 1. Every production-REQUIRED (and FORBIDDEN) rule key appears.
const requiredRules = RULES.filter((r) => ['required', 'forbidden'].includes(r.levels.production));
check(requiredRules.length >= 20, `launchConfig has ${requiredRules.length} production-required/forbidden rules`);
for (const r of requiredRules) for (const k of r.keys) check(mentioned.has(k), `required rule ${r.id}: ${k} appears in the template`);
for (const k of REQUIRED_IN_PRODUCTION) check(active.has(k), `serverConfig REQUIRED_IN_PRODUCTION ${k} is an active (uncommented) line`);
// Recommended keys too (warnings in production are part of the checklist).
for (const r of RULES.filter((x) => x.levels.production === 'recommended')) check(r.keys.some((k) => mentioned.has(k)), `recommended rule ${r.id}: at least one of ${r.keys.join('/')} appears`);

// 2. No secret values.
const SECRETISH = [/sk_(live|test)_\w/, /rk_(live|test)_\w/, /whsec_\w/, /eyJ[\w-]{8,}\./, /\bAC[0-9a-f]{32}\b/, /\bSK[0-9a-f]{32}\b/, /\bAP[0-9a-f]{32}\b/, /\bsbp_\w{8,}/, /\bre_[A-Za-z0-9]{8,}/, /\bsk-[A-Za-z0-9-]{8,}/, /@(?!homecallguard\.co\.uk)[\w-]+\.\w+/];
for (const [k, v] of active) check(!SECRETISH.some((re) => re.test(v)), `${k}: value is not secret-looking`);
const SECRET_KEYS = ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ABUSE_AUDIT_HASH_SECRET', 'SAFETY_CALLER_KEY_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'REVENUECAT_WEBHOOK_AUTHORIZATION', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SECRET', 'TWILIO_VOICE_API_KEY_SECRET', 'OPENAI_API_KEY', 'Resend_API_Key', 'NEW_SUBSCRIPTIONS_ALLOWLIST'];
for (const k of SECRET_KEYS) check(active.has(k) && active.get(k) === '', `${k} is present with an EMPTY value (entered in Railway only)`);

// 3. The template's own non-empty values are production-safe: with synthetic
//    placeholders for the empty lines, check-launch-config gives 0 fatal and
//    0 warnings in production.
const PLACEHOLDER = {
  TRUST_PROXY_HOPS: '1', ABUSE_AUDIT_HASH_SECRET: 'a'.repeat(40), SAFETY_CALLER_KEY_SECRET: 'b'.repeat(40),
  STRIPE_SECRET_KEY: 'rk_live_PLACEHOLDER', STRIPE_PRICE_ID: 'price_PLACEHOLDER', REVENUECAT_WEBHOOK_AUTHORIZATION: 'c'.repeat(24),
  TWILIO_VOICE_FALLBACK_URL: 'https://handler.twilio.com/twiml/EHplaceholder', HCG_SUPPORT_VERIFICATION_CALLERS: '+447700900000',
  PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS: 'UTplaceholder', TWILIO_ACCOUNT_SID: 'ACplaceholder',
  // Agent 1 2026-10-11 (credential isolation + OpenAI project key rules).
  TWILIO_API_KEY_SID: `SK${'0'.repeat(32)}`, HCG_TWILIO_PARENT_ACCOUNT_SID: `AC${'1'.repeat(32)}`, OPENAI_API_KEY: 'sk-proj-PLACEHOLDER',
};
const env = {};
for (const [k, v] of active) env[k] = v !== '' ? v : (PLACEHOLDER[k] || `placeholder-${k}`);
const r = evaluateLaunchConfig(env);
check(r.deployment === 'production', `template evaluates as production (got ${r.deployment})`);
check(r.fatal.length === 0, `template + placeholders: 0 fatal (got ${r.fatal.map((f) => f.id).join(', ') || 0})`);
check(r.warnings.length === 0, `template + placeholders: 0 warnings (got ${r.warnings.map((f) => f.id).join(', ') || 0})`);
// And it must NOT be acceptable with the secrets left empty (the template is not a working config by itself).
const bare = Object.fromEntries([...active].map(([k, v]) => [k, v]));
check(evaluateLaunchConfig(bare).fatal.length > 0, 'the bare template (secrets empty) is FATAL — it can never be deployed as-is');

// 4. Controlled-launch values from the procedure §5.
check(active.get('NEW_SUBSCRIPTIONS_PAUSED') === 'true', 'NEW_SUBSCRIPTIONS_PAUSED=true at the merge');
check(active.get('ALLOWANCE_SOURCE') === 'fortress', 'ALLOWANCE_SOURCE=fortress');
check(active.get('ALLOWANCE_TOPUPS_ENABLED') === 'false' && active.get('ACCOUNTING_XERO_POSTING_ENABLED') === 'false' && active.get('ACCOUNTING_CAPTURE_ENABLED') === 'false', 'top-ups, accounting capture and Xero posting are off');
for (const k of ['PROCESS_ROUTE_ENABLED', 'TWILIO_WEBHOOK_AUTH_MODE', 'FC_DEGRADED_MODE', 'NUMBER_PROVISIONING_MODE', 'HCG_CONFIG_ACKNOWLEDGE', 'ALLOWANCE_ALLOW_SANDBOX_CREDITS', 'SAFETY_ADMISSION_REQUIRES_SIGNATURE']) check(!active.has(k), `${k} is not set (commented guidance only)`);

console.log(failures === 0 ? '\nAll WS1 env template checks passed.' : `\n${failures} WS1 env template check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
