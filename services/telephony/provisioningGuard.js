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

  const app = hostOf(env.APP_URL);
  const productionHosts = (env.PRODUCTION_APP_HOSTS ? env.PRODUCTION_APP_HOSTS.split(',') : DEFAULT_PRODUCTION_APP_HOSTS).map((h) => h.trim().toLowerCase());
  const productionRef = env.PRODUCTION_SUPABASE_REF || DEFAULT_PRODUCTION_SUPABASE_REF;
  const onProductionHost = app.https && productionHosts.includes(app.host);
  const onProductionDb = supabaseRef(env.SUPABASE_URL) === productionRef;

  if (onProductionHost && onProductionDb) return { action: 'purchase', environment: 'production', reason: 'production signature (APP_URL host and Supabase project)' };
  if (onProductionHost !== onProductionDb) {
    return { action: 'block', reason: `mixed configuration: APP_URL ${onProductionHost ? 'is' : 'is not'} production but SUPABASE_URL ${onProductionDb ? 'is' : 'is not'} — refusing to buy a number` };
  }

  // Non-production from here on.
  const productionSid = env.PRODUCTION_TWILIO_ACCOUNT_SID;
  const sid = env.TWILIO_ACCOUNT_SID;
  if (mode !== 'live') {
    return { action: 'block', reason: 'non-production environment: numbers are not bought unless NUMBER_PROVISIONING_MODE=live on a dedicated non-production provider account (use NUMBER_PROVISIONING_MODE=fake for local testing)' };
  }
  if (!productionSid || !sid || sid === productionSid) {
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

module.exports = { decideNumberPurchase, fakeNumber, DEFAULT_PRODUCTION_APP_HOSTS, DEFAULT_PRODUCTION_SUPABASE_REF, DEFAULT_NONPRODUCTION_MAX_NUMBERS };
