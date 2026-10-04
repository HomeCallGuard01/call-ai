// Tests for the business control dashboard (2026-09-27), deployable
// observational version: services/businessControl/{subscriptionOverview,
// numberReconciliation, financialReadModel, campaignPerformance,
// financialOverview}.js, routes/adminBusinessControl.js and the four
// admin-business.html tabs. Pure functions and source guards only — no
// database, Stripe or Twilio.
//
// Run with: node tests/business-control.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-27T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const ent = (householdId, type, startsAgo, extra = {}) => ({ household_id: householdId, entitlement_type: type, status: 'active', source: type === 'paid_subscription' ? 'stripe' : 'admin_manual', starts_at: ago(startsAgo), ends_at: null, updated_at: ago(startsAgo), ...extra });

// ============================================================
// 1. Subscriptions overview
// ============================================================
{
  const { computeSubscriptionOverview } = require('../services/businessControl/subscriptionOverview.js');
  const households = [
    { id: 'g1', email: 'g1@x.com' }, // genuine paying, new (3d)
    { id: 'g2', email: 'g2@x.com' }, // genuine paying for 60d, cancelling
    { id: 'g3', email: 'g3@x.com' }, // genuine, paid 40d ago, churned 10d ago
    { id: 'r1', email: 'r1@x.com' }, // reviewer with paid entitlement
    { id: 'c1', email: 'c1@x.com' }, // unclassified complimentary
    { id: 't1', email: 't1@x.com' }, // internal test, trial
    { id: 'd1', email: 'anonymized-d1@deleted.homecallguard.internal' },
  ];
  const entitlements = [
    ent('g1', 'paid_subscription', 3 * DAY),
    ent('g2', 'paid_subscription', 60 * DAY),
    ent('g3', 'paid_subscription', 40 * DAY, { status: 'expired', updated_at: ago(10 * DAY) }),
    ent('r1', 'paid_subscription', 5 * DAY, { source: 'apple_revenuecat' }),
    ent('c1', 'complimentary', 5 * DAY),
    ent('t1', 'free_trial', 2 * DAY),
  ];
  const subscriptions = [
    { household_id: 'g2', status: 'active', cancel_at_period_end: true, updated_at: ago(DAY) },
    { household_id: 'g3', status: 'canceled', cancel_at_period_end: false, updated_at: ago(10 * DAY) },
    { household_id: 'g1', status: 'past_due', cancel_at_period_end: false, updated_at: ago(HOUR) },
  ];
  const classificationMap = new Map([['g1', 'genuine_customer'], ['g2', 'genuine_customer'], ['g3', 'genuine_customer'], ['r1', 'reviewer'], ['t1', 'internal_test']]);
  const { counts, churn, needsClassification } = computeSubscriptionOverview({ households, entitlements, subscriptions, classificationMap }, NOW);

  check(counts.genuinePayingCustomers === 2, 'genuine paying = genuine_customer households with an active paid entitlement (2)');
  check(counts.activePaidSubscriptions.total === 3 && counts.activePaidSubscriptions.genuine === 2, 'active paid subscriptions: 3 in total, 2 genuine — the reviewer\'s paid access is excluded from genuine');
  check(counts.activePaidSubscriptions.bySource.stripe === 2 && counts.activePaidSubscriptions.bySource.apple_revenuecat === 1, 'active paid split by source');
  check(counts.cancellingAtPeriodEnd.genuine === 1 && counts.cancelledSubscriptions.genuine === 1, 'cancelling at period end and cancelled counted from subscriptions');
  check(counts.paymentIssue.genuine === 1, 'past_due counted as a payment issue');
  check(counts.complimentary === 1 && counts.trial === 1, 'complimentary and trial counted separately from paid');
  check(counts.nonGenuineAccounts.reviewer === 1 && counts.nonGenuineAccounts.internal_test === 1 && counts.nonGenuineWithActiveAccess === 2, 'reviewer/test accounts counted, never genuine');
  check(counts.unclassifiedWithActiveAccess === 1 && needsClassification[0].householdId === 'c1', 'unclassified active household listed as needing classification, not counted genuine');
  check(counts.households === 6 && counts.deletedAccounts === 1, 'deleted (anonymised) accounts counted separately');
  check(counts.newGenuinePayingLast7d === 1 && counts.newGenuinePayingLast30d === 1, 'new genuine paying customers in last 7 / 30 days');
  check(churn.available && churn.base === 2 && churn.lost === 1 && churn.rate === 50, '30-day churn: 2 genuine paying 30 days ago, 1 no longer paying → 50%');

  const none = computeSubscriptionOverview({ households: [{ id: 'g1', email: 'a@b.c' }], entitlements: [ent('g1', 'paid_subscription', 3 * DAY)], subscriptions: [], classificationMap: new Map([['g1', 'genuine_customer']]) }, NOW);
  check(none.churn.available === false, 'churn not reported when nobody was paying 30 days ago (no meaningless 0%)');
}

// ============================================================
// 2. Number reconciliation
// ============================================================
{
  const { computeNumberReconciliation, detectHouseholdAnomalies } = require('../services/businessControl/numberReconciliation.js');
  const h = (id, extra = {}) => ({ id, email: `${id}@x.com`, twilio_number: '+447700900' + id.slice(-3).padStart(3, '0'), twilio_provisioning_status: 'active', twilio_number_pending_release_at: null, voice_client_registered_at: ago(DAY), delivery_verified_at: ago(DAY), ...extra });
  const codes = (household, entitlements = [], quarantineRows = []) => detectHouseholdAnomalies({ household, entitlements, quarantineRows }, NOW).anomalies.map((a) => a.code);

  check(codes(h('ok1'), [ent('ok1', 'complimentary', 10 * DAY)]).length === 0, 'healthy entitled household with number, app and delivery → no anomalies');
  check(codes(h('p1', { twilio_number: null }), [ent('p1', 'paid_subscription', 2 * DAY)]).includes('PAID_WITHOUT_NUMBER'), 'active paid customer without a number');
  check(codes(h('e1', { twilio_number: null }), [ent('e1', 'complimentary', 2 * DAY)]).includes('ENTITLED_WITHOUT_NUMBER'), 'entitlement without a number');
  check(codes(h('e2', { twilio_number: null, twilio_provisioning_status: 'pending' }), [ent('e2', 'complimentary', 10 * 60 * 1000)]).join() === 'PROVISIONING_IN_PROGRESS', 'number missing 10 minutes after entitlement → watch "provisioning in progress", not action');
  check(codes(h('e3', { twilio_number: null, twilio_provisioning_status: 'failed' }), [ent('e3', 'complimentary', 10 * 60 * 1000)]).join() === 'PROVISIONING_FAILED', 'provisioning failed is its own action immediately (canonical PROVISIONING_FAILED)');
  check(codes(h('e4', { twilio_number: null, twilio_provisioning_status: 'failed' }), [ent('e4', 'paid_subscription', 10 * 60 * 1000)]).join() === 'PAID_WITHOUT_NUMBER', 'a PAYING customer whose provisioning failed keeps the dashboard\'s "paying customer without a number" label');
  check(codes(h('r1', { twilio_number_pending_release_at: ago(-5 * DAY) }), [ent('r1', 'paid_subscription', 30 * DAY)]).includes('ENTITLED_PENDING_RELEASE'), 'entitled household whose number is pending release');
  check(codes(h('n1'), []).includes('NUMBER_RETAINED_NO_ENTITLEMENT'), 'no entitlement but number retained with no release scheduled');
  check(codes(h('n2', { twilio_number_pending_release_at: ago(-2 * DAY) }), []).length === 0, 'no entitlement, release scheduled in the future → normal lifecycle, no anomaly');
  // Canonical: overdue after one 24h release-job interval (the sweep's value; was 48h here).
  check(codes(h('n3', { twilio_number_pending_release_at: ago(23 * HOUR) }), []).length === 0, 'release 23h past due → within one daily-job interval, no anomaly');
  check(codes(h('n4', { twilio_number_pending_release_at: ago(25 * HOUR) }), []).join() === 'RELEASE_OVERDUE', 'release 25h past due → overdue (same threshold the backend sweep alerts on)');
  check(codes(h('n4', { twilio_number_pending_release_at: ago(49 * HOUR) }), []).includes('RELEASE_OVERDUE'), 'release 49h past due → cancelled customer still retaining number');
  check(codes(h('v1', { voice_client_registered_at: null }), [ent('v1', 'complimentary', 5 * DAY)]).includes('VOICE_SDK_NEVER_REGISTERED'), 'Voice SDK never registered');
  check(codes(h('v2', { delivery_verified_at: null }), [ent('v2', 'complimentary', 5 * DAY)]).includes('DELIVERY_NEVER_CONFIRMED'), 'delivery never confirmed');
  check(codes(h('q1', { twilio_number: null }), [], [{ household_id: 'q1', twilio_number: '+447700900111', deactivation_confirmed: false, quarantined_at: ago(3 * DAY), released_at: null, release_reason: 'subscription_grace_expired' }]).includes('QUARANTINE_AWAITING_CONFIRMATION'), 'quarantined number awaiting deactivation confirmation');
  check(codes(h('q2', { twilio_number: null }), [], [{ household_id: 'q2', deactivation_confirmed: true, deactivation_confirmed_at: ago(3 * DAY), released_at: null }]).includes('QUARANTINE_RELEASE_STUCK'), 'confirmed quarantine unreleased 3 days later → inferred provider release failure');
  check(codes(h('q3', { twilio_number: null }), [], [{ household_id: 'q3', deactivation_confirmed: true, deactivation_confirmed_at: ago(3 * DAY), released_at: ago(2 * DAY) }]).length === 0, 'released quarantine → no anomaly');
  check(codes(h('q4', { twilio_number: null }), [ent('q4', 'complimentary', 2 * DAY)], [{ household_id: 'q4', deactivation_confirmed: false, quarantined_at: ago(3 * DAY), released_at: null }]).includes('QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD'), 'entitled household whose number is quarantined → flagged (do not confirm deactivation)');
  // Upcoming entitlements (047 / PR #47 definition).
  check(codes(h('u1'), [ent('u1', 'paid_subscription', -2 * DAY)]).length === 0, 'active entitlement starting in 2 days: keeping the number is expected, not "retained without entitlement"');
  check(codes(h('u2'), [ent('u2', 'paid_subscription', 0, { status: 'scheduled', starts_at: ago(-5 * DAY) })]).length === 0, 'scheduled entitlement: keeping the number is expected');
  check(codes(h('u3', { twilio_number_pending_release_at: ago(-1 * DAY) }), [ent('u3', 'paid_subscription', -2 * DAY)]).includes('ENTITLED_PENDING_RELEASE'), 'upcoming entitlement with a release scheduled → flagged (the incident 047 guards against)');
  check(codes(h('u4', { twilio_number: null }), [ent('u4', 'paid_subscription', -2 * DAY)]).length === 0, 'upcoming entitlement without a number yet → no anomaly');

  const report = computeNumberReconciliation({
    households: [h('ok1'), h('v2', { delivery_verified_at: null }), h('n1'), { id: 'x9', email: 'never@x.com', twilio_number: null }],
    entitlements: [ent('ok1', 'complimentary', 10 * DAY), ent('v2', 'complimentary', 5 * DAY)],
    subscriptions: [],
    quarantineRows: [{ household_id: null, twilio_number: '+447700900555', deactivation_confirmed: false, quarantined_at: ago(DAY), released_at: null }],
  }, NOW);
  // n1 (number retained) is action; v2 (delivery never confirmed) and the
  // 1-day-old unconfirmed quarantine are watch (45/90-day policy); ok1 ok.
  check(report.overall === 'ACTION_REQUIRED' && report.actionCount === 1 && report.watchCount === 2 && report.okCount === 1 && report.rows.find((r) => r.hcgNumber === '+44 •••• ••0555').status === 'watch', `overall ACTION REQUIRED with action / watch / ok counts (got ${report.overall} ${report.actionCount}/${report.watchCount}/${report.okCount}; ${report.rows.map((r) => (r.householdId || r.hcgNumber) + ':' + r.status + ':' + r.anomalies.map((a) => a.code).join('+')).join(' ')})`);
  check(report.rows[0].status === 'action_required' && report.rows[report.rows.length - 1].status === 'ok', 'rows sorted action → watch → ok');
  check(!report.rows.some((r) => r.householdId === 'x9'), 'households with no entitlement, number or quarantine are not listed (nothing to reconcile)');
  check(report.rows.some((r) => r.numberOnly && r.hcgNumber === '+44 •••• ••0555'), 'a quarantine with no household (deleted account) is still reconciled as a number-level row');
  check(report.anomalyCounts.NUMBER_RETAINED_NO_ENTITLEMENT === 1 && report.anomalyCounts.QUARANTINE_AWAITING_CONFIRMATION === 1, 'anomaly counts');
  const chain = report.rows.find((r) => r.householdId === 'ok1').chain.map((s) => s.key).join('→');
  check(chain === 'subscription→entitlement→number→app→delivery→protected→cancellation→quarantine→released', 'lifecycle chain stages in order');

  const allOk = computeNumberReconciliation({ households: [h('ok1')], entitlements: [ent('ok1', 'complimentary', 10 * DAY)], subscriptions: [], quarantineRows: [] }, NOW);
  check(allOk.overall === 'OK', 'nothing wrong → OK');

  const src = readFileSync(path.join(__dirname, '..', 'services', 'businessControl', 'numberReconciliation.js'), 'utf8');
  check(!/\.(insert|update|upsert|delete|rpc)\(/.test(src), 'reconciliation never writes to the database or calls an RPC');
  const providerCalls = [...src.matchAll(/incomingPhoneNumbers[^;\n]*/g)].map((m) => m[0]);
  check(providerCalls.length === 1 && /incomingPhoneNumbers\.list\(/.test(providerCalls[0]) && !/\.remove\(|\.create\(|\.update\(|availablePhoneNumbers/.test(src), 'the only provider call is a read-only number list — no release, purchase or update');

  // Provider inventory, both directions.
  const inv = computeNumberReconciliation({
    households: [h('ok1', { twilio_number: '+447700900001' }), h('gone', { twilio_number: '+447700900002' })],
    entitlements: [ent('ok1', 'complimentary', 10 * DAY), ent('gone', 'complimentary', 10 * DAY)],
    subscriptions: [],
    quarantineRows: [{ household_id: null, twilio_number: '+447700900003', deactivation_confirmed: false, quarantined_at: ago(DAY), released_at: null }],
    providerNumbers: ['+447700900001', '+447700900003', '+44 7700 900009'],
  }, NOW);
  check(inv.providerInventory.available && inv.providerInventory.providerCount === 3, 'provider inventory compared when the number list is available');
  const orphan = inv.rows.find((r) => r.providerOnly);
  check(orphan && orphan.hcgNumber === '+44 •••• ••0009' && orphan.anomalies[0].code === 'PROVIDER_NUMBER_UNACCOUNTED', 'a provider number held by no household or open quarantine is flagged (formatting differences normalised)');
  check(!inv.rows.some((r) => r.providerOnly && r.hcgNumber === '+447700900003'), 'a number in an open quarantine is accounted for, not flagged as orphaned');
  check(inv.rows.find((r) => r.householdId === 'gone').anomalies.some((a) => a.code === 'NUMBER_MISSING_AT_PROVIDER'), 'a household number missing from the provider account is flagged');
  check(!inv.rows.find((r) => r.householdId === 'ok1').anomalies.some((a) => a.code === 'NUMBER_MISSING_AT_PROVIDER'), 'a household number present at the provider is fine');
  const noInv = computeNumberReconciliation({ households: [h('ok1')], entitlements: [ent('ok1', 'complimentary', 10 * DAY)], subscriptions: [], quarantineRows: [] }, NOW);
  check(noInv.providerInventory.available === false && noInv.overall === 'OK', 'without a provider list the provider checks are skipped and reported as unavailable (never assumed OK or broken)');
}

// ============================================================
// 3. Financial read model (control centre v2)
// ============================================================
{
  const { PROVENANCE, LINE_ORDER, buildLiveLines, linesFromFinanceViews, buildProfitAndLoss, monthToDatePeriod } = require('../services/businessControl/financialReadModel.js');
  const { resolveFixedCostSettings } = require('../services/businessControl/fixedCostSettings.js');
  const period = monthToDatePeriod(NOW);
  check(new Date(period.startMs).toISOString() === '2026-09-01T00:00:00.000Z', 'period is calendar month to date (UTC)');
  check(LINE_ORDER.map((l) => l[0]).join() === 'revenue_ex_vat,payment_fees,telephony,ai_transcription,railway,supabase,resend,other,advertising', 'Finance lines in the requested order');

  const twilio = { available: true, spendMtdGbp: 16.5, spendMtdSplit: { numberRentalGbp: 15.65, callUsageGbp: 0.85 } };
  const openaiEstimate = { estimatedCostGbp: 0.46, unknownCallCount: 48, assumedAvgMinutesPerCall: 2, fxRateUsdToGbp: 0.79 };
  const settings = resolveFixedCostSettings({ BUSINESS_FIXED_COST_RAILWAY_GBP: '5', BUSINESS_FIXED_COST_RAILWAY_AS_OF: '2026-09-20' }, NOW);

  // Stripe TEST mode → revenue and fees NOT CONNECTED, never test money as revenue.
  const testMode = buildLiveLines({ stripeRevenue: { available: true, mode: 'test', vatRate: 0.2, collectedThisMonth: { genuine: { GBP: 39.92 }, genuineExVat: { GBP: 33.27 }, genuineCharges: 8, genuineFees: { GBP: 2 }, feesMissing: 0 } }, twilio, openaiEstimate, fixedCostSettings: settings });
  check(testMode.revenue_ex_vat.amountGbp === null && testMode.revenue_ex_vat.provenance === 'NOT_CONNECTED' && /TEST mode/.test(testMode.revenue_ex_vat.basis), 'Stripe test mode: revenue NOT CONNECTED (test payments never shown as revenue)');
  check(testMode.payment_fees.amountGbp === null, 'Stripe test mode: fees NOT CONNECTED');

  // Live mode, genuine customers only.
  const live = buildLiveLines({ stripeRevenue: { available: true, mode: 'live', vatRate: 0.2, collectedThisMonth: { genuine: { GBP: 59.88 }, genuineExVat: { GBP: 49.9 }, genuineCharges: 12, genuineFees: { GBP: 3.5 }, feesMissing: 0, otherNonGenuine: { GBP: 4.99 } } }, twilio, openaiEstimate, fixedCostSettings: settings });
  check(live.revenue_ex_vat.amountGbp === 49.9 && /excludes receipts from non-genuine accounts/.test(live.revenue_ex_vat.basis), 'live: revenue ex VAT from genuine customers only; non-genuine receipts named and excluded');
  check(live.payment_fees.amountGbp === 3.5 && live.payment_fees.provenance === 'ACTUAL', 'live: payment fees are Stripe\'s own fee per genuine payment (ACTUAL)');
  const feesMissing = buildLiveLines({ stripeRevenue: { available: true, mode: 'live', vatRate: 0.2, collectedThisMonth: { genuine: { GBP: 10 }, genuineExVat: { GBP: 8.33 }, genuineCharges: 2, genuineFees: {}, feesMissing: 1 } }, twilio, openaiEstimate, fixedCostSettings: settings });
  check(feesMissing.payment_fees.amountGbp === null, 'a genuine payment without a fee record → fees NOT CONNECTED, never understated');
  check(live.telephony.amountGbp === 16.5 && live.telephony.provenance === 'ACTUAL', 'telephony is Twilio\'s own total (ACTUAL)');
  check(live.ai_transcription.provenance === 'ESTIMATED' && /0\.79 USD→GBP/.test(live.ai_transcription.basis), 'AI is ESTIMATED and states its USD→GBP conversion');
  check(live.railway.provenance === 'MANUAL' && live.railway.checkedAt === '2026-09-20' && live.railway.stale === false, 'Railway: manual figure with its checked date');
  check(live.supabase.amountGbp === null && /BUSINESS_FIXED_COST_SUPABASE_GBP/.test(live.supabase.basis), 'Supabase unset → NOT CONNECTED, naming the setting to fill in');
  check(live.other.amountGbp === null && live.advertising.amountGbp === null, 'Other and advertising NOT CONNECTED (no ledger / manual costs yet)');

  // Totals never manufacture precision.
  const pnlTest = buildProfitAndLoss({ period, lines: testMode, source: 'interim_live_sources', units: { accountsWithAccess: 7, genuinePayingCustomers: 0 } });
  check(pnlTest.totals.revenueExVat.amountGbp === null && pnlTest.totals.revenueExVat.complete === false, 'unknown revenue → total revenue has no amount (not £0)');
  check(pnlTest.totals.grossContribution.amountGbp === null && pnlTest.totals.operatingContribution.amountGbp === null, 'contribution is not computed when revenue or any cost is unknown (no "−£16.96")');
  check(pnlTest.totals.totalOperatingCost.partial === true && pnlTest.totals.totalOperatingCost.amountGbp === 21.96, 'operating cost with missing lines → known part only (£21.96), flagged partial');
  check(pnlTest.unitEconomics.revenueExVatPerGenuinePayingCustomer === null, 'no genuine paying customers → no per-customer revenue');

  const allKnown = { revenue_ex_vat: { amountGbp: 100, provenance: 'ESTIMATED' }, payment_fees: { amountGbp: 4, provenance: 'ACTUAL' }, telephony: { amountGbp: 16, provenance: 'ACTUAL' }, ai_transcription: { amountGbp: 1, provenance: 'ESTIMATED' }, railway: { amountGbp: 5, provenance: 'MANUAL' }, supabase: { amountGbp: 20, provenance: 'MANUAL' }, resend: { amountGbp: 0, provenance: 'MANUAL' }, other: { amountGbp: 3, provenance: 'MANUAL' }, advertising: { amountGbp: 50, provenance: 'MANUAL' } };
  const pnl = buildProfitAndLoss({ period, lines: allKnown, source: 'x', units: { accountsWithAccess: 10, genuinePayingCustomers: 4 } });
  check(pnl.totals.grossContribution.amountGbp === 79 && pnl.totals.operatingContribution.amountGbp === 51 && pnl.totals.totalOperatingCost.amountGbp === 49, 'all known: gross contribution £79, operating contribution £51, total operating cost £49 (advertising separate)');
  check(pnl.totals.marketing.amountGbp === 50 && pnl.unitEconomics.revenueExVatPerGenuinePayingCustomer.amountGbp === 25, 'marketing shown separately; revenue ex VAT per genuine paying customer £25');
  check(pnl.unitEconomics.customerAcquisitionCost.provenance === 'NOT_CONNECTED', 'CAC NOT CONNECTED until attribution exists');

  // Finance ledger views adapter (docs/finance/LEDGER_REPORTING_INTERFACE.md contract).
  const viewsLines = linesFromFinanceViews({
    contribution: { revenue: 59.88, tax: -9.98, payment_fees: -3.2, direct_service_costs: -17.1, infrastructure: -25, advertising: 0, estimated_or_allocated_part: -0.5, unknown_items: 2 },
    bucketRows: [
      { dashboard_bucket: 'payment_fees', amount_quality: 'ACTUAL', signed_total: -3.2, entries_without_amount: 0 },
      { dashboard_bucket: 'telephony', amount_quality: 'ACTUAL', signed_total: -15.9, entries_without_amount: 2 },
      { dashboard_bucket: 'telephony', amount_quality: 'ALLOCATED', signed_total: -0.7, entries_without_amount: 0 },
      { dashboard_bucket: 'ai_transcription', amount_quality: 'ESTIMATED', signed_total: -0.5, entries_without_amount: 0 },
    ],
    infrastructureBySupplier: [{ supplier: 'railway', signed_total: -5 }, { supplier: 'supabase', signed_total: -20 }],
  });
  check(viewsLines.revenue_ex_vat.amountGbp === 49.9, 'views: revenue ex VAT = revenue − tax from finance_monthly_contribution');
  check(viewsLines.telephony.amountGbp === 16.6 && viewsLines.telephony.provenance === 'MIXED' && /2 item\(s\) not yet priced/.test(viewsLines.telephony.basis), 'views: telephony bucket, mixed quality, unpriced items counted not zeroed');
  check(viewsLines.railway.amountGbp === 5 && viewsLines.supabase.amountGbp === 20 && viewsLines.resend.amountGbp === null, 'views: infrastructure split by supplier; missing Resend stays NOT CONNECTED');
  check(viewsLines.advertising.amountGbp === null, 'views: no advertising rows → NOT CONNECTED');
  check(linesFromFinanceViews({ contribution: null }) === null, 'views: no contribution row for the month → adapter returns nothing (falls back, never zero)');
  const src = readFileSync(path.join(__dirname, '..', 'services', 'businessControl', 'financialReadModel.js'), 'utf8');
  check(!/from\(['"]financial_entries['"]\)/.test(src) && !/aggregateLedgerLine/.test(src), 'no competing ledger aggregation: financial_entries is never read directly');
}

// ============================================================
// 5. Campaign attribution
// ============================================================
{
  const { normaliseCampaignRef, deriveChannel, computeCampaignPerformance, buildTrackedGoLink } = require('../services/businessControl/campaignPerformance.js');
  check(normaliseCampaignRef('TikTok', 'Organic_Social', null) === 'tiktok/organic_social/(none)' && normaliseCampaignRef('', null, '') === null, 'campaign_ref normalisation (lower-case source/medium/campaign)');
  check(deriveChannel({ utm_medium: 'paid_social' }) === 'paid_social' && deriveChannel({ utm_medium: 'community' }) === 'community', 'paid social / community channels from UTM medium');
  check(deriveChannel({ referrer_host: 'www.google.com' }) === 'organic_search' && deriveChannel({ referrer_host: 'l.instagram.com' }) === 'organic_social' && deriveChannel({ referrer_host: 'blog.example.org' }) === 'referral', 'untagged visits classified from referrer host');
  check(deriveChannel({}) === 'direct_or_unknown', 'no UTM and no referrer → direct_or_unknown, never a campaign');

  const events = [
    { event_type: 'landing_visit', utm_source: 'tiktok', utm_medium: 'organic_social' },
    { event_type: 'landing_visit', utm_source: 'tiktok', utm_medium: 'organic_social' },
    { event_type: 'registration_completed', utm_source: 'tiktok', utm_medium: 'organic_social' },
    { event_type: 'landing_visit', referrer_host: 'www.google.co.uk' },
    { event_type: 'landing_visit' },
    { event_type: 'checkout_started' },
    { event_type: 'paid_conversion' },
  ];
  const perf = computeCampaignPerformance({ events });
  const tiktok = perf.rows.find((r) => r.campaignRef === 'tiktok/organic_social/(none)');
  check(tiktok && tiktok.landingVisits === 2 && tiktok.registrationsCompleted === 1, 'visits and registrations grouped by campaign');
  check(tiktok.payingCustomers === null && tiktok.cac === null && tiktok.spend.provenance === 'NOT_CONNECTED', 'paying customers, spend and CAC per campaign are NOT CONNECTED — a click is never treated as a purchase');
  check(perf.unattributed.paidConversions === 1 && perf.unattributed.checkoutsStarted === 1, 'checkouts and paid conversions reported as unattributed (no UTM at checkout)');
  check(perf.chain.find((s) => s.stage === 'Paying customers by campaign').status === 'NOT_CONNECTED', 'attribution chain shows the missing household → campaign link');

  const withData = computeCampaignPerformance({ events, spendByCampaign: { 'tiktok/organic_social/(none)': { amountGbp: 30, provenance: 'manual' } }, attributedCustomers: { 'tiktok/organic_social/(none)': 3 } });
  check(withData.rows.find((r) => r.campaignRef === 'tiktok/organic_social/(none)').cac === 10, 'once spend and attributed paying customers both exist, CAC = spend ÷ customers');
  const noCustomers = computeCampaignPerformance({ events, spendByCampaign: { 'tiktok/organic_social/(none)': { amountGbp: 30, provenance: 'manual' } }, attributedCustomers: null });
  check(noCustomers.rows.find((r) => r.campaignRef === 'tiktok/organic_social/(none)').cac === null, 'spend alone never produces a CAC');

  check(buildTrackedGoLink('https://homecallguard.co.uk/', { source: 'Instagram', medium: 'organic_social', campaign: 'Launch Oct' }) === 'https://homecallguard.co.uk/go?utm_source=instagram&utm_medium=organic_social&utm_campaign=launch-oct', 'tracked /go link builder follows the naming convention');
}

// ============================================================
// 6. Routes and the observational guarantee
// ============================================================
{
  const routeSrc = readFileSync(path.join(__dirname, '..', 'routes', 'adminBusinessControl.js'), 'utf8');
  const decls = [...routeSrc.matchAll(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]\s*,([^\n]+)/g)];
  const anyRouterCall = [...routeSrc.matchAll(/router\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1]);
  check(anyRouterCall.length === 7 && anyRouterCall.every((m) => m === 'get'), 'the router registers nothing but seven GET handlers (any quote style, no router.use/all/post)');
  check(decls.length === 7 && decls.every((d) => d[1] === 'get'), 'exactly seven routes, all GET — no write endpoint exists');
  check(decls.map((d) => d[2]).join() === '/admin/api/business-control/overview,/admin/api/business-control/subscriptions,/admin/api/business-control/reconciliation,/admin/api/business-control/finance,/admin/api/business-control/marketing,/admin/api/business-control/usage-safety,/admin/api/business-control/snapshot', 'routes: overview, subscriptions, reconciliation, finance, marketing, usage-safety (2026-10-01), snapshot');
  check(decls.every((d) => d[3].includes('requireAuth') && d[3].includes('requireAdmin')), 'every route requires an authenticated admin');
  check(!/recordAdminAction|express\.json\(\)/.test(routeSrc), 'no request bodies are parsed and no admin actions recorded (nothing to act on)');

  const dir = path.join(__dirname, '..', 'services', 'businessControl');
  const files = ['subscriptionOverview.js', 'numberReconciliation.js', 'financialReadModel.js', 'financialOverview.js', 'campaignPerformance.js', 'definitions.js', 'stripeRevenue.js', 'numberInventory.js', 'controlOverview.js', 'lifecycleTimeline.js', 'fixedCostSettings.js'];
  const code = (f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const all = files.map(code).join('\n') + '\n' + routeSrc;
  check(!/\.(insert|update|upsert|delete|rpc)\(/.test(all), 'no database write or RPC anywhere in the dashboard services or routes');
  check(!/from\(\s*['"](financial_entries|manual_cost_schedules|customer_acquisition|telephony_call_legs)['"]/.test(all), 'no query touches ledger/attribution tables directly (financial_entries, manual_cost_schedules, customer_acquisition, telephony_call_legs)');
  const finSrc = code('financialOverview.js');
  check(/BUSINESS_FINANCE_LEDGER_VIEWS === 'enabled'/.test(finSrc) && /ledgerSwitch \? readFinanceViews/.test(finSrc), 'Finance ledger views (051) are read only behind the explicit BUSINESS_FINANCE_LEDGER_VIEWS=enabled switch');
  check(!/\.remove\(|\.create\(|availablePhoneNumbers|incomingPhoneNumbers\.create|incomingPhoneNumbers\([^)]*\)\.(update|remove)/.test(all), 'no Twilio number is purchased, released or updated');
  check(!/stripe\.[a-zA-Z]+\.(create|update|del|cancel)/.test(all), 'no Stripe object is created, updated or cancelled');
  const providerCalls = [...all.matchAll(/incomingPhoneNumbers\.[a-zA-Z]+/g)].map((m) => m[0]);
  check(providerCalls.length > 0 && providerCalls.every((c) => c === 'incomingPhoneNumbers.list'), 'the only Twilio number calls are read-only lists');
  check(!/usage\.triggers|\.purchase|\.messages\.create|\.calls\.create/.test(all), 'no Twilio usage trigger, message, call or purchase is created');
  // Lifecycle actions are recognised by the real RPC/function names that
  // perform them (P0-owned); reading lifecycle columns is allowed.
  check(!/mark_household_twilio_number_pending_release|cancel_household_twilio_number_pending_release|release_household_twilio_number|record_twilio_release_attempt|expire_lapsed_entitlement|markTwilioNumber|releaseHousehold|releaseExpiredTwilioNumber|releaseQuarantinedTwilioNumber|quarantineHouseholdTwilioNumber|confirmTwilioNumberDeactivation|updateTwilioNumberForEntitlementChange|ensureTwilioNumberProvisioned/.test(all), 'no number is scheduled, quarantined, released or provisioned (no lifecycle RPC or function is called)');
  check(!existsSync(path.join(__dirname, '..', 'supabase', 'migrations', '050_manual_cost_schedules.sql')) && !existsSync(path.join(dir, 'manualCosts.js')), 'draft migration 050 and the manual-cost module are not part of this deployable');

  const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check(/app\.use\(adminBusinessControlRoutes\)/.test(server), 'business-control routes mounted in server.js');
}

// ============================================================
// 7. Dashboard UI (admin-business.html) — helpers and XSS safety
// ============================================================
{
  const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
  const extract = (name) => {
    const s = `// TEST-EXTRACT-START: ${name}`;
    const e = `// TEST-EXTRACT-END: ${name}`;
    const i = html.indexOf(s);
    const j = html.indexOf(e);
    return i === -1 || j === -1 ? null : html.slice(i + s.length, j);
  };
  const monitorHelpers = extract('customerMonitorHelpers');
  const dateTime = extract('fmtDateTime');
  const tabs = extract('businessControlTabs');
  check(monitorHelpers && dateTime && tabs, 'business-control UI block and shared helpers are extractable');

  // Five tabs (2026-09-28 consolidation); the former tabs are sections.
  for (const id of ['overview', 'customers', 'numbers', 'money', 'operations']) {
    check(html.includes(`id="tabBtn-${id}"`) && html.includes(`<div id="${id}" class="tab-panel"`), `tab "${id}" has a button and a panel`);
  }
  check(/const TAB_NAMES = \['overview', 'customers', 'numbers', 'money', 'operations'\]/.test(html), 'five tabs, Overview first');
  check((html.match(/class="tab-button"/g) || []).length === 5, 'exactly five tab buttons (was nine)');
  // Admin redesign (2026-10-04): the detailed checks grid (overviewBody) moved to Operations.
  for (const [section, tab] of [['overviewBody', 'operations'], ['attention', 'overview'], ['ccHeadline', 'overview'], ['ccStatus', 'overview'], ['ccActivity', 'overview'], ['ccMoney', 'money'], ['ccNumbers', 'numbers'], ['ccOpsStatus', 'operations'], ['customerHealth', 'customers'], ['subscriptions', 'customers'], ['reconciliation', 'numbers'], ['finance', 'money'], ['marketing', 'money'], ['acquisition', 'money'], ['callActivity', 'operations'], ['systemhealth', 'operations'], ['opsTools', 'operations']]) {
    const panelStart = html.indexOf(`<div id="${tab}" class="tab-panel"`);
    const panelEnd = html.indexOf('\n', panelStart);
    check(panelStart !== -1 && html.slice(panelStart, panelEnd).includes(`id="${section}"`), `section "${section}" sits in the ${tab} tab`);
  }
  check(!html.includes('tabBtn-business') && !html.includes('tabBtn-systemhealth') && !html.includes('renderBusinessTab'), 'the superseded Business and System Health tabs are gone');
  check(/LEGACY_TAB_HASHES = \{ business: 'money', subscriptions: 'customers', reconciliation: 'numbers', finance: 'money', marketing: 'money', systemhealth: 'operations' \}/.test(html), 'old #tab bookmarks land on the tab that now holds that content');
  check(/TAB_NAMES.includes\(mapped\) \? mapped : 'overview'/.test(html), 'the dashboard opens on the Overview');

  const evil = '"><img src=x onerror=alert(1)>';
  const elements = {};
  const stubEl = (id) => (elements[id] = elements[id] || { id, innerHTML: '', textContent: '', value: '', addEventListener() {}, hidden: false });
  const documentStub = { getElementById: (id) => stubEl(id), querySelectorAll: () => [], querySelector: () => null };
  const responses = {};
  const fetchStub = async (url) => ({ ok: true, redirected: false, status: 200, json: async () => responses[url.split('/business-control/')[1]] });
  const factory = new Function('document', 'fetch', 'window', 'fmtNum', `${monitorHelpers}\n${dateTime}\n${tabs}\nreturn { renderOverviewTab, renderSubscriptionsTab, renderReconciliationTab, renderFinanceTab, renderMarketingTab, provenanceBadge, statusBadge, overallBanner, formatGbpOrMissing, describeTotal, reconciliationBanner, chainStageClass, buildTrackedGoLinkClient, buildAttentionItems, groupOverviewCards, audienceOfRow, filterRowsByAudience, countAudiences, describeAudienceBadges };`);
  const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB'));
  const ui = factory(documentStub, fetchStub, { location: { origin: 'https://homecallguard.co.uk' } }, fmtNum);

  check(ui.formatGbpOrMissing(null) === 'Not connected' && ui.formatGbpOrMissing(0) === '£0.00' && ui.formatGbpOrMissing(-12.5) === '−£12.50', 'money formatting: missing is "Not connected", never £0; negatives shown');
  check(ui.describeTotal({ amountGbp: 10, complete: false, partial: true }).note === 'known part only' && ui.describeTotal({ amountGbp: null, complete: false }).text === 'Not connected' && ui.describeTotal({ amountGbp: 5, complete: true }).note === 'complete', 'totals: complete / known part only / not connected');
  check(ui.statusBadge('red').includes('Action needed') && ui.statusBadge('grey').includes('Cannot check') && ui.statusBadge(evil).includes('&lt;img'), 'status badges state what the colour means and escape unknown values');
  check(ui.overallBanner({ overall: 'green', counts: {}, incomplete: true }).text.includes('in what could be checked'), 'green banner is qualified when some checks could not run');
  check(ui.provenanceBadge('NOT_CONNECTED').includes('Not connected') && ui.provenanceBadge(evil).includes('&lt;img'), 'provenance badge labels and escapes unknown values');
  check(ui.reconciliationBanner('ACTION_REQUIRED', 2, 1).text.startsWith('ACTION REQUIRED') && ui.reconciliationBanner('OK', 0, 0).className === 'ready', 'reconciliation banner OK / ACTION REQUIRED');
  check(ui.chainStageClass({ state: 'awaiting confirmation' }) === 'chain-bad' && ui.chainStageClass({ state: 'yes' }) === 'chain-good', 'lifecycle chain stage colouring');
  check(ui.buildTrackedGoLinkClient('https://homecallguard.co.uk', { source: 'TikTok', medium: 'paid_social', campaign: 'Oct Launch', content: '123' }) === 'https://homecallguard.co.uk/go?utm_source=tiktok&utm_medium=paid_social&utm_campaign=oct-launch&utm_content=123', 'client link builder matches the server convention');

  responses.overview = { generatedAt: NOW.toISOString(), overall: 'red', incomplete: true, counts: { red: 1, amber: 0, green: 0, grey: 1 },
    cards: [{ id: 'x', label: evil, value: evil, status: 'red', rule: evil, sub: evil, items: [{ email: evil, detail: evil }, { number: evil, detail: evil }] }],
    stripe: { mode: evil }, inventory: { providerNumberCount: 1, releaseFailureRecording: evil, monthlyRental: { perNumber: 0.87, currency: 'GBP', basis: evil, flaggedNumbers: 0.87 },
      rows: [{ number: evil, owner: { email: evil, householdId: 'h', accountClass: evil, membership: evil }, whyExpected: evil, stateLabel: evil, environment: evil, voiceHost: evil, monthlyRental: 0.87, severity: 'red', flags: [{ severity: 'red', label: evil }], recommendations: [evil] }] }, inventoryReason: null };
  responses.subscriptions = { generatedAt: NOW.toISOString(), counts: { membership: { current: 1, upcoming: 0, cancelled: 2, expired: 3, never: 0 }, protection: { protected: 1, entitled_not_protected: 0 }, households: 1, deletedAccounts: 0, genuinePayingCustomers: 0, activePaidSubscriptions: { total: 0, genuine: 0, bySource: { [evil]: 1 } }, cancellingAtPeriodEnd: { total: 0, genuine: 0 }, paymentIssue: { total: 0, genuine: 0 }, cancelledSubscriptions: { total: 0, genuine: 0 }, complimentary: 1, trial: 0, nonGenuineAccounts: { internal_test: 0, admin: 0, reviewer: 0, qa_automation: 0 }, nonGenuineWithActiveAccess: 0, unclassifiedWithActiveAccess: 1, newGenuinePayingLast7d: 0, newGenuinePayingLast30d: 0 }, churn: { available: false, reason: evil }, needsClassification: [{ householdId: 'h', email: evil, entitlementType: evil }] };
  responses.reconciliation = { generatedAt: NOW.toISOString(), overall: 'ACTION_REQUIRED', actionCount: 1, watchCount: 0, okCount: 0, anomalyCounts: { NUMBER_RETAINED_NO_ENTITLEMENT: 1 }, anomalyDefinitions: { NUMBER_RETAINED_NO_ENTITLEMENT: { severity: 'action', label: 'x' } }, rows: [{ householdId: 'h', email: evil, hcgNumber: evil, status: 'action_required', anomalies: [{ severity: 'action', label: evil, detail: evil }], chain: [], timeline: { steps: [{ key: 'number', label: evil, state: 'broken', at: '2026-09-01T00:00:00Z', note: evil }], firstBroken: 0 } }], notes: [evil] };
  responses.finance = { generatedAt: NOW.toISOString(), period: { label: evil }, stripeMode: evil, source: evil,
    totals: { revenueExVat: { amountGbp: null, complete: false }, totalOperatingCost: { amountGbp: 16.96, complete: false, partial: true }, grossContribution: { amountGbp: null, complete: false }, operatingContribution: { amountGbp: null, complete: false }, marketing: { amountGbp: null, complete: false } },
    lines: [{ id: 'x', section: 'revenue', label: evil, amountGbp: null, provenance: evil, basis: evil }, { id: 'r', section: 'overhead', label: 'Railway', amountGbp: 5, provenance: 'MANUAL', stale: true, basis: evil }],
    unitEconomics: { accountsWithAccess: 1, genuinePayingCustomers: 0, operatingCostPerAccountWithAccess: { amountGbp: 16.96, complete: false, partial: true }, telephonyPerAccountWithAccess: null, revenueExVatPerGenuinePayingCustomer: null, monitoredMinutes: null, customerAcquisitionCost: { basis: evil } },
    fixedCostSettings: [{ label: evil, configured: false, amountVar: evil, asOfVar: evil, howToFind: evil }, { label: 'Railway', configured: true, valueGbp: 5, asOf: evil, stale: true, howToFind: evil }],
    connections: { source: evil, [evil]: evil } };
  responses.marketing = { generatedAt: NOW.toISOString(), windowDays: 90,
    channelComparison: { rows: [{ label: evil, visits: 1, registrations: 0, otherDetails: { [evil]: 1 } }], stageStatus: { visits: { status: 'ACTUAL', note: evil }, signups: { status: 'PARTIAL', note: evil }, payingCustomers: { status: 'NOT_CONNECTED', note: evil }, revenue: { status: 'NOT_CONNECTED', note: evil }, cac: { status: 'NOT_CONNECTED', note: evil } }, selfReported: { status: 'NOT_CAPTURED', note: evil } },
    chain: [{ stage: evil, status: 'NOT_CONNECTED', note: evil }], rows: [{ label: evil, channel: evil, landingVisits: 1, registrationsCompleted: 0, spend: { amountGbp: null }, payingCustomers: null, cac: null }], unattributed: { checkoutsStarted: 0, paidConversions: 0, note: evil } };

  await ui.renderOverviewTab();
  await ui.renderSubscriptionsTab();
  await ui.renderReconciliationTab();
  await ui.renderFinanceTab();
  await ui.renderMarketingTab();
  for (const id of ['overviewBody', 'attention', 'subscriptions', 'reconciliation', 'finance', 'marketing']) {
    const out = elements[id].innerHTML;
    check(out.length > 200 && !out.includes('<img') && !out.includes('onerror=alert(1)>') && out.includes('&lt;img src=x onerror=alert(1)&gt;'), `${id} tab renders hostile data as escaped text, never markup`);
  }
  check(elements.finance.innerHTML.includes('Not connected') && !/£0\.00/.test(elements.finance.innerHTML), 'finance tab shows missing figures as "Not connected", never £0.00');
  check(elements.finance.innerHTML.includes('known part only') && elements.finance.innerHTML.includes('re-check'), 'finance tab labels partial totals "known part only" and stale fixed costs "re-check"');
  check(elements.finance.innerHTML.includes('Manual costs') && !elements.finance.innerHTML.includes('<form'), 'finance tab explains manual costs arrive with the ledger and offers no form');
  check(elements.overviewBody.innerHTML.includes('control-rule') && elements.overviewBody.innerHTML.includes('Definitions used on every tab'), 'overview shows each card\'s rule and the definitions');
  check(elements.attention.innerHTML.includes('Needs your attention (1)') && elements.attention.innerHTML.includes('att-red'), 'overview leads with a "Needs your attention" list built from the red/amber checks');

  // Attention: grouped by topic, de-duplicated, WHAT/WHO/WHEN/WHY/NEXT.
  const overviewPayload = {
    cards: [
      { id: 'entitled_missing_number', label: 'Entitled households missing a number', value: 1, status: 'red', items: [{ householdId: 'h-prov', email: 'prov@x', detail: 'provisioning failed' }] },
      { id: 'lifecycle_anomalies', label: 'Lifecycle anomalies', value: 2, status: 'red', items: [{ householdId: 'h-lapsed', email: 'lapsed@x', detail: 'No entitlement, number retained' }, { householdId: 'h-prov', email: 'prov@x', detail: 'Entitled without number' }] },
      { id: 'lapsed_retaining_number', label: 'Lapsed households holding a number', value: 1, status: 'red', items: [{ householdId: 'h-lapsed', email: 'lapsed@x', detail: 'outside lifecycle' }] },
      { id: 'unmapped_numbers', label: 'Unmapped numbers', value: 8, status: 'red', items: [{ number: '+44 •••• ••0010', detail: 'dev' }] },
      { id: 'paid_unclassified', label: 'Paid at some point, not classified', value: 1, status: 'amber', items: [{ householdId: 'h-payer', email: 'payer@x', detail: 'former paying' }] },
      { id: 'non_paying_access', label: 'Complimentary/test access', value: 3, status: 'amber', items: [{ householdId: 'h-rev', email: 'rev@x', detail: 'reviewer · complimentary' }, { householdId: 'h-unc', email: 'unc@x', detail: 'unclassified · complimentary' }] },
      { id: 'entitled_not_protected', label: 'Entitled but NOT protected', value: 2, status: 'amber', items: [{ householdId: 'h-new', email: 'new@x' }] },
      { id: 'mrr', label: 'MRR', value: 'Stripe TEST mode', status: 'grey', items: [] },
      { id: 'protected', label: 'Protected', value: 3, status: 'info', items: [] },
    ],
    financialSafety: { state: 'stale', level: 'ALERT', asOf: '2026-09-28T09:00:00Z', warnings: [{ severity: 'critical', text: 'newest ledger data is 40h old' }] },
  };
  const customersPayload = { rows: [
    { householdId: 'h-del', email: 'del@x', health: 'needs_attention', healthReason: 'A call could not be delivered since the last successful one', lastDelivery: { at: '2026-09-29T08:00:00Z', failure: 'no answer from app' } },
    { householdId: 'h-app', email: 'app@x', health: 'needs_attention', healthReason: 'Calls reaching HCG but no registered app' },
    { householdId: 'h-prov', email: 'prov@x', health: 'needs_attention', healthReason: 'HCG number provisioning failed' },
    { householdId: 'h-gone', email: 'gone@x', health: 'needs_attention', healthReason: 'x', deletedAccount: true },
    { householdId: 'h-ok', email: 'ok@x', health: 'healthy' },
  ] };
  const businessPayload = { generatedAt: '2026-09-29T11:00:00Z', systemHealth: { components: { stripe: { status: 'GREEN', reason: 'ok' }, twilio: { status: 'AMBER', reason: 'configured, not confirmed' } } } };
  const att = ui.buildAttentionItems(overviewPayload, customersPayload, businessPayload);
  const topic = (t) => att.find((x) => x.topic === t);
  check(att.every((x) => x.what && x.why && x.next && x.tab && Array.isArray(x.who)), 'attention: every item says WHAT, WHO, WHY and NEXT, and links to a tab');
  check(topic('provisioning').affected === 1 && topic('provisioning').who[0].label === 'prov@x', 'attention: the same household from the Overview card and from Customers is ONE affected entry, not two');
  check(topic('number_lifecycle').affected === 2 && topic('number_lifecycle').details.length === 2, 'attention: two lifecycle cards merge into one "number lifecycle" item, households de-duplicated (lapsed@x once)');
  check(topic('classification').affected === 2 && topic('classification').who.map((w) => w.label).sort().join() === 'payer@x,unc@x', 'attention: classification = paid-but-unclassified + unclassified-with-access; reviewers (already classified) excluded');
  check(!att.some((x) => x.who.some((w) => w.label === 'new@x')), 'attention: "entitled but not protected" (normal setup) is NOT in the list — no wall of warnings');
  check(topic('delivery').who[0].label === 'del@x' && topic('delivery').when === '2026-09-29T08:00:00Z' && topic('voice_sdk').who[0].label === 'app@x', 'attention: customer problems split by cause (delivery vs app registration), with WHEN from the evidence');
  check(!att.some((x) => x.who.some((w) => w.label === 'del@x' && x.topic !== 'delivery')) && !att.some((x) => x.who.some((w) => w.label === 'gone@x')), 'attention: each customer appears under one cause; deleted accounts excluded');
  check(topic('finance').severity === 'red' && topic('finance').details.some((d) => /stale/.test(d)) && topic('finance').when === '2026-09-28T09:00:00Z', 'attention: stale / ALERT financial data is one red "spend safety" item');
  check(topic('data_freshness') && /MRR/.test(topic('data_freshness').details[0]), 'attention: checks that could not run become one data-freshness item (missing ≠ fine)');
  check(topic('system').severity === 'amber' && topic('system').details.length === 1, 'attention: only non-green system components');
  check(att.length === 9 && att.findIndex((x) => x.severity === 'amber') > att.findIndex((x) => x.severity === 'red') && att.filter((x) => x.severity === 'red').every((x, i, arr) => i === 0 || arr[i - 1].affected >= x.affected), 'attention: 9 grouped items from 13 raw signals, red first, then by number affected');
  check(ui.buildAttentionItems(null, null, null).length === 0, 'attention: nothing loaded yet → empty, no crash');
  check(ui.buildAttentionItems({ cards: [{ id: 'some_future_check', label: 'New check', value: 1, status: 'red', items: [] }] }, null, null)[0].topic === 'other_checks', 'attention: a check with no topic yet is shown under "other checks", never dropped');
  check(!/method\s*:|'POST'|\.remove\(|release\(/.test(ui.buildAttentionItems.toString()), 'attention: builds text only — no action, request or release');
  // Customers: every row says what kind of account it is.
  const rows = [
    { householdId: 'g', classification: 'genuine_customer', account: { kind: 'paying' }, everPaid: true, health: 'healthy' },
    { householdId: 'f', classification: 'genuine_customer', account: { kind: 'ended' }, everPaid: true, health: 'setup_incomplete' },
    { householdId: 'u', classification: 'unclassified', account: { kind: 'complimentary' }, health: 'healthy' },
    { householdId: 'r', classification: 'reviewer', account: { kind: 'complimentary', testLabel: 'Reviewer' }, health: 'healthy' },
    { householdId: 'x', classification: 'genuine_customer', account: { kind: 'none' }, health: 'inactive' },
  ];
  check(ui.audienceOfRow(rows[0]) === 'genuine' && ui.audienceOfRow(rows[2]) === 'unclassified' && ui.audienceOfRow({ classification: null }) === 'unclassified' && ui.audienceOfRow(rows[3]) === 'test', 'customers: audience is genuine / unclassified / test — a missing classification is never genuine');
  check(ui.filterRowsByAudience(rows, 'genuine').map((r) => r.householdId).join() === 'g,f,x' && ui.filterRowsByAudience(rows, 'all').length === 5, 'customers: audience filter');
  const ac = ui.countAudiences(rows);
  check(ac.all === 4 && ac.genuine === 2 && ac.unclassified === 1 && ac.test === 1, 'customers: audience chip counts exclude inactive/deleted, like the health counts');
  check(ui.describeAudienceBadges(rows[0]).map((b) => b.label).join() === 'Genuine' && ui.describeAudienceBadges(rows[1]).map((b) => b.label).join() === 'Genuine,Paid before' && ui.describeAudienceBadges(rows[2])[0].label === 'Unclassified' && ui.describeAudienceBadges(rows[3])[0].label === 'Reviewer', 'customers: badges — Genuine / Unclassified / Reviewer, plus "Paid before" for a former payer');
  const groups = ui.groupOverviewCards([{ id: 'mrr' }, { id: 'protected' }, { id: 'provider_numbers' }, { id: 'new_future_card' }]);
  check(groups.map((g) => g.title).join('|') === 'Customers & revenue|Protection|Numbers & cost|Other checks', 'overview cards grouped customers → protection → numbers; an unknown card is never dropped');
  check(elements.reconciliation.innerHTML.includes('First broken step') && elements.reconciliation.innerHTML.includes('What HCG pays for'), 'reconciliation shows the first broken lifecycle step and the number inventory');
  check(elements.marketing.innerHTML.includes('By channel') && elements.marketing.innerHTML.includes('Self-reported'), 'marketing shows the channel comparison and keeps self-report separate');
  check(!/method\s*:|'POST'|"POST"/.test(tabs), 'the business-control tabs only ever issue GET requests');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All business control checks passed.');
