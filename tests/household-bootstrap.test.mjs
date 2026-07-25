// Unit tests for services/householdBootstrap.js — the fix for the
// reset-password session defect found during production Test 1 follow-up:
// /reset-password-complete established a genuinely valid session
// (setSessionCookies) but never called ensureHouseholdAndRole(), so a
// customer resetting their password before ever completing a first login
// got a valid session that requireAuth then destroyed on the very next
// request (no households row -> requireAuth's own
// "clearSessionCookies + redirect" branch). /login and /register both
// already called this function for exactly this reason; /reset-password-
// complete now does too.
//
// Uses a minimal fake Supabase query-builder — no real network, no real
// Supabase — matching this codebase's established pattern (see
// services/twilioProvisioning.js and its tests) of pure functions /
// injected collaborators over integration harnesses this project doesn't
// have. The real, live end-to-end behaviour (session cookies actually
// working against /dashboard after reset) was verified separately with
// direct HTTP requests against production, reported alongside this fix.
//
// Run with: node tests/household-bootstrap.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensureHouseholdAndRole } = require('../services/householdBootstrap.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// A minimal fake of the subset of the Supabase query builder
// ensureHouseholdAndRole actually calls: .from(table).select(...).eq(...).
// maybeSingle(), .from(table).update(...).is(...).select(), and
// .from(table).insert(...). Backed by a plain in-memory store per table,
// keyed by auth_user_id, so idempotency (calling twice) can be asserted
// directly against real state changes rather than just call counts.
function makeFakeUserClient(initial = { households: [], user_roles: [] }) {
  const store = {
    households: [...initial.households],
    user_roles: [...initial.user_roles],
  };
  const calls = { insert: [], update: [] };

  function from(table) {
    let pendingEq = null;

    const builder = {
      select() {
        return builder;
      },
      eq(column, value) {
        pendingEq = { column, value };
        return builder;
      },
      is(column, value) {
        pendingEq = { column, value };
        return builder;
      },
      async maybeSingle() {
        const rows = store[table];
        const match = pendingEq
          ? rows.find(r => r[pendingEq.column] === pendingEq.value)
          : rows[0];
        return { data: match || null, error: null };
      },
      update(patch) {
        calls.update.push({ table, patch });
        return {
          is(column, value) {
            const rows = store[table];
            const matches = rows.filter(r => r[column] === value);
            matches.forEach(r => Object.assign(r, patch));
            return {
              async select() {
                return { data: matches, error: null };
              },
            };
          },
        };
      },
      async insert(row) {
        calls.insert.push({ table, row });
        store[table].push({ ...row });
        return { error: null };
      },
    };

    return builder;
  }

  return { from, store, calls };
}

async function run() {
  // --- item 1: a customer with no household gets exactly one household
  // and the correct household role ---
  {
    const client = makeFakeUserClient();
    await ensureHouseholdAndRole(client, 'user-1', 'new@example.com', null);

    check(client.store.households.length === 1, 'item 1: exactly one household row created for a user with none');
    check(
      client.store.households[0].auth_user_id === 'user-1' && client.store.households[0].email === 'new@example.com',
      'item 1: the created household is correctly attributed to this user and email'
    );
    check(client.store.user_roles.length === 1, 'item 1: exactly one user_roles row created');
    check(
      client.store.user_roles[0].auth_user_id === 'user-1' && client.store.user_roles[0].role === 'household',
      'item 1: the created role is "household", attributed to the correct user'
    );
  }

  // --- item 1 (variant): claims a pre-existing unclaimed default
  // household rather than always inserting a new one ---
  {
    const client = makeFakeUserClient({
      households: [{ id: 'default-household', auth_user_id: null, email: null }],
      user_roles: [],
    });
    await ensureHouseholdAndRole(client, 'user-2', 'claim@example.com', null);

    check(client.store.households.length === 1, 'claims the existing unclaimed household instead of inserting a second one');
    check(
      client.store.households[0].auth_user_id === 'user-2' && client.store.households[0].email === 'claim@example.com',
      'the claimed household is now correctly attributed to this user'
    );
  }

  // --- item 2: an existing customer (household + role already exist)
  // does not get a duplicate household or role ---
  {
    const client = makeFakeUserClient({
      households: [{ id: 'h1', auth_user_id: 'user-3', email: 'existing@example.com' }],
      user_roles: [{ auth_user_id: 'user-3', role: 'household' }],
    });
    await ensureHouseholdAndRole(client, 'user-3', 'existing@example.com', null);

    check(client.store.households.length === 1, 'item 2: no duplicate household created for an existing customer');
    check(client.store.user_roles.length === 1, 'item 2: no duplicate role created for an existing customer');
    check(client.calls.insert.length === 0, 'item 2: no insert was even attempted — genuinely a no-op, not insert-then-ignore');
  }

  // --- item 2 (repeat-call idempotency): calling it twice in a row for
  // a brand-new user behaves the same as calling it once ---
  {
    const client = makeFakeUserClient();
    await ensureHouseholdAndRole(client, 'user-4', 'twice@example.com', null);
    await ensureHouseholdAndRole(client, 'user-4', 'twice@example.com', null);

    check(client.store.households.length === 1, 'calling ensureHouseholdAndRole twice still results in exactly one household');
    check(client.store.user_roles.length === 1, 'calling ensureHouseholdAndRole twice still results in exactly one role');
  }

  // --- errors from the underlying client propagate rather than being
  // silently swallowed (so /reset-password-complete's try/catch, which
  // returns a real 500, actually has something to catch) ---
  {
    const client = makeFakeUserClient();
    client.from = (table) => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      async maybeSingle() {
        return { data: null, error: { message: 'simulated failure' } };
      },
    });

    let threw = false;
    try {
      await ensureHouseholdAndRole(client, 'user-5', 'fail@example.com', null);
    } catch (e) {
      threw = true;
    }
    check(threw, 'a Supabase error during the household check propagates as a thrown error, not a silent failure');
  }

  // --- item 3 (static verification — the live behavioural proof is
  // reported separately, see PR description): /reset-password-complete
  // actually calls ensureHouseholdAndRole before setting session cookies ---
  const serverJs = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const resetRouteMatch = serverJs.match(
    /app\.post\("\/reset-password-complete"[\s\S]*?\n\}\);/
  );
  check(!!resetRouteMatch, 'found the /reset-password-complete route in server.js');

  const resetRouteBody = resetRouteMatch ? resetRouteMatch[0] : '';
  const ensureIndex = resetRouteBody.indexOf('ensureHouseholdAndRole(');
  const setCookiesIndex = resetRouteBody.indexOf('setSessionCookies(');

  check(
    ensureIndex !== -1,
    'item 3: /reset-password-complete calls ensureHouseholdAndRole()'
  );
  check(
    ensureIndex !== -1 && setCookiesIndex !== -1 && ensureIndex < setCookiesIndex,
    'item 3: ensureHouseholdAndRole() runs before setSessionCookies() — the household exists before the session is handed to the browser'
  );
  check(
    resetRouteBody.includes('resetClient') && resetRouteBody.match(/ensureHouseholdAndRole\(\s*resetClient/),
    'uses the already-authenticated resetClient (the same session just verified/updated), not a fresh unauthenticated client'
  );

  // --- item 4: existing password-reset error cases are untouched ---
  check(
    resetRouteBody.includes('error: "invalid"') &&
      resetRouteBody.includes('error: "same_password"') &&
      resetRouteBody.includes('error: "failed"'),
    'item 4: all three existing error responses (invalid, same_password, failed) are still present'
  );
  check(
    (resetRouteBody.match(/res\.status\(400\)/g) || []).length >= 2,
    'item 4: the two 400 error paths (missing fields, invalid/expired token or same_password) are unchanged'
  );

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
