// Unit tests for services/registrationFlow.js — the fix for the
// repeat-registration defect found during production Test 1 (a real
// customer who resubmitted /register before confirming ended up with a
// password that was never actually saved, and no error anywhere to
// explain why). Root cause: Supabase's signUp() silently keeps the
// password from the FIRST signup attempt when called again for an
// already-existing unconfirmed email
// (github.com/supabase/supabase/issues/29347) — this file tests the
// fix's decision logic in isolation, with injected fake collaborators,
// no real Supabase calls. Wording checks read public/register.html and
// public/login.html source directly, matching the existing pattern in
// tests/trusted-contacts-mobile-layout.test.mjs.
//
// Run with: node tests/registration-flow.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { decideRegistrationAction, findExistingAuthUser } = require('../services/registrationFlow.js');

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

function makeFakeAdminClient(users, { errorOnPage } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      admin: {
        async listUsers({ page, perPage }) {
          calls.push({ page, perPage });

          if (errorOnPage && page === errorOnPage) {
            return { data: null, error: { message: 'simulated listUsers failure' } };
          }

          const start = (page - 1) * perPage;
          return { data: { users: users.slice(start, start + perPage) }, error: null };
        },
      },
    },
  };
}

async function run() {
  // --- decideRegistrationAction: the actual fix, pure and isolated ---

  check(
    decideRegistrationAction(null).action === 'signup',
    'no existing user -> first registration proceeds to a normal signup (Test coverage item 1: first registration succeeds)'
  );

  check(
    decideRegistrationAction({ email_confirmed_at: null }).action === 'resend',
    'existing unconfirmed user -> resend, never signup again (item 2/3: repeat registration while unconfirmed does not replace the password, and resends instead)'
  );

  check(
    decideRegistrationAction({ email_confirmed_at: '2026-01-01T00:00:00Z' }).action === 'already_registered',
    'existing confirmed user -> already_registered, never signup again (item 5: confirmed existing user directed safely, not re-signed-up)'
  );

  check(
    decideRegistrationAction({ email_confirmed_at: null }).action !== 'signup' &&
      decideRegistrationAction({ email_confirmed_at: '2026-01-01T00:00:00Z' }).action !== 'signup',
    'item 6: signUp() is never the decision when any existing user (confirmed or not) is found — the only path that could create a duplicate auth user is unreachable once one already exists'
  );

  // --- findExistingAuthUser: the lookup itself ---

  const users = [
    { id: 'u1', email: 'someone@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' },
    { id: 'u2', email: 'Pending@Example.com', email_confirmed_at: null },
  ];

  {
    const admin = makeFakeAdminClient(users);
    const found = await findExistingAuthUser('someone@example.com', { adminClient: admin });
    check(found?.id === 'u1', 'finds an existing user by exact-case email match');
  }

  {
    const admin = makeFakeAdminClient(users);
    const found = await findExistingAuthUser('pending@example.com', { adminClient: admin });
    check(found?.id === 'u2', 'email matching is case-insensitive (Supabase itself normalises email case)');
  }

  {
    const admin = makeFakeAdminClient(users);
    const found = await findExistingAuthUser('  someone@example.com  ', { adminClient: admin });
    check(found?.id === 'u1', 'leading/trailing whitespace on the input email is trimmed before matching');
  }

  {
    const admin = makeFakeAdminClient(users);
    const found = await findExistingAuthUser('brand-new@example.com', { adminClient: admin });
    check(found === null, 'a genuinely new email returns null, so first registration is unaffected');
  }

  {
    // Two full pages of perPage=1 forces pagination; the match is on page 2.
    const admin = makeFakeAdminClient(users);
    const found = await findExistingAuthUser('pending@example.com', { adminClient: admin, perPage: 1 });
    check(
      found?.id === 'u2' && admin.calls.length === 2,
      'paginates across multiple pages rather than only checking the first'
    );
  }

  {
    const found = await findExistingAuthUser('anyone@example.com', { adminClient: null });
    check(found === null, 'fails open (returns null, so /register proceeds as a normal signup) when no admin client is configured');
  }

  {
    const admin = makeFakeAdminClient(users, { errorOnPage: 1 });
    const found = await findExistingAuthUser('someone@example.com', { adminClient: admin });
    check(found === null, 'fails open when the lookup itself errors, rather than blocking registration');
  }

  // --- Customer-facing wording (item 4) ---

  const registerHtml = readFileSync(path.join(__dirname, '..', 'public', 'register.html'), 'utf8');
  const loginHtml = readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');

  check(
    registerHtml.includes('An account is already waiting for confirmation') &&
      registerHtml.includes('Please use the password you originally chose'),
    'register.html states plainly that an account is already waiting for confirmation and the original password remains in use'
  );

  check(
    registerHtml.includes('pending_confirmation'),
    'register.html handles the pending_confirmation state distinctly from the plain first-time success state'
  );

  check(
    registerHtml.includes('reset it') && registerHtml.includes('/forgot-password.html'),
    'item 3: register.html offers a clear route to reset the password if the customer is unsure of the original one'
  );

  check(
    loginHtml.includes('already_registered') && loginHtml.includes('already registered'),
    'item 5: login.html directs an already-confirmed existing user to log in or reset their password'
  );

  check(
    !loginHtml.match(/already_registered[\s\S]{0,400}(confirmed|subscription|entitlement|household)/i),
    'item 5 / enumeration: the already_registered message stays neutral — no confirmation state or account detail beyond "an account exists"'
  );

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
