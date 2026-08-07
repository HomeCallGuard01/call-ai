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
import { outcomeContent, planResendEffect } from '../mobile/lib/registrationOutcome.ts';

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

  // --- Customer-facing wording (2026-08-05 revision: dedicated result
  // screens on both web and mobile, same title/body/actions on each) ---

  const registerHtml = readFileSync(path.join(__dirname, '..', 'public', 'register.html'), 'utf8');
  const loginHtml = readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');

  check(
    registerHtml.includes('Check your email or sign in'),
    'register.html uses the exact required title for the pending_confirmation outcome'
  );
  check(
    registerHtml.includes("If this is a new account, we’ve sent you a confirmation email.") &&
      registerHtml.includes("If you already have a Home Call Guard account, sign in with your existing password or reset it if you’ve forgotten it."),
    'register.html uses the exact required body text for the pending_confirmation outcome'
  );
  check(
    registerHtml.includes('This email may already be registered'),
    'register.html uses the exact required title for the already_registered outcome'
  );
  check(
    registerHtml.includes('Try signing in with your existing password. The password you just entered has not replaced your existing password.'),
    'register.html uses the exact required body text for the already_registered outcome'
  );

  check(
    registerHtml.includes('id="alreadyRegisteredPanel"') &&
      registerHtml.match(/alreadyRegisteredPanel[\s\S]{0,400}href="\/login\.html"[\s\S]{0,400}href="\/forgot-password\.html"/),
    'register.html\'s already_registered panel offers both Sign in and Reset password actions'
  );

  check(
    registerHtml.includes('state === "already_registered"') && registerHtml.includes('showAlreadyRegistered'),
    'register.html routes state=already_registered to its own dedicated panel, not the pending_confirmation one — never claims an email was sent for an already-confirmed account'
  );

  check(
    !registerHtml.includes('please use the password you originally chose'),
    'register.html no longer carries the old pre-2026-08-05 wording (superseded by the new unified body text)'
  );

  check(
    registerHtml.includes('pending_confirmation'),
    'register.html still routes the pending_confirmation state server-side (the underlying decision logic is unchanged) — only the displayed wording changed'
  );

  check(
    !registerHtml.includes('SUCCESS_MESSAGES'),
    'security wording fix (still in force): no state-conditional message table exists for the pending_confirmation outcome — "success" and "pending_confirmation" both call the exact same showSuccess(...) with the exact same markup'
  );

  check(
    registerHtml.match(/if \(state === "success" \|\| state === "pending_confirmation"\)/),
    'register.html still treats a genuinely new signup and a resend-to-unconfirmed identically — one branch, not two — the anti-enumeration property this whole flow depends on'
  );

  check(
    registerHtml.includes('name="return_to" value="register"') &&
      loginHtml.includes('name="return_to" value="login"'),
    'both register.html\'s and login.html\'s resend forms mark which page they came from, so /resend-confirmation returns the customer to the right context'
  );

  check(
    registerHtml.includes('id="resentNotice"') && registerHtml.includes('resent_attempted'),
    'register.html only shows a "sent again" notice when the server confirms a resend was actually attempted and processed — never unconditionally'
  );

  check(
    loginHtml.includes('already_registered') && loginHtml.includes('may already be registered'),
    'login.html (reached from a failed login attempt, not registration) still directs a possibly-existing user to sign in or reset their password, using hedged "may already be" wording rather than a definitive claim'
  );

  check(
    !loginHtml.match(/already_registered[\s\S]{0,400}(confirmed|subscription|entitlement|household)/i),
    'enumeration: login.html\'s already_registered message stays neutral — no confirmation state or account detail beyond "may already be registered"'
  );

  // --- Cross-platform wording parity (requirement: same wording and
  // behaviour on web and mobile) ---

  check(
    registerHtml.includes(outcomeContent('pending_confirmation').title) &&
      registerHtml.includes(outcomeContent('already_registered').title),
    'web and mobile share the exact same two outcome titles — register.html contains both strings mobile/lib/registrationOutcome.ts exports'
  );

  check(
    outcomeContent('already_registered').paragraphs.every(p => registerHtml.includes(p)),
    'web and mobile share the exact same already_registered body text'
  );

  check(
    registerHtml.includes(planResendEffect('resent').message),
    'web\'s resentNotice text and mobile\'s planResendEffect("resent") notice are the exact same string'
  );

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
