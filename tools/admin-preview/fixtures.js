// SYNTHETIC preview fixtures for the Admin Control Centre (admin redesign,
// 2026-10-04). NOT production data, NOT staging data: every household,
// email (example.com) and telephone number below is invented, apart from
// HCG's own staging test number (a business asset, shown masked) so the
// "never release the staging number" rule can be previewed.
//
// Wherever a pure builder exists, the payload is produced by the REAL
// server-side code (canonical classifiers, lifecycle, inventory, usage,
// subscription, reconciliation, Fortress overview), so the preview shows
// what those modules actually derive — only the input rows are invented.
// Payloads with no pure builder (finance, marketing, the legacy
// /admin/api/overview feeds) are hand-built to the shapes their renderers
// and tests use.
//
// Used by tools/admin-preview/serve.js and tests/admin-control-centre-redesign.test.mjs.
'use strict';

// Pure modules only; no network or database is touched. Dummy values keep
// modules that read configuration at require time quiet.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'preview';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'preview';

const path = require('path');
const root = path.join(__dirname, '..', '..');
const req = (p) => require(path.join(root, p));

const { buildControlCentreSummary } = req('services/adminControlCentre/summary');
const { formatAccountNumber } = req('services/customerIdentity/accountNumber');
const { buildOnboardingRow } = req('database/adminMetrics');
const { computeControlOverview } = req('services/businessControl/controlOverview');
const { buildNumberInventory } = req('services/businessControl/numberInventory');
const { computeSubscriptionOverview } = req('services/businessControl/subscriptionOverview');
const { computeNumberReconciliation } = req('services/businessControl/numberReconciliation');
const { computeUsageSafety, summariseForOverview } = req('services/businessControl/usageSafety');
const { getFortressOverview } = req('services/businessControl/fortressOverview');
const { buildExceptionQueue } = req('services/lifecycle/exceptionQueue');

const NOW = new Date('2026-10-04T15:00:00Z');
const H = 3600e3;
const D = 24 * H;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms) => new Date(NOW.getTime() + ms).toISOString();
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STAGING_NUMBER = '+442046521883';

// ---------------------------------------------------------------------------
// Households — the first five genuine customers plus every non-genuine kind.
// ---------------------------------------------------------------------------
function household(n, over) {
  return {
    id: id(n), account_number: formatAccountNumber(10000 + n), status: 'active', auth_user_id: id(900 + n),
    email: `sample.customer${String(n).padStart(2, '0')}@example.com`, created_at: ago(10 * D), stripe_customer_id: null,
    twilio_number: null, twilio_provisioning_status: 'not_started', twilio_provisioning_updated_at: null, twilio_number_pending_release_at: null,
    activation_verified_at: null, voice_client_registered_at: null, delivery_verified_at: null,
    device_type: 'mobile', carrier_provider_key: 'giffgaff', app_version: null, app_build_version: null, app_platform: null,
    ...over,
  };
}
const withNumber = (n, at, extra = {}) => ({ twilio_number: `+44207946${String(n).padStart(4, '0')}`, twilio_provisioning_status: 'active', twilio_provisioning_updated_at: at, ...extra });
const app = { app_version: '1.0.2', app_build_version: '22', app_platform: 'android' };

const people = [
  { key: 'g_protected', cls: 'genuine_customer', h: household(1, { created_at: ago(18 * D), stripe_customer_id: 'cus_synthetic01', ...withNumber(1, ago(18 * D)), ...app, carrier_provider_key: 'ee', activation_verified_at: ago(17 * D), voice_client_registered_at: ago(2 * H), delivery_verified_at: ago(17 * D) }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'stripe', starts_at: ago(18 * D), ends_at: ahead(12 * D) }], sub: { status: 'active' } },
  { key: 'g_new', cls: 'genuine_customer', h: household(2, { created_at: ago(3 * H), stripe_customer_id: 'cus_synthetic02', ...withNumber(2, ago(170 * 60e3)), carrier_provider_key: 'vodafone' }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'stripe', starts_at: ago(175 * 60e3), ends_at: ahead(30 * D) }], sub: { status: 'active' } },
  { key: 'g_incident', cls: 'genuine_customer', h: household(3, { created_at: ago(3 * D), stripe_customer_id: 'cus_synthetic03', ...withNumber(3, ago(3 * D)), carrier_provider_key: 'o2', activation_verified_at: ago(60 * H) }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'stripe', starts_at: ago(3 * D), ends_at: ahead(27 * D) }], sub: { status: 'active' },
    lastDial: { created_at: ago(5 * H), dial_call_status: 'no-answer' } },
  { key: 'g_apple', cls: 'genuine_customer', h: household(4, { created_at: ago(2 * D), ...withNumber(4, ago(2 * D)), ...app, app_platform: 'ios', device_type: 'iphone', carrier_provider_key: 'three', activation_verified_at: ago(40 * H), voice_client_registered_at: ago(41 * H), delivery_verified_at: ago(20 * H) }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'apple_revenuecat', revenuecat_environment: 'production', starts_at: ago(2 * D), ends_at: ahead(28 * D) }] },
  { key: 'g_payment', cls: 'genuine_customer', h: household(5, { created_at: ago(26 * D), stripe_customer_id: 'cus_synthetic05', ...withNumber(5, ago(26 * D)), ...app, carrier_provider_key: 'sky', activation_verified_at: ago(25 * D), voice_client_registered_at: ago(6 * H), delivery_verified_at: ago(25 * D) }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'stripe', starts_at: ago(26 * D), ends_at: ahead(4 * D) }], sub: { status: 'past_due', updated_at: ago(5 * D) } },
  { key: 'comp', cls: null, h: household(6, { created_at: ago(9 * D), ...withNumber(6, ago(9 * D)), ...app, activation_verified_at: ago(8 * D), voice_client_registered_at: ago(1 * D), delivery_verified_at: ago(8 * D) }),
    ents: [{ entitlement_type: 'complimentary', source: 'admin', starts_at: ago(9 * D), ends_at: ahead(81 * D) }] },
  { key: 'internal', cls: 'internal_test', h: household(7, { created_at: ago(30 * D), stripe_customer_id: 'cus_synthetic07', ...withNumber(7, ago(30 * D)), ...app, activation_verified_at: ago(29 * D), voice_client_registered_at: ago(1 * H), delivery_verified_at: ago(29 * D) }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'stripe', starts_at: ago(30 * D), ends_at: ahead(1 * D) }], sub: { status: 'active' } },
  { key: 'reviewer', cls: 'reviewer', h: household(8, { created_at: ago(6 * D), ...withNumber(8, ago(6 * D)), device_type: 'iphone' }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'apple_revenuecat', revenuecat_environment: 'sandbox', starts_at: ago(6 * D), ends_at: ahead(1 * D) }] },
  { key: 'sandbox', cls: null, h: household(9, { created_at: ago(4 * D), ...withNumber(9, ago(4 * D)), device_type: 'iphone' }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'apple_revenuecat', revenuecat_environment: 'sandbox', starts_at: ago(4 * D), ends_at: ahead(1 * D) }] },
  { key: 'unverified', cls: null, h: household(10, { created_at: ago(1 * D), device_type: 'iphone' }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'apple_revenuecat', revenuecat_environment: null, starts_at: ago(1 * D), ends_at: ahead(29 * D) }] },
  { key: 'former', cls: 'genuine_customer', h: household(11, { created_at: ago(40 * D), stripe_customer_id: 'cus_synthetic11', status: 'cancelled', activation_verified_at: ago(39 * D), voice_client_registered_at: ago(39 * D), delivery_verified_at: ago(39 * D) }),
    ents: [{ entitlement_type: 'paid_subscription', source: 'stripe', status: 'expired', starts_at: ago(40 * D), ends_at: ago(4 * D) }], sub: { status: 'canceled' } },
  { key: 'signed_up', cls: null, h: household(12, { created_at: ago(20 * H), carrier_provider_key: null, device_type: null }), ents: [] },
];

const households = people.map((p) => p.h);
const entitlements = people.flatMap((p) => p.ents.map((e, i) => ({ id: id(500 + Number(p.h.id.slice(-3)) * 10 + i), household_id: p.h.id, status: 'active', updated_at: e.starts_at, external_reference: null, ...e })));
const subscriptions = people.filter((p) => p.sub).map((p, i) => ({ household_id: p.h.id, stripe_subscription_id: `sub_synthetic${i}`, cancel_at_period_end: false, created_at: p.h.created_at, updated_at: p.h.created_at, current_period_end: ahead(20 * D), ...p.sub }));
const classificationMap = new Map(people.filter((p) => p.cls).map((p) => [p.h.id, p.cls]));
const quarantineRows = [
  { id: 'q-former', household_id: id(11), twilio_number: '+442079460011', release_reason: 'membership_ended', deactivation_confirmed: false, deactivation_confirmed_at: null, quarantined_at: ago(4 * D), released_at: null },
  { id: 'q-orphan', household_id: null, twilio_number: '+442079460510', release_reason: 'manual', deactivation_confirmed: false, deactivation_confirmed_at: null, quarantined_at: ago(11 * D), released_at: null },
];
const byHousehold = (rows) => rows.reduce((m, r) => (r.household_id ? m.set(r.household_id, [...(m.get(r.household_id) || []), r]) : m), new Map());

// ---------------------------------------------------------------------------
// Canonical summary (the redesign's own endpoint) — REAL builder.
// ---------------------------------------------------------------------------
const snapshots = people.map((p) => ({
  household: p.h,
  entitlements: entitlements.filter((e) => e.household_id === p.h.id),
  subscription: subscriptions.find((s) => s.household_id === p.h.id) || null,
  quarantineRows: quarantineRows.filter((q) => q.household_id === p.h.id),
  financialHold: null,
  currentNumberAssignedAt: p.h.twilio_provisioning_status === 'active' ? p.h.twilio_provisioning_updated_at : null,
  failedStripeEvents: [],
  liveSubscriptionEventsAfterDeletion: [],
  classification: p.cls,
  deliveryHealth: null,
}));
const orphanQuarantineRows = quarantineRows.filter((q) => !q.household_id);

function controlCentreSummary() {
  return { ...buildControlCentreSummary({ snapshots, orphanQuarantineRows }, NOW), sources: { subscriptions: 'ok', financialHolds: 'ok', routingAssignments: 'ok', deliveryHealth: 'not_loaded_in_bulk' }, truncated: false };
}

// ---------------------------------------------------------------------------
// Customers feed (/admin/api/customers/onboarding) — REAL row builder.
// ---------------------------------------------------------------------------
function onboarding() {
  const entsBy = byHousehold(entitlements);
  const subsBy = byHousehold(subscriptions);
  const classLabel = (c) => c || null;
  const rows = people.map((p) => buildOnboardingRow({
    household: p.h,
    entitlements: entsBy.get(p.h.id) || [],
    subscription: (subsBy.get(p.h.id) || [])[0],
    lastCall: p.lastDial ? { created_at: p.lastDial.created_at, status: 'Unknown', result: null } : (p.h.delivery_verified_at ? { created_at: ago(26 * H), status: 'Known', result: 'SAFE' } : null),
    lastDial: p.lastDial || null,
    classification: classLabel(p.cls),
  }, NOW));
  const { summariseCustomerHealth } = req('services/adminCustomerHealth');
  return { available: true, generatedAt: NOW.toISOString(), thresholdHours: 24, classificationAvailable: true, truncated: false, summary: summariseCustomerHealth(rows), deletedAccountsHidden: 0, rows };
}

function householdStatus(householdId) {
  const p = people.find((x) => x.h.id === householdId);
  if (!p) return null;
  const row = onboarding().rows.find((r) => r.householdId === householdId);
  const { deriveAdminCustomerState } = req('services/adminOnboardingStatus');
  const derived = deriveAdminCustomerState({ household: p.h, entitlements: entitlements.filter((e) => e.household_id === householdId), lastCallAt: row.lastCallAt }, NOW);
  const recentCalls = p.key === 'g_incident'
    ? [5, 19, 30, 44].map((h) => ({ at: ago(h * H), caller: '…' + String(4810 + h).slice(-4), status: 'Unknown', result: null, terminatedBySystem: false, dialCallStatus: 'no-answer', clientInviteReceivedAt: null, clientOutcome: null, durationSeconds: 31 }))
    : p.h.delivery_verified_at ? [{ at: ago(26 * H), caller: '…2231', status: 'Known', result: 'SAFE', terminatedBySystem: false, dialCallStatus: 'completed', clientInviteReceivedAt: ago(26 * H), clientOutcome: 'accepted', durationSeconds: 184 }] : [];
  return {
    available: true, found: true, customer: row, timeline: derived.timeline, recentCalls,
    technical: {
      householdId, hcgNumber: p.h.twilio_number ? '•••' + p.h.twilio_number.slice(-3) : null, provisioningStatus: p.h.twilio_provisioning_status, provisioningAttempts: 1, provisioningLastError: null,
      provisioningUpdatedAt: p.h.twilio_provisioning_updated_at, deviceType: p.h.device_type, carrierProviderKey: p.h.carrier_provider_key, carrierTariffType: 'pay_monthly', carrierCapturedAt: p.h.created_at,
      activationVerifiedAt: p.h.activation_verified_at, voiceClientRegisteredAt: p.h.voice_client_registered_at, deliveryVerifiedAt: p.h.delivery_verified_at,
      appVersion: p.h.app_version, appBuildVersion: p.h.app_build_version, appPlatform: p.h.app_platform, mostRecentDialOutcome: p.lastDial ? { status: p.lastDial.dial_call_status, at: p.lastDial.created_at } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// v2 business-control payloads — REAL builders where pure.
// ---------------------------------------------------------------------------
const providerNumbers = [
  ...households.filter((h) => h.twilio_number).map((h) => ({ phoneNumber: h.twilio_number, sid: 'PNsynthetic' + h.id.slice(-4), voiceUrl: 'https://homecallguard.co.uk/voice', dateCreated: new Date(h.twilio_provisioning_updated_at) })),
  { phoneNumber: '+442079460011', sid: 'PNsyntheticQ011', voiceUrl: 'https://homecallguard.co.uk/voice', dateCreated: new Date(ago(40 * D)) },
  { phoneNumber: '+442079460510', sid: 'PNsyntheticQ510', voiceUrl: 'https://homecallguard.co.uk/voice', dateCreated: new Date(ago(60 * D)) },
  { phoneNumber: STAGING_NUMBER, sid: 'PNsyntheticS883', voiceUrl: '', dateCreated: new Date(ago(45 * D)) },
];

function inventory() {
  return buildNumberInventory({
    providerNumbers, households, entitlementsByHousehold: byHousehold(entitlements), subscriptionsByHousehold: byHousehold(subscriptions), classificationMap,
    quarantineRows, productionHosts: new Set(['homecallguard.co.uk']), rental: { perNumber: 0.87, currency: 'GBP', basis: 'Twilio usage records, last month (synthetic)' }, releaseRecordingAvailable: true,
    lastCallByHousehold: new Map(people.filter((p) => p.h.delivery_verified_at || p.lastDial).map((p) => [p.h.id, p.lastDial ? p.lastDial.created_at : ago(26 * H)])),
  }, NOW);
}

const stripeRevenue = { available: true, mode: 'live', vatRate: 0.2, mrr: { genuine: { GBP: 23.96 }, genuineSubscriptions: 4, excludedNonGenuine: { GBP: 5.99 }, excludedSubscriptions: 1, unattributed: {}, unattributedSubscriptions: 0, livemode: true }, collectedThisMonth: { genuine: { GBP: 11.98 }, genuineCharges: 2 } };

function calls() {
  const out = [];
  let n = 0;
  const add = (hh, msAgo, status, extra = {}) => out.push({ household_id: hh, created_at: ago(msAgo), number: '+447700900' + String(100 + (n++ % 800)).padStart(3, '0'), status, result: status === 'Known' ? 'SAFE' : 'SAFE', duration_seconds: 95, monitored_duration_seconds: status === 'Unknown' ? 80 : null, monitoring_limit_reached: false, dial_call_status: 'completed', terminated_by_system: false, warning_sent: false, ...extra });
  for (let d = 0; d < 14; d += 1) {
    add(id(1), d * D + 3 * H, 'Known');
    if (d % 2 === 0) add(id(1), d * D + 5 * H, 'Unknown');
    add(id(5), d * D + 4 * H, 'Known');
    if (d % 3 === 0) add(id(7), d * D + 2 * H, 'Unknown', { result: 'SCAM', warning_sent: true });
  }
  for (const h of [5, 19, 30, 44]) add(id(3), h * H, 'Unknown', { dial_call_status: 'no-answer', duration_seconds: 31, monitored_duration_seconds: 25 });
  add(id(4), 20 * H, 'Known');
  add(id(6), 30 * H, 'Unknown', { result: 'SCAM', terminated_by_system: true, warning_sent: true });
  return out;
}

function usageSafety() {
  return computeUsageSafety({ calls: calls(), households: households.map((h) => ({ id: h.id, email: h.email })), classificationMap, env: {}, present: () => false, truncated: false }, NOW);
}

function businessControlOverview() {
  const inv = inventory();
  const usage = usageSafety();
  return {
    available: true, generatedAt: NOW.toISOString(),
    usageSafety: summariseForOverview(usage),
    financialSafety: { state: 'fresh', level: 'NORMAL', asOf: ago(2 * H), ageHours: 2, reason: null, warnings: [] },
    ...computeControlOverview({ households, entitlementsByHousehold: byHousehold(entitlements), subscriptionsByHousehold: byHousehold(subscriptions), classificationMap, quarantineRows, inventory: inv, stripeRevenue, releaseRecordingAvailable: true }, NOW),
    inventory: inv, inventoryReason: null,
    stripe: { mode: 'live', mrr: stripeRevenue.mrr, collectedThisMonth: stripeRevenue.collectedThisMonth, vatRate: 0.2 },
  };
}

function subscriptionsPayload() {
  return { available: true, generatedAt: NOW.toISOString(), ...computeSubscriptionOverview({ households, entitlements, subscriptions, classificationMap }, NOW) };
}

function reconciliationPayload() {
  return { available: true, generatedAt: NOW.toISOString(), ...computeNumberReconciliation({ households, entitlements, subscriptions, quarantineRows, providerNumbers: providerNumbers.map((p) => p.phoneNumber), classificationMap }, NOW) };
}

const line = (id, section, label, amountGbp, provenance, basis) => ({ id, section, label, amountGbp, provenance, basis });
function financePayload() {
  return {
    available: true, generatedAt: NOW.toISOString(), period: { label: 'October 2026 (month to date)' }, stripeMode: 'live', source: 'live provider reads (synthetic preview)',
    totals: {
      revenueExVat: { amountGbp: 19.97, complete: true },
      totalOperatingCost: { amountGbp: 16.42, complete: false, partial: true },
      grossContribution: { amountGbp: 11.47, complete: false, partial: true },
      operatingContribution: { amountGbp: 3.55, complete: false, partial: true },
      marketing: { amountGbp: null, complete: false },
    },
    lines: [
      line('revenue', 'revenue', 'Subscription revenue ex VAT (genuine)', 19.97, 'ACTUAL', '£23.96 collected from 4 genuine-customer payments (Stripe, net of refunds) less VAT at 20%'),
      line('apple', 'revenue', 'App Store revenue', null, 'NOT_CONNECTED', 'RevenueCat revenue is not connected — 1 genuine Apple customer'),
      line('numbers', 'direct', 'Twilio number rental', 8.70, 'ACTUAL', '10 numbers × £0.87 (Twilio usage records)'),
      line('inbound', 'direct', 'Inbound call minutes', 3.21, 'ESTIMATED', 'register rate × recorded call minutes'),
      line('ai', 'direct', 'AI monitoring (OpenAI)', 1.43, 'ESTIMATED', 'register rate × monitored minutes'),
      line('sms', 'direct', 'Warning SMS', 0.08, 'ESTIMATED', '2 warning SMS × register rate'),
      line('railway', 'overhead', 'Railway hosting', 5.00, 'MANUAL', 'set by you on 1 Oct 2026'),
      line('supabase', 'overhead', 'Supabase', null, 'NOT_CONNECTED', 'set SUPABASE_MONTHLY_COST_GBP'),
    ],
    unitEconomics: { accountsWithAccess: 9, genuinePayingCustomers: 5, operatingCostPerAccountWithAccess: { amountGbp: 1.82, complete: false, partial: true }, telephonyPerAccountWithAccess: { amountGbp: 1.32, complete: true }, revenueExVatPerGenuinePayingCustomer: { amountGbp: 4.99, complete: true }, unknownCallMinutes: 38, monitoredMinutes: 31, minutesIncomplete: false, customerAcquisitionCost: { basis: 'No marketing spend source is connected.' } },
    fixedCostSettings: [{ label: 'Railway hosting', configured: true, valueGbp: 5, asOf: '2026-10-01', stale: false, howToFind: 'Railway → Usage' }, { label: 'Supabase', configured: false, amountVar: 'SUPABASE_MONTHLY_COST_GBP', asOfVar: 'SUPABASE_MONTHLY_COST_AS_OF', howToFind: 'Supabase → Billing' }],
    connections: { source: 'live provider reads (synthetic preview)', stripe: 'live', twilio: 'connected', openai: 'usage API not connected (estimated)', revenuecat: 'not connected' },
    safety: {
      state: 'fresh', level: 'NORMAL', asOf: ago(2 * H), ageHours: 2, reason: null, warnings: [],
      projection: { monthToDateGbp: 13.42, projectedMonthGbp: 98.4 },
      topHouseholds: [], actions: [],
    },
  };
}

function marketingPayload() {
  return {
    available: true, generatedAt: NOW.toISOString(), windowDays: 90,
    channelComparison: {
      rows: [{ label: 'Website (direct)', visits: 412, registrations: 9, otherDetails: {} }, { label: 'Facebook', visits: 128, registrations: 3, otherDetails: {} }],
      stageStatus: { visits: { status: 'ACTUAL', note: 'page requests' }, signups: { status: 'PARTIAL', note: 'attributed signups' }, payingCustomers: { status: 'NOT_CONNECTED', note: 'not attributed yet' }, revenue: { status: 'NOT_CONNECTED', note: '—' }, cac: { status: 'NOT_CONNECTED', note: '—' } },
      selfReported: { status: 'NOT_CAPTURED', note: 'Self-reported "how did you hear about us" is not asked yet' },
    },
    chain: [{ stage: 'Visit → signup', status: 'ACTUAL', note: '—' }],
    rows: [{ label: 'go / facebook / launch', channel: 'facebook', landingVisits: 128, registrationsCompleted: 3, spend: { amountGbp: null }, payingCustomers: null, cac: null }],
    unattributed: { checkoutsStarted: 2, paidConversions: 1, note: 'Checkouts without a campaign tag' },
  };
}

// ---------------------------------------------------------------------------
// Legacy feeds (hand-built to the renderer shapes).
// ---------------------------------------------------------------------------
function callStats(scale) {
  return { available: true, truncated: false, totalCalls: 6 * scale, knownContactCalls: 3 * scale, unknownMonitoredCalls: 3 * scale, safeCalls: 2 * scale, suspiciousCalls: scale, highRiskCalls: Math.ceil(scale / 3), warningsSent: Math.ceil(scale / 3), callsTerminatedByHcg: Math.ceil(scale / 5), averageRiskScore: 31 };
}
function businessOverview() {
  const comp = (status, reason) => ({ status, reason });
  return {
    generatedAt: NOW.toISOString(),
    systemHealth: { overall: 'AMBER', checkedAt: NOW.toISOString(), components: {
      twilio: comp('GREEN', 'Account reachable; API responded in 210 ms'),
      openai: comp('GREEN', 'API key configured; last transcription 26 minutes ago'),
      supabase: comp('GREEN', 'Database reachable'),
      stripe: comp('GREEN', 'Live mode; no failed webhooks in 24 h'),
      revenuecat: comp('AMBER', 'Webhook configured; revenue not connected to this dashboard'),
      resend: comp('GREEN', 'Email provider configured'),
      railway: comp('GREEN', 'Running release 7c39828'),
    } },
    callStats: { today: callStats(1), monthToDate: callStats(6) },
    fairUse: { households: [{ householdId: id(1), email: 'sample.customer01@example.com', unknownCallCount: 7, tier: 'normal' }], truncated: false, thresholds: { warningCallsPerMonth: 150, hardCallsPerMonth: 300 } },
    release: { backend: { gitCommitSha: 'b0e46dd (synthetic)', note: 'preview', environmentName: 'preview' }, mobile: { android: { appVersion: '1.0.2', versionCode: 22, confidence: 'from app reports' }, ios: { appVersion: '1.0.2', buildNumber: 15, confidence: 'from app reports' } } },
    acquisition: { available: true, today: { rawFunnel: { landingVisits: 31 } }, monthToDate: { rawFunnel: { landingVisits: 540, registrationsSubmitted: 14, registrationsCompleted: 12, checkoutsStarted: 7, paidConversions: 5 }, classifiedGenuineCustomerFunnel: { checkoutsStarted: 6, paidConversions: 4 }, genuineConversionRatePercent: 66.7 } },
  };
}

function operationsOverview() {
  return {
    customerOperations: { provisioningFailuresCount: 0, recentRegistrations: [{ type: 'signup', email: 'sample.customer02@example.com', at: ago(3 * H) }, { type: 'signup', email: 'sample.customer12@example.com', at: ago(20 * H) }] },
    launchReadiness: { summary: { status: 'ready_with_open_items', blockersCount: 0, openCount: 2 }, items: [{ title: 'Apply migration 072 (operational events)', detail: 'Draft — not applied anywhere', severity: 'medium', done: false }, { title: 'Connect App Store revenue', detail: 'RevenueCat revenue is not read by the dashboard', severity: 'medium', done: false }] },
    recentActivityFeed: { recentCalls: [{ number: '…231', result: 'SAFE', householdEmail: 'sample.customer01@example.com', time: '26 h ago' }], recentErrors: [], adminActions: [] },
  };
}

function fortressOverview() {
  const table = (rows) => {
    const q = { select: () => q, lte: () => q, gt: () => q, order: () => q, limit: async () => ({ data: rows, error: null }), in: async () => ({ data: households.map((h) => ({ id: h.id, account_number: h.account_number, email: h.email })), error: null }), then: (r) => r({ data: rows, error: null }) };
    return q;
  };
  const budget = (n, consumed) => ({ household_id: id(n), profile: 'standard', period_start: ago(4 * D), period_end: ahead(26 * D), base_budget_gbp: 0.86, adjustments_gbp: 0, delivery_reserve_gbp: 0.1, consumed_gbp: consumed, reserved_gbp: 0, last_denial_reason: null, last_denial_at: null });
  const supabase = { from: (t) => table(t === 'fc_budget_accounts' ? [budget(1, 0.41), budget(5, 0.22), budget(3, 0.07)] : t === 'fc_events' ? [] : []) };
  return getFortressOverview({ supabase, globalStatus: async () => ({ killSwitch: false, breakerOpen: false, enforcementMode: 'enforce', activeCount: 0, activeReservedGbp: 0, activeWorstCaseGbp: 0, entitledHouseholds: 9, caps: { globalDailyGbp: 25 }, window: { spentTodayGbp: 1.92 } }), incidentState: async () => ({ level: 'normal', sources: [] }) }, NOW);
}

function lifecycleExceptions() {
  const q = buildExceptionQueue({ snapshots, orphanQuarantineRows }, NOW);
  return { label: 'read-only (synthetic)', ...q, numberRetirement: null, sources: {}, truncated: false };
}

const UNAVAILABLE = (reason) => ({ __status: 503, body: { error: 'unavailable', reason } });

async function routes() {
  const fortress = await fortressOverview();
  const map = {
    '/admin/api/control-centre/summary': controlCentreSummary(),
    '/admin/api/customers/onboarding': onboarding(),
    '/admin/api/business/overview': businessOverview(),
    '/admin/api/overview': operationsOverview(),
    '/admin/api/business-control/overview': businessControlOverview(),
    '/admin/api/business-control/subscriptions': subscriptionsPayload(),
    '/admin/api/business-control/reconciliation': reconciliationPayload(),
    '/admin/api/business-control/finance': financePayload(),
    '/admin/api/business-control/marketing': marketingPayload(),
    '/admin/api/business-control/usage-safety': { available: true, ...usageSafety() },
    '/admin/api/fortress/overview': fortress,
    '/admin/api/lifecycle/exceptions': lifecycleExceptions(),
    '/admin/api/ops-events': UNAVAILABLE('operational events not deployed (migration 072)'),
    '/admin/api/accounting/status': UNAVAILABLE('accounting tables not present (migration 071 not applied)'),
    '/admin/api/accounting/exceptions': UNAVAILABLE('accounting tables not present (migration 071 not applied)'),
    '/admin/api/complimentary-invites': { invites: [] },
  };
  for (const p of people) {
    map[`/admin/api/households/${p.h.id}/status`] = householdStatus(p.h.id);
    map[`/admin/api/households/${p.h.id}/classification`] = UNAVAILABLE('classification history needs migration 069');
  }
  return map;
}

module.exports = { NOW, people, snapshots, orphanQuarantineRows, STAGING_NUMBER, controlCentreSummary, onboarding, routes, id };
