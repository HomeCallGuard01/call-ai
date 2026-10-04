// Controlled-launch acquisition gate (launch sprint 2026-10-05): the
// stop-acquisition switch and the invite-only cohort. New checkouts only.
//
// Run with: node tests/acquisition-gate.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { decideNewSubscription } = require('../services/acquisitionGate.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const hh = (email) => ({ id: 'h', email });

check(decideNewSubscription({ household: hh('a@x.co'), env: {} }).allowed === true, 'both unset → open, exactly as before');
check(decideNewSubscription({ household: hh('a@x.co'), env: { NEW_SUBSCRIPTIONS_PAUSED: 'true' } }).reason === 'new_memberships_paused', 'paused → no new paid sign-ups');
check(decideNewSubscription({ household: hh('a@x.co'), env: { NEW_SUBSCRIPTIONS_PAUSED: 'true', NEW_SUBSCRIPTIONS_ALLOWLIST: 'a@x.co' } }).reason === 'new_memberships_paused', 'pause outranks the invite list (stop means stop)');
check(decideNewSubscription({ household: hh('A@X.co '), env: { NEW_SUBSCRIPTIONS_ALLOWLIST: ' a@x.co , b@y.co' } }).allowed === true, 'invited email (case/space-insensitive) → allowed');
check(decideNewSubscription({ household: hh('c@z.co'), env: { NEW_SUBSCRIPTIONS_ALLOWLIST: 'a@x.co,b@y.co' } }).reason === 'not_invited', 'not on the invite list → refused');
check(decideNewSubscription({ household: hh(null), env: { NEW_SUBSCRIPTIONS_ALLOWLIST: 'a@x.co' } }).reason === 'not_invited', 'no email on the account → refused (never guessed)');
check(decideNewSubscription({ household: hh('a@x.co'), env: { NEW_SUBSCRIPTIONS_PAUSED: 'false', NEW_SUBSCRIPTIONS_ALLOWLIST: ' , ' } }).allowed === true, 'only the exact string "true" pauses; an empty list is open');

const root = path.join(__dirname, '..');
const web = readFileSync(path.join(root, 'routes', 'billing.js'), 'utf8');
const mobile = readFileSync(path.join(root, 'routes', 'mobileApi.js'), 'utf8');
const webRoute = web.slice(web.indexOf('router.post("/billing/create-checkout-session"'), web.indexOf('stripe.checkout.sessions.create', web.indexOf('router.post("/billing/create-checkout-session"')) > 0 ? web.indexOf('stripe.checkout.sessions.create', web.indexOf('router.post("/billing/create-checkout-session"')) : undefined);
check(/decideNewSubscription\(\{ household: req\.household \}\)/.test(webRoute) && /checkout=\$\{acquisition\.reason\}/.test(webRoute), 'web checkout: gate runs before any Stripe call, redirects with the reason');
const mobileRoute = mobile.slice(mobile.indexOf('router.post("/api/v1/billing/create-checkout-session"'));
const gateAt = mobileRoute.indexOf('decideNewSubscription({ household: req.household })');
const stripeAt = mobileRoute.indexOf('getActiveEntitlement(req.household.id)');
check(gateAt > 0 && gateAt < stripeAt && /res\.status\(403\)\.json\(\{ error: acquisition\.reason \}\)/.test(mobileRoute), 'mobile checkout: gate runs before entitlement/Stripe work, 403 with the reason');
const gateUsers = ['routes/billing.js', 'routes/mobileApi.js'];
const others = ['server.js', 'database/billing.js', 'services/twilioProvisioning.js', 'middleware/requireEntitlement.js'];
check(others.every((f) => !/acquisitionGate/.test(readFileSync(path.join(root, f), 'utf8'))) && gateUsers.length === 2, 'the gate is used only by the two new-checkout routes (no entitlement, renewal, call or provisioning path)');
const dash = readFileSync(path.join(root, 'upload.html'), 'utf8');
check(/kind === "new_memberships_paused"/.test(dash) && /kind === "not_invited"/.test(dash) && /no payment was taken/.test(dash), 'dashboard explains both refusals and says no payment was taken');

console.log(failures === 0 ? '\nAcquisition gate: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
