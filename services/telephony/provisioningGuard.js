// provisioningGuard.js — decides whether this running environment may buy
// a real telephone number. Pure (env and counts are passed in).
//
// Why: on 2026-09-27, 7 of HCG's 19 billed numbers belonged to STAGING
// households — local/staging servers (APP_URL on an ngrok tunnel, staging
// Supabase) were using the production Twilio credentials, so every staging
// signup bought a real number on the production account, with no release
// lifecycle behind it. This guard makes that impossible by construction.
//
// Rules:
//   production signature  APP_URL is https on a production host AND
//                         SUPABASE_URL is the production project → purchase.
//   non-production        never on the production provider account. Allowed
//                         only with an explicit NUMBER_PROVISIONING_MODE=live,
//                         a provider account that is NOT the production one
//                         (PRODUCTION_TWILIO_ACCOUNT_SID set and different),
//                         and under a small number cap.
//   NUMBER_PROVISIONING_MODE=fake      no provider call; a fake number from
//                         Ofcom's drama range (+44 7700 900xxx) for local UI work.
//   NUMBER_PROVISIONING_MODE=disabled  never buy.
// Production needs no new configuration: the production signature is
// recognised from values it already has. Non-secret identifiers only.
'use strict';

const DEFAULT_PRODUCTION_APP_HOSTS = ['homecallguard.co.uk', 'www.homecallguard.co.uk'];
const DEFAULT_PRODUCTION_SUPABASE_REF = 'psbzynxplxfbyrbdidmn';
const DEFAULT_NONPRODUCTION_MAX_NUMBERS = 3;

function hostOf(url) {
  try {
    const u = new URL(String(url || ''));
    return { host: u.hostname.toLowerCase(), https: u.protocol === 'https:' };
  } catch {
    return { host: null, https: false };
  }
}

function supabaseRef(url) {
  const { host } = hostOf(url);
  return host && host.endsWith('.supabase.co') ? host.split('.')[0] : null;
}

// Which environment is this process? Pure; non-secret identifiers only.
//   production     https production APP_URL host AND production Supabase
//   mixed          exactly one of the two is production (e.g. a laptop on
//                  localhost with the default .env → the PRODUCTION
//                  database): the most dangerous case, never trusted
//   nonproduction  neither is production and SUPABASE_URL is a
//                  recognisable non-production project
//   unknown        identity cannot be established (SUPABASE_URL missing
//                  or unrecognisable) — refused for purchases, provider
//                  mutations and lifecycle jobs; never treated as production
function resolveEnvironment(env = process.env) {
  const app = hostOf(env.APP_URL);
  const productionHosts = (env.PRODUCTION_APP_HOSTS ? env.PRODUCTION_APP_HOSTS.split(',') : DEFAULT_PRODUCTION_APP_HOSTS).map((h) => h.trim().toLowerCase());
  const productionRef = env.PRODUCTION_SUPABASE_REF || DEFAULT_PRODUCTION_SUPABASE_REF;
  const onProductionHost = app.https && productionHosts.includes(app.host);
  const ref = supabaseRef(env.SUPABASE_URL);
  const onProductionDb = ref === productionRef;
  if (onProductionHost && onProductionDb) return { kind: 'production', reason: 'production signature (APP_URL host and Supabase project)' };
  if (onProductionHost !== onProductionDb) {
    return { kind: 'mixed', reason: `mixed configuration: APP_URL ${onProductionHost ? 'is' : 'is not'} production but SUPABASE_URL ${onProductionDb ? 'is' : 'is not'}` };
  }
  if (!ref) return { kind: 'unknown', reason: 'environment identity cannot be established (SUPABASE_URL missing or not a Supabase project URL)' };
  return { kind: 'nonproduction', reason: `non-production (Supabase project ${ref})` };
}

// True only when a non-production process is provably on a DIFFERENT
// provider account from production: both SIDs present and unequal.
function onDedicatedNonProductionAccount(env) {
  const productionSid = env.PRODUCTION_TWILIO_ACCOUNT_SID;
  const sid = env.TWILIO_ACCOUNT_SID;
  return Boolean(productionSid && sid && sid !== productionSid);
}

/**
 * Any change to an EXISTING provider telephony resource — releasing
 * (.remove()) or reconfiguring (.update()) a number. Same rules as a
 * purchase, minus fake mode (a fake environment owns no real resource):
 * production signature → allow; mixed → block; non-production/unknown →
 * allowed only with NUMBER_PROVISIONING_MODE=live on a dedicated,
 * declared-different provider account. Everything else fails closed.
 * @returns {{ action: 'allow'|'block', environment: string, reason: string }}
 */
function decideTelephonyMutation(env = process.env, { operation = 'modify' } = {}) {
  const mode = String(env.NUMBER_PROVISIONING_MODE || 'auto').toLowerCase();
  const e = resolveEnvironment(env);
  const refuse = (why) => ({ action: 'block', environment: e.kind, reason: `refusing to ${operation} a provider number: ${why}` });
  if (mode === 'disabled') return refuse('NUMBER_PROVISIONING_MODE=disabled');
  if (mode === 'fake') return refuse('NUMBER_PROVISIONING_MODE=fake (this environment owns no real numbers)');
  if (!['auto', 'live'].includes(mode)) return refuse(`unknown NUMBER_PROVISIONING_MODE "${mode}"`);
  if (e.kind === 'production') return { action: 'allow', environment: 'production', reason: e.reason };
  if (e.kind === 'mixed' || e.kind === 'unknown') return refuse(e.reason);
  if (mode !== 'live') return refuse(`${e.reason}; non-production may only change numbers with NUMBER_PROVISIONING_MODE=live on its own provider account`);
  if (!onDedicatedNonProductionAccount(env)) return refuse(`${e.reason} is using the production provider account (or PRODUCTION_TWILIO_ACCOUNT_SID is not declared)`);
  return { action: 'allow', environment: 'nonproduction', reason: 'dedicated non-production provider account' };
}

/**
 * May this process run the number-lifecycle jobs (grace-period quarantine
 * and confirmed-quarantine release) at all? Never from a mixed or unknown
 * environment — a developer laptop running the default .env points at the
 * PRODUCTION database and would otherwise quarantine production
 * households from localhost. Production and a genuine non-production
 * environment (its own database) may run them; provider mutations inside
 * them are still gated by decideTelephonyMutation.
 * @returns {{ run: boolean, environment: string, reason: string }}
 */
function decideLifecycleJobs(env = process.env) {
  if (String(env.NUMBER_LIFECYCLE_JOBS || '').toLowerCase() === 'disabled') return { run: false, environment: resolveEnvironment(env).kind, reason: 'NUMBER_LIFECYCLE_JOBS=disabled' };
  const e = resolveEnvironment(env);
  if (e.kind === 'production' || e.kind === 'nonproduction') return { run: true, environment: e.kind, reason: e.reason };
  return { run: false, environment: e.kind, reason: `${e.reason} — number-lifecycle jobs not started` };
}

/**
 * @param {object} env - process.env-like
 * @param {{ ownedNumberCount?: number }} [facts]
 * @returns {{ action: 'purchase'|'fake'|'block', environment?: string, reason: string }}
 */
function decideNumberPurchase(env = process.env, facts = {}) {
  const mode = String(env.NUMBER_PROVISIONING_MODE || 'auto').toLowerCase();
  if (mode === 'disabled') return { action: 'block', reason: 'NUMBER_PROVISIONING_MODE=disabled' };
  if (mode === 'fake') return { action: 'fake', environment: 'fake', reason: 'NUMBER_PROVISIONING_MODE=fake (no provider call)' };
  if (!['auto', 'live'].includes(mode)) return { action: 'block', reason: `unknown NUMBER_PROVISIONING_MODE "${mode}"` };

  const e = resolveEnvironment(env);
  if (e.kind === 'production') return { action: 'purchase', environment: 'production', reason: e.reason };
  if (e.kind === 'mixed') return { action: 'block', reason: `${e.reason} — refusing to buy a number` };
  // Fail closed: an environment that cannot be identified never buys,
  // whatever mode or account it claims.
  if (e.kind === 'unknown') return { action: 'block', reason: `${e.reason} — refusing to buy a number` };

  // Non-production (or unknown, which is never trusted as production).
  if (mode !== 'live') {
    return { action: 'block', reason: 'non-production environment: numbers are not bought unless NUMBER_PROVISIONING_MODE=live on a dedicated non-production provider account (use NUMBER_PROVISIONING_MODE=fake for local testing)' };
  }
  if (!onDedicatedNonProductionAccount(env)) {
    return { action: 'block', reason: 'non-production environment is using the production provider account (or PRODUCTION_TWILIO_ACCOUNT_SID is not set): refusing to buy a number' };
  }
  const cap = Number(env.NONPRODUCTION_MAX_NUMBERS || DEFAULT_NONPRODUCTION_MAX_NUMBERS);
  if (facts.ownedNumberCount != null && facts.ownedNumberCount >= cap) {
    return { action: 'block', reason: `non-production number cap reached (${facts.ownedNumberCount}/${cap})` };
  }
  return { action: 'purchase', environment: 'nonproduction', reason: 'dedicated non-production provider account, under the number cap' };
}

// A fake UK mobile number from Ofcom's drama range, never routable.
function fakeNumber(seed = Date.now()) {
  return `+447700900${String(Math.abs(Number(seed)) % 1000).padStart(3, '0')}`;
}

module.exports = { decideNumberPurchase, decideTelephonyMutation, decideLifecycleJobs, resolveEnvironment, fakeNumber, DEFAULT_PRODUCTION_APP_HOSTS, DEFAULT_PRODUCTION_SUPABASE_REF, DEFAULT_NONPRODUCTION_MAX_NUMBERS };
