// Regression tests for the acquisition/conversion analytics foundation
// (2026-09) — services/acquisitionAnalytics.js (recording),
// services/businessMetrics/acquisitionOverview.js (dashboard read
// side), and their wiring into server.js/routes/billing.js.
//
// Recording/read logic is exercised via pure functions and an injected
// fake Supabase client (matching this codebase's established pattern —
// see tests/complimentary-entitlement.test.mjs's makeFakeSupabaseAdmin).
// Route-wiring concerns (fire-and-forget, never blocking the real
// response, correct event placed at the correct point) are checked
// structurally against the real source, matching
// tests/account-classification.test.mjs's convention.
//
// Run with: node tests/acquisition-analytics.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy-test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';

const require = createRequire(import.meta.url);

const { parseUtmParams, parseReferrerHost, recordAcquisitionEvent, KNOWN_EVENT_TYPES } = require('../services/acquisitionAnalytics.js');
const {
  countByEventType,
  splitByGenuineCustomer,
  topUtmSources,
  computeAcquisitionSnapshot,
} = require('../services/businessMetrics/acquisitionOverview.js');

const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const billingSource = readFileSync(new URL('../routes/billing.js', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../supabase/migrations/032_acquisition_events.sql', import.meta.url), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- parseUtmParams ---

check(
  JSON.stringify(parseUtmParams({ utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'launch' })) ===
    JSON.stringify({ utmSource: 'facebook', utmMedium: 'cpc', utmCampaign: 'launch' }),
  'parseUtmParams: reads all three UTM fields when present'
);

check(
  JSON.stringify(parseUtmParams({})) === JSON.stringify({ utmSource: null, utmMedium: null, utmCampaign: null }),
  'parseUtmParams: missing fields are null, never undefined or empty string'
);

check(
  parseUtmParams({ utm_source: 123, other_field: 'ignored' }).utmSource === null,
  'parseUtmParams: a non-string value is ignored (never coerced), and unrelated fields are never read'
);

check(
  (() => {
    try {
      parseUtmParams(null);
      return true;
    } catch {
      return false;
    }
  })(),
  'parseUtmParams: a null/missing query object never throws'
);

// --- parseReferrerHost ---

check(
  parseReferrerHost('https://www.google.com/search?q=home+call+guard', 'homecallguard.co.uk') === 'www.google.com',
  'parseReferrerHost: extracts only the hostname, never the path or query string of the referring page'
);

check(
  parseReferrerHost('https://homecallguard.co.uk/some-page', 'homecallguard.co.uk') === null,
  'parseReferrerHost: this app\'s own domain is never recorded as an external referrer (internal navigation, not an acquisition source)'
);

check(
  parseReferrerHost('not a url at all', 'homecallguard.co.uk') === null,
  'parseReferrerHost: a malformed referrer never throws — returns null'
);

check(
  parseReferrerHost(undefined, 'homecallguard.co.uk') === null,
  'parseReferrerHost: a missing referrer header returns null'
);

// --- recordAcquisitionEvent: fire-and-forget safety + idempotency ---

// Minimal fake Supabase client that actually enforces the same
// (event_type, external_event_id) uniqueness migration 032's real
// database index enforces — lets the dedup behaviour be proven without
// a real database, matching this codebase's established
// fake-query-builder convention (tests/complimentary-entitlement.test.mjs).
function makeFakeDedupingClient(store) {
  return {
    from: (table) => ({
      insert: async (row) => {
        if (row.external_event_id) {
          const clash = store.some((r) => r.row.event_type === row.event_type && r.row.external_event_id === row.external_event_id);
          if (clash) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint "acquisition_events_dedup_idx"' } };
          }
        }
        store.push({ table, row });
        return { error: null };
      },
    }),
  };
}

async function testRecordsAKnownEvent() {
  const store = [];
  const client = makeFakeDedupingClient(store);
  const result = await recordAcquisitionEvent('landing_visit', { path: '/', utmSource: 'google' }, { client });

  check(result.inserted === true && result.deduplicated === false, 'recordAcquisitionEvent: reports inserted:true on a successful, first-time insert');
  check(store.length === 1 && store[0].table === 'acquisition_events', 'recordAcquisitionEvent: inserts into acquisition_events');
  check(store[0].row.event_type === 'landing_visit' && store[0].row.utm_source === 'google', 'recordAcquisitionEvent: the inserted row carries the correct event_type and fields');
  check(store[0].row.household_id === null, 'recordAcquisitionEvent: household_id defaults to null when not supplied');
}

async function testRejectsUnknownEventType() {
  const store = [];
  const client = makeFakeDedupingClient(store);
  const result = await recordAcquisitionEvent('not_a_real_event', {}, { client });

  check(result.inserted === false, 'recordAcquisitionEvent: an unrecognised event type is refused');
  check(store.length === 0, 'recordAcquisitionEvent: no row is inserted for an unrecognised event type');
}

async function testNeverThrowsWithNoClient() {
  let threw = false;
  let result;
  try {
    result = await recordAcquisitionEvent('landing_visit', {}, { client: null });
  } catch {
    threw = true;
  }
  check(!threw, 'recordAcquisitionEvent: never throws when no Supabase client is configured — fails open/silent, matching this codebase\'s established telemetry convention');
  check(result.inserted === false, 'recordAcquisitionEvent: reports inserted:false (not a thrown error) when unconfigured');
}

async function testNeverThrowsOnInsertError() {
  const client = {
    from: () => ({
      insert: async () => ({ error: { message: 'simulated database outage' } }),
    }),
  };
  let threw = false;
  let result;
  try {
    result = await recordAcquisitionEvent('landing_visit', {}, { client });
  } catch {
    threw = true;
  }
  check(!threw, 'recordAcquisitionEvent: a database error on insert is caught, never thrown — a broken analytics write must never affect the real request it\'s attached to');
  check(result.inserted === false && result.deduplicated === false, 'recordAcquisitionEvent: a genuine (non-duplicate) database error reports inserted:false, deduplicated:false');
}

// The core idempotency proof required by review: replaying the exact
// same successful Stripe webhook (same event.id) must never create a
// second paid_conversion row.
async function testReplayedWebhookNeverDoublesConversion() {
  const store = [];
  const client = makeFakeDedupingClient(store);
  const STRIPE_EVENT_ID = 'evt_test_replayed_webhook_123';

  const first = await recordAcquisitionEvent('paid_conversion', { householdId: 'household-1', externalEventId: STRIPE_EVENT_ID }, { client });
  check(first.inserted === true && first.deduplicated === false, 'recordAcquisitionEvent: the first delivery of a real paid_conversion is recorded normally');

  // Simulate Stripe redelivering the exact same webhook event.
  const replay = await recordAcquisitionEvent('paid_conversion', { householdId: 'household-1', externalEventId: STRIPE_EVENT_ID }, { client });
  check(replay.inserted === false && replay.deduplicated === true, 'recordAcquisitionEvent: replaying the exact same Stripe webhook event.id is recognised as a duplicate, not inserted again');

  const paidConversionRows = store.filter((r) => r.row.event_type === 'paid_conversion' && r.row.external_event_id === STRIPE_EVENT_ID);
  check(paidConversionRows.length === 1, 'A single real subscription/payment produces exactly ONE paid_conversion row, even after the webhook is replayed — this is enforced by the same (event_type, external_event_id) uniqueness the real migration 032 index enforces, not just in-memory logic');

  // A genuinely different real conversion (different event.id) must
  // still be recorded normally — dedup must never suppress unrelated events.
  const different = await recordAcquisitionEvent('paid_conversion', { householdId: 'household-2', externalEventId: 'evt_different_conversion_456' }, { client });
  check(different.inserted === true, 'a genuinely different paid_conversion (different Stripe event.id) is still recorded normally — dedup is scoped to the exact event, never over-suppressing');
  check(store.filter((r) => r.row.event_type === 'paid_conversion').length === 2, 'two distinct real conversions produce two distinct rows');
}

await testRecordsAKnownEvent();
await testRejectsUnknownEventType();
await testNeverThrowsWithNoClient();
await testNeverThrowsOnInsertError();
await testReplayedWebhookNeverDoublesConversion();

check(
  KNOWN_EVENT_TYPES.length === 5 &&
    ['landing_visit', 'registration_submitted', 'registration_completed', 'checkout_started', 'paid_conversion'].every((t) => KNOWN_EVENT_TYPES.includes(t)),
  'KNOWN_EVENT_TYPES contains exactly the five defined funnel stages, using the corrected "registration_submitted" name (it fires on form POST, not on first keystroke)'
);

check(
  !KNOWN_EVENT_TYPES.includes('registration_started'),
  'the old, inaccurate "registration_started" name no longer exists anywhere in the known event types'
);

// --- acquisitionOverview: pure computation, explicit raw vs. classified funnels ---

const fixtureRows = [
  { event_type: 'landing_visit', household_id: null, utm_source: 'google' },
  { event_type: 'landing_visit', household_id: null, utm_source: 'google' },
  { event_type: 'landing_visit', household_id: null, utm_source: null },
  { event_type: 'registration_submitted', household_id: null, utm_source: 'google' },
  { event_type: 'registration_completed', household_id: null, utm_source: 'google' },
  { event_type: 'checkout_started', household_id: 'genuine-1', utm_source: 'google' },
  { event_type: 'checkout_started', household_id: 'internal-test-1', utm_source: null },
  { event_type: 'checkout_started', household_id: 'unclassified-1', utm_source: null },
  { event_type: 'paid_conversion', household_id: 'genuine-1', utm_source: 'google' },
];

// unclassified-1 is deliberately NOT in this map — proves an
// unclassified household is never silently treated as genuine.
const fixtureClassificationMap = new Map([
  ['genuine-1', 'genuine_customer'],
  ['internal-test-1', 'internal_test'],
]);

check(
  countByEventType(fixtureRows, 'landing_visit') === 3,
  'countByEventType: counts raw rows for the given event type'
);

check(
  countByEventType(fixtureRows, 'paid_conversion') === 1,
  'countByEventType: correctly counts a different event type independently'
);

const checkoutSplit = splitByGenuineCustomer(
  fixtureRows.filter((r) => r.event_type === 'checkout_started'),
  fixtureClassificationMap
);
check(
  checkoutSplit.genuine === 1 && checkoutSplit.total === 3,
  'splitByGenuineCustomer: only the explicitly genuine_customer household counts as genuine — the internal_test household AND the unclassified household are both excluded from the real count'
);

const paidConversionSplit = splitByGenuineCustomer(
  fixtureRows.filter((r) => r.event_type === 'paid_conversion'),
  fixtureClassificationMap
);
check(
  paidConversionSplit.genuine === 1 && paidConversionSplit.total === 1,
  'splitByGenuineCustomer: a genuine paid conversion counts correctly'
);

const sources = topUtmSources(fixtureRows, 10);
check(
  sources.find((s) => s.source === 'google').count === 6,
  'topUtmSources: aggregates every row tagged with the same utm_source, across all event types'
);
check(
  sources.some((s) => s.source === '(not tagged)'),
  'topUtmSources: untagged rows are grouped under a labeled bucket, never silently dropped from the total'
);

const snapshot = computeAcquisitionSnapshot(fixtureRows, fixtureClassificationMap);

check(
  snapshot.rawFunnel.landingVisits === 3 &&
    snapshot.rawFunnel.registrationsSubmitted === 1 &&
    snapshot.rawFunnel.registrationsCompleted === 1 &&
    snapshot.rawFunnel.checkoutsStarted === 3 &&
    snapshot.rawFunnel.paidConversions === 1,
  'computeAcquisitionSnapshot: the raw/all-traffic funnel counts every row at every stage, unclassified and internal/test traffic included — never used to imply a genuine-customer figure'
);

check(
  snapshot.classifiedGenuineCustomerFunnel.checkoutsStarted === 1 && snapshot.classifiedGenuineCustomerFunnel.paidConversions === 1,
  'computeAcquisitionSnapshot: the classified genuine-customer funnel exists as a completely separate object, containing ONLY the two stages that can actually be classified, and only counting explicitly genuine_customer households'
);

check(
  !('landingVisits' in snapshot.classifiedGenuineCustomerFunnel) && !('registrationsSubmitted' in snapshot.classifiedGenuineCustomerFunnel),
  'computeAcquisitionSnapshot: landing visits and registrations are structurally absent from the genuine-customer funnel — they can never be mistaken for a classified, real-customer figure, because the field simply does not exist there'
);

check(
  snapshot.genuineConversionRatePercent === 100,
  'computeAcquisitionSnapshot: genuine checkout->paid conversion rate is computed from genuine-customer counts only (1 of 1 genuine checkout converted = 100%)'
);

const emptySnapshot = computeAcquisitionSnapshot([], new Map());
check(
  emptySnapshot.genuineConversionRatePercent === null,
  'computeAcquisitionSnapshot: conversion rate is null (not a divide-by-zero NaN/Infinity) when there are no genuine checkouts to divide by'
);

check(
  emptySnapshot.rawFunnel.landingVisits === 0 && emptySnapshot.classifiedGenuineCustomerFunnel.checkoutsStarted === 0,
  'computeAcquisitionSnapshot: an empty/no-classification input never throws and correctly reports all-zero funnels'
);

// A household present in the rows but with NO entry at all in the
// classification map (not even 'unclassified' explicitly) must still
// never be counted as genuine — classifyHousehold's own default,
// exercised end-to-end here through splitByGenuineCustomer.
const allUnclassifiedSnapshot = computeAcquisitionSnapshot(
  [{ event_type: 'checkout_started', household_id: 'never-classified-1', utm_source: null }],
  new Map()
);
check(
  allUnclassifiedSnapshot.classifiedGenuineCustomerFunnel.checkoutsStarted === 0 && allUnclassifiedSnapshot.rawFunnel.checkoutsStarted === 1,
  'a brand-new household with no classification row at all is counted in the raw funnel but NEVER in the genuine-customer funnel — the absence of a classification is never treated as "genuine" by default'
);

// --- Structural: fire-and-forget wiring, never blocking the real response ---

const landingRouteStart = serverSource.indexOf('app.get("/", (req, res) => {');
const landingRouteEnd = serverSource.indexOf('\n});', landingRouteStart) + 4;
const landingRouteBlock = serverSource.slice(landingRouteStart, landingRouteEnd);

check(
  landingRouteBlock.indexOf('res.sendFile') < landingRouteBlock.indexOf('recordAcquisitionEvent'),
  'GET / sends the real homepage response BEFORE recording the landing-visit event — analytics can never delay the page load'
);

check(
  landingRouteBlock.includes('recordAcquisitionEvent("landing_visit"') && landingRouteBlock.includes('.catch(() => {})'),
  'GET / records landing_visit as a fire-and-forget call (errors caught, never surfaced to the request)'
);

const registerRouteStart = serverSource.indexOf('app.post("/register", async (req, res) => {');
const registerRouteEnd = serverSource.indexOf('\n// AUTH: LOGIN', registerRouteStart);
const registerRouteBlock = serverSource.slice(registerRouteStart, registerRouteEnd);

check(
  registerRouteBlock.includes('recordAcquisitionEvent("registration_submitted"'),
  '/register records registration_submitted (renamed from the inaccurate registration_started — it fires on form POST, not on the visitor first opening/focusing the form, and no focus/typing JavaScript was added to detect that)'
);

check(
  !registerRouteBlock.includes('recordAcquisitionEvent("registration_started"'),
  '/register no longer calls recordAcquisitionEvent with the old, inaccurate "registration_started" name (a code comment explaining the rename is fine and expected — this checks the actual function call, not prose)'
);

check(
  registerRouteBlock.includes('recordAcquisitionEvent("registration_completed"'),
  '/register records registration_completed'
);

check(
  registerRouteBlock.indexOf('recordAcquisitionEvent("registration_submitted"') < registerRouteBlock.indexOf('if (!email || !password)'),
  'registration_submitted is recorded before validation — it represents every submission attempt, not just valid ones'
);

check(
  registerRouteBlock.indexOf('SUPABASE SIGNUP ERROR') < registerRouteBlock.indexOf('recordAcquisitionEvent("registration_completed"'),
  'registration_completed is only recorded AFTER a successful signUp() call — never for a failed signup attempt'
);

check(
  (registerRouteBlock.match(/\.catch\(\(\) => \{\}\)/g) || []).length >= 2,
  '/register\'s acquisition event calls are fire-and-forget (errors caught, never affecting the real registration flow)'
);

check(
  billingSource.includes('recordAcquisitionEvent("checkout_started"') && billingSource.includes('householdId: req.household.id'),
  '/billing/create-checkout-session records checkout_started with the real, server-resolved household id — never anything client-supplied'
);

const checkoutStartedIdx = billingSource.indexOf('recordAcquisitionEvent("checkout_started"');
const sessionCreateIdx = billingSource.indexOf('stripe.checkout.sessions.create(');
check(
  checkoutStartedIdx > sessionCreateIdx,
  'checkout_started is recorded only AFTER a real new Stripe Checkout Session was actually created — never on the already-active/reusable-session bail-out paths above it'
);

check(
  billingSource.includes('event.type === "customer.subscription.created" && result === "processed" && PAID_CONVERSION_STATUSES.has(subscription.status)'),
  'paid_conversion is recorded only for a genuinely NEW subscription (customer.subscription.created), successfully processed (not stale), with a qualifying status — never on a renewal, cancellation, or reactivation update'
);

check(
  billingSource.includes('recordAcquisitionEvent("paid_conversion", { householdId, path: "/billing/webhook", externalEventId: event.id })'),
  'paid_conversion passes Stripe\'s own authoritative event.id as externalEventId, the exact field the database-level dedup index (migration 032) is keyed on — required for the idempotency guarantee to actually apply in production, not just in this test file'
);

// --- Structural: migration is additive, isolated, reversible, and idempotent-by-design ---

check(
  migrationSource.includes('create table if not exists public.acquisition_events') &&
    !migrationSource.toLowerCase().includes('alter table public.households') &&
    !migrationSource.toLowerCase().includes('alter table public.entitlements') &&
    !migrationSource.toLowerCase().includes('alter table public.subscriptions') &&
    !migrationSource.toLowerCase().includes('alter table public.calls'),
  'migration 032 creates only the new table — no existing household/entitlement/subscription/call table is altered'
);

check(
  migrationSource.includes('on delete set null'),
  'household_id uses ON DELETE SET NULL — a household can always be deleted/anonymised without this table ever blocking it'
);

check(
  migrationSource.includes('grant select, insert on public.acquisition_events to service_role') &&
    !migrationSource.includes('to anon') &&
    !migrationSource.includes('to authenticated'),
  'migration 032 grants only service_role — no anon or authenticated access to this table at all, matching account_classifications\' precedent'
);

check(
  migrationSource.includes('external_event_id text') &&
    migrationSource.includes('create unique index if not exists acquisition_events_dedup_idx') &&
    migrationSource.includes('on public.acquisition_events (event_type, external_event_id)') &&
    migrationSource.includes('where external_event_id is not null'),
  'migration 032 enforces paid_conversion idempotency at the DATABASE level (a partial unique index on event_type + external_event_id), not merely in application memory — this holds even across separate server processes/deploys, unlike an in-memory dedup map would'
);

check(
  migrationSource.includes("'landing_visit', 'registration_submitted', 'registration_completed',") &&
    !migrationSource.includes('registration_started'),
  'migration 032\'s own CHECK constraint uses the corrected registration_submitted name'
);

// --- Structural: this feature never writes to account_classifications ---
// (existing historical accounts must never be auto-classified as
// genuine_customer by this work — the only writer of that table
// remains the manual admin process from Business Dashboard V2/migration 031)

const acquisitionOverviewSource = readFileSync(new URL('../services/businessMetrics/acquisitionOverview.js', import.meta.url), 'utf8');
const acquisitionAnalyticsSource = readFileSync(new URL('../services/acquisitionAnalytics.js', import.meta.url), 'utf8');

check(
  !acquisitionOverviewSource.includes("from('account_classifications')") &&
    !acquisitionOverviewSource.includes('.insert(') &&
    !acquisitionOverviewSource.includes('.update('),
  'services/businessMetrics/acquisitionOverview.js never writes to account_classifications (or anything else) — it only ever reads via the existing getClassificationMap()/classifyHousehold(), exactly like customerClassificationOverview.js already does'
);

check(
  !acquisitionAnalyticsSource.includes('account_classifications'),
  'services/acquisitionAnalytics.js has no reference to account_classifications at all — it cannot classify, reclassify, or auto-approve any account as a genuine customer'
);

console.log(failures === 0 ? '\nAll acquisition-analytics checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
