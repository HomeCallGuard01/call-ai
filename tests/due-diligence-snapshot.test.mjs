// Due-diligence snapshot (2026-09-29): aggregates only, stable schema,
// missing ≠ 0, and no personal data — even though every input below is
// full of emails, phone numbers and household ids.
//
// Run with: node tests/due-diligence-snapshot.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';

const dd = require('../services/businessControl/dueDiligenceSnapshot.js');
const { computeControlOverview } = require('../services/businessControl/controlOverview.js');
const { computeSubscriptionOverview } = require('../services/businessControl/subscriptionOverview.js');
const { buildNumberInventory, resolveProductionHosts } = require('../services/businessControl/numberInventory.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const NOW = new Date('2026-09-29T12:00:00.000Z');
const DAY = 86400000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const ent = (hh, type, startsAgo, extra = {}) => ({ household_id: hh, entitlement_type: type, status: 'active', source: 'stripe', starts_at: ago(startsAgo), ends_at: null, updated_at: ago(startsAgo), ...extra });

const IDS = { g: '11111111-1111-4111-8111-111111111111', f: '22222222-2222-4222-8222-222222222222', r: '33333333-3333-4333-8333-333333333333', u: '44444444-4444-4444-8444-444444444444' };
const households = [
  { id: IDS.g, email: 'real.customer@example.com', twilio_number: '+447000000301', activation_verified_at: ago(DAY), voice_client_registered_at: ago(DAY), delivery_verified_at: ago(DAY) },
  { id: IDS.f, email: 'former.customer@example.com', twilio_number: '+447000000302', twilio_number_pending_release_at: ago(-5 * DAY) },
  { id: IDS.r, email: 'appreview@example.com', twilio_number: '+447000000303' },
  { id: IDS.u, email: 'someone@example.com', twilio_number: null },
];
const entitlements = [
  ent(IDS.g, 'paid_subscription', 10 * DAY),
  ent(IDS.f, 'paid_subscription', 40 * DAY, { status: 'revoked', updated_at: ago(20 * DAY) }),
  ent(IDS.r, 'complimentary', 30 * DAY),
  ent(IDS.u, 'paid_subscription', 50 * DAY, { status: 'expired', updated_at: ago(15 * DAY) }),
];
const classes = new Map([[IDS.g, 'genuine_customer'], [IDS.f, 'genuine_customer'], [IDS.r, 'reviewer']]);
const byHh = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.household_id)) m.set(r.household_id, []); m.get(r.household_id).push(r); } return m; };
const inventory = buildNumberInventory({
  providerNumbers: [...households.filter((h) => h.twilio_number).map((h, i) => ({ phoneNumber: h.twilio_number, sid: `PN${i}`, voiceUrl: 'https://www.homecallguard.co.uk/voice' })), { phoneNumber: '+447000000399', sid: 'PNs', voiceUrl: 'https://x.ngrok-free.dev/voice' }],
  households, entitlementsByHousehold: byHh(entitlements), subscriptionsByHousehold: new Map(), classificationMap: classes, quarantineRows: [],
  productionHosts: resolveProductionHosts({ APP_URL: 'https://www.homecallguard.co.uk' }), rental: { perNumber: 0.86917, currency: 'GBP', basis: 'b', provenance: 'ACTUAL' }, releaseRecordingAvailable: false, lastCallByHousehold: new Map(),
}, NOW);
const overview = {
  ...computeControlOverview({ households, entitlementsByHousehold: byHh(entitlements), subscriptionsByHousehold: new Map(), classificationMap: classes, quarantineRows: [], inventory, stripeRevenue: null, releaseRecordingAvailable: false }, NOW),
  inventory, stripe: { mode: 'test' }, financialSafety: { state: 'not_connected', level: null, asOf: null },
};
const subscriptions = { ...computeSubscriptionOverview({ households, entitlements, subscriptions: [], classificationMap: classes }, NOW), available: true };
const calls = [
  { status: 'Known', result: 'SAFE', dial_call_status: 'completed', terminated_by_system: false },
  { status: 'Unknown', result: 'SCAM', dial_call_status: null, terminated_by_system: true },
  { status: 'Unknown', result: 'SAFE', dial_call_status: 'failed', terminated_by_system: false },
  { status: 'Known', result: 'SAFE', dial_call_status: 'no-answer', terminated_by_system: false },
];

const snap = dd.buildDueDiligenceSnapshot({ overview, subscriptions, calls, month: '2026-09', now: NOW });

// ---------- content ----------
check(snap.customers.genuinePayingNow === 1 && snap.customers.genuineEverPaid === 2 && snap.customers.genuineFormerPaying === 1 && snap.customers.paidButUnclassified === 1, 'customers: paying now 1 · ever paid 2 · former 1 · paid-but-unclassified 1');
check(snap.customers.entitledHouseholds === 2 && snap.customers.testReviewerAccounts.reviewer === 1 && snap.customers.protected === 1, 'customers: entitled 2, reviewer 1, protected 1');
check(snap.numbers.onProviderAccount === 4 && snap.numbers.activeCustomer === 1 && snap.numbers.stagingOrInternal === 1 && snap.numbers.byCategory.reviewer.count === 1 && snap.numbers.byCategory.customer_cancelled_grace.count === 1, 'numbers: 4 on the account — 1 active customer, 1 cancelled in grace, 1 reviewer, 1 staging');
check(snap.calls.total === 4 && snap.calls.unknownBlocked === 1 && snap.calls.endedByHcg === 1 && snap.calls.deliveryFailed === 1 && snap.calls.deliveryUnanswered === 1 && snap.calls.deliveryNotRecorded === 1, 'calls: volumes, blocked, ended by HCG, delivery failed / unanswered / not recorded');
check(snap.finance.stripeMode === 'test' && snap.finance.genuineMrrGbp === null && snap.finance.spendSafety.state === 'not_connected', 'finance: test-mode Stripe gives no revenue figure (null, not £0); spend safety not connected');
check(/point in time/.test(snap.basis.customersAndNumbers) && /2026-09/.test(snap.basis.calls), 'the snapshot states what is point-in-time and what is for the month');

// ---------- privacy ----------
const json = JSON.stringify(snap);
check(!/example\.com/.test(json) && !/\+4470000003/.test(json) && !Object.values(IDS).some((id) => json.includes(id)), 'no email, HCG number or household id from the inputs appears in the snapshot');
check(dd.findPrivacyLeaks(snap).length === 0, 'privacy scan: clean');
check(dd.findPrivacyLeaks({ a: 'x@y.co' }).length === 1 && dd.findPrivacyLeaks({ a: '+44 7700 900123' }).length === 1 && dd.findPrivacyLeaks({ [IDS.g]: 1 }).length === 1 && dd.findPrivacyLeaks({ t: '2026-09-29T12:00:00.000Z', n: 12 }).length === 0, 'privacy scan catches emails, phone numbers and ids (even as keys), not timestamps');
const md = dd.renderSnapshotMarkdown(snap);
check(dd.findPrivacyLeaks({ md }).length === 0 && /Genuine paying now: 1 · ever paid: 2 · former paying: 1/.test(md) && /genuine MRR not connected/.test(md), 'markdown summary: same figures, no personal data, "not connected" wording');

// ---------- missing ≠ 0 ----------
const empty = dd.buildDueDiligenceSnapshot({ overview: null, subscriptions: null, calls: null, month: '2026-09', now: NOW });
check(empty.customers.genuinePayingNow === null && empty.customers.entitledHouseholds === null && empty.calls === null && empty.numbers.unavailable && empty.finance.spendSafety.state === 'not_connected', 'no sources → nulls / "not connected", never 0');
check(/not connected/.test(dd.renderSnapshotMarkdown(empty)) && !/: 0\b/.test(dd.renderSnapshotMarkdown(empty)), 'markdown with no sources says "not connected", never 0');

// ---------- stable schema ----------
check(snap.schemaVersion === '1.0' && Object.keys(snap).join() === 'schemaVersion,product,generatedAt,period,basis,customers,numbers,calls,finance,checks,definitions', 'top-level schema pinned (a change must bump schemaVersion)');
check(Object.keys(snap.customers).join() === 'entitledHouseholds,genuinePayingNow,genuineEverPaid,genuineFormerPaying,paidButUnclassified,complimentaryWithAccess,trialWithAccess,testReviewerAccounts,testReviewerWithAccess,unclassifiedWithAccess,protected,entitledNotProtected,cancelled,expired,deletedAccounts,churn30d', 'customer section keys pinned');
check(dd.monthBounds('2026-09').start === '2026-09-01T00:00:00.000Z' && dd.monthBounds('2026-12').end === '2027-01-01T00:00:00.000Z' && dd.monthBounds('Sept') === null, 'month bounds (UTC), invalid month refused');

// ---------- route ----------
const route = readFileSync(path.join(__dirname, '..', 'routes', 'adminBusinessControl.js'), 'utf8');
check(/router\.get\("\/admin\/api\/business-control\/snapshot", requireAuth, requireAdmin,/.test(route) && !/router\.(post|put|patch|delete)\(/.test(route), 'snapshot route: GET only, admin only');
const svc = readFileSync(path.join(__dirname, '..', 'services', 'businessControl', 'dueDiligenceSnapshot.js'), 'utf8');
check(/findPrivacyLeaks\(snapshot\)/.test(svc) && /snapshot refused/.test(svc), 'the loader refuses to return a snapshot that fails the privacy scan');
check(!/\.(insert|update|upsert|delete|rpc)\(/.test(svc), 'the snapshot service only reads');

console.log(failures === 0 ? '\nAll due-diligence snapshot checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
