// Regression tests for Friends & Family complimentary invite links
// (2026-09) — services/complimentaryInvites.js, routes/admin.js's three
// new invite routes, and the /register + /login redemption hooks in
// server.js.
//
// Same convention as tests/complimentary-entitlement.test.mjs: the real
// production functions (services/complimentaryInvites.js,
// database/billing.js's grantComplimentaryEntitlement, unmodified) run
// against a small in-memory fake Supabase query builder, injected via
// the same `deps.client` pattern used throughout this codebase. Route/
// server-wiring concerns are checked structurally against the real
// source, matching tests/admin-business-auth.test.mjs's established
// convention, since there is no HTTP test tooling in this project.
//
// Run with: node tests/complimentary-invites.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy-test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';

const require = createRequire(import.meta.url);
const {
  ALLOWED_DURATIONS_DAYS,
  generateToken,
  hashToken,
  computeDisplayStatus,
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
} = require('../services/complimentaryInvites.js');

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
// Supports exactly the chain shapes services/complimentaryInvites.js and
// database/billing.js's grantComplimentaryEntitlement use across
// complimentary_invites, entitlements, and account_classifications:
// select/eq/gt/order/insert/update/upsert/single/maybeSingle, plus the
// query builder itself being awaitable (real supabase-js behaviour).
function makeFakeSupabaseAdmin(initialRows = {}) {
  const store = {
    complimentary_invites: [...(initialRows.complimentary_invites || [])],
    entitlements: [...(initialRows.entitlements || [])],
    account_classifications: [...(initialRows.account_classifications || [])],
  };
  let idCounter = 1000;

  function makeBuilder(table) {
    const eqFilters = [];
    const gtFilters = [];
    let updateData = null;
    let insertData = null;
    let upsertData = null;
    let upsertConflictCol = null;
    let wantSingle = false;

    function matches(row) {
      return eqFilters.every(([col, val]) => row[col] === val) && gtFilters.every(([col, val]) => row[col] > val);
    }

    async function execute() {
      if (insertData) {
        // status defaults to 'pending' at the real database column level
        // (migration 033: `status text not null default 'pending'`) —
        // reproduced here since createInvite() itself relies on that
        // column default rather than setting it explicitly.
        const row = { id: `fake-${table}-${idCounter++}`, created_at: new Date().toISOString(), ...(table === 'complimentary_invites' ? { status: 'pending' } : {}), ...insertData };
        store[table].push(row);
        return { data: wantSingle ? row : [row], error: null };
      }

      if (upsertData) {
        const existingIdx = store[table].findIndex((row) => row[upsertConflictCol] === upsertData[upsertConflictCol]);
        if (existingIdx >= 0) {
          store[table][existingIdx] = { ...store[table][existingIdx], ...upsertData };
        } else {
          store[table].push({ id: `fake-${table}-${idCounter++}`, ...upsertData });
        }
        return { data: null, error: null };
      }

      const matched = store[table].filter(matches);
      if (updateData) {
        matched.forEach((row) => Object.assign(row, updateData));
      }
      return { data: wantSingle ? matched[0] || null : matched, error: null };
    }

    const builder = {
      select() { return builder; },
      order() { return builder; },
      eq(col, val) { eqFilters.push([col, val]); return builder; },
      gt(col, val) { gtFilters.push([col, val]); return builder; },
      update(data) { updateData = data; return builder; },
      insert(data) { insertData = data; return builder; },
      upsert(data, opts) { upsertData = data; upsertConflictCol = (opts && opts.onConflict) || 'id'; return builder; },
      single() { wantSingle = true; return builder; },
      maybeSingle() { wantSingle = true; return builder; },
      then(onFulfilled, onRejected) { return execute().then(onFulfilled, onRejected); },
    };
    return builder;
  }

  return { from: (table) => makeBuilder(table), __store: store };
}

const HOUSEHOLD = { id: 'household-cousin-tester' };
const FUTURE_REDEMPTION_DEADLINE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const PAST_REDEMPTION_DEADLINE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

// --- generateToken / hashToken ---

{
  const a = generateToken();
  const b = generateToken();
  check(typeof a === 'string' && a.length >= 40, 'generateToken: produces a long, non-trivial string (32 random bytes, base64url-encoded)');
  check(a !== b, 'generateToken: two calls never produce the same token (cryptographically random, not a counter/guessable value)');
  check(hashToken(a) === hashToken(a), 'hashToken: deterministic — the same token always hashes to the same value (required for lookup by hash)');
  check(hashToken(a) !== hashToken(b), 'hashToken: different tokens hash to different values');
  check(/^[0-9a-f]{64}$/.test(hashToken(a)), 'hashToken: produces a 64-character hex SHA-256 digest');
}

// --- computeDisplayStatus ---

{
  const now = Date.now();
  check(computeDisplayStatus({ status: 'pending', redemption_expires_at: new Date(now + 10000).toISOString() }, now) === 'pending', 'computeDisplayStatus: a pending invite still within its redemption window displays as pending');
  check(computeDisplayStatus({ status: 'pending', redemption_expires_at: new Date(now - 10000).toISOString() }, now) === 'expired', 'computeDisplayStatus: a pending invite past its redemption deadline displays as expired, without needing a background job to flip its stored status');
  check(computeDisplayStatus({ status: 'redeemed', redemption_expires_at: new Date(now - 10000).toISOString() }, now) === 'redeemed', 'computeDisplayStatus: an already-redeemed invite always displays as redeemed, regardless of its deadline');
  check(computeDisplayStatus({ status: 'revoked', redemption_expires_at: new Date(now + 10000).toISOString() }, now) === 'revoked', 'computeDisplayStatus: a revoked invite displays as revoked');
}

// --- createInvite ---

async function testCreateInviteRejectsBadDuration() {
  const client = makeFakeSupabaseAdmin();
  try {
    await createInvite({ durationDays: 45, note: 'x' }, { client });
    check(false, 'createInvite: rejects a durationDays value outside the allowed set');
  } catch (err) {
    check(/durationDays must be one of/.test(err.message), 'createInvite: rejects a durationDays value outside the allowed set');
  }
}

async function testCreateInviteStoresOnlyTheHash() {
  const client = makeFakeSupabaseAdmin();
  const { invite, token } = await createInvite({ durationDays: 30, note: 'Sister', createdByAuthUserId: 'admin-1' }, { client });

  check(typeof token === 'string' && token.length > 0, 'createInvite: returns the raw token to the caller exactly once');
  check(invite.duration_days === 30, 'createInvite: stores the requested duration');

  const storedRow = client.__store.complimentary_invites[0];
  check(storedRow.token_hash === hashToken(token), "createInvite: the stored row's token_hash matches a hash of the returned raw token");
  check(!('token' in storedRow) && !JSON.stringify(storedRow).includes(token), 'createInvite: the raw token itself is never present anywhere in the stored row');
  check(storedRow.status === 'pending', 'createInvite: a newly created invite starts in pending status');
}

await testCreateInviteRejectsBadDuration();
await testCreateInviteStoresOnlyTheHash();

check(ALLOWED_DURATIONS_DAYS.join(',') === '30,90,365', 'ALLOWED_DURATIONS_DAYS matches the three admin-selectable durations (30/90 days, 12 months)');

// --- redeemInvite: the core flow ---

async function testRedeemGrantsComplimentaryEntitlement() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [
      { id: 'inv-1', token_hash: hashToken('good-token'), duration_days: 30, note: 'Sister', status: 'pending', redemption_expires_at: FUTURE_REDEMPTION_DEADLINE },
    ],
  });

  const result = await redeemInvite('good-token', HOUSEHOLD, { client });

  check(result.redeemed === true, 'redeemInvite: a valid, pending, not-yet-expired invite is successfully redeemed');
  check(result.granted === true, 'redeemInvite: the complimentary entitlement is granted for a household with no existing entitlement');

  const invRow = client.__store.complimentary_invites[0];
  check(invRow.status === 'redeemed', "redeemInvite: flips the invite's own status to redeemed");
  check(invRow.redeemed_household_id === HOUSEHOLD.id, 'redeemInvite: records which household redeemed the invite, for audit');
  check(invRow.grant_outcome === 'granted', 'redeemInvite: records the downstream grant outcome for audit');

  const entRow = client.__store.entitlements[0];
  check(entRow.source === 'admin_manual' && entRow.entitlement_type === 'complimentary', 'redeemInvite: the granted entitlement uses the exact same source/type as the existing manual-grant path — no second entitlement mechanism');
  check(entRow.notes.includes('Friends & Family invite') && entRow.notes.includes('Sister'), "redeemInvite: the entitlement's notes reference the invite and its admin note");

  const classRow = client.__store.account_classifications.find((r) => r.household_id === HOUSEHOLD.id);
  check(!!classRow && classRow.classification === 'internal_test', 'redeemInvite: classifies the redeeming household as internal_test');
  check(classRow.classification !== 'genuine_customer', 'redeemInvite: NEVER classifies a Friends & Family account as genuine_customer');
}

async function testRedeemUsesFullDurationFromRedemptionTime() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [
      { id: 'inv-1', token_hash: hashToken('good-token'), duration_days: 90, status: 'pending', redemption_expires_at: FUTURE_REDEMPTION_DEADLINE },
    ],
  });

  const before = Date.now();
  await redeemInvite('good-token', HOUSEHOLD, { client });
  const entRow = client.__store.entitlements[0];
  const endsAtMs = new Date(entRow.ends_at).getTime();
  const expectedMinMs = before + 89 * 24 * 60 * 60 * 1000; // small tolerance below the full 90 days
  check(endsAtMs > expectedMinMs, 'redeemInvite: computes the full 90-day entitlement window from the moment of REDEMPTION, not from when the invite was originally created — a recipient who takes days to click the link still gets the full duration');
}

async function testRedeemRejectsUnknownToken() {
  const client = makeFakeSupabaseAdmin();
  const result = await redeemInvite('nonexistent-token', HOUSEHOLD, { client });
  check(result.redeemed === false && result.reason === 'invalid_expired_or_used', 'redeemInvite: an unknown/nonexistent token is refused, never grants anything');
  check(client.__store.entitlements.length === 0, 'redeemInvite: no entitlement is created for an unknown token');
}

async function testRedeemRejectsExpiredInvite() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [
      { id: 'inv-1', token_hash: hashToken('stale-token'), duration_days: 30, status: 'pending', redemption_expires_at: PAST_REDEMPTION_DEADLINE },
    ],
  });
  const result = await redeemInvite('stale-token', HOUSEHOLD, { client });
  check(result.redeemed === false && result.reason === 'invalid_expired_or_used', 'redeemInvite: an invite past its redemption deadline is refused, even though the token itself is otherwise correct');
  check(client.__store.complimentary_invites[0].status === 'pending', 'redeemInvite: an expired invite is left in its original state, not silently marked redeemed');
}

async function testRedeemRejectsAlreadyRevokedInvite() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [
      { id: 'inv-1', token_hash: hashToken('revoked-token'), duration_days: 30, status: 'revoked', redemption_expires_at: FUTURE_REDEMPTION_DEADLINE },
    ],
  });
  const result = await redeemInvite('revoked-token', HOUSEHOLD, { client });
  check(result.redeemed === false, 'redeemInvite: a revoked invite can never be redeemed');
}

async function testDoubleRedemptionOnlySucceedsOnce() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [
      { id: 'inv-1', token_hash: hashToken('single-use-token'), duration_days: 30, status: 'pending', redemption_expires_at: FUTURE_REDEMPTION_DEADLINE },
    ],
  });

  const householdA = { id: 'household-a' };
  const householdB = { id: 'household-b' };

  // Simulates two requests racing to redeem the exact same token. The
  // real atomicity guarantee comes from Postgres serializing the
  // UPDATE ... WHERE status = 'pending' against the same row — this
  // fake approximates that by applying the identical WHERE-clause
  // filtering logic sequentially, which is sufficient to prove the
  // application-level contract: once status flips away from 'pending',
  // no second caller can ever match the update again.
  const first = await redeemInvite('single-use-token', householdA, { client });
  const second = await redeemInvite('single-use-token', householdB, { client });

  check(first.redeemed === true, 'redeemInvite (single-use): the first redemption attempt succeeds');
  check(second.redeemed === false, 'redeemInvite (single-use): a second redemption attempt for the exact same token is refused — an invite can never be redeemed twice');
  check(client.__store.entitlements.length === 1, 'redeemInvite (single-use): only ONE entitlement is ever created from a single invite, even when redemption is attempted twice');
  check(client.__store.complimentary_invites[0].redeemed_household_id === householdA.id, 'redeemInvite (single-use): the invite records the household that actually won the race, not the second/losing attempt');
}

async function testRedeemNeverOverwritesExistingPaidEntitlement() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [
      { id: 'inv-1', token_hash: hashToken('good-token'), duration_days: 30, status: 'pending', redemption_expires_at: FUTURE_REDEMPTION_DEADLINE },
    ],
    entitlements: [
      { id: 'existing-stripe-ent', household_id: HOUSEHOLD.id, status: 'active', source: 'stripe', entitlement_type: 'paid' },
    ],
  });

  const result = await redeemInvite('good-token', HOUSEHOLD, { client });

  check(result.redeemed === true, 'redeemInvite: the invite is still consumed (single-use) even when the downstream grant is refused');
  check(result.granted === false && result.reason === 'active_paid_entitlement_exists', 'redeemInvite: the complimentary grant is refused when the household already has an active paid entitlement');

  const stripeEnt = client.__store.entitlements.find((e) => e.id === 'existing-stripe-ent');
  check(stripeEnt.status === 'active' && stripeEnt.source === 'stripe', "redeemInvite: the household's existing real Stripe entitlement is completely untouched — never expired, replaced, or downgraded");
  check(client.__store.entitlements.filter((e) => e.household_id === HOUSEHOLD.id).length === 1, 'redeemInvite: no second/complimentary entitlement is created alongside the untouched paid one');

  const invRow = client.__store.complimentary_invites[0];
  check(invRow.grant_outcome === 'refused:active_paid_entitlement_exists', 'redeemInvite: the refusal reason is recorded on the invite for audit');
}

await testRedeemGrantsComplimentaryEntitlement();
await testRedeemUsesFullDurationFromRedemptionTime();
await testRedeemRejectsUnknownToken();
await testRedeemRejectsExpiredInvite();
await testRedeemRejectsAlreadyRevokedInvite();
await testDoubleRedemptionOnlySucceedsOnce();
await testRedeemNeverOverwritesExistingPaidEntitlement();

// --- revokeInvite ---

async function testRevokePendingInvite() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [{ id: 'inv-1', token_hash: 'x', duration_days: 30, status: 'pending', redemption_expires_at: FUTURE_REDEMPTION_DEADLINE }],
  });
  const result = await revokeInvite('inv-1', { client });
  check(result.revoked === true, 'revokeInvite: a pending invite can be revoked');
  check(client.__store.complimentary_invites[0].status === 'revoked', "revokeInvite: flips the invite's status to revoked");
}

async function testRevokeAlreadyRedeemedInviteIsANoOp() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [{ id: 'inv-1', token_hash: 'x', duration_days: 30, status: 'redeemed', redemption_expires_at: FUTURE_REDEMPTION_DEADLINE }],
  });
  const result = await revokeInvite('inv-1', { client });
  check(result.revoked === false, 'revokeInvite: an already-redeemed invite cannot be revoked (nothing to undo — the grant already happened)');
  check(client.__store.complimentary_invites[0].status === 'redeemed', 'revokeInvite: leaves an already-redeemed invite completely untouched');
}

await testRevokePendingInvite();
await testRevokeAlreadyRedeemedInviteIsANoOp();

// --- listInvites ---

async function testListInvitesReturnsDisplayStatus() {
  const client = makeFakeSupabaseAdmin({
    complimentary_invites: [
      { id: 'inv-1', duration_days: 30, status: 'pending', redemption_expires_at: PAST_REDEMPTION_DEADLINE, created_at: new Date().toISOString() },
    ],
  });
  const result = await listInvites({ client });
  check(result.available === true, 'listInvites: returns available:true when the client is configured');
  check(result.invites[0].displayStatus === 'expired', 'listInvites: annotates each invite with its computed display status (pending/redeemed/expired/revoked)');
}

async function testListInvitesUnavailableWithoutClient() {
  const result = await listInvites({ client: null });
  check(result.available === false, 'listInvites: reports unavailable rather than throwing when no Supabase client is configured');
}

await testListInvitesReturnsDisplayStatus();
await testListInvitesUnavailableWithoutClient();

// ============================================================
// Structural checks — route wiring, server hooks, migration shape.
// Matches this codebase's established convention (tests/admin-business-
// auth.test.mjs) since there is no HTTP test tooling in this project.
// ============================================================

const adminRouteSource = readFileSync(new URL('../routes/admin.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const registerHtmlSource = readFileSync(new URL('../public/register.html', import.meta.url), 'utf8');
const loginHtmlSource = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../supabase/migrations/033_complimentary_invites.sql', import.meta.url), 'utf8');
const complimentaryInvitesSource = readFileSync(new URL('../services/complimentaryInvites.js', import.meta.url), 'utf8');

// --- routes/admin.js: the three new routes are admin-gated ---

const inviteRouteDeclarations = [...adminRouteSource.matchAll(/router\.(get|post)\("(\/admin\/api\/complimentary-invites[^"]*)",\s*([^)]*)\)/g)];
check(inviteRouteDeclarations.length === 3, 'routes/admin.js: declares exactly the three expected invite routes (create, list, revoke)');
for (const [, method, urlPath, middlewareArgs] of inviteRouteDeclarations) {
  check(
    middlewareArgs.includes('requireAuth') && middlewareArgs.includes('requireAdmin'),
    `routes/admin.js: ${method.toUpperCase()} ${urlPath} is gated by both requireAuth and requireAdmin directly in its own declaration`
  );
}

check(
  adminRouteSource.includes('createInvite(') && adminRouteSource.includes('require("../services/complimentaryInvites")'),
  'routes/admin.js: the create-invite route uses the real services/complimentaryInvites.js module, not a reimplementation'
);

// ============================================================
// Regression: LIVE BUG — every duration selection failed with
// "durationDays must be one of 30, 90, 365", including 12 months
// (365). Root cause: server.js applies only bodyParser.urlencoded()
// globally (no global express.json()) — every JSON-body route in this
// codebase must scope express.json() onto itself (see
// /household/phone-number, /confirm-session, /reset-password-verify),
// and the create-invite route never did, so req.body arrived {} for
// every request regardless of which duration was picked.
// ============================================================

// --- structural: the actual fix is in place on the real route ---

const createInviteRouteDeclaration = adminRouteSource.match(/router\.post\("\/admin\/api\/complimentary-invites",[\s\S]{0,120}?async/);
check(
  !!createInviteRouteDeclaration && createInviteRouteDeclaration[0].includes('express.json()'),
  'routes/admin.js: POST /admin/api/complimentary-invites now scopes express.json() onto itself, matching this codebase\'s existing per-route JSON-parsing convention — this is the actual fix for the live duration-mismatch bug'
);

// --- functional: reproduces the exact Express/body-parser mechanism,
// isolated from real auth/Supabase (this codebase never boots the real
// server.js in tests — see tests/admin-business-auth.test.mjs). Proves
// the bug's real mechanism (a JSON POST silently arrives as an empty
// body under bodyParser.urlencoded() alone) and that scoping
// express.json() onto the route actually fixes it. ---

async function startTestApp(withJsonFix) {
  const express = require('express');
  const bodyParser = require('body-parser');
  const app = express();
  // Same global body-parser configuration as the real server.js (line
  // 143: app.use(bodyParser.urlencoded({ extended: false })) — no
  // global express.json() anywhere in this codebase).
  app.use(bodyParser.urlencoded({ extended: false }));
  app.post(
    '/test-route',
    ...(withJsonFix ? [express.json()] : []),
    (req, res) => res.json({ receivedDurationDays: (req.body || {}).durationDays })
  );
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function postJson(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/test-route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function testJsonBodyIsLostWithoutTheFix() {
  const server = await startTestApp(false);
  try {
    const port = server.address().port;
    const result = await postJson(port, { durationDays: 365, note: 'Sister' });
    check(
      result.receivedDurationDays === undefined,
      'Regression proof (bug mechanism): with only the global bodyParser.urlencoded() this codebase actually uses, a JSON POST body is silently NOT parsed — req.body.durationDays comes back undefined for EVERY duration, not just 365, exactly matching the reported "durationDays must be one of 30, 90, 365" failure on every selection'
    );
  } finally {
    server.close();
  }
}

async function testJsonBodyParsesCorrectlyWithTheFix() {
  const server = await startTestApp(true);
  try {
    const port = server.address().port;
    for (const duration of [30, 90, 365]) {
      const result = await postJson(port, { durationDays: duration, note: 'Sister' });
      check(
        result.receivedDurationDays === duration,
        `Regression proof (fix): with express.json() scoped onto the route (the actual fix applied to routes/admin.js), a JSON POST correctly delivers durationDays: ${duration}`
      );
    }
  } finally {
    server.close();
  }
}

await testJsonBodyIsLostWithoutTheFix();
await testJsonBodyParsesCorrectlyWithTheFix();

// --- every dropdown option in the real admin UI submits an accepted
// backend value, closing the actual UI/API mismatch surface, not just
// the body-parsing bug ---

const dashboardHtmlSourceForInviteCheck = readFileSync(new URL('../admin-business.html', import.meta.url), 'utf8');
const inviteSelectMatch = dashboardHtmlSourceForInviteCheck.match(/<select id="opInviteDuration">([\s\S]*?)<\/select>/);
check(!!inviteSelectMatch, 'admin-business.html: the Friends & Family duration <select> is present');
const inviteOptionValues = [...(inviteSelectMatch ? inviteSelectMatch[1] : '').matchAll(/<option value="(\d+)">/g)].map((m) => Number(m[1]));
check(inviteOptionValues.length === 3, 'admin-business.html: the duration dropdown has exactly the three expected options (30 days / 90 days / 12 months)');
for (const optionValue of inviteOptionValues) {
  check(
    ALLOWED_DURATIONS_DAYS.includes(optionValue),
    `admin-business.html: dropdown option value ${optionValue} is an accepted backend duration (ALLOWED_DURATIONS_DAYS: ${ALLOWED_DURATIONS_DAYS.join(', ')}) — the UI label may say "12 months" but must submit the exact backend value`
  );
}

// --- no secret env var ever assigned into a response ---

const SECRET_ENV_VAR_NAMES = ['STRIPE_SECRET_KEY', 'TWILIO_AUTH_TOKEN', 'TWILIO_VOICE_API_KEY_SECRET', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'Resend_API_Key'];
for (const varName of SECRET_ENV_VAR_NAMES) {
  const dangerousPattern = new RegExp(`:\\s*process\\.env\\.${varName}\\b(?!\\s*\\))`);
  check(!dangerousPattern.test(complimentaryInvitesSource), `services/complimentaryInvites.js never assigns process.env.${varName}'s value into a returned field`);
}

// --- the raw invite token is never logged ---

check(
  !/console\.(log|error|warn)\([^)]*\btoken\b(?!Hash)/i.test(complimentaryInvitesSource.replace(/\/\/.*$/gm, '')),
  'services/complimentaryInvites.js: no console.log/error/warn call references the raw token variable — only its hash is ever handled after generation'
);

// --- server.js: /register captures the invite token but never validates it synchronously ---

check(
  serverSource.includes('req.body.invite_token'),
  '/register reads the invite token from the hidden form field, exactly like the existing UTM fields'
);
check(
  serverSource.includes('pending_invite_token: inviteToken'),
  '/register stashes the invite token in this account\'s own Supabase Auth user_metadata at signUp time, so it survives to first login (households are created at login, not at /register, since email confirmation is required)'
);
check(
  !/if\s*\(!?inviteToken\)[\s\S]{0,80}redirect\(`\/register\.html\?state=error/.test(serverSource),
  '/register never fails or blocks normal registration based on invite-token validity — an invalid/missing invite never affects the real signup outcome'
);

// --- server.js: /login redeems the invite and clears the metadata afterward ---

check(
  serverSource.includes('data.user.user_metadata?.pending_invite_token'),
  '/login reads back the invite token stashed during registration, once the household genuinely exists'
);
check(
  serverSource.includes('redeemInvite(pendingInviteToken, household)'),
  '/login calls the real redeemInvite() against the newly-available household — the entitlement is granted only once a real household row exists, never before'
);
check(
  serverSource.includes('updateUser({ data: { pending_invite_token: null } })'),
  '/login clears the pending invite token from user_metadata after attempting redemption, so it is not retried indefinitely on every future login'
);

// A login-flow invite failure must never be able to block a normal login.
const loginInviteBlockSource = serverSource.slice(
  serverSource.indexOf('const pendingInviteToken ='),
  serverSource.indexOf('} catch (err) {\n    console.error("LOGIN HOUSEHOLD SETUP ERROR')
);
check(
  loginInviteBlockSource.includes('try {') && loginInviteBlockSource.includes('} catch (inviteErr)'),
  '/login: invite redemption is wrapped in its own try/catch, separate from the household-setup failure path, so an invite-redemption error can never redirect a normal customer to setup_failed'
);

// --- public/register.html: forwards the ?invite= query param ---

check(registerHtmlSource.includes('name="invite_token"'), 'public/register.html: has a hidden invite_token field, forwarded on submit exactly like the existing UTM fields');
check(registerHtmlSource.includes('params.get("invite")'), 'public/register.html: populates the hidden field from this page\'s own ?invite= URL parameter — no cookie, no new tracking surface');

// ============================================================
// Existing-account path: invite -> login -> authenticate -> existing
// household resolved -> invite redeemed. Added as a correction after
// the initial review: a recipient who already has an HCG account was
// previously losing the invite token when routed to /login.html.
// ============================================================

// --- register.html forwards the token to the login link, so opening
// the invite as an existing user and clicking "Log in" doesn't lose it ---

check(
  registerHtmlSource.includes('id="loginLink"') && registerHtmlSource.includes('loginLink.href = "/login.html?invite="'),
  'public/register.html: the "Log in" link is rewritten to carry the invite token forward when one is present, so an existing-account recipient does not lose it'
);
check(
  !/loginLink\.href[\s\S]{0,80}(document\.cookie|localStorage)/.test(registerHtmlSource),
  'public/register.html: the invite token is forwarded via a plain URL parameter only — never written to a cookie or localStorage'
);

// --- server.js's already_registered redirect also forwards the token ---

check(
  serverSource.includes('const inviteQuery = inviteToken ? `&invite=${encodeURIComponent(inviteToken)}` : "";') &&
    serverSource.includes('res.redirect(`/login.html?state=already_registered${inviteQuery}`)'),
  '/register: when an existing account is detected, the redirect to /login.html still forwards the invite token, instead of silently dropping it'
);

// --- login.html: hidden field, populated from the URL, no client-side storage ---

check(loginHtmlSource.includes('name="invite_token"'), 'public/login.html: has a hidden invite_token field on the login form, mirroring register.html');
check(loginHtmlSource.includes('params.get("invite")'), "public/login.html: populates the hidden field from this page's own ?invite= URL parameter");
check(
  !/document\.cookie|localStorage/.test(loginHtmlSource.replace(/<!--[\s\S]*?-->/g, '')),
  'public/login.html: the invite token is never written to a cookie or localStorage — it only flows through the one form submission'
);

// --- server.js: /login accepts the invite token from the login form
// itself (existing-account path), not only from signup metadata ---

check(
  serverSource.includes('typeof req.body.invite_token === "string" && req.body.invite_token.trim().slice(0, 512)') &&
    serverSource.includes('data.user.user_metadata?.pending_invite_token;'),
  '/login: resolves the invite token from either the login form (existing-account path) or signup metadata (new-account path) — the same redemption call handles both, no second/duplicate redemption mechanism'
);

// --- redemption still happens only after successful authentication and
// household resolution, for both paths — never before ---

const loginHandlerSource = serverSource.slice(serverSource.indexOf('app.post("/login"'), serverSource.indexOf('app.post("/login"') + 3000);
const authCheckIdx = loginHandlerSource.indexOf('if (error || !data.session)');
const ensureHouseholdIdx = loginHandlerSource.indexOf('ensureHouseholdAndRole(userClient, data.user.id, email, "[LOGIN]")');
const redeemIdx = loginHandlerSource.indexOf('await redeemInvite(pendingInviteToken, household)');
check(
  authCheckIdx !== -1 && ensureHouseholdIdx !== -1 && redeemIdx !== -1 && authCheckIdx < ensureHouseholdIdx && ensureHouseholdIdx < redeemIdx,
  '/login: invite redemption is code-ordered strictly after the authentication check and after household resolution — never attempted before a successful login'
);

// --- exactly one redemption call site is reused for both the new- and
// existing-account paths — no second implementation was created ---

check(
  (serverSource.match(/await redeemInvite\(/g) || []).length === 2,
  'server.js calls redeemInvite() from exactly two call sites (the rare synchronous-session /register branch, and the common /login path) — no separate, duplicate redemption logic was written for the existing-account correction'
);

// --- existing safeguards are still all reachable from the shared
// redeemInvite() call — re-asserted structurally now that a second
// call path (existing-account/login-form) feeds into it ---

check(
  complimentaryInvitesSource.includes("eq('status', 'pending')") && complimentaryInvitesSource.includes("gt('redemption_expires_at', nowIso)"),
  'services/complimentaryInvites.js: the atomic single-use + expiry guard in redeemInvite() is unchanged and applies identically regardless of which caller (new- or existing-account path) invokes it'
);
check(
  complimentaryInvitesSource.includes('grantComplimentaryEntitlement('),
  'services/complimentaryInvites.js: redeemInvite() still delegates the actual grant to the existing, unmodified grantComplimentaryEntitlement() — its paid-entitlement safety guard applies to both invite paths equally'
);
check(
  complimentaryInvitesSource.includes("classification: 'internal_test'"),
  'services/complimentaryInvites.js: redeemInvite() still classifies the redeeming household as internal_test regardless of which path (new- or existing-account) reached it'
);

// --- migration 033: additive, isolated, correctly scoped ---

check(
  migrationSource.includes('create table if not exists public.complimentary_invites') &&
    !migrationSource.toLowerCase().includes('alter table public.households') &&
    !migrationSource.toLowerCase().includes('alter table public.entitlements'),
  'migration 033 creates only the new table — no existing household/entitlement table is altered'
);
check(migrationSource.includes('token_hash text not null unique'), 'migration 033: token_hash has a UNIQUE constraint — the database itself, not just application logic, prevents two invites from ever sharing a token');
check(migrationSource.includes("check (duration_days in (30, 90, 365))"), 'migration 033: duration_days is constrained at the database level to the three admin-selectable durations');
check(migrationSource.includes('on delete set null'), 'migration 033: redeemed_household_id uses ON DELETE SET NULL — a household can always be deleted/anonymised without this table ever blocking it');
check(
  migrationSource.includes('grant select, insert, update on public.complimentary_invites to service_role') &&
    !migrationSource.includes('to anon') &&
    !migrationSource.includes('to authenticated'),
  'migration 033 grants only service_role — no anon or authenticated access to this table, matching account_classifications/acquisition_events precedent'
);

console.log(failures === 0 ? '\nAll Friends & Family invite checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
