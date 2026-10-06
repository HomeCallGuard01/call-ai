// Canonical customer protection (soft-launch integration 2026-10-04, brief §6
// B7). ONE definition — services/lifecycle/activationState.js — now decides
// the customer-facing `fullyProtected` on web and mobile, via
// services/lifecycle/canonicalProtection.js. A customer must NOT be shown
// protected when not entitled, financially held, routing number inactive or
// quarantined, forwarding/delivery evidence belongs to an old number, app
// unreachable, or the state cannot be established.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { resolveCanonicalProtection, mergeProtection } = require('../services/lifecycle/canonicalProtection');
const { buildCustomerProtectionSteps } = require('../services/customerProtectionSteps');
const { computeProtectionStatus } = require('../services/callRouting');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const NOW = new Date('2026-10-04T12:00:00Z');
const iso = (d) => new Date(NOW.getTime() - d * 86400e3).toISOString();

const HH = {
  id: 'hh-canon', status: 'active', email: 'c@example.com', auth_user_id: 'auth-c', stripe_customer_id: 'cus_c',
  twilio_number: '+441234567890', twilio_provisioning_status: 'active',
  activation_verified_at: iso(5), forwarding_proven_at: iso(5), delivery_verified_at: iso(4), voice_client_registered_at: iso(3),
};
const ENT = { id: 'e1', household_id: HH.id, entitlement_type: 'paid_subscription', status: 'active', starts_at: iso(20), ends_at: null, source: 'stripe' };
const base = { household: HH, entitlements: [ENT], subscription: null, quarantineRows: [], financialHold: null, currentNumberAssignedAt: iso(10), failedStripeEvents: [] };
const resolve = (snapOver = {}, { hh = {}, deliveryHealth = null, loader = null } = {}) => {
  const household = { ...HH, ...hh };
  const snap = { ...base, ...snapOver, household };
  return resolveCanonicalProtection({ supabase: {}, household, deliveryHealth, now: NOW, log: () => {}, loadSnapshots: loader || (async () => ({ snapshots: [snap] })) });
};

// ── Fully protected baseline ─────────────────────────────────────────────
{
  const { protection, activation } = await resolve();
  check(protection.fullyProtected === true && activation.stage === 'protected' && protection.protectionBlockers.length === 0, 'baseline: every gate satisfied → protected');
  check(['forwardingVerified', 'deliveryReady', 'endToEndDeliveryVerified', 'fullyProtected'].every((k) => typeof protection[k] === 'boolean'), 'backward-compatible shape: all four legacy booleans present');
}

// ── Every way a customer must NOT be shown protected ─────────────────────
const cases = [
  ['not entitled (membership ended)', { entitlements: [{ ...ENT, status: 'expired', ends_at: iso(1) }] }, {}, 'entitledNow'],
  ['no entitlement ever', { entitlements: [] }, {}, 'entitledNow'],
  ['Fortress financial hold', { financialHold: { held: true, source: 'financial', reason: 'spend anomaly', heldAt: iso(0) } }, {}, 'notOnHold'],
  ['hold table unreadable (fail closed)', { financialHold: { unreadable: true } }, {}, 'stateKnown'],
  ['routing number not active', {}, { twilio_provisioning_status: 'pending' }, 'numberActive'],
  ['no routing number', {}, { twilio_number: null }, 'numberActive'],
  ['routing number quarantined', { quarantineRows: [{ id: 'q1', household_id: HH.id, twilio_number: HH.twilio_number, quarantined_at: iso(1), released_at: null }] }, {}, 'numberNotQuarantined'],
  ['forwarding + delivery proof belong to the OLD number', { currentNumberAssignedAt: iso(1) }, {}, 'forwardingVerifiedForCurrentNumber'],
  ['app never registered', {}, { voice_client_registered_at: null }, 'appReachable'],
  ['never a delivered call', {}, { delivery_verified_at: null }, 'deliveryVerifiedForCurrentNumber'],
  ['account deleted/anonymised', {}, { status: 'cancelled', auth_user_id: null, email: 'anonymized-x@deleted.homecallguard.internal' }, 'accountActive'],
];
for (const [name, snapOver, hh, gate] of cases) {
  const { protection } = await resolve(snapOver, { hh });
  check(protection.fullyProtected === false && protection.protectionBlockers.includes(gate), `${name} → NOT protected (blocker ${gate})`);
}
{
  const { protection } = await resolve({}, { deliveryHealth: { state: 'UNREACHABLE' } });
  check(protection.fullyProtected === false && protection.deliveryReady === false, 'delivery health UNREACHABLE → NOT protected');
  const legacyHeld = computeProtectionStatus(HH, NOW, null);
  const held = await resolve({ financialHold: { held: true, source: 'admin', reason: 'x', heldAt: iso(0) } });
  check(legacyHeld.fullyProtected === true && held.protection.fullyProtected === false, 'REGRESSION GUARD: the old rule said "protected" for a held household; the canonical one does not');
  const old = await resolve({ currentNumberAssignedAt: iso(1) });
  check(old.protection.forwardingVerified === false && old.protection.endToEndDeliveryVerified === false, 'old-number proof no longer counts as forwarding/delivery verified (customer is led back to set up the new number)');
}

// ── Fail closed when the facts cannot be loaded ──────────────────────────
{
  const thrown = await resolve({}, { loader: async () => { throw new Error('db down'); } });
  check(thrown.protection.fullyProtected === false && thrown.protection.activationStage === 'unavailable' && thrown.activation === null, 'lifecycle facts unreadable → NOT protected (never a guess)');
  const missing = await resolve({}, { loader: async () => ({ snapshots: [] }) });
  check(missing.protection.fullyProtected === false, 'household snapshot missing → NOT protected');
  const wrong = await resolve({}, { loader: async () => ({ snapshots: [{ ...base, household: { ...HH, id: 'someone-else' } }] }) });
  check(wrong.protection.fullyProtected === false, "another household's snapshot is never used");
}

// ── mergeProtection can only NARROW the legacy answer ────────────────────
{
  const legacyNo = { forwardingVerified: false, deliveryReady: false, endToEndDeliveryVerified: false, fullyProtected: false };
  const actYes = { protected: true, stage: 'protected', blockers: [], gates: { forwardingVerifiedForCurrentNumber: true, deliveryVerifiedForCurrentNumber: true } };
  const m = mergeProtection(legacyNo, actYes);
  check(m.fullyProtected === false && m.forwardingVerified === false && m.endToEndDeliveryVerified === false, 'canonical can never turn a legacy "no" into "yes"');
}

// ── Checklist "Protection Active" always agrees with fullyProtected ──────
for (const [name, snapOver, hh] of [['protected', {}, {}], ['held', { financialHold: { held: true, source: 'admin', reason: 'x', heldAt: iso(0) } }, {}], ['quarantined', { quarantineRows: [{ twilio_number: HH.twilio_number, released_at: null }] }, {}]]) {
  const { protection } = await resolve(snapOver, { hh });
  const steps = buildCustomerProtectionSteps({ ...HH, ...hh }, NOW, null, protection);
  check(steps.steps.find((s) => s.key === 'protection_active').done === protection.fullyProtected, `checklist "Protection Active" = fullyProtected (${name})`);
}
check(buildCustomerProtectionSteps(HH, NOW, null).steps.length === 5, 'steps builder without the canonical argument keeps its previous behaviour');

// ── Every customer surface uses the canonical status ─────────────────────
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const mobileApi = readFileSync(path.join(ROOT, 'routes/mobileApi.js'), 'utf8');
const dashData = server.slice(server.indexOf('app.get("/dashboard-data"'), server.indexOf('res.json({', server.indexOf('app.get("/dashboard-data"')));
check(/resolveCanonicalProtection\(\{ supabase: supabaseAdmin, household: req\.household, deliveryHealth/.test(dashData) && !/computeProtectionStatus\(/.test(dashData), 'web /dashboard-data → canonical status only');
const meDash = mobileApi.slice(mobileApi.indexOf('"/api/v1/me/dashboard"'), mobileApi.indexOf('res.json({', mobileApi.indexOf('"/api/v1/me/dashboard"')));
check(/resolveCanonicalProtection\(/.test(meDash) && !/computeProtectionStatus\(/.test(meDash) && /buildCustomerProtectionSteps\(req\.household, new Date\(\), deliveryHealth, protectionStatus\)/.test(meDash), 'mobile /api/v1/me/dashboard → canonical status + checklist from it');
const vStart = mobileApi.indexOf('router.post("/api/v1/activation/verify"'); const verify = mobileApi.slice(vStart, mobileApi.indexOf('\n});', vStart));
check(/resolveCanonicalProtection\(/.test(verify) && /getHouseholdDeliveryHealth/.test(verify) && !/computeProtectionStatus\(/.test(verify), 'mobile /api/v1/activation/verify → canonical status with delivery health (P-5)');
const account = readFileSync(path.join(ROOT, 'mobile/app/(tabs)/account/index.tsx'), 'utf8');
check(/setIsProtected\(result\.protection\.fullyProtected === true\)/.test(account) && !/setIsProtected\(hasProvenActivation/.test(account), 'mobile Account tab "Protected" = server fullyProtected (P-4), not the setup-done rule');

console.log(failures === 0 ? '\nCanonical protection: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
