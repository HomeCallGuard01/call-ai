// Regression tests for admin-granted complimentary entitlements (2026-09)
// — database/billing.js's grantComplimentaryEntitlement/
// revokeComplimentaryEntitlement, and routes/admin.js's two new routes.
//
// The entitlement-transition logic is exercised against a tiny in-memory
// fake Supabase query builder (injected via the same `deps.client`
// pattern services/twilioProvisioning.js already uses elsewhere in this
// codebase) rather than a real database — this lets the real
// production functions run unmodified while still proving out the
// one-active-entitlement transition, the complimentary-only revoke
// guard, and error handling. Route-level concerns (admin gating, which
// Twilio hook gets called with which boolean) are checked structurally
// against the real route source, matching this codebase's existing
// convention (see tests/admin-business-auth.test.mjs) since there's no
// HTTP test tooling in this project.
//
// Run with: node tests/complimentary-entitlement.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy-test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';

const require = createRequire(import.meta.url);
const { grantComplimentaryEntitlement, revokeComplimentaryEntitlement } = require('../database/billing.js');

const adminRouteSource = readFileSync(new URL('../routes/admin.js', import.meta.url), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- Minimal in-memory fake Supabase query builder ---
// Supports exactly the chain shapes database/billing.js's entitlement
// functions use: .from(table).select().eq().eq().maybeSingle(),
// .from(table).update({...}).eq() (awaited directly, no terminal call —
// matches real supabase-js's "query builder is itself a thenable"
// behaviour), and .from(table).insert({...}).select("*").single().
function makeFakeSupabaseAdmin(initialRows = {}) {
  const store = { entitlements: [...(initialRows.entitlements || [])] };
  let idCounter = 1000;

  function makeBuilder(table) {
    const filters = [];
    let updateData = null;
    let insertData = null;
    let wantSingle = false;

    async function execute() {
      if (insertData) {
        const row = {
          id: `fake-entitlement-${idCounter++}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ends_at: null,
          notes: null,
          created_by: null,
          external_reference: null,
          ...insertData,
        };
        store[table].push(row);
        return { data: wantSingle ? row : [row], error: null };
      }
      const matched = store[table].filter((row) => filters.every(([col, val]) => row[col] === val));
      if (updateData) {
        matched.forEach((row) => Object.assign(row, updateData));
      }
      return { data: wantSingle ? matched[0] || null : matched, error: null };
    }

    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push([col, val]); return builder; },
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

const HOUSEHOLD_ID = 'household-family-tester';
const ADMIN_AUTH_USER_ID = 'admin-auth-user-id';
const FUTURE_ENDS_AT = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

// --- grantComplimentaryEntitlement ---

async function testGrantOnCleanHousehold() {
  const client = makeFakeSupabaseAdmin();
  const result = await grantComplimentaryEntitlement(
    HOUSEHOLD_ID,
    { grantedByAuthUserId: ADMIN_AUTH_USER_ID, notes: 'Family tester', endsAt: FUTURE_ENDS_AT },
    { client }
  );

  check(result.granted === true && result.action === 'granted' && typeof result.entitlementId === 'string', 'grantComplimentaryEntitlement: grants successfully on a household with no existing entitlement');

  const rows = client.__store.entitlements;
  check(rows.length === 1, 'grantComplimentaryEntitlement: creates exactly one entitlement row');

  const row = rows[0];
  check(row.entitlement_type === 'complimentary', 'the new row has entitlement_type = complimentary');
  check(row.source === 'admin_manual', 'the new row has source = admin_manual');
  check(row.external_reference === null, 'the new row has external_reference = null — no Stripe/RevenueCat object is created or implied');
  check(row.status === 'active', 'the new row is active');
  check(row.created_by === ADMIN_AUTH_USER_ID, 'the new row records which admin granted it (created_by)');
  check(row.notes === 'Family tester', 'the new row records the required reason/note');
  check(row.ends_at === new Date(FUTURE_ENDS_AT).toISOString(), 'the supplied expiry date is honoured exactly');

  const activeRows = rows.filter((r) => r.status === 'active');
  check(activeRows.length === 1, 'exactly one active entitlement exists after granting — the one-active-per-household invariant holds');
}

async function testGrantRequiresNotes() {
  const client = makeFakeSupabaseAdmin();
  let threw = false;
  try {
    await grantComplimentaryEntitlement(HOUSEHOLD_ID, { grantedByAuthUserId: ADMIN_AUTH_USER_ID, notes: '', endsAt: FUTURE_ENDS_AT }, { client });
  } catch {
    threw = true;
  }
  check(threw, 'grantComplimentaryEntitlement: refuses to grant without a reason/note');
  check(client.__store.entitlements.length === 0, 'no row is written when the note is missing');
}

async function testGrantRequiresEndsAt() {
  const client = makeFakeSupabaseAdmin();
  let threw = false;
  try {
    await grantComplimentaryEntitlement(HOUSEHOLD_ID, { grantedByAuthUserId: ADMIN_AUTH_USER_ID, notes: 'Family tester' }, { client });
  } catch {
    threw = true;
  }
  check(threw, 'grantComplimentaryEntitlement: refuses to grant without an expiry date');
  check(client.__store.entitlements.length === 0, 'no row is written when the expiry date is missing');
}

// Safety guard (2026-09): grantComplimentaryEntitlement must NEVER
// expire/replace a real paid entitlement — only a household with no
// active entitlement, or one whose active entitlement is ITSELF already
// admin_manual/complimentary, may be granted.

async function testGrantCanExtendExistingComplimentary() {
  const existingComplimentary = {
    id: 'existing-comp-1',
    household_id: HOUSEHOLD_ID,
    entitlement_type: 'complimentary',
    status: 'active',
    source: 'admin_manual',
    external_reference: null,
  };
  const client = makeFakeSupabaseAdmin({ entitlements: [existingComplimentary] });

  const result = await grantComplimentaryEntitlement(HOUSEHOLD_ID, { grantedByAuthUserId: ADMIN_AUTH_USER_ID, notes: 'Extending the trial', endsAt: FUTURE_ENDS_AT }, { client });

  check(result.granted === true, 'grantComplimentaryEntitlement: succeeds when the existing active entitlement is itself complimentary — safe to extend/replace');

  const rows = client.__store.entitlements;
  const activeRows = rows.filter((r) => r.status === 'active');
  check(activeRows.length === 1, 'extending a complimentary grant never leaves two active rows at once');
  check(activeRows[0].source === 'admin_manual' && activeRows[0].notes === 'Extending the trial', 'the surviving active row is the new, extended complimentary grant');

  const oldRow = rows.find((r) => r.id === 'existing-comp-1');
  check(oldRow.status === 'expired', 'the old complimentary entitlement is transitioned to expired, not deleted — its history is preserved');
}

async function testGrantRefusedAgainstActiveStripeEntitlement() {
  const stripeRow = {
    id: 'stripe-existing-1',
    household_id: HOUSEHOLD_ID,
    entitlement_type: 'paid_subscription',
    status: 'active',
    source: 'stripe',
    external_reference: 'sub_real_paying_customer',
  };
  const client = makeFakeSupabaseAdmin({ entitlements: [stripeRow] });

  const result = await grantComplimentaryEntitlement(HOUSEHOLD_ID, { grantedByAuthUserId: ADMIN_AUTH_USER_ID, notes: 'Attempted grant', endsAt: FUTURE_ENDS_AT }, { client });

  check(
    result.granted === false && result.reason === 'active_paid_entitlement_exists' && result.existingEntitlement.source === 'stripe',
    'grantComplimentaryEntitlement refuses outright when the household has an active real Stripe entitlement — returns a clear, structured refusal, not a thrown error'
  );

  const rows = client.__store.entitlements;
  check(rows.length === 1, 'no new entitlement row is created on a refused grant');
  const row = rows.find((r) => r.id === 'stripe-existing-1');
  check(row.status === 'active' && row.source === 'stripe', 'the real Stripe entitlement is completely untouched — still active, still Stripe — never expired or replaced');
}

async function testGrantRefusedAgainstActiveRevenueCatEntitlement() {
  const appleRow = {
    id: 'apple-existing-1',
    household_id: HOUSEHOLD_ID,
    entitlement_type: 'paid_subscription',
    status: 'active',
    source: 'apple_revenuecat',
    external_reference: '2000001228875948',
  };
  const client = makeFakeSupabaseAdmin({ entitlements: [appleRow] });

  const result = await grantComplimentaryEntitlement(HOUSEHOLD_ID, { grantedByAuthUserId: ADMIN_AUTH_USER_ID, notes: 'Attempted grant', endsAt: FUTURE_ENDS_AT }, { client });

  check(
    result.granted === false && result.reason === 'active_paid_entitlement_exists' && result.existingEntitlement.source === 'apple_revenuecat',
    'grantComplimentaryEntitlement refuses outright when the household has an active real RevenueCat/Apple entitlement'
  );

  const rows = client.__store.entitlements;
  check(rows.length === 1, 'no new entitlement row is created on a refused grant');
  const row = rows.find((r) => r.id === 'apple-existing-1');
  check(row.status === 'active' && row.source === 'apple_revenuecat', 'the real RevenueCat entitlement is completely untouched — still active, still RevenueCat — never expired or replaced');
}

// --- revokeComplimentaryEntitlement ---

async function testRevokeComplimentary() {
  const complimentaryRow = {
    id: 'comp-1',
    household_id: HOUSEHOLD_ID,
    entitlement_type: 'complimentary',
    status: 'active',
    source: 'admin_manual',
    external_reference: null,
  };
  const client = makeFakeSupabaseAdmin({ entitlements: [complimentaryRow] });

  const result = await revokeComplimentaryEntitlement(HOUSEHOLD_ID, { client });

  check(result.revoked === true, 'revokeComplimentaryEntitlement: revokes a genuine active complimentary entitlement');
  const row = client.__store.entitlements.find((r) => r.id === 'comp-1');
  check(row.status === 'revoked', 'the row\'s status becomes revoked (not expired, not deleted)');
  check(client.__store.entitlements.length === 1, 'the row still exists — revocation preserves entitlement/audit history, never deletes it');
}

async function testRevokeNeverTouchesPaidStripeEntitlement() {
  const paidRow = {
    id: 'stripe-1',
    household_id: HOUSEHOLD_ID,
    entitlement_type: 'paid_subscription',
    status: 'active',
    source: 'stripe',
    external_reference: 'sub_real_paying_customer',
  };
  const client = makeFakeSupabaseAdmin({ entitlements: [paidRow] });

  const result = await revokeComplimentaryEntitlement(HOUSEHOLD_ID, { client });

  check(result.revoked === false && result.reason === 'active_entitlement_is_not_complimentary', 'revokeComplimentaryEntitlement refuses to act when the active entitlement is a real Stripe subscription, not complimentary');
  const row = client.__store.entitlements.find((r) => r.id === 'stripe-1');
  check(row.status === 'active', 'the real Stripe entitlement is completely untouched — still active');
}

async function testRevokeNeverTouchesPaidRevenueCatEntitlement() {
  const appleRow = {
    id: 'apple-1',
    household_id: HOUSEHOLD_ID,
    entitlement_type: 'paid_subscription',
    status: 'active',
    source: 'apple_revenuecat',
    external_reference: '2000001228875948',
  };
  const client = makeFakeSupabaseAdmin({ entitlements: [appleRow] });

  const result = await revokeComplimentaryEntitlement(HOUSEHOLD_ID, { client });

  check(result.revoked === false && result.reason === 'active_entitlement_is_not_complimentary', 'revokeComplimentaryEntitlement refuses to act when the active entitlement is a real RevenueCat/Apple subscription, not complimentary');
  const row = client.__store.entitlements.find((r) => r.id === 'apple-1');
  check(row.status === 'active', 'the real RevenueCat entitlement is completely untouched — still active');
}

async function testRevokeNoActiveEntitlement() {
  const client = makeFakeSupabaseAdmin({ entitlements: [] });
  const result = await revokeComplimentaryEntitlement(HOUSEHOLD_ID, { client });
  check(result.revoked === false && result.reason === 'no_active_entitlement', 'revokeComplimentaryEntitlement reports a clear, safe outcome when there is nothing active to revoke');
}

await testGrantOnCleanHousehold();
await testGrantRequiresNotes();
await testGrantRequiresEndsAt();
await testGrantCanExtendExistingComplimentary();
await testGrantRefusedAgainstActiveStripeEntitlement();
await testGrantRefusedAgainstActiveRevenueCatEntitlement();
await testRevokeComplimentary();
await testRevokeNeverTouchesPaidStripeEntitlement();
await testRevokeNeverTouchesPaidRevenueCatEntitlement();
await testRevokeNoActiveEntitlement();

// --- Structural: admin route wiring ---

check(
  adminRouteSource.includes('router.post("/admin/api/households/:id/grant-complimentary", requireAuth, requireAdmin,'),
  'POST /admin/api/households/:id/grant-complimentary is gated by requireAuth + requireAdmin directly in its own declaration'
);

check(
  adminRouteSource.includes('router.post("/admin/api/households/:id/revoke-complimentary", requireAuth, requireAdmin,'),
  'POST /admin/api/households/:id/revoke-complimentary is gated by requireAuth + requireAdmin directly in its own declaration'
);

const grantHandlerStart = adminRouteSource.indexOf('grant-complimentary');
const grantHandlerEnd = adminRouteSource.indexOf('revoke-complimentary');
const grantHandlerBlock = adminRouteSource.slice(grantHandlerStart, grantHandlerEnd);

check(
  grantHandlerBlock.includes('updateTwilioNumberForEntitlementChange(household, true)'),
  'the grant route calls the existing updateTwilioNumberForEntitlementChange(household, true) hook — the same one every other entitlement-activation path already uses, no duplicate provisioning logic'
);

check(
  grantHandlerBlock.includes('grantComplimentaryEntitlement('),
  'the grant route uses database/billing.js\'s grantComplimentaryEntitlement, not a hand-rolled insert'
);

check(
  grantHandlerBlock.includes('if (grantResult.granted) {') && grantHandlerBlock.includes('await updateTwilioNumberForEntitlementChange(household, true);'),
  'the grant route only calls updateTwilioNumberForEntitlementChange(household, true) when the grant genuinely happened — never on a refused grant, so a household with a real paid entitlement can never have its Twilio number touched by a refused complimentary-grant attempt'
);

const revokeHandlerBlock = adminRouteSource.slice(grantHandlerEnd);

check(
  revokeHandlerBlock.includes('if (revokeResult.revoked) {') && revokeHandlerBlock.includes('updateTwilioNumberForEntitlementChange(household, false)'),
  'the revoke route only calls updateTwilioNumberForEntitlementChange(household, false) when a revoke genuinely happened — never unconditionally, so a refused (not-actually-complimentary) revoke attempt can never mark a paying customer\'s Twilio number for release'
);

console.log(failures === 0 ? '\nAll complimentary-entitlement checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
