// GET /api/v1/billing/eligibility (WS4, 2026-10-10): may the signed-in
// account start a new paid membership? For the apps to hide store purchase
// UI from accounts outside the invite-only cohort (store purchases never
// reach the Stripe checkout gate). Router factory, NOT mounted.
//
// Proves: the real acquisition gate drives the answer (paused / allowlist /
// open, case-insensitive), an existing member is "already_active", a read
// error fails CLOSED (503, canPurchase false), the route needs the bearer
// auth middleware, the body never contains the email or the allowlist, the
// response is not cacheable, and any server.js mount uses the real defaults.
//
// Run with: node tests/billing-eligibility.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x' });

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const { createBillingEligibilityRoutes, buildEligibility, REASONS } = require('../routes/billingEligibility.js');
const { decideNewSubscription } = require('../services/acquisitionGate.js');
const express = require('express');

// ---- pure ----
check(JSON.stringify(buildEligibility({ acquisition: { allowed: true, reason: null }, activeEntitlement: null })) === '{"canPurchase":true,"reason":null,"alreadyEntitled":false}', 'open + no entitlement → canPurchase');
check(buildEligibility({ acquisition: { allowed: true }, activeEntitlement: { id: 'e1' } }).reason === 'already_active', 'open + active entitlement → already_active');
check(buildEligibility({ acquisition: { allowed: false, reason: 'new_memberships_paused' }, activeEntitlement: null }).reason === 'new_memberships_paused', 'paused → new_memberships_paused');
check(buildEligibility({ acquisition: { allowed: false, reason: 'not_invited' }, activeEntitlement: null }).reason === 'not_invited', 'not on allowlist → not_invited');
check(buildEligibility({ acquisition: { allowed: false, reason: 'something_new' } }).reason === 'unavailable' && buildEligibility({ acquisition: null }).canPurchase === false, 'an unknown gate answer fails closed as unavailable');
check(Object.isFrozen(REASONS), 'reason codes are frozen');

// ---- route ----
let authCalls = 0;
let currentHousehold = null;
const fakeAuth = (req, res, next) => {
  authCalls++;
  if (!req.headers.authorization) return res.status(401).json({ error: 'unauthenticated' });
  req.household = currentHousehold;
  return next();
};
const entitlements = new Map();
let entitlementReadFails = false;
const entitlementReads = [];
const getActiveEntitlement = async (id) => { entitlementReads.push(id); if (entitlementReadFails) throw new Error('db down'); return entitlements.get(id) || null; };
const env = {};
const logs = [];
const app = express();
app.use(createBillingEligibilityRoutes({ requireAuthApi: fakeAuth, decideNewSubscription, getActiveEntitlement, env, log: (...a) => logs.push(a.join(' ')) }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (auth = true) => {
  const res = await fetch(`${base}/api/v1/billing/eligibility`, { headers: auth ? { authorization: 'Bearer t' } : {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text, cache: res.headers.get('cache-control') };
};

try {
  currentHousehold = { id: 'hh-invited', email: 'Invited.Person@Example.com' };
  const noAuth = await get(false);
  check(noAuth.status === 401 && authCalls === 1, 'no bearer token → 401 from the auth middleware (route requires auth)');

  let r = await get();
  check(r.status === 200 && r.body.canPurchase === true && r.body.reason === null && r.cache === 'no-store', 'gate open, no membership → canPurchase:true, no-store');

  env.NEW_SUBSCRIPTIONS_ALLOWLIST = 'someone@example.com, invited.person@example.com';
  r = await get();
  check(r.body.canPurchase === true, 'on the allowlist (case-insensitive, spaces trimmed) → canPurchase:true');
  check(!r.raw.toLowerCase().includes('invited.person') && !r.raw.includes('someone@'), 'the response never contains the account email or the allowlist');

  currentHousehold = { id: 'hh-stranger', email: 'stranger@example.com' };
  const readsBefore = entitlementReads.length;
  r = await get();
  check(r.status === 200 && r.body.canPurchase === false && r.body.reason === 'not_invited', 'not on the allowlist → not_invited');
  check(entitlementReads.length === readsBefore, '… without even reading the entitlement');

  env.NEW_SUBSCRIPTIONS_PAUSED = 'true';
  currentHousehold = { id: 'hh-invited', email: 'invited.person@example.com' };
  r = await get();
  check(r.body.canPurchase === false && r.body.reason === 'new_memberships_paused', 'stop-acquisition switch on → new_memberships_paused, even for an invitee');
  delete env.NEW_SUBSCRIPTIONS_PAUSED;

  entitlements.set('hh-invited', { id: 'ent-1', status: 'active' });
  r = await get();
  check(r.body.canPurchase === false && r.body.reason === 'already_active' && r.body.alreadyEntitled === true, 'an existing member is never told they can buy again (already_active)');
  entitlements.delete('hh-invited');

  entitlementReadFails = true;
  r = await get();
  check(r.status === 503 && r.body.canPurchase === false && r.body.reason === 'unavailable' && r.cache === 'no-store', 'entitlement unreadable → 503 canPurchase:false (fails closed, never "go ahead")');
  check(logs.some((l) => l.includes('BILLING ELIGIBILITY ERROR')) && !logs.join(' ').includes('invited.person'), 'the failure is logged without the email');
  entitlementReadFails = false;

  currentHousehold = null;
  r = await get();
  check(r.status === 503 && r.body.canPurchase === false, 'no household on the request → fails closed');

  check(Object.keys(r.body).sort().join() === 'alreadyEntitled,canPurchase,reason', 'the body has exactly canPurchase, reason, alreadyEntitled');
} finally {
  server.close();
}

// ---- wiring ----
const src = readFileSync(path.join(root, 'routes', 'billingEligibility.js'), 'utf8');
check(src.includes('require("../middleware/requireAuthApi").requireAuthApi') && src.includes('router.get("/api/v1/billing/eligibility", requireAuthApi,'), 'default wiring uses the real bearer-token middleware');
check(src.includes('require("../database/billing").getActiveEntitlementOrThrow'), 'default wiring uses the throwing entitlement read (an unreadable database is never "no membership")');
const billingDb = readFileSync(path.join(root, 'database', 'billing.js'), 'utf8');
check(/async function getActiveEntitlementOrThrow[\s\S]{0,900}if \(error\) throw new Error/.test(billingDb), 'database/billing.js getActiveEntitlementOrThrow throws on a read error');
const server_ = readFileSync(path.join(root, 'server.js'), 'utf8');
// Not mounted by WS4 (server.js is outside its files). Once the integrator
// mounts it, it must be the factory with its real defaults.
check(!server_.includes('billingEligibility') || server_.includes('app.use(require("./routes/billingEligibility").createBillingEligibilityRoutes());'), 'server.js either does not mount it yet, or mounts the factory with its real (auth + strict read) defaults');

console.log(failures === 0 ? '\nBilling eligibility: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
