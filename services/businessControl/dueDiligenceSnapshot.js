// Monthly operational snapshot for due diligence (2026-09-29). READ-ONLY.
//
// A stable, machine-readable JSON (schemaVersion) plus a human-readable
// Markdown summary. Aggregates only: no email, no phone number, no
// household id — enforced by findPrivacyLeaks() before anything is
// returned (a leak makes the snapshot refuse, not redact silently).
//
// Honesty rules:
//   - customer and number figures are POINT-IN-TIME (when generated);
//     only call volumes are for the requested month. The snapshot says so.
//   - missing sources are null with a reason, never 0 (same rule as Money);
//   - definitions travel with the numbers.
// Archiving a snapshot each month (so a buyer gets a time series) needs a
// storage decision; not built — download and keep the file for now.
'use strict';

const SCHEMA_VERSION = '1.0';

const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;
const PHONE_RE = /\+?\d[\d\s-]{9,}\d/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Pure. Every string value (and key) in the object, checked.
function findPrivacyLeaks(obj, pathSoFar = '$') {
  const leaks = [];
  const visit = (v, p) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (EMAIL_RE.test(v)) leaks.push(`${p}: email-like value`);
      if (UUID_RE.test(v)) leaks.push(`${p}: identifier-like value`);
      else if (PHONE_RE.test(v.replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, ''))) leaks.push(`${p}: phone-like value`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${p}[${i}]`)); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { visit(k, `${p}.<key>`); visit(x, `${p}.${k}`); }
  };
  visit(obj, pathSoFar);
  return leaks;
}

function cardValue(overview, id) {
  const c = overview && overview.cards ? overview.cards.find((x) => x.id === id) : null;
  return c && typeof c.value === 'number' ? c.value : null;
}

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return null;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

// Pure. Calls rows: { status, result, dial_call_status, terminated_by_system }.
function summariseCalls(rows) {
  if (!rows) return null;
  const count = (f) => rows.filter(f).length;
  return {
    total: rows.length,
    knownContact: count((c) => c.status === 'Known'),
    unknownCaller: count((c) => c.status === 'Unknown'),
    unknownBlocked: count((c) => c.status === 'Unknown' && c.result === 'SCAM'),
    endedByHcg: count((c) => !!c.terminated_by_system),
    deliveryFailed: count((c) => c.dial_call_status === 'failed'),
    deliveryUnanswered: count((c) => c.dial_call_status === 'no-answer' || c.dial_call_status === 'busy'),
    deliveryNotRecorded: count((c) => !c.dial_call_status),
  };
}

/**
 * Pure.
 * @param {{ overview, subscriptions, calls, month, now }} input
 *   overview: getControlOverview() payload; subscriptions: getSubscriptionOverview();
 *   calls: rows for the month (or null if unavailable).
 */
function buildDueDiligenceSnapshot({ overview, subscriptions, calls, month, now }) {
  const sub = subscriptions && subscriptions.counts ? subscriptions.counts : null;
  const ph = sub && sub.paymentHistory ? sub.paymentHistory : null;
  const inv = overview && overview.inventory ? overview.inventory : null;
  const cat = (key) => (inv && inv.byCategory ? (inv.byCategory.find((c) => c.category === key) || {}) : {});
  const safety = overview && overview.financialSafety ? overview.financialSafety : null;
  const stripe = overview && overview.stripe ? overview.stripe : null;
  const gbp = (m) => (m && Number.isFinite(Number(m.GBP)) ? Number(m.GBP) : null);

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    product: 'Home Call Guard',
    generatedAt: now.toISOString(),
    period: month,
    basis: {
      customersAndNumbers: `point in time, ${now.toISOString()} (not reconstructed for ${month})`,
      calls: `calls created in ${month} (UTC)`,
      finance: 'as reported by the connected sources at generation time; null = not connected (never 0)',
    },
    customers: {
      entitledHouseholds: sub ? sub.membership.current : null,
      genuinePayingNow: sub ? sub.genuinePayingCustomers : null,
      genuineEverPaid: ph ? ph.genuineEverPaid : null,
      genuineFormerPaying: ph ? ph.genuineFormerPaying : null,
      paidButUnclassified: ph ? ph.unclassifiedEverPaid : null,
      complimentaryWithAccess: sub ? sub.complimentary : null,
      trialWithAccess: sub ? sub.trial : null,
      testReviewerAccounts: sub ? { ...sub.nonGenuineAccounts } : null,
      testReviewerWithAccess: sub ? sub.nonGenuineWithActiveAccess : null,
      unclassifiedWithAccess: sub ? sub.unclassifiedWithActiveAccess : null,
      protected: cardValue(overview, 'protected'),
      entitledNotProtected: cardValue(overview, 'entitled_not_protected'),
      cancelled: sub ? sub.membership.cancelled : null,
      expired: sub ? sub.membership.expired : null,
      deletedAccounts: sub ? sub.deletedAccounts : null,
      churn30d: subscriptions && subscriptions.churn && subscriptions.churn.available ? { ratePercent: subscriptions.churn.rate, lost: subscriptions.churn.lost, base: subscriptions.churn.base } : null,
    },
    numbers: inv ? {
      onProviderAccount: inv.providerNumberCount,
      monthlyRentalGbp: inv.monthlyRental ? inv.monthlyRental.allNumbers : null,
      rentalProvenance: inv.monthlyRental ? inv.monthlyRental.provenance : 'NOT_CONNECTED',
      byCategory: Object.fromEntries((inv.byCategory || []).map((c) => [c.category, { count: c.count, monthlyCostGbp: c.monthlyCost }])),
      activeCustomer: cat('customer_active').count ?? null,
      pendingRelease: cat('pending_release').count ?? null,
      stagingOrInternal: (cat('staging').count || 0) + (cat('internal_test').count || 0),
      orphanOrUnknown: (cat('orphan').count || 0) + (cat('unknown').count || 0),
      possiblyUnnecessary: inv.needsReview ? { count: inv.needsReview.count, monthlyCostGbp: inv.needsReview.monthlyCost } : null,
    } : { unavailable: overview && overview.inventoryReason ? 'provider inventory unavailable' : 'not connected' },
    calls: calls ? summariseCalls(calls) : null,
    finance: {
      stripeMode: stripe ? stripe.mode : 'unavailable',
      genuineMrrGbp: stripe && stripe.mode === 'live' && stripe.mrr ? gbp(stripe.mrr.genuine) : null,
      genuineCollectedThisMonthGbp: stripe && stripe.mode === 'live' && stripe.collectedThisMonth ? gbp(stripe.collectedThisMonth.genuine) : null,
      unattributedLiveSubscriptions: stripe && stripe.mode === 'live' && stripe.mrr ? stripe.mrr.unattributedSubscriptions ?? null : null,
      spendSafety: safety ? { state: safety.state, level: safety.level, asOf: safety.asOf } : { state: 'not_connected', level: null, asOf: null },
    },
    checks: overview && overview.cards ? Object.fromEntries(overview.cards.map((c) => [c.id, { value: typeof c.value === 'number' ? c.value : null, status: c.status }])) : null,
    definitions: {
      genuineCustomer: 'An account explicitly classified genuine_customer. Never inferred.',
      payingNow: 'Genuine customer with a current paid entitlement.',
      everPaid: 'A paid entitlement was recorded at some point (Stripe test / Apple sandbox rows are indistinguishable at this level).',
      protected: 'Current membership, delivery confirmed and app registered.',
      numberCategories: 'customer_active, customer_cancelled_grace, pending_release, internal_test, staging, reviewer, orphan, unknown, other — see the dashboard Numbers tab.',
      deliveryFailed: 'Twilio DialCallStatus "failed". Unanswered = "no-answer"/"busy". Not recorded = calls before migration 044 or not dialled.',
    },
  };
  return snapshot;
}

function fmt(v, suffix = '') {
  return v === null || v === undefined ? 'not connected' : `${v}${suffix}`;
}
function money(v) {
  return v === null || v === undefined ? 'not connected' : `£${Number(v).toFixed(2)}`;
}

// Pure. Human-readable summary of the same object.
function renderSnapshotMarkdown(s) {
  const c = s.customers;
  const n = s.numbers;
  const k = s.calls;
  const f = s.finance;
  const lines = [
    `# Home Call Guard — operational snapshot ${s.period}`,
    '',
    `Generated ${s.generatedAt} · schema ${s.schemaVersion}. Customers and numbers are point in time; calls are for ${s.period}. "not connected" means no source, never zero.`,
    '',
    '## Customers',
    `- Entitled households: ${fmt(c.entitledHouseholds)}`,
    `- Genuine paying now: ${fmt(c.genuinePayingNow)} · ever paid: ${fmt(c.genuineEverPaid)} · former paying: ${fmt(c.genuineFormerPaying)}`,
    `- Paid but not yet classified: ${fmt(c.paidButUnclassified)} · unclassified with access: ${fmt(c.unclassifiedWithAccess)}`,
    `- Test / reviewer / admin / QA accounts: ${c.testReviewerAccounts ? Object.entries(c.testReviewerAccounts).map(([key, v]) => `${key} ${v}`).join(', ') : 'not connected'} (with access: ${fmt(c.testReviewerWithAccess)})`,
    `- Complimentary / trial with access: ${fmt(c.complimentaryWithAccess)} / ${fmt(c.trialWithAccess)}`,
    `- Protected: ${fmt(c.protected)} · entitled but not protected: ${fmt(c.entitledNotProtected)}`,
    `- Cancelled / expired / deleted: ${fmt(c.cancelled)} / ${fmt(c.expired)} / ${fmt(c.deletedAccounts)}`,
    `- 30-day churn: ${c.churn30d ? `${c.churn30d.ratePercent}% (${c.churn30d.lost} of ${c.churn30d.base})` : 'not meaningful (no genuine paying base 30 days ago)'}`,
    '',
    '## Numbers',
    ...(n.unavailable ? [`- Provider inventory: ${n.unavailable}`] : [
      `- On the provider account: ${n.onProviderAccount} · rental ${money(n.monthlyRentalGbp)}/month (${n.rentalProvenance})`,
      `- Active customer: ${fmt(n.activeCustomer)} · pending release: ${fmt(n.pendingRelease)} · staging/internal: ${fmt(n.stagingOrInternal)} · orphan/unknown: ${fmt(n.orphanOrUnknown)}`,
      `- Possibly unnecessary: ${n.possiblyUnnecessary ? `${n.possiblyUnnecessary.count} numbers, ${money(n.possiblyUnnecessary.monthlyCostGbp)}/month` : 'not connected'}`,
    ]),
    '',
    `## Calls (${s.period})`,
    ...(k ? [
      `- Total ${k.total} · known contacts ${k.knownContact} · unknown callers ${k.unknownCaller} (blocked ${k.unknownBlocked}, ended by HCG ${k.endedByHcg})`,
      `- Delivery failed ${k.deliveryFailed} · unanswered ${k.deliveryUnanswered} · outcome not recorded ${k.deliveryNotRecorded}`,
    ] : ['- not connected']),
    '',
    '## Finance',
    `- Stripe: ${f.stripeMode} mode · genuine MRR ${money(f.genuineMrrGbp)} · collected this month ${money(f.genuineCollectedThisMonthGbp)}${f.unattributedLiveSubscriptions ? ` · ${f.unattributedLiveSubscriptions} live subscription(s) not attributed to a classified customer` : ''}`,
    `- Spend safety: ${f.spendSafety.state}${f.spendSafety.level ? ` · level ${f.spendSafety.level}` : ''}${f.spendSafety.asOf ? ` · as of ${f.spendSafety.asOf}` : ''}`,
    '',
    '## Definitions',
    ...Object.entries(s.definitions).map(([key, v]) => `- **${key}**: ${v}`),
    '',
  ];
  return lines.join('\n');
}

function resolveSupabaseAdmin() {
  try { return require('../supabaseClients').supabaseAdmin; } catch (err) { return null; }
}

// Read-only gather.
async function getDueDiligenceSnapshot({ month, now = new Date() } = {}) {
  const period = month || now.toISOString().slice(0, 7);
  const bounds = monthBounds(period);
  if (!bounds) return { available: false, status: 400, reason: 'month must be YYYY-MM' };
  const { getControlOverview } = require('./controlOverview');
  const { getSubscriptionOverview } = require('./subscriptionOverview');
  const supabaseAdmin = resolveSupabaseAdmin();
  const [overview, subscriptions, callsRes] = await Promise.all([
    getControlOverview(now).catch(() => null),
    getSubscriptionOverview(now).catch(() => null),
    supabaseAdmin
      ? supabaseAdmin.from('calls').select('status, result, dial_call_status, terminated_by_system').gte('created_at', bounds.start).lt('created_at', bounds.end).limit(100000)
      : Promise.resolve({ error: { message: 'not configured' } }),
  ]);
  const snapshot = buildDueDiligenceSnapshot({
    overview: overview && overview.available ? overview : null,
    subscriptions: subscriptions && subscriptions.available ? subscriptions : null,
    calls: callsRes && !callsRes.error ? callsRes.data || [] : null,
    month: period,
    now,
  });
  const leaks = findPrivacyLeaks(snapshot);
  if (leaks.length) return { available: false, status: 500, reason: 'snapshot refused: it would contain personal data', leaks };
  return { available: true, snapshot, markdown: renderSnapshotMarkdown(snapshot) };
}

module.exports = { SCHEMA_VERSION, findPrivacyLeaks, summariseCalls, buildDueDiligenceSnapshot, renderSnapshotMarkdown, getDueDiligenceSnapshot, monthBounds };
