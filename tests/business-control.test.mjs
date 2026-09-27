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
  check(codes(h('e3', { twilio_number: null, twilio_provisioning_status: 'failed' }), [ent('e3', 'complimentary', 10 * 60 * 1000)]).includes('ENTITLED_WITHOUT_NUMBER'), 'provisioning failed is action immediately');
  check(codes(h('r1', { twilio_number_pending_release_at: ago(-5 * DAY) }), [ent('r1', 'paid_subscription', 30 * DAY)]).includes('ENTITLED_PENDING_RELEASE'), 'entitled household whose number is pending release');
  check(codes(h('n1'), []).includes('NUMBER_RETAINED_NO_ENTITLEMENT'), 'no entitlement but number retained with no release scheduled');
  check(codes(h('n2', { twilio_number_pending_release_at: ago(-2 * DAY) }), []).length === 0, 'no entitlement, release scheduled in the future → normal lifecycle, no anomaly');
  check(codes(h('n3', { twilio_number_pending_release_at: ago(47 * HOUR) }), []).length === 0, 'release 47h past due → within the daily-job grace, no anomaly');
  check(codes(h('n4', { twilio_number_pending_release_at: ago(49 * HOUR) }), []).includes('RELEASE_OVERDUE'), 'release 49h past due → cancelled customer still retaining number');
  check(codes(h('v1', { voice_client_registered_at: null }), [ent('v1', 'complimentary', 5 * DAY)]).includes('VOICE_SDK_NEVER_REGISTERED'), 'Voice SDK never registered');
  check(codes(h('v2', { delivery_verified_at: null }), [ent('v2', 'complimentary', 5 * DAY)]).includes('DELIVERY_NEVER_CONFIRMED'), 'delivery never confirmed');
  check(codes(h('q1', { twilio_number: null }), [], [{ household_id: 'q1', twilio_number: '+447700900111', deactivation_confirmed: false, quarantined_at: ago(3 * DAY), released_at: null, release_reason: 'subscription_grace_expired' }]).includes('QUARANTINE_AWAITING_CONFIRMATION'), 'quarantined number awaiting deactivation confirmation');
  check(codes(h('q2', { twilio_number: null }), [], [{ household_id: 'q2', deactivation_confirmed: true, deactivation_confirmed_at: ago(3 * DAY), released_at: null }]).includes('QUARANTINE_RELEASE_OVERDUE'), 'confirmed quarantine unreleased 3 days later → inferred provider release failure');
  check(codes(h('q3', { twilio_number: null }), [], [{ household_id: 'q3', deactivation_confirmed: true, deactivation_confirmed_at: ago(3 * DAY), released_at: ago(2 * DAY) }]).length === 0, 'released quarantine → no anomaly');
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
  check(report.overall === 'ACTION_REQUIRED' && report.actionCount === 2 && report.watchCount === 1 && report.okCount === 1, 'overall ACTION REQUIRED with action / watch / ok counts');
  check(report.rows[0].status === 'action_required' && report.rows[report.rows.length - 1].status === 'ok', 'rows sorted action → watch → ok');
  check(!report.rows.some((r) => r.householdId === 'x9'), 'households with no entitlement, number or quarantine are not listed (nothing to reconcile)');
  check(report.rows.some((r) => r.numberOnly && r.hcgNumber === '+447700900555'), 'a quarantine with no household (deleted account) is still reconciled as a number-level row');
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
  check(orphan && orphan.hcgNumber === '+447700900009' && orphan.anomalies[0].code === 'PROVIDER_NUMBER_UNACCOUNTED', 'a provider number held by no household or open quarantine is flagged (formatting differences normalised)');
  check(!inv.rows.some((r) => r.providerOnly && r.hcgNumber === '+447700900003'), 'a number in an open quarantine is accounted for, not flagged as orphaned');
  check(inv.rows.find((r) => r.householdId === 'gone').anomalies.some((a) => a.code === 'NUMBER_MISSING_AT_PROVIDER'), 'a household number missing from the provider account is flagged');
  check(!inv.rows.find((r) => r.householdId === 'ok1').anomalies.some((a) => a.code === 'NUMBER_MISSING_AT_PROVIDER'), 'a household number present at the provider is fine');
  const noInv = computeNumberReconciliation({ households: [h('ok1')], entitlements: [ent('ok1', 'complimentary', 10 * DAY)], subscriptions: [], quarantineRows: [] }, NOW);
  check(noInv.providerInventory.available === false && noInv.overall === 'OK', 'without a provider list the provider checks are skipped and reported as unavailable (never assumed OK or broken)');
}

// ============================================================
// 3. Financial read model
// ============================================================
const LEDGER_048_CATEGORIES = [
  'subscription', 'vat_output', 'store_commission', 'payment_processing_fee', 'refund',
  'number_rental', 'inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts',
  'channel_capacity', 'platform_fee', 'sms', 'transcription', 'ai_inference', 'email',
  'hosting', 'database', 'domain', 'developer_program', 'saas', 'insurance', 'accountancy',
  'other_overhead', 'advertising', 'acquisition_other', 'other',
];
{
  const { PROVENANCE, LEDGER_PROVENANCE_MAP, LINE_DEFINITIONS, buildLiveFigures, buildProfitAndLoss, aggregateLedgerLine, monthToDatePeriod } = require('../services/businessControl/financialReadModel.js');
  const period = monthToDatePeriod(NOW);
  check(new Date(period.startMs).toISOString() === '2026-09-01T00:00:00.000Z', 'period is calendar month to date (UTC)');

  check(LINE_DEFINITIONS.every((d) => d.ledger.categories.every((c) => LEDGER_048_CATEGORIES.includes(c))), 'every P&L line maps only to migration 048 ledger categories');
  const covered = new Set(LINE_DEFINITIONS.flatMap((d) => d.ledger.categories));
  check(LEDGER_048_CATEGORIES.every((c) => covered.has(c)), 'every ledger category lands on some P&L line (nothing in the ledger is silently dropped)');
  check(Object.keys(LEDGER_PROVENANCE_MAP).join() === 'provider_actual,provider_allocated,estimated,manual', 'ledger provenance values mapped: provider_actual/provider_allocated/estimated/manual');
  const ledgerContractPath = path.join(__dirname, '..', 'services', 'ledger', 'contract.js');
  if (existsSync(ledgerContractPath)) {
    const contract = require(ledgerContractPath);
    check(JSON.stringify(Object.keys(LEDGER_PROVENANCE_MAP)) === JSON.stringify(contract.PROVENANCE), 'provenance map matches the merged ledger contract');
    check(JSON.stringify([...LEDGER_048_CATEGORIES]) === JSON.stringify(contract.CATEGORIES), 'category list matches the merged ledger contract');
  } else {
    console.log('  (ledger contract not merged yet — contract-drift checks will run automatically once services/ledger/contract.js exists)');
  }

  // Nothing connected.
  const empty = buildLiveFigures({ stripe: { available: false, reason: 'no key' }, twilio: { available: false, reason: 'no creds' }, openaiEstimate: null, appleEstimate: null, vatRate: 0.2, fixedCostsStatus: null, manualCostsConnected: false });
  const pnlEmpty = buildProfitAndLoss({ period, ledgerEntries: null, liveFigures: empty, units: {} });
  check(pnlEmpty.lines.filter((l) => l.id !== 'revenue_app_stores' && l.id !== 'store_commission').every((l) => l.provenance === PROVENANCE.NOT_CONNECTED && l.amountGbp === null), 'with no sources, every line is NOT CONNECTED with no amount — never £0');
  check(pnlEmpty.totals.operatingProfit.complete === false && pnlEmpty.totals.grossRevenue.complete === false, 'totals that include a missing line are marked incomplete');

  // Live sources present.
  const live = buildLiveFigures({
    stripe: { available: true, grossRevenueMtdGbp: 120, refundsMtdGbp: 0, stripeFeesMtdGbp: 2.5, chargeCountMtd: 24 },
    twilio: { available: true, numberCount: 7, spendMtdSplit: { callUsageGbp: 3.2, numberRentalGbp: 7 } },
    openaiEstimate: { estimatedCostGbp: 0.4, unknownCallCount: 20, assumedAvgMinutesPerCall: 2 },
    appleEstimate: { activeAppleEntitlements: 0 },
    vatRate: 0.2,
    fixedCostsStatus: { railway: { configured: true, valueGbp: 5 }, supabase: { configured: true, valueGbp: 20 }, resend: { configured: false } },
    manualCostsConnected: false,
  });
  check(live.revenue_stripe.provenance === 'ACTUAL' && live.revenue_stripe.amountGbp === 120, 'Stripe revenue is ACTUAL');
  check(live.vat_output.amountGbp === 20 && live.vat_output.provenance === 'ESTIMATED', 'VAT: £120 VAT-inclusive at 20% → £20, labelled ESTIMATED');
  check(live.telephony_usage.provenance === 'ACTUAL' && live.number_rental.amountGbp === 7, 'Twilio usage and number rental are ACTUAL supplier totals');
  check(live.ai_transcription.provenance === 'ESTIMATED', 'OpenAI is ESTIMATED');
  check(live.hosting.provenance === 'MANUAL' && live.email.provenance === 'NOT_CONNECTED', 'configured fixed costs are MANUAL; unset ones NOT CONNECTED');
  check(live.revenue_app_stores.amountGbp === 0 && live.store_commission.amountGbp === 0, 'no app-store subscriptions → app-store revenue and commission are genuinely £0');

  const pnl = buildProfitAndLoss({ period, ledgerEntries: null, liveFigures: live, units: { activeCustomers: 10, genuinePayingCustomers: 4, monitoredMinutes: 50 } });
  check(pnl.totals.grossRevenue.amountGbp === 120 && pnl.totals.grossRevenue.complete, 'gross revenue £120, complete');
  check(pnl.totals.netRevenueExVat.amountGbp === 100, 'revenue ex-VAT = 120 − 0 refunds − 20 VAT = £100');
  check(pnl.totals.variableCost.amountGbp === 13.1, 'variable cost = 2.5 fees + 3.2 usage + 7 rental + 0.4 AI + 0 commission = £13.10');
  check(pnl.totals.grossContribution.amountGbp === 86.9, 'gross contribution = £86.90');
  check(pnl.totals.fixedCost.amountGbp === 25 && pnl.totals.fixedCost.complete === false, 'fixed cost £25 but incomplete (Resend and other overheads not connected)');
  check(pnl.totals.operatingProfit.amountGbp === 61.9 && pnl.totals.operatingProfit.complete === false, 'operating profit £61.90, flagged incomplete');
  check(pnl.unitEconomics.telephonyCostPerActiveCustomer.amountGbp === 1.02, 'telephony cost per active customer = 10.2 / 10');
  check(pnl.unitEconomics.monitoredMinutesPerActiveCustomer === 5, 'monitored minutes per active customer = 50 / 10');
  check(pnl.unitEconomics.netRevenuePerPayingCustomer.amountGbp === 25, 'net revenue per genuine paying customer = 100 / 4');
  check(pnl.unitEconomics.customerAcquisitionCost.provenance === 'NOT_CONNECTED', 'CAC is NOT CONNECTED until attribution exists');
  check(pnl.ledgerConnected === false, 'reports that the ledger is not connected');

  // Ledger takes over line by line.
  const ledgerEntries = [
    { entry_class: 'cost', category: 'inbound_voice', supplier: 'twilio', provenance: 'provider_actual', amount: 1.1, native_currency: 'GBP', occurred_at: '2026-09-10T10:00:00Z' },
    { entry_class: 'cost', category: 'media_stream', supplier: 'twilio', provenance: 'provider_allocated', amount: 0.9, native_currency: 'GBP', occurred_at: '2026-09-11T10:00:00Z' },
    { entry_class: 'cost', category: 'app_leg', supplier: 'twilio', provenance: 'provider_actual', amount: null, native_currency: 'GBP', occurred_at: '2026-09-12T10:00:00Z' },
    { entry_class: 'cost', category: 'inbound_voice', supplier: 'telnyx', provenance: 'provider_actual', amount: 5, native_currency: 'USD', occurred_at: '2026-09-12T10:00:00Z' },
    { entry_class: 'cost', category: 'advertising', supplier: 'meta', provenance: 'manual', amount: 50, native_currency: 'GBP', occurred_at: '2026-09-05T00:00:00Z', campaign_ref: 'meta/paid_social/launch' },
    { entry_class: 'cost', category: 'hosting', supplier: 'railway', provenance: 'manual', amount: 6, native_currency: 'GBP', occurred_at: '2026-08-01T00:00:00Z' },
  ];
  const usage = aggregateLedgerLine(ledgerEntries, LINE_DEFINITIONS.find((d) => d.id === 'telephony_usage'), period);
  check(usage.amountGbp === 2 && usage.provenance === 'MIXED' && usage.provenanceMix.ACTUAL === 1 && usage.provenanceMix.ALLOCATED === 1, 'ledger telephony: £2.00 from one actual + one allocated row → MIXED provenance');
  check(usage.unobservedEntries === 1 && usage.excludedNonGbpEntries === 1, 'a not-yet-observed charge is not counted as zero; a USD row is excluded (no FX yet), never silently converted');
  const pnlLedger = buildProfitAndLoss({ period, ledgerEntries, liveFigures: live, units: {} });
  const line = (id) => pnlLedger.lines.find((l) => l.id === id);
  check(line('telephony_usage').source === 'ledger' && line('telephony_usage').amountGbp === 2, 'telephony usage now comes from the ledger');
  check(line('advertising').source === 'ledger' && line('advertising').amountGbp === 50 && line('advertising').provenance === 'MANUAL', 'advertising from a manual ledger entry');
  check(line('hosting').source === 'settings', 'a ledger row outside the period is ignored; hosting falls back to the live (settings) figure');
  check(line('revenue_stripe').source === 'stripe', 'lines the ledger has nothing for keep their live source');
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
  check(anyRouterCall.length === 4 && anyRouterCall.every((m) => m === 'get'), 'the router registers nothing but four GET handlers (any quote style, no router.use/all/post)');
  check(decls.length === 4 && decls.every((d) => d[1] === 'get'), 'exactly four routes, all GET — no write endpoint exists');
  check(decls.map((d) => d[2]).join() === '/admin/api/business-control/subscriptions,/admin/api/business-control/reconciliation,/admin/api/business-control/finance,/admin/api/business-control/marketing', 'routes: subscriptions, reconciliation, finance, marketing');
  check(decls.every((d) => d[3].includes('requireAuth') && d[3].includes('requireAdmin')), 'every route requires an authenticated admin');
  check(!/recordAdminAction|express\.json\(\)/.test(routeSrc), 'no request bodies are parsed and no admin actions recorded (nothing to act on)');

  const dir = path.join(__dirname, '..', 'services', 'businessControl');
  const files = ['subscriptionOverview.js', 'numberReconciliation.js', 'financialReadModel.js', 'financialOverview.js', 'campaignPerformance.js'];
  const code = (f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const all = files.map(code).join('\n') + '\n' + routeSrc;
  check(!/\.(insert|update|upsert|delete|rpc)\(/.test(all), 'no database write or RPC anywhere in the dashboard services or routes');
  check(!/from\(\s*['"](financial_entries|manual_cost_schedules|customer_acquisition|telephony_call_legs)['"]/.test(all), 'no query touches tables from migrations 048/049/050 (live-source fallback only)');
  check(!/\.remove\(|\.create\(|availablePhoneNumbers|incomingPhoneNumbers\.create|incomingPhoneNumbers\([^)]*\)\.(update|remove)/.test(all), 'no Twilio number is purchased, released or updated');
  check(!/stripe\.[a-zA-Z]+\.(create|update|del|cancel)/.test(all), 'no Stripe object is created, updated or cancelled');
  const providerCalls = [...all.matchAll(/incomingPhoneNumbers\.[a-zA-Z]+/g)].map((m) => m[0]);
  check(providerCalls.length === 1 && providerCalls[0] === 'incomingPhoneNumbers.list', 'the only Twilio number call is a read-only list');
  check(!/pending_release|quarantine[a-zA-Z]*\(|markTwilio|releaseHousehold|release_household|mark_household_twilio/.test(all.replace(/twilio_number_pending_release_at/g, '').replace(/twilio_number_quarantine/g, '')), 'no number is scheduled, quarantined or released (only lifecycle columns are read)');
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

  for (const id of ['subscriptions', 'reconciliation', 'finance', 'marketing']) {
    check(html.includes(`id="tabBtn-${id}"`) && html.includes(`<div id="${id}" class="tab-panel"`), `tab "${id}" has a button and a panel`);
  }
  check(/const TAB_NAMES = \['business', 'customers', 'subscriptions', 'reconciliation', 'finance', 'marketing', 'operations', 'systemhealth'\]/.test(html), 'existing Business / Customers / Operations / System Health tabs kept');

  const evil = '"><img src=x onerror=alert(1)>';
  const elements = {};
  const stubEl = (id) => (elements[id] = elements[id] || { id, innerHTML: '', textContent: '', value: '', addEventListener() {}, hidden: false });
  const documentStub = { getElementById: (id) => stubEl(id) };
  const responses = {};
  const fetchStub = async (url) => ({ ok: true, redirected: false, status: 200, json: async () => responses[url.split('/business-control/')[1]] });
  const factory = new Function('document', 'fetch', 'window', 'fmtNum', `${monitorHelpers}\n${dateTime}\n${tabs}\nreturn { renderSubscriptionsTab, renderReconciliationTab, renderFinanceTab, renderMarketingTab, provenanceBadge, formatGbpOrMissing, describeTotal, reconciliationBanner, chainStageClass, buildTrackedGoLinkClient };`);
  const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB'));
  const ui = factory(documentStub, fetchStub, { location: { origin: 'https://homecallguard.co.uk' } }, fmtNum);

  check(ui.formatGbpOrMissing(null) === 'Not connected' && ui.formatGbpOrMissing(0) === '£0.00' && ui.formatGbpOrMissing(-12.5) === '−£12.50', 'money formatting: missing is "Not connected", never £0; negatives shown');
  check(ui.describeTotal({ amountGbp: 10, complete: false }).incomplete === true, 'incomplete totals flagged');
  check(ui.provenanceBadge('NOT_CONNECTED').includes('Not connected') && ui.provenanceBadge(evil).includes('&lt;img'), 'provenance badge labels and escapes unknown values');
  check(ui.reconciliationBanner('ACTION_REQUIRED', 2, 1).text.startsWith('ACTION REQUIRED') && ui.reconciliationBanner('OK', 0, 0).className === 'ready', 'reconciliation banner OK / ACTION REQUIRED');
  check(ui.chainStageClass({ state: 'awaiting confirmation' }) === 'chain-bad' && ui.chainStageClass({ state: 'yes' }) === 'chain-good', 'lifecycle chain stage colouring');
  check(ui.buildTrackedGoLinkClient('https://homecallguard.co.uk', { source: 'TikTok', medium: 'paid_social', campaign: 'Oct Launch', content: '123' }) === 'https://homecallguard.co.uk/go?utm_source=tiktok&utm_medium=paid_social&utm_campaign=oct-launch&utm_content=123', 'client link builder matches the server convention');

  responses.subscriptions = { generatedAt: NOW.toISOString(), counts: { households: 1, deletedAccounts: 0, genuinePayingCustomers: 0, activePaidSubscriptions: { total: 0, genuine: 0, bySource: { [evil]: 1 } }, cancellingAtPeriodEnd: { total: 0, genuine: 0 }, paymentIssue: { total: 0, genuine: 0 }, cancelledSubscriptions: { total: 0, genuine: 0 }, complimentary: 1, trial: 0, nonGenuineAccounts: { internal_test: 0, admin: 0, reviewer: 0, qa_automation: 0 }, nonGenuineWithActiveAccess: 0, unclassifiedWithActiveAccess: 1, newGenuinePayingLast7d: 0, newGenuinePayingLast30d: 0 }, churn: { available: false, reason: evil }, needsClassification: [{ householdId: 'h', email: evil, entitlementType: evil }] };
  responses.reconciliation = { generatedAt: NOW.toISOString(), overall: 'ACTION_REQUIRED', actionCount: 1, watchCount: 0, okCount: 0, anomalyCounts: { NUMBER_RETAINED_NO_ENTITLEMENT: 1 }, anomalyDefinitions: { NUMBER_RETAINED_NO_ENTITLEMENT: { severity: 'action', label: 'x' } }, rows: [{ householdId: 'h', email: evil, hcgNumber: evil, status: 'action_required', anomalies: [{ severity: 'action', label: evil, detail: evil }], chain: [{ key: 'number', label: evil, state: evil, at: null }] }], notes: [evil] };
  responses.finance = { generatedAt: NOW.toISOString(), period: { label: evil }, totals: { grossRevenue: { amountGbp: null, complete: false }, netRevenueExVat: null, variableCost: null, grossContribution: null, fixedCost: null, marketingSpend: null, operatingProfit: null }, lines: [{ id: 'x', section: 'revenue', label: evil, amountGbp: null, provenance: evil, basis: evil }], unitEconomics: { activeCustomers: 1, genuinePayingCustomers: 0, costPerActiveCustomer: null, telephonyCostPerActiveCustomer: null, netRevenuePerPayingCustomer: null, monitoredMinutes: null, monitoredMinutesPerActiveCustomer: null, customerAcquisitionCost: { basis: evil } }, connections: { [evil]: evil } };
  responses.marketing = { generatedAt: NOW.toISOString(), windowDays: 90, chain: [{ stage: evil, status: 'NOT_CONNECTED', note: evil }], rows: [{ label: evil, channel: evil, landingVisits: 1, registrationsCompleted: 0, spend: { amountGbp: null }, payingCustomers: null, cac: null }], unattributed: { checkoutsStarted: 0, paidConversions: 0, note: evil } };

  await ui.renderSubscriptionsTab();
  await ui.renderReconciliationTab();
  await ui.renderFinanceTab();
  await ui.renderMarketingTab();
  for (const id of ['subscriptions', 'reconciliation', 'finance', 'marketing']) {
    const out = elements[id].innerHTML;
    check(out.length > 200 && !out.includes('<img') && !out.includes('onerror=alert(1)>') && out.includes('&lt;img src=x onerror=alert(1)&gt;'), `${id} tab renders hostile data as escaped text, never markup`);
  }
  check(elements.finance.innerHTML.includes('Not connected') && !/£0\.00/.test(elements.finance.innerHTML.split('Manual costs')[0]), 'finance tab shows missing figures as "Not connected", not £0.00');
  check(elements.finance.innerHTML.includes('Manual costs') && elements.finance.innerHTML.includes('Not available yet') && !elements.finance.innerHTML.includes('<form'), 'finance tab explains manual costs are not available yet and offers no form');
  check(!/method\s*:|'POST'|"POST"/.test(tabs), 'the business-control tabs only ever issue GET requests');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All business control checks passed.');
