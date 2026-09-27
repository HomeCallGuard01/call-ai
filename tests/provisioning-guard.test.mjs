// Tests for services/telephony/provisioningGuard.js and its hook in
// ensureTwilioNumberProvisioned: a staging or local server must never buy a
// real number on the production provider account (the 2026-09-27 finding:
// 7 of 19 billed numbers belonged to staging households).
//
// Run with: node tests/provisioning-guard.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideNumberPurchase, fakeNumber } = require('../services/telephony/provisioningGuard.js');
const { ensureTwilioNumberProvisioned } = require('../services/twilioProvisioning.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const PROD_SUPABASE = 'https://psbzynxplxfbyrbdidmn.supabase.co';
const STAGING_SUPABASE = 'https://tigwgmayeuisrxjjykqd.supabase.co';
const PROD_SID = 'AC_production_example';

// ---------- decisions ----------
check(decideNumberPurchase({ APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: PROD_SUPABASE }).action === 'purchase',
  'production signature (production host + production Supabase) buys numbers with no new configuration');
check(decideNumberPurchase({ APP_URL: 'https://homecallguard.co.uk', SUPABASE_URL: PROD_SUPABASE }).action === 'purchase', 'apex production host is recognised too');
const ngrok = decideNumberPurchase({ APP_URL: 'https://ferret-example.ngrok-free.dev', SUPABASE_URL: STAGING_SUPABASE, TWILIO_ACCOUNT_SID: PROD_SID });
check(ngrok.action === 'block', 'the real 2026-09 case — ngrok APP_URL + staging Supabase on the production Twilio account — is blocked');
check(decideNumberPurchase({ APP_URL: 'http://localhost:3000', SUPABASE_URL: STAGING_SUPABASE }).action === 'block', 'localhost is blocked');
check(decideNumberPurchase({ APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: STAGING_SUPABASE }).action === 'block',
  'mixed configuration (production host, staging database) is blocked');
check(decideNumberPurchase({ APP_URL: 'https://ferret-example.ngrok-free.dev', SUPABASE_URL: PROD_SUPABASE }).action === 'block',
  'mixed configuration (dev host, production database) is blocked');
check(decideNumberPurchase({ APP_URL: 'http://www.homecallguard.co.uk', SUPABASE_URL: PROD_SUPABASE }).action === 'block', 'a non-https production host is not treated as production');
check(decideNumberPurchase({ NUMBER_PROVISIONING_MODE: 'fake', APP_URL: 'http://localhost:3000' }).action === 'fake', 'fake mode never calls the provider');
check(decideNumberPurchase({ NUMBER_PROVISIONING_MODE: 'disabled', APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: PROD_SUPABASE }).action === 'block',
  'disabled mode blocks even in production');
check(decideNumberPurchase({ NUMBER_PROVISIONING_MODE: 'yes-please' }).action === 'block', 'an unknown mode is blocked, not treated as live');
const liveOnProdAccount = { NUMBER_PROVISIONING_MODE: 'live', APP_URL: 'https://staging.example', SUPABASE_URL: STAGING_SUPABASE, TWILIO_ACCOUNT_SID: PROD_SID, PRODUCTION_TWILIO_ACCOUNT_SID: PROD_SID };
check(decideNumberPurchase(liveOnProdAccount).action === 'block', 'NUMBER_PROVISIONING_MODE=live cannot buy on the production provider account from non-production');
check(decideNumberPurchase({ ...liveOnProdAccount, PRODUCTION_TWILIO_ACCOUNT_SID: undefined }).action === 'block',
  'non-production live mode is blocked when the production account SID is not declared (cannot prove it is a different account)');
const subaccount = { ...liveOnProdAccount, TWILIO_ACCOUNT_SID: 'AC_staging_subaccount' };
check(decideNumberPurchase(subaccount).action === 'purchase' && decideNumberPurchase(subaccount).environment === 'nonproduction',
  'a dedicated non-production sub-account with explicit live mode may buy');
check(decideNumberPurchase(subaccount, { ownedNumberCount: 3 }).action === 'block', 'the non-production number cap (default 3) blocks further purchases');
check(decideNumberPurchase({ ...subaccount, NONPRODUCTION_MAX_NUMBERS: '5' }, { ownedNumberCount: 3 }).action === 'purchase', 'the cap is configurable');
check(/^\+447700900\d{3}$/.test(fakeNumber(123456)), 'fake numbers come from Ofcom\'s drama range (+44 7700 900xxx)');

// ---------- hook in ensureTwilioNumberProvisioned ----------
function fakeClient() {
  const calls = [];
  return {
    calls,
    availablePhoneNumbers: () => ({ local: { list: async () => { calls.push('search'); return [{ phoneNumber: '+441700000001' }]; } } }),
    incomingPhoneNumbers: Object.assign((sid) => ({ remove: async () => calls.push(`remove:${sid}`) }), {
      create: async () => { calls.push('create'); return { sid: 'PN_new', phoneNumber: '+441700000001' }; },
      list: async () => { calls.push('list'); return [{}, {}, {}]; },
    }),
  };
}
const household = { id: 'hh-guard', twilio_provisioning_attempts: 0 };

{
  const client = fakeClient();
  const failures_ = [];
  const r = await ensureTwilioNumberProvisioned(household, {
    client, enforceGuard: true,
    guardEnv: { APP_URL: 'https://ferret-example.ngrok-free.dev', SUPABASE_URL: STAGING_SUPABASE, TWILIO_ACCOUNT_SID: PROD_SID },
    assign: async () => { throw new Error('must not assign'); },
    recordFailure: async (id, msg) => { failures_.push(msg); },
    sendAlert: async () => {},
  });
  check(r.blocked === true && client.calls.length === 0, 'blocked environment: no number search, no purchase — the provider is never called');
  check(failures_.length === 1 && /provisioning blocked/.test(failures_[0]), 'a blocked purchase is recorded as a provisioning failure (the attempt limit then stops retries)');
}
{
  const client = fakeClient();
  const assigned = [];
  const r = await ensureTwilioNumberProvisioned(household, {
    client, enforceGuard: true,
    guardEnv: { APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: PROD_SUPABASE },
    assign: async (id, n) => { assigned.push(n); return true; },
    recordFailure: async () => {}, sendAlert: async () => {},
    appUrl: 'https://www.homecallguard.co.uk',
  });
  check(r.success === true && client.calls.includes('create') && assigned[0] === '+441700000001', 'production signature: the number is bought and assigned exactly as before');
}
{
  const client = fakeClient();
  const assigned = [];
  const r = await ensureTwilioNumberProvisioned(household, {
    client, enforceGuard: true,
    guardEnv: { NUMBER_PROVISIONING_MODE: 'fake', APP_URL: 'http://localhost:3000' },
    assign: async (id, n) => { assigned.push(n); return true; },
    recordFailure: async () => {}, sendAlert: async () => {},
  });
  check(r.fake === true && client.calls.length === 0 && /^\+447700900\d{3}$/.test(assigned[0]), 'fake mode assigns a drama-range number with no provider call');
}
{
  const client = fakeClient();
  const r = await ensureTwilioNumberProvisioned(household, {
    client, enforceGuard: true,
    guardEnv: { ...subaccount },
    assign: async () => true, recordFailure: async () => {}, sendAlert: async () => {},
  });
  check(r.blocked === true && client.calls.includes('list') && !client.calls.includes('create'),
    'non-production sub-account at its number cap: counts owned numbers, then refuses to buy');
}

{
  const alerts = [];
  const r = await ensureTwilioNumberProvisioned(household, {
    client: fakeClient(), enforceGuard: true,
    guardEnv: { NODE_ENV: 'production', APP_URL: 'https://some-preview.up.railway.app', SUPABASE_URL: PROD_SUPABASE },
    assign: async () => true, recordFailure: async () => {}, sendAlert: async (type) => { alerts.push(type); },
  });
  check(r.blocked === true && alerts.includes('twilio_provisioning_blocked_by_guard'),
    'a NODE_ENV=production process that fails the production signature raises a critical alert (a misconfigured production would never silently skip numbers)');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
