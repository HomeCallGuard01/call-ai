// Launch-required environment schema (soft-launch integration 2026-10-04,
// brief §6 A5/A6/E20). Production and staging must not SILENTLY start in an
// unsafe financial/security configuration.
//
// Deployment = the STRICTER of
//   - declared: HCG_DEPLOYMENT=production|staging (optional, recommended), and
//   - detected: services/telephony/provisioningGuard.js resolveEnvironment
//     (production / mixed ⇒ production rules; the staging Supabase project ⇒
//     staging rules), NODE_ENV=test ⇒ test, otherwise development.
//
// Each rule says, per deployment, REQUIRED (fatal), RECOMMENDED (warning),
// OPTIONAL, or TEST/DEV ONLY (fatal if present in production/staging).
// A fatal finding stops the process before it listens. The only bypass is an
// explicit, named acknowledgement per rule — HCG_CONFIG_ACKNOWLEDGE=rule_id,…
// — which still raises a critical alert (the emergency escape hatch the
// webhook auth 'report' mode was designed as; never a silent default).
//
// Never prints, returns or logs a secret VALUE: findings carry key names and
// problem codes only.
//
// Authoritative schema. services/serverConfig.js validateProductionEnv (the
// original NODE_ENV=production minimum) still runs; this schema is a strict
// superset of it (tests/launch-config-safety.test.mjs asserts that).
'use strict';

const { resolveEnvironment } = require('../telephony/provisioningGuard');
const { classifyTwilioRuntimeCredentials } = require('./twilioCredentials');

const DEFAULT_STAGING_SUPABASE_REF = 'tigwgmayeuisrxjjykqd';
const STRICT = ['production', 'staging'];
const RANK = { development: 0, test: 0, staging: 1, production: 2 };

const present = (v) => typeof v === 'string' && v.trim() !== '';
const minLen = (n) => (v) => present(v) && v.trim().length >= n;

function supabaseRef(url) {
  try { const h = new URL(url).hostname; return h.endsWith('.supabase.co') ? h.split('.')[0] : null; } catch { return null; }
}

function resolveDeployment(env = process.env) {
  const detectedEnv = resolveEnvironment(env);
  let detected;
  if (detectedEnv.kind === 'production' || detectedEnv.kind === 'mixed') detected = 'production';
  else if (supabaseRef(env.SUPABASE_URL) === (env.STAGING_SUPABASE_REF || DEFAULT_STAGING_SUPABASE_REF)) detected = 'staging';
  else if (env.NODE_ENV === 'test') detected = 'test';
  else detected = 'development';
  const declaredRaw = String(env.HCG_DEPLOYMENT || '').trim().toLowerCase();
  const declared = ['production', 'staging', 'development', 'test'].includes(declaredRaw) ? declaredRaw : null;
  const deployment = declared && RANK[declared] > RANK[detected] ? declared : detected;
  return { deployment, detected, declared, environmentKind: detectedEnv.kind };
}

// level per deployment: 'required' | 'recommended' | 'optional' | 'forbidden'
// (forbidden = TEST/DEV ONLY: must not be enabled there).
// test(env) returns null when satisfied, else a problem code.
const R = (id, area, keys, levels, test, why, extra = {}) => ({ id, area, keys, levels, test, why, ...extra });
// Agent 1 2026-10-11: once the runtime has moved to a Twilio subaccount
// (docs/launch/2026-10-11-TWILIO-SUBACCOUNT-MIGRATION-RUNBOOK.md), Andrew sets
// HCG_TWILIO_SUBACCOUNT_REQUIRED=true and the credential-isolation warnings
// become FATAL, so a later env edit cannot silently put master credentials back.
const subaccountRequired = (e) => String(e.HCG_TWILIO_SUBACCOUNT_REQUIRED || '').trim().toLowerCase() === 'true';
const twilioCreds = (e) => classifyTwilioRuntimeCredentials(e);
const REQ_BOTH = { production: 'required', staging: 'required' };
const REC_BOTH = { production: 'recommended', staging: 'recommended' };

const RULES = [
  // ── Platform / Supabase ────────────────────────────────────────────────
  R('supabase', 'Supabase', ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'], REQ_BOTH,
    (e) => (present(e.SUPABASE_URL) && present(e.SUPABASE_ANON_KEY) && present(e.SUPABASE_SERVICE_ROLE_KEY) ? null : 'missing'),
    'Every financial authority (Fortress 067, 056 claims, entitlements) lives in Supabase.'),
  R('app_url_https', 'Platform', ['APP_URL'], REQ_BOTH,
    (e) => {
      if (!/^https:\/\/[^\s/]+/.test(String(e.APP_URL || ''))) return 'missing_or_not_https';
      try { if (['localhost', '127.0.0.1'].includes(new URL(e.APP_URL).hostname)) return 'localhost'; } catch { return 'invalid_url'; }
      return null;
    },
    'Twilio signature validation and callback-host checks are computed from APP_URL.'),
  R('deployment_declared', 'Platform', ['HCG_DEPLOYMENT'], REC_BOTH,
    (e) => (present(e.HCG_DEPLOYMENT) ? null : 'not_declared'),
    'Declaring the deployment means a URL typo can never relax these checks.'),
  // ── Security / abuse ──────────────────────────────────────────────────
  R('abuse_audit_hash_secret', 'Security', ['ABUSE_AUDIT_HASH_SECRET'], REQ_BOTH,
    (e) => (minLen(32)(e.ABUSE_AUDIT_HASH_SECRET) ? null : 'missing_or_shorter_than_32'),
    'Without it caller fingerprints in the abuse audit use a public hard-coded key (reversible by enumeration).'),
  R('safety_caller_key_secret', 'Security', ['SAFETY_CALLER_KEY_SECRET'], REQ_BOTH,
    (e) => {
      if (!minLen(32)(e.SAFETY_CALLER_KEY_SECRET)) return 'missing_or_shorter_than_32';
      if (present(e.ABUSE_AUDIT_HASH_SECRET) && e.SAFETY_CALLER_KEY_SECRET.trim() === e.ABUSE_AUDIT_HASH_SECRET.trim()) return 'same_as_abuse_audit_hash_secret';
      return null;
    },
    'Without it per-caller admission keys use a public hard-coded key.'),
  R('trust_proxy_hops', 'Security', ['TRUST_PROXY_HOPS'], REQ_BOTH,
    (e) => (/^[1-3]$/.test(String(e.TRUST_PROXY_HOPS || '').trim()) ? null : 'missing_or_not_1_to_3'),
    'Unset silently disables every per-IP rate limit (auth endpoints); behind Railway the hop count must be explicit.'),
  R('twilio_webhook_auth_enforced', 'Security', ['TWILIO_WEBHOOK_AUTH_MODE'], REQ_BOTH,
    (e) => (String(e.TWILIO_WEBHOOK_AUTH_MODE || '').toLowerCase() === 'report' ? 'report_mode_accepts_unsigned_webhooks' : null),
    "'report' accepts unsigned Twilio webhooks (emergency-only escape hatch)."),
  R('admission_requires_signature', 'Security', ['SAFETY_ADMISSION_REQUIRES_SIGNATURE'], REQ_BOTH,
    (e) => (e.SAFETY_ADMISSION_REQUIRES_SIGNATURE === 'false' ? 'disabled' : null),
    'Paid monitoring must only start for a genuine Twilio request.'),
  // ── Stripe / RevenueCat ───────────────────────────────────────────────
  R('stripe', 'Stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID'], REQ_BOTH,
    (e) => (present(e.STRIPE_SECRET_KEY) && present(e.STRIPE_WEBHOOK_SECRET) && present(e.STRIPE_PRICE_ID) ? null : 'missing'),
    'Checkout, the signed subscription webhook and entitlement all depend on these.'),
  R('stripe_key_mode_production', 'Stripe', ['STRIPE_SECRET_KEY'], { production: 'required', staging: 'optional' },
    (e) => (!present(e.STRIPE_SECRET_KEY) || /^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY.trim()) ? null : 'not_a_live_key'),
    'Production must charge real money with a live key.'),
  R('stripe_key_mode_staging', 'Stripe', ['STRIPE_SECRET_KEY'], { production: 'optional', staging: 'required' },
    (e) => (present(e.STRIPE_SECRET_KEY) && /^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY.trim()) ? 'live_key_in_staging' : null),
    'Staging must never hold a live Stripe key.'),
  R('revenuecat_webhook_auth', 'RevenueCat', ['REVENUECAT_WEBHOOK_AUTHORIZATION'], REQ_BOTH,
    (e) => (minLen(16)(e.REVENUECAT_WEBHOOK_AUTHORIZATION) ? null : 'missing_or_shorter_than_16'),
    'Apple IAP entitlements arrive only through this authenticated webhook.'),
  // ── Twilio ────────────────────────────────────────────────────────────
  R('twilio_core', 'Twilio', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], REQ_BOTH,
    (e) => (present(e.TWILIO_ACCOUNT_SID) && present(e.TWILIO_AUTH_TOKEN) ? null : 'missing'),
    'Signature validation and call control (Fortress termination) need these.'),
  R('twilio_voice_sdk', 'Twilio', ['TWILIO_VOICE_API_KEY_SID', 'TWILIO_VOICE_API_KEY_SECRET', 'TWILIO_VOICE_TWIML_APP_SID'], REQ_BOTH,
    (e) => (present(e.TWILIO_VOICE_API_KEY_SID) && present(e.TWILIO_VOICE_API_KEY_SECRET) && present(e.TWILIO_VOICE_TWIML_APP_SID) ? null : 'missing'),
    'Calls are delivered to the app via the Voice SDK.'),
  R('twilio_voice_fallback_url', 'Twilio', ['TWILIO_VOICE_FALLBACK_URL'], REC_BOTH,
    (e) => (/^https:\/\//.test(String(e.TWILIO_VOICE_FALLBACK_URL || '')) ? null : 'missing'),
    'Without a <Reject/> fallback, calls during an HCG outage are answered by Twilio and billed (containment T4).'),
  // ── Twilio credential isolation (containment P6; Agent 1 2026-10-11) ──
  R('twilio_rest_api_key', 'Twilio', ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET'], { production: 'recommended', staging: 'optional' },
    (e) => (twilioCreds(e).restMode === 'auth_token' ? 'rest_client_uses_account_auth_token' : null),
    'The REST client should use a scoped API key on the runtime subaccount, not an account SID + auth token (an auth token is a full account credential; on the parent it reaches every subaccount, billing and the usage breaker). FATAL once HCG_TWILIO_SUBACCOUNT_REQUIRED=true.',
    { escalate: subaccountRequired }),
  R('twilio_api_key_complete', 'Twilio', ['TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET'], REQ_BOTH,
    (e) => { const c = twilioCreds(e); return c.apiKeyIncomplete ? 'api_key_sid_and_secret_must_both_be_set' : c.apiKeyMalformed ? 'api_key_sid_is_not_an_SK_sid' : null; },
    'With only one of the pair set, services/twilioClient.js silently falls back to the account auth token.'),
  R('twilio_runtime_not_parent', 'Twilio', ['TWILIO_ACCOUNT_SID', 'HCG_TWILIO_PARENT_ACCOUNT_SID'], REQ_BOTH,
    (e) => { const c = twilioCreds(e); return c.parentMalformed ? 'parent_account_sid_malformed' : c.runtimeIsParent ? 'runtime_uses_parent_account' : null; },
    'TWILIO_ACCOUNT_SID equal to the declared parent means master credentials are in the runtime (the auth token kept for signature validation would be the PARENT token).'),
  R('twilio_parent_declared', 'Twilio', ['HCG_TWILIO_PARENT_ACCOUNT_SID'], { production: 'recommended', staging: 'optional' },
    (e) => (twilioCreds(e).parentDeclared ? null : 'parent_account_not_declared'),
    'Declaring the parent SID (a non-secret identifier) is what lets the check above detect master credentials in the runtime. FATAL once HCG_TWILIO_SUBACCOUNT_REQUIRED=true.',
    { escalate: subaccountRequired }),
  R('twilio_no_parent_secret_in_runtime', 'Twilio', ['HCG_TWILIO_PARENT_AUTH_TOKEN', 'TWILIO_MASTER_AUTH_TOKEN'], { production: 'forbidden', staging: 'forbidden' },
    (e) => (twilioCreds(e).parentSecretKeys.length ? 'parent_or_master_secret_present' : null),
    'The parent account\'s credentials belong only in the Twilio Functions service that runs the usage breaker, never in the HCG backend (any *TWILIO_PARENT_*TOKEN/SECRET or *TWILIO_MASTER_*TOKEN/SECRET key).'),
  R('number_provisioning_not_fake', 'Twilio', ['NUMBER_PROVISIONING_MODE'], { production: 'required', staging: 'optional' },
    (e) => (String(e.NUMBER_PROVISIONING_MODE || '').toLowerCase() === 'fake' ? 'fake_mode_in_production' : null),
    'Fake provisioning in production would give customers numbers that do not exist.'),
  R('provider_usage_alert_trip', 'Provider usage alerts', ['PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS', 'PROVIDER_USAGE_ALERT_TRIP_ALL'], { production: 'recommended', staging: 'optional' },
    (e) => (present(e.PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS) || e.PROVIDER_USAGE_ALERT_TRIP_ALL === 'true' ? null : 'no_trigger_designated'),
    'No provider alert can latch the kill switch until at least one trigger is designated (containment T11).'),
  R('support_verification_callers', 'Customer protection', ['HCG_SUPPORT_VERIFICATION_CALLERS'], { production: 'recommended', staging: 'optional' },
    (e) => (String(e.HCG_SUPPORT_VERIFICATION_CALLERS || '').split(',').some((s) => /^\+44\d{10}$/.test(s.trim())) ? null : 'no_support_phone'),
    'Without a designated support phone no customer can be shown Protected (support-verified forwarding proof, migration 075).'),
  // ── Financial authority ───────────────────────────────────────────────
  R('fortress_degraded_mode_reject', 'Financial authority', ['FC_DEGRADED_MODE', 'FC_ALLOW_BOUNDED_DEGRADED_MODE'], REQ_BOTH,
    (e) => (String(e.FC_DEGRADED_MODE || '').toLowerCase() === 'bounded' || e.FC_ALLOW_BOUNDED_DEGRADED_MODE === 'true' ? 'bounded_degraded_mode_requested' : null),
    'D3 = REJECT: spend is refused when the Fortress cannot authorise (policy.js already refuses bounded outside test/dev).'),
  R('abuse_financial_unavailable_policy', 'Financial authority', ['ABUSE_FINANCIAL_UNAVAILABLE_POLICY'], REQ_BOTH,
    (e) => (e.ABUSE_FINANCIAL_UNAVAILABLE_POLICY === 'unmonitored' ? 'unmonitored_on_financial_outage' : null),
    "'unmonitored' connects calls without a financial decision when the authority is down."),
  R('process_route_disabled', 'Financial authority', ['PROCESS_ROUTE_ENABLED'], REQ_BOTH,
    (e) => (e.PROCESS_ROUTE_ENABLED === 'true' ? 'dormant_paid_route_enabled' : null),
    '/process has no Fortress reservation (containment T9).'),
  R('allowance_topups_configured', 'Allowance', ['ALLOWANCE_TOPUPS_ENABLED', 'ALLOWANCE_TOPUP_PRODUCTS'], REQ_BOTH,
    (e) => (e.ALLOWANCE_TOPUPS_ENABLED === 'true' && !present(e.ALLOWANCE_TOPUP_PRODUCTS) ? 'enabled_without_products' : null),
    'Top-ups on with no product catalogue would credit unpriced minutes.'),
  R('allowance_sandbox_credits', 'Allowance', ['ALLOWANCE_ALLOW_SANDBOX_CREDITS'], { production: 'forbidden', staging: 'optional' },
    (e) => (e.ALLOWANCE_ALLOW_SANDBOX_CREDITS === 'true' ? 'sandbox_credits_in_production' : null),
    'Sandbox store purchases must never credit real allowance in production.'),
  // ── AI ────────────────────────────────────────────────────────────────
  R('openai', 'OpenAI', ['OPENAI_API_KEY'], REQ_BOTH,
    (e) => (present(e.OPENAI_API_KEY) ? null : 'missing'),
    'server.js constructs the OpenAI client at boot and crashes without a key (found 2026-10-04); spend limits on the OpenAI project are EXTERNAL configuration.'),
  R('openai_project_key', 'OpenAI', ['OPENAI_API_KEY', 'OPENAI_PROJECT_ID'], { production: 'recommended', staging: 'optional' },
    (e) => {
      const key = String(e.OPENAI_API_KEY || '').trim();
      if (/^sk-(proj|svcacct)-/.test(key)) return null;
      if (/^proj_[A-Za-z0-9]+$/.test(String(e.OPENAI_PROJECT_ID || '').trim())) return null;
      return 'key_not_project_scoped';
    },
    'Containment P1: the only provider-enforced AI cap is an OpenAI PROJECT hard spend limit, which binds only keys of that project (sk-proj-/sk-svcacct- keys, or a legacy key with OPENAI_PROJECT_ID). Setting the limit itself is a console step (AGENT1 report §6).'),
  // ── Email / comms ─────────────────────────────────────────────────────
  R('alert_email', 'Email/comms', ['Resend_API_Key'], REC_BOTH,
    (e) => (present(e.Resend_API_Key) ? null : 'missing'),
    'Critical alerts (breaker, kill switch, provider alert) are emailed via Resend (services/alerting.js; recipient hard-coded); without it they only reach logs.'),
  // Lifecycle communications: services/lifecycle/communicationsPlan.js has NO
  // send path and no switch (it plans only) — proven by
  // tests/launch-config-safety.test.mjs rather than an env rule.
  // ── Operational events / customer notifications (launch sprint 2026-10-05) ──
  R('ops_email_configured', 'Email/comms', ['OPS_NOTIFY_EMAIL_ENABLED', 'Resend_API_Key', 'OPS_NOTIFY_ROLE_OPERATIONS_EMAIL'], REQ_BOTH,
    (e) => (e.OPS_NOTIFY_EMAIL_ENABLED === 'true' && !(present(e.Resend_API_Key) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e.OPS_NOTIFY_ROLE_OPERATIONS_EMAIL || '').trim())) ? 'email_enabled_without_provider_or_operations_recipient' : null),
    'Notification email on without Resend or an operations@ recipient would silently mark every delivery disabled.'),
  R('ops_events_schedule', 'Email/comms', ['OPS_EVENTS_SCHEDULE_ENABLED'], REC_BOTH,
    (e) => (e.OPS_EVENTS_SCHEDULE_ENABLED === 'true' ? null : 'off'),
    'Without the schedule (needs migration 072) no NEW_GENUINE_CUSTOMER / needs-attention events are recorded, so Andrew is not told when a genuine customer joins (services/opsEvents/scheduler.js).'),
  // ── Customer allowance display (DT-2, real-device finding 2026-10-05) ──
  R('allowance_display_matches_enforcement', 'Customer allowance', ['ALLOWANCE_SOURCE'], REC_BOTH,
    (e) => (e.ALLOWANCE_SOURCE === 'fortress' ? null : 'meter_shows_minutes_while_fortress_enforces_gbp'),
    'Fortress enforces a £ protection budget; without ALLOWANCE_SOURCE=fortress the customer meter shows monitored minutes instead, so it would not match what actually limits calls (decision AL-1).'),
  // ── Accounting / Xero (credentials only when posting is on) ───────────
  R('xero_posting_credentials', 'Accounting/Xero', ['ACCOUNTING_XERO_POSTING_ENABLED', 'XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_TENANT_ID'], REQ_BOTH,
    (e) => (e.ACCOUNTING_XERO_POSTING_ENABLED === 'true' && !(present(e.XERO_CLIENT_ID) && present(e.XERO_CLIENT_SECRET) && present(e.XERO_TENANT_ID)) ? 'posting_enabled_without_credentials' : null),
    'Xero credentials are required only once posting is enabled.'),
  R('xero_posting_decisions', 'Accounting/Xero', ['ACCOUNTING_XERO_POSTING_ENABLED', 'ACCOUNTING_CONFIRMED_DECISIONS'], REQ_BOTH,
    (e) => (e.ACCOUNTING_XERO_POSTING_ENABLED === 'true' && !present(e.ACCOUNTING_CONFIRMED_DECISIONS) ? 'posting_enabled_without_accountant_decisions' : null),
    'Posting before AD-1..AD-11 are confirmed would invent accounting policy.'),
  // ── BEGIN WS6 Magrathea → Twilio BYOC rules (Agent 2, 2026-10-11) ───────
  // Kept as one delimited block at the end of RULES (Agent 1 also edits this
  // list). Helpers: services/telephony/twilioAccounts.js,
  // services/telephony/numberProviders/config.js.
  R('byoc_twilio_account_pair', 'Twilio BYOC', ['TWILIO_BYOC_ACCOUNT_SID', 'TWILIO_BYOC_AUTH_TOKEN'], REQ_BOTH,
    (e) => require('../telephony/twilioAccounts').resolveAdditionalTwilioAccounts(e).problem,
    'An incomplete/invalid BYOC account pair is ignored, so every webhook from that account would be refused 403 (calls fail); the same SID/token as the primary account is a misconfiguration.'),
  R('number_provider_known', 'Twilio BYOC', ['NUMBER_PROVIDER'], REQ_BOTH,
    (e) => require('../telephony/numberProviders/config').resolveNumberProvider(e).problem,
    'An unknown NUMBER_PROVIDER holds every number provisioning (fail closed) — new customers would get no number.'),
  R('number_provider_magrathea_production', 'Twilio BYOC', ['NUMBER_PROVIDER'], { production: 'forbidden', staging: 'optional' },
    (e) => (require('../telephony/numberProviders/config').resolveNumberProvider(e).provider === 'magrathea' ? 'magrathea_not_approved_for_production' : null),
    'Magrathea DDIs via Twilio BYOC are staging-unverified (leg stacking T1, Diversion T13, signing T15); production needs Andrew\'s explicit approval (HCG_CONFIG_ACKNOWLEDGE).'),
  R('byoc_trunk_sid_recorded', 'Twilio BYOC', ['TWILIO_BYOC_TRUNK_SID'], REC_BOTH,
    (e) => {
      if (require('../telephony/numberProviders/config').resolveNumberProvider(e).provider !== 'magrathea') return null;
      return /^BY[0-9a-f]{32}$/i.test(String(e.TWILIO_BYOC_TRUNK_SID || '').trim()) ? null : 'byoc_trunk_sid_not_recorded';
    },
    'Documentation only (no code calls the trunk): records which BYOC trunk the inventory DDIs are routed to, for incident response and rollback.'),
  // ── END WS6 Magrathea → Twilio BYOC rules ───────────────────────────────
];

// Documentation-only classification of the remaining settings (no startup
// check): OPTIONAL tunables and TEST/DEV ONLY switches.
const OPTIONAL_GROUPS = Object.freeze({
  'OPTIONAL (tunables with safe defaults)': ['SAFETY_*', 'ABUSE_* (except ABUSE_FINANCIAL_UNAVAILABLE_POLICY)', 'MEDIA_STREAM_*', 'MONITORING_*', 'RAPID_ABUSE_*', 'ALLOWANCE_* (except the rules above)', 'BUSINESS_*', 'LIFECYCLE_MONTHLY_NUMBER_COST_GBP', 'HCG_ECONOMICS_INCLUDE_PLATFORM_FEE', 'PLAN_PRODUCT_MAP', 'ACCOUNTING_CAPTURE_ENABLED (keep false until 071 applied)', 'ACCOUNTING_XERO_ACCOUNT_CODES', 'XERO_SCOPES', 'TWILIO_ADDRESS_SID', 'TWILIO_BUNDLE_SID', 'HCG_TWILIO_SUBACCOUNT_REQUIRED (set true after the subaccount migration: credential-isolation warnings become fatal)', 'TWILIO_VOICE_PUSH_CREDENTIAL_SID[_IOS]', 'TWILIO_WEBHOOK_ALLOWED_HOSTS', 'PRODUCTION_APP_HOSTS', 'PRODUCTION_SUPABASE_REF', 'PRODUCTION_TWILIO_ACCOUNT_SID', 'STAGING_SUPABASE_REF', 'NONPRODUCTION_MAX_NUMBERS', 'NUMBER_LIFECYCLE_JOBS', 'ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE (decision D-N1)', 'CALL_DELIVERY_*', 'DELIVERY_PUSH_FAILURE_POLLING', 'FC_TERMINATION_MODE', 'FC_TERMINATION_ANNOUNCEMENT', 'FC_ESSENTIAL_CALLERS', 'HCG_INCIDENT_MODE', 'IOS_COMING_SOON', 'LANDLINE_COMING_SOON', 'APP_STORE_URL', 'PROVIDER_USAGE_ALERT_MAX_AGE_MINUTES', 'PORT', 'RAILWAY_*', 'OPS_NOTIFY_FROM_EMAIL', 'OPS_NOTIFY_ROLE_FOUNDER_EMAIL', 'OPS_NOTIFY_FOUNDER_EARLY_LAUNCH', 'OPS_NOTIFY_PUSH_ENABLED (no adapter yet)', 'NEW_SUBSCRIPTIONS_PAUSED (stop-acquisition switch)', 'NEW_SUBSCRIPTIONS_ALLOWLIST (invite-only cohort emails)', 'NUMBER_INVENTORY_COOLING_OFF_DAYS (WS6, default 30)'],
  'TEST/DEV ONLY': ['FC_DEGRADED_MODE=bounded', 'FC_ALLOW_BOUNDED_DEGRADED_MODE=true', 'NUMBER_PROVISIONING_MODE=fake', 'ALLOWANCE_ALLOW_SANDBOX_CREDITS=true (production)', 'TWILIO_WEBHOOK_AUTH_MODE=report', 'PROCESS_ROUTE_ENABLED=true', 'SAFETY_ADMISSION_REQUIRES_SIGNATURE=false', 'FC_REALPG_MODULES (tests)'],
});

function evaluateLaunchConfig(env = process.env) {
  const dep = resolveDeployment(env);
  const acknowledged = new Set(String(env.HCG_CONFIG_ACKNOWLEDGE || '').split(',').map((s) => s.trim()).filter(Boolean));
  const fatal = []; const acknowledgedFatal = []; const warnings = []; const rows = [];
  for (const rule of RULES) {
    let level = STRICT.includes(dep.deployment) ? (rule.levels[dep.deployment] || 'optional') : 'optional';
    if (level === 'recommended' && typeof rule.escalate === 'function' && rule.escalate(env)) level = 'required';
    const problem = rule.test(env);
    const finding = { id: rule.id, area: rule.area, keys: rule.keys, level, problem, why: rule.why };
    rows.push(finding);
    if (!problem || level === 'optional') continue;
    if (level === 'required' || level === 'forbidden') (acknowledged.has(rule.id) ? acknowledgedFatal : fatal).push(finding);
    else warnings.push(finding);
  }
  if (dep.declared && RANK[dep.declared] < RANK[dep.detected]) {
    warnings.push({ id: 'deployment_declaration_weaker_than_detected', area: 'Platform', keys: ['HCG_DEPLOYMENT'], level: 'recommended', problem: `declared_${dep.declared}_detected_${dep.detected}`, why: 'The stricter (detected) rules were applied.' });
  }
  return { ...dep, ok: fatal.length === 0, fatal, acknowledgedFatal, warnings, rows };
}

const summarise = (f) => `${f.id} [${f.keys.join(', ')}]: ${f.problem}`;

/**
 * Call once at boot, before listening. Production/staging with an
 * unacknowledged fatal finding: logs (names + codes only) and exits(1).
 */
function enforceLaunchConfig({ env = process.env, log = console.error, exit = (c) => process.exit(c), alert = null } = {}) {
  const r = evaluateLaunchConfig(env);
  if (!STRICT.includes(r.deployment)) return r;
  for (const w of r.warnings) log(`LAUNCH CONFIG WARNING (${r.deployment}): ${summarise(w)}`);
  for (const a of r.acknowledgedFatal) {
    log(`LAUNCH CONFIG UNSAFE BUT ACKNOWLEDGED (${r.deployment}): ${summarise(a)}`);
    if (typeof alert === 'function') Promise.resolve(alert('launch_config_unsafe_acknowledged', `Started with an acknowledged unsafe setting: ${a.id}`, { rule: a.id, problem: a.problem })).catch(() => {});
  }
  if (r.fatal.length) {
    for (const f of r.fatal) log(`LAUNCH CONFIG FATAL (${r.deployment}): ${summarise(f)} — ${f.why}`);
    log(`REFUSING TO START: ${r.fatal.length} launch-required setting(s) unsafe or missing in ${r.deployment}. Fix them (or, in an emergency, name the rule in HCG_CONFIG_ACKNOWLEDGE).`);
    exit(1);
  }
  return r;
}

module.exports = { RULES, OPTIONAL_GROUPS, resolveDeployment, evaluateLaunchConfig, enforceLaunchConfig, DEFAULT_STAGING_SUPABASE_REF };
