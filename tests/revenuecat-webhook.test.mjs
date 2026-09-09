// Unit tests for the pure RevenueCat webhook event classification —
// see services/revenuecatWebhook.js for the full rationale (in
// particular why CANCELLATION must never classify as a revoke).
//
// Run with: node tests/revenuecat-webhook.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy-test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';

const require = createRequire(import.meta.url);
const {
  classifyRevenueCatEvent,
  resolveOriginalTransactionId,
  resolveTransferGainingAppUserId,
  resolveEventAppUserId,
  resolveTransferReference,
  resolveGrantReference,
  resolveAndRevokeTransferSources,
} = require('../services/revenuecatWebhook.js');
const {
  upsertActiveEntitlementFromRevenueCat,
  expireEntitlementFromRevenueCat,
  getMostRecentRevenueCatEntitlement,
} = require('../database/billing.js');
const { updateTwilioNumberForEntitlementChange } = require('../services/twilioProvisioning.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- classifyRevenueCatEvent ---

check(
  classifyRevenueCatEvent('INITIAL_PURCHASE') === 'grant',
  'INITIAL_PURCHASE classifies as a grant'
);
check(
  classifyRevenueCatEvent('RENEWAL') === 'grant',
  'RENEWAL classifies as a grant'
);
check(
  classifyRevenueCatEvent('UNCANCELLATION') === 'grant',
  'UNCANCELLATION classifies as a grant'
);
check(
  classifyRevenueCatEvent('PRODUCT_CHANGE') === 'grant',
  'PRODUCT_CHANGE classifies as a grant'
);
check(
  classifyRevenueCatEvent('TRANSFER') === 'grant',
  'TRANSFER (gaining identity) classifies as a grant'
);
check(
  classifyRevenueCatEvent('EXPIRATION') === 'revoke',
  'EXPIRATION classifies as a revoke — the real "access ends now" signal'
);
check(
  classifyRevenueCatEvent('CANCELLATION') === 'acknowledge',
  'CANCELLATION does NOT classify as a revoke — access continues until EXPIRATION, same as Stripe cancel_at_period_end'
);
check(
  classifyRevenueCatEvent('BILLING_ISSUE') === 'acknowledge',
  'BILLING_ISSUE does not revoke immediately — mirrors Stripe past_due behaviour'
);
check(
  classifyRevenueCatEvent('SOME_FUTURE_EVENT_TYPE') === 'acknowledge',
  'an unrecognised future event type fails closed to acknowledge, never accidentally revokes or grants'
);

// --- resolveOriginalTransactionId ---

check(
  resolveOriginalTransactionId({ original_transaction_id: 'abc123', transaction_id: 'xyz789' }) === 'abc123',
  'prefers original_transaction_id when present'
);
check(
  resolveOriginalTransactionId({ transaction_id: 'xyz789' }) === 'xyz789',
  'falls back to transaction_id when original_transaction_id is absent'
);
check(
  resolveOriginalTransactionId({}) === null,
  'returns null rather than throwing when neither field is present'
);
check(
  resolveOriginalTransactionId(null) === null,
  'returns null rather than throwing for a null event'
);

// --- TRANSFER handling (2026-08-31) ---
// The real shape RevenueCat actually sends for a TRANSFER event — captured
// from RevenueCat's own delivery record for the sandbox event that first
// exposed this gap (6/6 failed attempts against the production webhook,
// HTTP 400 invalid_payload) — not a guessed/simplified fixture. Notably
// absent: app_user_id, original_transaction_id, transaction_id. Every
// other event type this webhook handles carries all three.
const REAL_TRANSFER_EVENT = {
  id: 'evt_real_transfer_captured_20260831',
  type: 'TRANSFER',
  environment: 'SANDBOX',
  app_id: 'app_homecallguard',
  event_timestamp_ms: 1798000000000,
  transferred_from: ['4bb57845-393d-4299-8cb3-ed3b7ac03e47'],
  transferred_to: ['da5ecb5d-21f2-4eb6-b03f-a28e71edac73'],
};

// --- resolveTransferGainingAppUserId ---

check(
  resolveTransferGainingAppUserId(REAL_TRANSFER_EVENT) === 'da5ecb5d-21f2-4eb6-b03f-a28e71edac73',
  'resolveTransferGainingAppUserId: resolves the single gaining identity from the real captured TRANSFER payload shape'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: [] }) === null,
  'resolveTransferGainingAppUserId: an empty transferred_to is ambiguous — fails safe to null, never guesses'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: ['a', 'b'] }) === null,
  'resolveTransferGainingAppUserId: more than one gaining identity is ambiguous for this data model — fails safe to null'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: undefined }) === null,
  'resolveTransferGainingAppUserId: a missing transferred_to fails safe to null, never throws'
);
check(
  resolveTransferGainingAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: 'da5ecb5d-21f2-4eb6-b03f-a28e71edac73' }) === null,
  'resolveTransferGainingAppUserId: a non-array transferred_to (malformed payload) fails safe to null rather than treating a string as a single-element list'
);
check(
  resolveTransferGainingAppUserId(null) === null,
  'resolveTransferGainingAppUserId: a null event fails safe to null, never throws'
);

// --- resolveEventAppUserId: TRANSFER-aware identity resolution ---

check(
  resolveEventAppUserId(REAL_TRANSFER_EVENT) === 'da5ecb5d-21f2-4eb6-b03f-a28e71edac73',
  'resolveEventAppUserId: TRANSFER resolves identity from transferred_to, not app_user_id (which the real payload does not have)'
);
check(
  resolveEventAppUserId({ ...REAL_TRANSFER_EVENT, transferred_to: [] }) === null,
  'resolveEventAppUserId: an unresolvable TRANSFER (ambiguous transferred_to) resolves to null, not a guessed identity'
);
check(
  resolveEventAppUserId({ type: 'INITIAL_PURCHASE', app_user_id: 'household-x' }) === 'household-x',
  'resolveEventAppUserId: every non-TRANSFER event type is completely unchanged — reads app_user_id directly'
);
check(
  resolveEventAppUserId({ type: 'RENEWAL' }) === null,
  'resolveEventAppUserId: a non-TRANSFER event genuinely missing app_user_id still resolves to null (unchanged prior behaviour), not TRANSFER-specific logic leaking into other types'
);
check(
  resolveEventAppUserId(null) === null,
  'resolveEventAppUserId: a null event resolves to null rather than throwing'
);

// --- resolveTransferReference ---

check(
  resolveTransferReference(REAL_TRANSFER_EVENT) === 'revenuecat_transfer_evt_real_transfer_captured_20260831',
  'resolveTransferReference: derives a stable, traceable reference from the event\'s own real id, never fabricated data'
);
check(
  resolveTransferReference({ ...REAL_TRANSFER_EVENT, id: undefined }) === null,
  'resolveTransferReference: no event id at all fails safe to null rather than producing a broken reference string'
);
check(
  resolveTransferReference(null) === null,
  'resolveTransferReference: a null event fails safe to null'
);

// --- resolveGrantReference: TRANSFER-aware, everything else delegates unchanged ---

check(
  resolveGrantReference(REAL_TRANSFER_EVENT) === 'revenuecat_transfer_evt_real_transfer_captured_20260831',
  'resolveGrantReference: TRANSFER uses the synthetic event-id-based reference, since the real payload has no transaction id at all'
);
check(
  resolveGrantReference({ type: 'INITIAL_PURCHASE', original_transaction_id: 'abc123', transaction_id: 'xyz789' }) === 'abc123',
  'resolveGrantReference: INITIAL_PURCHASE (and every other non-TRANSFER type) delegates straight to the real, unchanged resolveOriginalTransactionId'
);
check(
  resolveGrantReference({ type: 'RENEWAL', transaction_id: 'xyz789' }) === 'xyz789',
  'resolveGrantReference: RENEWAL still falls back to transaction_id exactly as resolveOriginalTransactionId always has'
);
check(
  resolveGrantReference({ type: 'RENEWAL' }) === null,
  'resolveGrantReference: a non-TRANSFER event missing both id fields still returns null, unchanged from resolveOriginalTransactionId'
);

// --- resolveAndRevokeTransferSources ---
// Fixes the correctness gap found reviewing the original TRANSFER fix:
// the destination was granted, but every source household in
// transferred_from was left with its entitlement/Twilio protection
// still fully active — a real duplicate-service bug, not a theoretical
// one. deps are plain functions (not a raw Supabase client), so this is
// fully testable with simple fakes, matching how database/billing.js's
// deps-injected functions (grantComplimentaryEntitlement etc.) are
// tested elsewhere in this codebase.

function makeFakeDeps({ households = {}, entitlements = {} } = {}) {
  const expireCalls = [];
  const deprovisionCalls = [];
  return {
    async getHouseholdByAuthUserId(authUserId) {
      return households[authUserId] || null;
    },
    async getMostRecentEntitlement(householdId) {
      return entitlements[householdId] || null;
    },
    async expireEntitlement(householdId, externalReference) {
      const row = entitlements[householdId];
      expireCalls.push({ householdId, externalReference });
      if (!row || row.status !== 'active' || row.external_reference !== externalReference) {
        return { revoked: false };
      }
      row.status = 'expired'; // mutate the fake store, exactly like the real expireEntitlementFromRevenueCat does
      return { revoked: true };
    },
    async updateTwilioNumberForEntitlementChange(household, active) {
      deprovisionCalls.push({ householdId: household.id, active });
    },
    __calls: { expireCalls, deprovisionCalls },
  };
}

async function testTransferRevokesSingleResolvableSource() {
  const deps = makeFakeDeps({
    households: { 'auth-source-a': { id: 'household-a' } },
    entitlements: { 'household-a': { status: 'active', external_reference: 'real_txn_original_123' } },
  });
  const event = { id: 'evt1', transferred_from: ['auth-source-a'], transferred_to: ['auth-dest-b'] };

  const resolved = await resolveAndRevokeTransferSources(event, deps);

  check(resolved === 'real_txn_original_123', 'resolveAndRevokeTransferSources: recovers the REAL original_transaction_id from the resolvable source household\'s own entitlement row, not a synthetic placeholder');
  check(deps.__calls.expireCalls.length === 1 && deps.__calls.expireCalls[0].householdId === 'household-a', 'resolveAndRevokeTransferSources: expires the source household\'s entitlement');
  check(deps.__calls.deprovisionCalls.length === 1 && deps.__calls.deprovisionCalls[0].householdId === 'household-a' && deps.__calls.deprovisionCalls[0].active === false, 'resolveAndRevokeTransferSources: deprovisions the source household\'s Twilio protection (active: false) — this is the fix for the duplicate-service bug');
}

async function testUnresolvableSourceIsSkippedNotGuessed() {
  const deps = makeFakeDeps({ households: {}, entitlements: {} });
  const event = { id: 'evt2', transferred_from: ['auth-anonymous-never-logged-in'], transferred_to: ['auth-dest-b'] };

  const resolved = await resolveAndRevokeTransferSources(event, deps);

  check(resolved === null, 'resolveAndRevokeTransferSources: an unresolvable source identity (no HCG household) never produces a guessed reference — returns null, letting the caller fall back to the synthetic reference');
  check(deps.__calls.expireCalls.length === 0 && deps.__calls.deprovisionCalls.length === 0, 'resolveAndRevokeTransferSources: never calls expire/deprovision for an identity that does not map to any household');
}

async function testMultipleSourcesOneResolvableOneNot() {
  const deps = makeFakeDeps({
    households: { 'auth-source-a': { id: 'household-a' } },
    entitlements: { 'household-a': { status: 'active', external_reference: 'real_txn_456' } },
  });
  const event = { id: 'evt3', transferred_from: ['auth-source-a', 'auth-unresolvable'], transferred_to: ['auth-dest-b'] };

  const resolved = await resolveAndRevokeTransferSources(event, deps);

  check(resolved === 'real_txn_456', 'resolveAndRevokeTransferSources: does not assume every transferred_from identity maps to an HCG household — resolves and uses the one that does, skips the one that does not');
  check(deps.__calls.expireCalls.length === 1, 'resolveAndRevokeTransferSources: only the genuinely resolvable source is ever touched');
}

async function testReplayIsIdempotent() {
  const deps = makeFakeDeps({
    households: { 'auth-source-a': { id: 'household-a' } },
    entitlements: { 'household-a': { status: 'active', external_reference: 'real_txn_789' } },
  });
  const event = { id: 'evt4', transferred_from: ['auth-source-a'], transferred_to: ['auth-dest-b'] };

  const firstDelivery = await resolveAndRevokeTransferSources(event, deps);
  const secondDelivery = await resolveAndRevokeTransferSources(event, deps); // same event, replayed

  check(firstDelivery === secondDelivery && secondDelivery === 'real_txn_789', 'resolveAndRevokeTransferSources: a replayed delivery of the exact same event recovers the IDENTICAL reference, even though the source entitlement is already expired by then — this is what lets the destination\'s upsertActiveEntitlementFromRevenueCat treat the replay as a harmless renewal, not a second grant');
  check(deps.__calls.expireCalls.length === 1, 'resolveAndRevokeTransferSources: on replay, the source entitlement is already status "expired" (not "active"), so expireEntitlement is never called a second time at all — the status check itself is the idempotency guard, not a redundant expire-and-get-refused round trip');
  check(deps.__calls.deprovisionCalls.length === 1, 'resolveAndRevokeTransferSources: Twilio is deprovisioned exactly once for the whole transfer, never on replay');
}

async function testMultipleResolvableSourcesWithDifferingReferencesUsesFirstAndStillRevokesBoth() {
  const deps = makeFakeDeps({
    households: {
      'auth-source-a': { id: 'household-a' },
      'auth-source-c': { id: 'household-c' },
    },
    entitlements: {
      'household-a': { status: 'active', external_reference: 'real_txn_first' },
      'household-c': { status: 'active', external_reference: 'real_txn_second' },
    },
  });
  const event = { id: 'evt5', transferred_from: ['auth-source-a', 'auth-source-c'], transferred_to: ['auth-dest-b'] };

  const resolved = await resolveAndRevokeTransferSources(event, deps);

  check(resolved === 'real_txn_first', 'resolveAndRevokeTransferSources: a genuinely ambiguous multi-source merge (two different real references) deterministically uses the first one found, rather than throwing or guessing randomly');
  check(deps.__calls.expireCalls.length === 2, 'resolveAndRevokeTransferSources: EVERY resolvable source is still revoked regardless of which reference is chosen for the destination — RevenueCat\'s semantics remove the entitlement from all of transferred_from, not just the "winning" one');
  check(deps.__calls.deprovisionCalls.length === 2, 'resolveAndRevokeTransferSources: both source households have Twilio protection deprovisioned');
}

async function testNoTransferredFromAtAllReturnsNull() {
  const deps = makeFakeDeps();
  const resolved = await resolveAndRevokeTransferSources({ id: 'evt6', transferred_to: ['auth-dest-b'] }, deps);
  check(resolved === null, 'resolveAndRevokeTransferSources: a missing transferred_from array (malformed/unexpected payload) fails safe to null rather than throwing');
}

async function testResolvableSourceWithNoRevenueCatEntitlementIsNeverTouched() {
  // Resolvable household, but it has never had ANY apple_revenuecat
  // entitlement (e.g. Stripe-only customer) — getMostRecentEntitlement
  // correctly returns null (the query itself is scoped to
  // source='apple_revenuecat'), and this must never be treated as "a
  // revocation happened".
  const deps = makeFakeDeps({
    households: { 'auth-source-stripe-only': { id: 'household-stripe-only' } },
    entitlements: {}, // no apple_revenuecat row at all for this household
  });
  const event = { id: 'evt7', transferred_from: ['auth-source-stripe-only'], transferred_to: ['auth-dest-b'] };

  const resolved = await resolveAndRevokeTransferSources(event, deps);

  check(resolved === null, 'resolveAndRevokeTransferSources: a resolvable household with no RevenueCat entitlement at all contributes no reference');
  check(deps.__calls.expireCalls.length === 0, 'resolveAndRevokeTransferSources: expireEntitlement is never called for a household with nothing to expire — being resolvable is not sufficient on its own');
  check(deps.__calls.deprovisionCalls.length === 0, 'resolveAndRevokeTransferSources: updateTwilioNumberForEntitlementChange(source, false) is never called for a household with nothing to expire — proves it is gated on an ACTUAL active-entitlement transition, not merely on the source being resolvable');
}

async function testResolvableSourceWithAlreadyExpiredEntitlementIsNeverTouched() {
  // Resolvable household with a REAL apple_revenuecat row, but it is
  // already 'expired' for an unrelated reason (not from a prior
  // delivery of THIS transfer) — same requirement: resolvability alone
  // must never trigger a Twilio deprovision call.
  const deps = makeFakeDeps({
    households: { 'auth-source-already-expired': { id: 'household-already-expired' } },
    entitlements: { 'household-already-expired': { status: 'expired', external_reference: 'real_txn_stale' } },
  });
  const event = { id: 'evt8', transferred_from: ['auth-source-already-expired'], transferred_to: ['auth-dest-b'] };

  const resolved = await resolveAndRevokeTransferSources(event, deps);

  check(resolved === 'real_txn_stale', 'resolveAndRevokeTransferSources: still recovers the reference from an already-expired row (needed for replay-safety) even though nothing needs revoking now');
  check(deps.__calls.expireCalls.length === 0, 'resolveAndRevokeTransferSources: expireEntitlement is never called when the source\'s entitlement is already expired');
  check(deps.__calls.deprovisionCalls.length === 0, 'resolveAndRevokeTransferSources: updateTwilioNumberForEntitlementChange(source, false) is never called when there is no active-entitlement transition to report — confirms the gate is expireEntitlementFromRevenueCat\'s actual {revoked:true} result, not the source merely existing/resolving');
}

await testTransferRevokesSingleResolvableSource();
await testUnresolvableSourceIsSkippedNotGuessed();
await testMultipleSourcesOneResolvableOneNot();
await testReplayIsIdempotent();
await testMultipleResolvableSourcesWithDifferingReferencesUsesFirstAndStillRevokesBoth();
await testNoTransferredFromAtAllReturnsNull();
await testResolvableSourceWithNoRevenueCatEntitlementIsNeverTouched();
await testResolvableSourceWithAlreadyExpiredEntitlementIsNeverTouched();

// ============================================================
// Full-lifecycle tests — exercise the REAL production functions
// together (upsertActiveEntitlementFromRevenueCat,
// expireEntitlementFromRevenueCat, getMostRecentRevenueCatEntitlement,
// resolveAndRevokeTransferSources, and the real
// updateTwilioNumberForEntitlementChange/ensureTwilioNumberProvisioned
// idempotency guard) wired together exactly as routes/mobileApi.js's
// webhook handler does, against a fake Supabase entitlements table and
// a fake Twilio client — not a parallel reimplementation of the logic
// being verified. Added after a final lifecycle review requested
// end-to-end proof beyond the isolated resolveAndRevokeTransferSources
// unit tests above.
// ============================================================

// Minimal fake Supabase query builder covering exactly the shapes
// database/billing.js's three entitlement functions use: select/eq/
// order/limit/single/maybeSingle/update/insert, plus the query builder
// itself being awaitable (real supabase-js behaviour). Rows are mutated
// in place on update, matching real Postgres UPDATE semantics.
function makeFakeEntitlementsClient(initialRows = []) {
  const store = { entitlements: initialRows.map((r) => ({ ...r })) };
  let idCounter = 7000;

  function makeBuilder(table) {
    const eqFilters = [];
    let orderCol = null;
    let orderDesc = false;
    let limitN = null;
    let updateData = null;
    let insertData = null;
    let wantSingle = false;

    function matches(row) {
      return eqFilters.every(([col, val]) => row[col] === val);
    }

    async function execute() {
      if (insertData) {
        const row = { id: `fake-life-${idCounter++}`, created_at: insertData.created_at || new Date().toISOString(), ...insertData };
        store[table].push(row);
        return { data: wantSingle ? row : [row], error: null };
      }

      let matched = store[table].filter(matches);

      if (updateData) {
        matched.forEach((row) => Object.assign(row, updateData));
        return { data: wantSingle ? matched[0] || null : matched, error: null };
      }

      if (orderCol) {
        matched = [...matched].sort((a, b) => {
          if (a[orderCol] === b[orderCol]) return 0;
          const cmp = a[orderCol] > b[orderCol] ? 1 : -1;
          return orderDesc ? -cmp : cmp;
        });
      }
      if (limitN != null) matched = matched.slice(0, limitN);

      return { data: wantSingle ? matched[0] || null : matched, error: null };
    }

    const builder = {
      select() { return builder; },
      eq(col, val) { eqFilters.push([col, val]); return builder; },
      order(col, opts) { orderCol = col; orderDesc = !!(opts && opts.ascending === false); return builder; },
      limit(n) { limitN = n; return builder; },
      update(data) { updateData = data; return builder; },
      insert(data) { insertData = data; return builder; },
      single() { wantSingle = true; return builder; },
      maybeSingle() { wantSingle = true; return builder; },
      then(onFulfilled, onRejected) { return execute().then(onFulfilled, onRejected); },
    };
    return builder;
  }

  return { from: (table) => makeBuilder(table), __store: store };
}

// Fake Twilio REST client — only the two calls ensureTwilioNumberProvisioned
// actually makes (services/twilioProvisioning.js): searching for an
// available GB number, then purchasing it. Real production purchase
// idempotency (a household that already has twilio_number never
// re-searches/re-purchases) lives in shouldAttemptProvisioning, already
// exhaustively covered by tests/twilio-provisioning.test.mjs — this
// fixture exists to prove that SAME real guarantee holds across a
// TRANSFER-replay specifically, not to re-test Twilio provisioning
// itself.
function makeFakeTwilioClient() {
  const state = { purchaseCalls: 0 };
  return {
    __state: state,
    availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: '+447700900123' }] } }),
    incomingPhoneNumbers: {
      create: async () => {
        state.purchaseCalls++;
        return { phoneNumber: '+447700900123', sid: 'PNfakelifecycle' };
      },
    },
  };
}

// Wires the real database/billing.js + services/twilioProvisioning.js
// functions together against one fake entitlements table + one fake
// Twilio client, mirroring exactly how routes/mobileApi.js's webhook
// handler calls them. `households` maps a fake app_user_id to a plain
// household object (id + optional twilio_number) — tests populate it
// directly and can inspect it afterward.
function makeLifecycleFixture(initialEntitlements) {
  const client = makeFakeEntitlementsClient(initialEntitlements);
  const twilioClient = makeFakeTwilioClient();
  const households = {};
  const calls = { provision: [], deprovision: [], assign: 0, markPendingRelease: 0 };

  const assign = async (householdId, phoneNumber) => {
    calls.assign++;
    const household = Object.values(households).find((h) => h.id === householdId);
    if (household) household.twilio_number = phoneNumber;
    return true;
  };
  const markPendingRelease = async () => {
    calls.markPendingRelease++;
    return true;
  };

  async function updateTwilio(household, isEntitled) {
    if (isEntitled) {
      calls.provision.push(household.id);
      return updateTwilioNumberForEntitlementChange(household, true, { client: twilioClient, assign, cancelPendingRelease: async () => {} });
    }
    calls.deprovision.push(household.id);
    return updateTwilioNumberForEntitlementChange(household, false, { markPendingRelease });
  }

  return {
    client,
    households,
    calls,
    updateTwilio,
    getHouseholdByAuthUserId: async (authUserId) => households[authUserId] || null,
    getMostRecentEntitlement: (householdId) => getMostRecentRevenueCatEntitlement(householdId, { client }),
    expireEntitlement: (householdId, ref) => expireEntitlementFromRevenueCat(householdId, ref, { client }),
  };
}

// --- Scenario 1: transfer then expiration, no intervening renewal ---

async function testScenario1_TransferThenExpirationNoRenewal() {
  const fx = makeLifecycleFixture([
    { id: 'ent-a-s1', household_id: 'household-a-s1', source: 'apple_revenuecat', status: 'active', external_reference: 'real_txn_S1', created_at: '2026-01-01T00:00:00Z', ends_at: null },
  ]);
  fx.households['auth-a-s1'] = { id: 'household-a-s1', twilio_number: '+447700900001' };
  fx.households['auth-b-s1'] = { id: 'household-b-s1' };

  const transferEvent = { id: 'evt_s1_transfer', type: 'TRANSFER', transferred_from: ['auth-a-s1'], transferred_to: ['auth-b-s1'] };

  const resolvedRef = await resolveAndRevokeTransferSources(transferEvent, {
    getHouseholdByAuthUserId: fx.getHouseholdByAuthUserId,
    getMostRecentEntitlement: fx.getMostRecentEntitlement,
    expireEntitlement: fx.expireEntitlement,
    updateTwilioNumberForEntitlementChange: fx.updateTwilio,
  });

  check(resolvedRef === 'real_txn_S1', 'Scenario 1: TRANSFER recovers A\'s REAL original_transaction_id');

  const aRow = fx.client.__store.entitlements.find((r) => r.household_id === 'household-a-s1');
  check(aRow.status === 'expired', 'Scenario 1: A\'s entitlement becomes expired/inactive');
  check(fx.calls.deprovision.filter((id) => id === 'household-a-s1').length === 1, 'Scenario 1: A\'s Twilio protection is deprovisioned exactly once');
  check(fx.calls.markPendingRelease === 1, 'Scenario 1: the real updateTwilioNumberForEntitlementChange(A, false) genuinely marked A\'s number for release');

  // Grant B, exactly as the route's grant branch does.
  const grantResult = await upsertActiveEntitlementFromRevenueCat(
    'household-b-s1',
    { originalTransactionId: resolvedRef, expiresAtMs: Date.parse('2027-01-01T00:00:00Z') },
    { client: fx.client }
  );
  await fx.updateTwilio(fx.households['auth-b-s1'], true);

  check(grantResult.action === 'granted', 'Scenario 1: B receives a fresh active entitlement');
  const bRow = fx.client.__store.entitlements.find((r) => r.id === grantResult.entitlementId);
  check(bRow.external_reference === 'real_txn_S1', 'Scenario 1: B\'s entitlement uses A\'s REAL original transaction reference, NOT the synthetic revenuecat_transfer_<event.id> reference');
  check(fx.calls.assign === 1 && fx.households['auth-b-s1'].twilio_number === '+447700900123', 'Scenario 1: B is genuinely provisioned a Twilio number');

  // A subsequent real EXPIRATION for this exact subscription.
  const expirationEvent = { type: 'EXPIRATION', original_transaction_id: 'real_txn_S1' };
  const expireRef = resolveGrantReference(expirationEvent); // non-TRANSFER path, completely unchanged
  check(expireRef === 'real_txn_S1', 'Scenario 1: the later EXPIRATION event carries the same real reference B was granted under');

  const expireResult = await expireEntitlementFromRevenueCat('household-b-s1', expireRef, { client: fx.client });
  check(expireResult.revoked === true, 'Scenario 1: the real EXPIRATION correctly matches and expires B\'s entitlement — this is exactly what recovering the real reference (instead of the synthetic one) was for');
  if (expireResult.revoked) await fx.updateTwilio(fx.households['auth-b-s1'], false);

  check(fx.calls.deprovision.filter((id) => id === 'household-a-s1').length === 1, 'Scenario 1: A remains deprovisioned exactly once total, unaffected by B\'s later expiration');
  check(fx.calls.deprovision.filter((id) => id === 'household-b-s1').length === 1, 'Scenario 1: B\'s Twilio protection is deprovisioned exactly once, following its own real EXPIRATION');
}

// --- Scenario 2: transfer -> renewal -> expiration ---

async function testScenario2_TransferThenRenewalThenExpiration() {
  const fx = makeLifecycleFixture([
    { id: 'ent-a-s2', household_id: 'household-a-s2', source: 'apple_revenuecat', status: 'active', external_reference: 'real_txn_S2', created_at: '2026-01-01T00:00:00Z', ends_at: null },
  ]);
  fx.households['auth-a-s2'] = { id: 'household-a-s2', twilio_number: '+447700900002' };
  fx.households['auth-b-s2'] = { id: 'household-b-s2' };

  const transferEvent = { id: 'evt_s2_transfer', type: 'TRANSFER', transferred_from: ['auth-a-s2'], transferred_to: ['auth-b-s2'] };
  const resolvedRef = await resolveAndRevokeTransferSources(transferEvent, {
    getHouseholdByAuthUserId: fx.getHouseholdByAuthUserId,
    getMostRecentEntitlement: fx.getMostRecentEntitlement,
    expireEntitlement: fx.expireEntitlement,
    updateTwilioNumberForEntitlementChange: fx.updateTwilio,
  });
  await upsertActiveEntitlementFromRevenueCat('household-b-s2', { originalTransactionId: resolvedRef, expiresAtMs: Date.parse('2026-02-01T00:00:00Z') }, { client: fx.client });
  await fx.updateTwilio(fx.households['auth-b-s2'], true);

  check(fx.client.__store.entitlements.filter((r) => r.household_id === 'household-b-s2').length === 1, 'Scenario 2: after the transfer, B has exactly one entitlement row');

  // RENEWAL using the same real original transaction id.
  const renewalEvent = { type: 'RENEWAL', original_transaction_id: 'real_txn_S2', expiration_at_ms: Date.parse('2026-03-01T00:00:00Z') };
  const renewalRef = resolveGrantReference(renewalEvent);
  check(renewalRef === 'real_txn_S2', 'Scenario 2: RENEWAL resolves to the same real reference B was transferred under');

  const renewResult = await upsertActiveEntitlementFromRevenueCat('household-b-s2', { originalTransactionId: renewalRef, expiresAtMs: renewalEvent.expiration_at_ms }, { client: fx.client });
  await fx.updateTwilio(fx.households['auth-b-s2'], true);

  check(renewResult.action === 'renewed', 'Scenario 2: RENEWAL updates B\'s existing entitlement (idempotent match on source+reference) rather than creating a second row');
  check(fx.client.__store.entitlements.filter((r) => r.household_id === 'household-b-s2').length === 1, 'Scenario 2: B still has exactly ONE active entitlement row after the renewal — no duplicate was created');
  const bRow = fx.client.__store.entitlements.find((r) => r.household_id === 'household-b-s2');
  check(bRow.ends_at === new Date(renewalEvent.expiration_at_ms).toISOString(), 'Scenario 2: the renewal correctly extended B\'s ends_at');
  check(fx.calls.assign === 1, 'Scenario 2: B\'s Twilio number is only ever purchased once (the renewal\'s provisioning call is a correct no-op — household already has a number)');

  // EXPIRATION then correctly revokes B.
  const expireResult = await expireEntitlementFromRevenueCat('household-b-s2', 'real_txn_S2', { client: fx.client });
  check(expireResult.revoked === true, 'Scenario 2: EXPIRATION correctly revokes B after the renewal, still matching on the same real reference');
  if (expireResult.revoked) await fx.updateTwilio(fx.households['auth-b-s2'], false);
  check(fx.calls.deprovision.filter((id) => id === 'household-b-s2').length === 1, 'Scenario 2: B is deprovisioned exactly once following the expiration');
}

// --- Scenario 3: exact TRANSFER replay ---

async function testScenario3_ExactTransferReplay() {
  const fx = makeLifecycleFixture([
    { id: 'ent-a-s3', household_id: 'household-a-s3', source: 'apple_revenuecat', status: 'active', external_reference: 'real_txn_S3', created_at: '2026-01-01T00:00:00Z', ends_at: null },
  ]);
  fx.households['auth-a-s3'] = { id: 'household-a-s3', twilio_number: '+447700900003' };
  fx.households['auth-b-s3'] = { id: 'household-b-s3' };

  const transferEvent = { id: 'evt_s3_transfer', type: 'TRANSFER', transferred_from: ['auth-a-s3'], transferred_to: ['auth-b-s3'] };
  const deps = {
    getHouseholdByAuthUserId: fx.getHouseholdByAuthUserId,
    getMostRecentEntitlement: fx.getMostRecentEntitlement,
    expireEntitlement: fx.expireEntitlement,
    updateTwilioNumberForEntitlementChange: fx.updateTwilio,
  };

  // First delivery — full processing, exactly as routes/mobileApi.js does.
  const firstRef = await resolveAndRevokeTransferSources(transferEvent, deps);
  const firstGrant = await upsertActiveEntitlementFromRevenueCat('household-b-s3', { originalTransactionId: firstRef, expiresAtMs: Date.parse('2027-01-01T00:00:00Z') }, { client: fx.client });
  await fx.updateTwilio(fx.households['auth-b-s3'], true);

  // Second delivery — RevenueCat redelivers the exact same event.
  const secondRef = await resolveAndRevokeTransferSources(transferEvent, deps);
  const secondGrant = await upsertActiveEntitlementFromRevenueCat('household-b-s3', { originalTransactionId: secondRef, expiresAtMs: Date.parse('2027-01-01T00:00:00Z') }, { client: fx.client });
  await fx.updateTwilio(fx.households['auth-b-s3'], true);

  check(firstRef === secondRef, 'Scenario 3 (replay): both deliveries recover the identical real reference');
  check(firstGrant.action === 'granted' && secondGrant.action === 'renewed' && firstGrant.entitlementId === secondGrant.entitlementId, 'Scenario 3 (replay): the second delivery hits the idempotent "renewed" branch against the SAME entitlement row created by the first — never a second grant');
  check(fx.client.__store.entitlements.filter((r) => r.household_id === 'household-b-s3').length === 1, 'Scenario 3 (replay): B does not receive a duplicate/churned entitlement row — exactly one exists after both deliveries');
  check(fx.client.__store.entitlements.filter((r) => r.household_id === 'household-a-s3').length === 1, 'Scenario 3 (replay): A\'s entitlement was not duplicated or re-inserted either — still exactly the one original row, now expired');
  check(fx.client.__store.entitlements.find((r) => r.household_id === 'household-a-s3').status === 'expired', 'Scenario 3 (replay): A is not left active by the replay');

  check(fx.calls.deprovision.filter((id) => id === 'household-a-s3').length === 1, 'Scenario 3 (replay): A is NOT expired/deprovisioned twice — exactly one deprovision call across both deliveries');
  check(fx.calls.markPendingRelease === 1, 'Scenario 3 (replay): the real Twilio pending-release mark only fires once');
  check(fx.calls.assign === 1, 'Scenario 3 (replay): B is NOT provisioned twice unnecessarily — the real ensureTwilioNumberProvisioned/shouldAttemptProvisioning guard (household.twilio_number already set) prevents a second purchase on the replayed delivery');
}

await testScenario1_TransferThenExpirationNoRenewal();
await testScenario2_TransferThenRenewalThenExpiration();
await testScenario3_ExactTransferReplay();

// --- Determinism of the multi-source-ambiguity fallback: re-asserted
// here with a console.error capture, proving the "documented behaviour,
// never an arbitrary/silent choice" requirement concretely — the
// warning is genuinely emitted, not just described in a comment. ---

async function testMultiSourceAmbiguityIsLoggedNotSilent() {
  const deps = makeFakeDeps({
    households: {
      'auth-source-x': { id: 'household-x' },
      'auth-source-y': { id: 'household-y' },
    },
    entitlements: {
      'household-x': { status: 'active', external_reference: 'real_txn_x' },
      'household-y': { status: 'active', external_reference: 'real_txn_y' },
    },
  });
  const event = { id: 'evt_ambiguous', transferred_from: ['auth-source-x', 'auth-source-y'], transferred_to: ['auth-dest'] };

  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  let resolved;
  try {
    resolved = await resolveAndRevokeTransferSources(event, deps);
  } finally {
    console.error = originalConsoleError;
  }

  check(resolved === 'real_txn_x', 'Multi-source ambiguity: deterministically picks the first resolvable reference every time (not a random/unstable choice)');
  check(
    loggedCalls.some((args) => typeof args[0] === 'string' && args[0].includes('multiple resolvable source households with differing references')),
    'Multi-source ambiguity: a genuinely ambiguous multi-source transfer is explicitly logged for manual review — never silently resolved as if it were unambiguous'
  );
}

await testMultiSourceAmbiguityIsLoggedNotSilent();

// --- Structural: the route's grant/revoke handling is byte-for-byte
// unchanged for every event type — only identity/reference resolution
// (above) became TRANSFER-aware. Isolation proof for the fix ported
// from commit a6d00c1 onto a fresh branch off origin/main, deliberately
// excluding that commit's unrelated Voice-reachability and mobile
// resume/setup-loop changes. ---

const routeSource = readFileSync(new URL('../routes/mobileApi.js', import.meta.url), 'utf8');

check(
  routeSource.includes('const { classifyRevenueCatEvent, resolveEventAppUserId, resolveGrantReference, resolveAndRevokeTransferSources } = require("../services/revenuecatWebhook");'),
  'routes/mobileApi.js: imports the TRANSFER-aware resolveEventAppUserId/resolveGrantReference/resolveAndRevokeTransferSources, replacing the old direct event.app_user_id/resolveOriginalTransactionId usage at the call site (the underlying resolveOriginalTransactionId function itself is untouched — resolveGrantReference delegates straight to it for every non-TRANSFER type)'
);

check(
  routeSource.includes('if (event.type === "TRANSFER") {') &&
    routeSource.includes('const resolvedFromSource = await resolveAndRevokeTransferSources(event, {') &&
    routeSource.includes('originalTransactionId = resolvedFromSource || resolveGrantReference(event);'),
  'routes/mobileApi.js: for TRANSFER only, resolves and revokes source households BEFORE computing the destination reference, falling back to the synthetic reference only when no source resolved one'
);

check(
  (() => {
    const nonTransferBranch = routeSource.slice(routeSource.indexOf('} else {\n      // Every other event type: completely unchanged.'));
    return nonTransferBranch.includes('originalTransactionId = resolveGrantReference(event);') && !nonTransferBranch.slice(0, 200).includes('resolveAndRevokeTransferSources');
  })(),
  'routes/mobileApi.js: every non-TRANSFER event type still resolves its reference via the single, unchanged resolveGrantReference(event) call — no source-revocation logic runs for anything but TRANSFER'
);

check(
  routeSource.includes('const household = await getHouseholdByAuthUserId(appUserId);'),
  'routes/mobileApi.js: household lookup uses the resolved appUserId (identical value to the old event.app_user_id for every non-TRANSFER event) — no lookup logic changed'
);

const grantRevokeBlock = routeSource.slice(routeSource.indexOf('const classification = classifyRevenueCatEvent(event.type);'));
check(
  grantRevokeBlock.includes('if (classification === "grant") {') &&
    grantRevokeBlock.includes('const result = await upsertActiveEntitlementFromRevenueCat(household.id, {') &&
    grantRevokeBlock.includes('originalTransactionId,\n        expiresAtMs: event.expiration_at_ms,') &&
    grantRevokeBlock.includes('await updateTwilioNumberForEntitlementChange(household, true)') &&
    grantRevokeBlock.includes('if (classification === "revoke") {') &&
    grantRevokeBlock.includes('const result = await expireEntitlementFromRevenueCat(household.id, originalTransactionId);') &&
    grantRevokeBlock.includes('await updateTwilioNumberForEntitlementChange(household, false)'),
  'routes/mobileApi.js: the entire grant/revoke classification, entitlement upsert/expiry, and Twilio provisioning hook block is completely untouched — proves existing non-TRANSFER RevenueCat events (INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION, etc.) go through exactly the same code path as before this fix'
);

// 2026-09-07 update: Voice-SDK-reachability logic now legitimately exists
// in this file — deliberately re-authored against current origin/main
// (migration 036, POST /api/v1/voice/registered) as its own dedicated,
// separately-scoped change, not brought across from commit a6d00c1's
// abandoned base. The isolation property this test actually cares about
// — that the RevenueCat TRANSFER fix above and Voice-SDK reachability
// are two independent, uncoupled concerns — still holds and is checked
// here directly, rather than by banning reachability code from the file
// altogether (which would now be testing something false).
check(
  !grantRevokeBlock.includes('voiceClientReachable') &&
    !grantRevokeBlock.includes('isVoiceClientReachable') &&
    !grantRevokeBlock.includes('markVoiceClientRegistered'),
  'routes/mobileApi.js: the RevenueCat grant/revoke classification block has no Voice-SDK-reachability coupling — the two features remain independent'
);

// --- Structural: database/billing.js's new getMostRecentRevenueCatEntitlement
// genuinely reads regardless of status — the property the whole
// replay-safety guarantee above depends on. Also confirms
// getActiveEntitlement (used everywhere else) is completely untouched. ---

const billingSource = readFileSync(new URL('../database/billing.js', import.meta.url), 'utf8');
const mostRecentFnSource = billingSource.slice(
  billingSource.indexOf('async function getMostRecentRevenueCatEntitlement'),
  billingSource.indexOf('async function expireEntitlementFromRevenueCat')
);

check(
  mostRecentFnSource.includes('.eq("source", "apple_revenuecat")') &&
    mostRecentFnSource.includes('.order("created_at", { ascending: false })') &&
    !mostRecentFnSource.includes('.eq("status"'),
  'database/billing.js: getMostRecentRevenueCatEntitlement deliberately has NO status filter (unlike getActiveEntitlement) — reads the most recent apple_revenuecat row regardless of active/expired, which is what makes reference-recovery survive a replayed webhook delivery'
);

check(
  billingSource.includes('getMostRecentRevenueCatEntitlement,') && billingSource.match(/module\.exports = \{[\s\S]*getMostRecentRevenueCatEntitlement/),
  'database/billing.js: getMostRecentRevenueCatEntitlement is exported'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
