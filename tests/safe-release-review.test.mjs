// Safe number-release review — PROTOTYPE, NOT WIRED (2026-09-29).
// Proves: every ambiguous or unsafe state is a blocker; confirmations
// are only offered with zero blockers; the page cannot release anything.
//
// Run with: node tests/safe-release-review.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';

const { evaluateReleaseReadiness, validateReleaseConfirmations } = require('../services/numberLifecycle/releaseReadiness.js');
const { buildNumberInventory, resolveProductionHosts } = require('../services/businessControl/numberInventory.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const NOW = new Date('2026-09-29T12:00:00.000Z');
const DAY = 86400000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const ent = (type, startsAgo, extra = {}) => ({ entitlement_type: type, status: 'active', source: 'stripe', starts_at: ago(startsAgo), ends_at: null, updated_at: ago(startsAgo), ...extra });
const V = 'https://www.homecallguard.co.uk/voice';
const n = (i) => `+4470000002${String(i).padStart(2, '0')}`;

const households = [
  { id: 'act', email: 'act@x', twilio_number: n(1) },
  { id: 'grace', email: 'grace@x', twilio_number: n(2), twilio_number_pending_release_at: ago(-10 * DAY) },
  { id: 'due', email: 'due@x', twilio_number: n(3), twilio_number_pending_release_at: ago(3 * DAY) },
  { id: 'recent', email: 'recent@x', twilio_number: n(4), twilio_number_pending_release_at: ago(3 * DAY) },
  { id: 'unc', email: 'unc@x', twilio_number: n(5), twilio_number_pending_release_at: ago(3 * DAY) },
  { id: 'outside', email: 'outside@x', twilio_number: n(6) },
  { id: 'weird', email: 'weird@x', twilio_number: n(7), twilio_number_pending_release_at: ago(3 * DAY) },
  { id: 'qh', email: 'qh@x', twilio_number: null },
];
const entitlements = new Map([
  ['act', [ent('paid_subscription', 20 * DAY)]],
  ['grace', [ent('paid_subscription', 60 * DAY, { status: 'revoked', updated_at: ago(20 * DAY) })]],
  ['due', [ent('paid_subscription', 90 * DAY, { status: 'revoked', updated_at: ago(33 * DAY) })]],
  ['recent', [ent('paid_subscription', 90 * DAY, { status: 'revoked', updated_at: ago(33 * DAY) })]],
  ['unc', []], ['outside', []],
  ['weird', [{ status: 'paused', starts_at: ago(DAY), entitlement_type: 'paid_subscription' }]],
  ['qh', [ent('paid_subscription', 90 * DAY, { status: 'revoked', updated_at: ago(40 * DAY) })]],
]);
const classes = new Map([['act', 'genuine_customer'], ['grace', 'genuine_customer'], ['due', 'genuine_customer'], ['recent', 'genuine_customer'], ['outside', 'genuine_customer'], ['weird', 'genuine_customer'], ['qh', 'genuine_customer']]);
const provider = [
  ...households.filter((h) => h.twilio_number).map((h, i) => ({ phoneNumber: h.twilio_number, sid: `PN_${h.id}`, voiceUrl: V })),
  { phoneNumber: n(20), sid: 'PN_staging', voiceUrl: 'https://x.ngrok-free.dev/voice' },
  { phoneNumber: n(21), sid: 'PN_orphan', voiceUrl: null },
  { phoneNumber: n(22), sid: 'PN_quar', voiceUrl: V },
  { phoneNumber: n(23), sid: 'PN_quar_confirmed', voiceUrl: V },
];
const quarantine = [
  { household_id: 'qh', twilio_number: n(22), deactivation_confirmed: false, quarantined_at: ago(20 * DAY), released_at: null, release_reason: 'subscription_grace_expired' },
  { household_id: null, twilio_number: n(23), deactivation_confirmed: true, deactivation_confirmed_at: ago(DAY), quarantined_at: ago(30 * DAY), released_at: null, release_reason: 'account_deletion' },
];
const lastCall = new Map([['due', ago(40 * DAY)], ['recent', ago(3 * DAY)], ['qh', ago(30 * DAY)]]);
const inv = buildNumberInventory({ providerNumbers: provider, households, entitlementsByHousehold: entitlements, subscriptionsByHousehold: new Map(), classificationMap: classes, quarantineRows: quarantine,
  productionHosts: resolveProductionHosts({ APP_URL: 'https://www.homecallguard.co.uk' }), rental: null, releaseRecordingAvailable: false, lastCallByHousehold: lastCall }, NOW);
const bySid = (sid) => inv.rows.find((r) => r.sid === sid).releaseReview;
const codes = (sid) => bySid(sid).blockers.map((b) => b.code);

// ---------- blockers ----------
check(codes('PN_act').includes('ENTITLED'), 'active customer → blocked: ENTITLED (047 would refuse)');
check(codes('PN_grace').includes('GRACE_PERIOD'), 'cancelled customer in grace → blocked until the grace period ends');
check(codes('PN_recent').join() === 'RECENT_INBOUND_CALL', 'inbound call 3 days ago → blocked (forwarding may still point here)');
check(codes('PN_unc').includes('UNCLASSIFIED_HOLDER'), 'unclassified holder → blocked (classify first)');
check(codes('PN_outside').includes('NOT_IN_LIFECYCLE'), 'no release scheduled → blocked: the lifecycle schedules releases, not this screen');
check(codes('PN_weird').includes('AMBIGUOUS_STATE') && codes('PN_weird').includes('ENTITLED'), 'unknown entitlement status → blocked as AMBIGUOUS (and fail-closed entitled)');
check(codes('PN_staging').includes('STAGING_NUMBER') && codes('PN_staging').includes('CALLS_UNKNOWN'), 'staging number → blocked (separate owner-approved cleanup); calls unknown');
check(codes('PN_orphan').includes('ORPHAN_NUMBER') && codes('PN_orphan').includes('CALLS_UNKNOWN'), 'orphan → blocked; inbound calls cannot be ruled out');
check(codes('PN_quar_confirmed').join() === 'CALLS_UNKNOWN', 'quarantined number of a deleted account → blocked until the provider call log is checked (HCG has no record)');
check(inv.rows.every((r) => r.releaseReview.wired === false), 'every review says wired: false');

// ---------- reviewable ----------
const due = bySid('PN_due');
check(due.reviewable && due.blockers.length === 0 && due.confirmations.map((c) => c.id).join() === 'typed_last4,calls_checked,reason', 'genuine former customer, release overdue, last call 40 days ago → reviewable; confirmations: type digits, calls checked, reason');
const q = bySid('PN_quar');
check(q.reviewable && q.confirmations.some((c) => c.id === 'forwarding_removed'), 'quarantined (unconfirmed) former customer, no recent calls → reviewable, and must confirm carrier forwarding is removed');
check(due.evidence.classification === 'genuine' && due.evidence.pendingReleaseAt && due.evidence.lastInboundCall && due.evidence.household === 'due@x' && due.evidence.membershipEndedAt, 'evidence shows household, classification, membership end, release date, last inbound call');
check(!JSON.stringify(inv).includes('+4470000002'), 'the review never exposes a full number (last four only)');

// ---------- stale view ----------
check(evaluateReleaseReadiness(inv.rows[0], { now: NOW, generatedAt: ago(11 * 60000) }).blockers.some((b) => b.code === 'STALE_VIEW'), 'a view generated 11 minutes ago is blocked (reload first)');
check(evaluateReleaseReadiness(inv.rows[0], { now: NOW }).blockers.some((b) => b.code === 'STALE_VIEW'), 'no timestamp → blocked, never assumed fresh');

// ---------- confirmations (server) ----------
const last4 = due.confirmations[0].expect;
check(!validateReleaseConfirmations(due, { typed_last4: '9999', calls_checked: true, reason: 'customer cancelled 33 days ago' }).ok, 'wrong digits → refused');
check(!validateReleaseConfirmations(due, { typed_last4: last4, calls_checked: false, reason: 'customer cancelled 33 days ago' }).ok, 'unticked confirmation → refused');
check(!validateReleaseConfirmations(due, { typed_last4: last4, calls_checked: true, reason: 'short' }).ok, 'short reason → refused');
const all = validateReleaseConfirmations(due, { typed_last4: last4, calls_checked: true, reason: 'customer cancelled 33 days ago' });
check(all.ok && /NOT wired/.test(all.message), 'complete → "all checks complete; NOT wired — nothing will happen"');
check(!validateReleaseConfirmations(bySid('PN_act'), { typed_last4: 'x', calls_checked: true, reason: 'x'.repeat(20) }).ok, 'a blocked review can never validate');

// ---------- UI ----------
const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
const x = (name) => { const a = html.indexOf(`// TEST-EXTRACT-START: ${name}`); const b = html.indexOf(`// TEST-EXTRACT-END: ${name}`); return html.slice(a, b); };
const ui = new Function('document', 'fetch', 'window', 'fmtNum', `${x('customerMonitorHelpers')}\n${x('fmtDateTime')}\n${x('businessControlTabs')}\nreturn { renderReleaseReviewHtml, releaseChecklistStatus, releaseReviewBlockers };`)({ getElementById: () => null }, async () => ({}), {}, String);
for (const answers of [
  { typed_last4: last4, calls_checked: true, reason: 'customer cancelled 33 days ago' },
  { typed_last4: '0000', calls_checked: true, reason: 'customer cancelled 33 days ago' },
  { typed_last4: last4, calls_checked: false, reason: 'customer cancelled 33 days ago' },
  { typed_last4: last4, calls_checked: true, reason: 'short' },
]) check(ui.releaseChecklistStatus(due, answers).ok === validateReleaseConfirmations(due, answers).ok, `client checklist matches the server rule (${JSON.stringify(answers).slice(0, 60)}…)`);
const row = inv.rows.find((r) => r.sid === 'PN_due');
const fresh = ui.renderReleaseReviewHtml(row, NOW.toISOString(), NOW.getTime());
check(/<button[^>]*disabled[^>]*>Release number \(not available\)<\/button>/.test(fresh) && fresh.includes('PROTOTYPE') && fresh.includes('rr_typed_last4'), 'panel: evidence + confirmations, final button permanently disabled, labelled prototype');
const stale = ui.renderReleaseReviewHtml(row, ago(20 * 60000), NOW.getTime());
check(stale.includes('Blocked (1)') && !stale.includes('rr_typed_last4'), 'panel: a stale page shows the blocker and no confirmation inputs (client re-checks age)');
const evil = '"><img src=x onerror=alert(1)>';
const hostile = ui.renderReleaseReviewHtml({ ...row, releaseReview: { ...row.releaseReview, blockers: [{ code: 'X', text: evil }], evidence: { ...row.releaseReview.evidence, household: evil } } }, NOW.toISOString(), NOW.getTime());
check(!hostile.includes('<img') && hostile.includes('&lt;img'), 'panel escapes evidence and blocker text');
const reviewCode = x('businessControlTabs').slice(x('businessControlTabs').indexOf('// Safe number-release review'), x('businessControlTabs').indexOf('function inventoryHtml('));
check(!/fetch\(|method\s*:|confirm-deactivation|\.remove\(/.test(reviewCode), 'the review UI makes no request at all — it cannot release or confirm anything');
const routes = readFileSync(path.join(__dirname, '..', 'routes', 'adminBusinessControl.js'), 'utf8');
check(!/router\.(post|put|patch|delete)\(/.test(routes), 'no write route exists behind the Numbers tab');

console.log(failures === 0 ? '\nAll safe release review checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
