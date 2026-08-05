// Unit tests for services/mobileRegistration.js — the mobile half of the
// same fix already shipped on web (services/registrationFlow.js,
// tests/registration-flow.test.mjs). Root cause: mobile/app/(auth)/
// register.tsx used to call supabase.auth.signUp() directly and only
// check for an error; Supabase returns success with no error, and sends
// no email, when signUp() is called for an already-registered, already-
// confirmed account (documented anti-enumeration behaviour) — the
// customer was pushed to "check your email" and left waiting forever.
// Found 2026-08-05 via andrewdeane_uk@yahoo.co.uk, already confirmed on
// staging since 2026-07-31.
//
// No real Supabase calls — findExistingAuthUser/decideRegistrationAction
// are exercised through fake adminClient/authClient objects, matching
// tests/registration-flow.test.mjs's own pattern exactly.
//
// Run with: node tests/mobile-registration.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handleMobileRegister, handleMobileResendConfirmation } = require('../services/mobileRegistration.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function makeFakeAdminClient(users) {
  return {
    auth: {
      admin: {
        async listUsers({ page, perPage }) {
          const start = (page - 1) * perPage;
          return { data: { users: users.slice(start, start + perPage) }, error: null };
        },
      },
    },
  };
}

function makeFakeAuthClient({ signUpError = null, resendError = null } = {}) {
  const calls = { signUp: [], resend: [] };
  return {
    calls,
    auth: {
      async signUp(args) {
        calls.signUp.push(args);
        return signUpError ? { data: null, error: { message: signUpError } } : { data: { user: { id: 'new-user' } }, error: null };
      },
      async resend(args) {
        calls.resend.push(args);
        return resendError ? { data: null, error: { message: resendError } } : { data: {}, error: null };
      },
    },
  };
}

async function run() {
  // === handleMobileRegister ===

  {
    const admin = makeFakeAdminClient([]);
    const authClient = makeFakeAuthClient();
    const result = await handleMobileRegister({ email: 'brand-new@example.com', password: 'pw1', adminClient: admin, authClient });
    check(result.status === 'pending_confirmation', 'brand-new email: status is pending_confirmation');
    check(authClient.calls.signUp.length === 1 && authClient.calls.signUp[0].email === 'brand-new@example.com', 'brand-new email: signUp is called exactly once, with the submitted email');
    check(authClient.calls.resend.length === 0, 'brand-new email: resend is never called');
  }

  {
    const admin = makeFakeAdminClient([{ email: 'pending@example.com', email_confirmed_at: null }]);
    const authClient = makeFakeAuthClient();
    const result = await handleMobileRegister({ email: 'pending@example.com', password: 'a-different-password', adminClient: admin, authClient });
    check(result.status === 'pending_confirmation', 'existing unconfirmed email: status is pending_confirmation (identical to brand-new — anti-enumeration)');
    check(authClient.calls.resend.length === 1, 'existing unconfirmed email: resend is called');
    check(authClient.calls.signUp.length === 0, 'existing unconfirmed email: signUp is never called again — the documented Supabase quirk (silently keeps the original password) is never triggered');
  }

  {
    const admin = makeFakeAdminClient([{ email: 'confirmed@example.com', email_confirmed_at: '2026-07-31T15:32:47Z' }]);
    const authClient = makeFakeAuthClient();
    const result = await handleMobileRegister({ email: 'confirmed@example.com', password: 'whatever-they-typed', adminClient: admin, authClient });
    check(result.status === 'already_registered', 'existing confirmed email: status is already_registered');
    check(authClient.calls.signUp.length === 0 && authClient.calls.resend.length === 0, 'existing confirmed email: neither signUp nor resend is ever called — no email sent, nothing pretended');
  }

  {
    // The exact scenario reported 2026-08-05: same email, a password that
    // does NOT match whatever was used on the original 2026-07-31
    // registration. The password value itself must make no difference to
    // the outcome — an already-confirmed account is never touched.
    const admin = makeFakeAdminClient([{ email: 'andrewdeane_uk@yahoo.co.uk', email_confirmed_at: '2026-07-31T15:32:47Z' }]);
    const authClient = makeFakeAuthClient();
    const result = await handleMobileRegister({ email: 'andrewdeane_uk@yahoo.co.uk', password: 'a-brand-new-different-password', adminClient: admin, authClient });
    check(result.status === 'already_registered', 'different password against an existing confirmed account: still already_registered, not silently applied or silently discarded without telling anyone');
    check(authClient.calls.signUp.length === 0, 'different password against an existing confirmed account: the newly entered password is never sent to Supabase at all for this account');
  }

  {
    // Simulates the exact double-registration sequence that could, in
    // principle, create two households for one email if signUp() were
    // ever called a second time: first call sees no existing user
    // (signup), second call — now that the account genuinely exists —
    // must never decide "signup" again.
    const users = [];
    const admin = { auth: { admin: { async listUsers({ page, perPage }) { const start = (page - 1) * perPage; return { data: { users: users.slice(start, start + perPage) }, error: null }; } } } };
    const authClient = makeFakeAuthClient();

    const first = await handleMobileRegister({ email: 'duplicate-check@example.com', password: 'pw1', adminClient: admin, authClient });
    check(first.status === 'pending_confirmation' && authClient.calls.signUp.length === 1, 'duplicate-household prevention, step 1: first registration for a new email does sign up');

    // Now the account exists (as Supabase itself would report it).
    users.push({ email: 'duplicate-check@example.com', email_confirmed_at: null });
    const second = await handleMobileRegister({ email: 'duplicate-check@example.com', password: 'pw2-different', adminClient: admin, authClient });
    check(second.status === 'pending_confirmation' && authClient.calls.signUp.length === 1, 'duplicate-household prevention, step 2: resubmitting the same email never calls signUp a second time — only one auth user (and so only one possible household bootstrap) can ever exist for this email');
    check(authClient.calls.resend.length === 1, 'duplicate-household prevention, step 2: the second attempt correctly resends instead');
  }

  {
    const admin = makeFakeAdminClient([]);
    const authClient = makeFakeAuthClient({ signUpError: 'simulated Supabase outage' });
    const result = await handleMobileRegister({ email: 'will-fail@example.com', password: 'pw1', adminClient: admin, authClient });
    check(result.status === 'error', 'a genuine signUp failure (e.g. Supabase outage) is surfaced as an error, not silently treated as pending_confirmation');
  }

  {
    // Anti-enumeration: the two "something was sent" outcomes must be
    // structurally identical to the caller — same status string, no
    // extra field distinguishing them.
    const adminNew = makeFakeAdminClient([]);
    const adminExisting = makeFakeAdminClient([{ email: 'x@example.com', email_confirmed_at: null }]);
    const authClient1 = makeFakeAuthClient();
    const authClient2 = makeFakeAuthClient();
    const newResult = await handleMobileRegister({ email: 'brand-new-2@example.com', password: 'pw', adminClient: adminNew, authClient: authClient1 });
    const resendResult = await handleMobileRegister({ email: 'x@example.com', password: 'pw', adminClient: adminExisting, authClient: authClient2 });
    check(
      JSON.stringify(newResult) === JSON.stringify(resendResult),
      'anti-enumeration: a brand-new signup and a resend-to-existing-unconfirmed produce an identical response shape — {status: "pending_confirmation"} either way'
    );
  }

  // === handleMobileResendConfirmation ===

  {
    const admin = makeFakeAdminClient([{ email: 'pending@example.com', email_confirmed_at: null }]);
    const authClient = makeFakeAuthClient();
    const result = await handleMobileResendConfirmation({ email: 'pending@example.com', adminClient: admin, authClient });
    check(result.status === 'resent', 'resend for an existing unconfirmed account: status is resent');
    check(authClient.calls.resend.length === 1, 'resend for an existing unconfirmed account: Supabase resend is actually called');
  }

  {
    const admin = makeFakeAdminClient([{ email: 'confirmed@example.com', email_confirmed_at: '2026-07-31T15:32:47Z' }]);
    const authClient = makeFakeAuthClient();
    const result = await handleMobileResendConfirmation({ email: 'confirmed@example.com', adminClient: admin, authClient });
    check(result.status === 'already_registered', 'resend for an already-confirmed account: status is already_registered, never "resent"');
    check(authClient.calls.resend.length === 0, 'resend for an already-confirmed account: Supabase resend is never called — no false "sent again" is possible, because nothing was sent');
  }

  {
    const admin = makeFakeAdminClient([]);
    const authClient = makeFakeAuthClient();
    const result = await handleMobileResendConfirmation({ email: 'never-registered@example.com', adminClient: admin, authClient });
    check(result.status === 'no_action', 'resend for an email with no pending registration at all: status is no_action, not resent');
    check(authClient.calls.resend.length === 0, 'resend for an email with no pending registration: Supabase resend is never called');
  }

  {
    const admin = makeFakeAdminClient([{ email: 'flaky@example.com', email_confirmed_at: null }]);
    const authClient = makeFakeAuthClient({ resendError: 'simulated Supabase outage' });
    const result = await handleMobileResendConfirmation({ email: 'flaky@example.com', adminClient: admin, authClient });
    check(result.status === 'no_action', 'a genuine resend failure never reports "resent" — no false success state even when Supabase itself errors');
  }

  {
    // Invariant across every branch: "resent" is returned if and only if
    // authClient.auth.resend was actually called and succeeded.
    const scenarios = [
      { users: [], expectResent: false },
      { users: [{ email: 'a@example.com', email_confirmed_at: null }], expectResent: true },
      { users: [{ email: 'a@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }], expectResent: false },
    ];
    let allHold = true;
    for (const { users, expectResent } of scenarios) {
      const admin = makeFakeAdminClient(users);
      const authClient = makeFakeAuthClient();
      const result = await handleMobileResendConfirmation({ email: 'a@example.com', adminClient: admin, authClient });
      const resendWasCalled = authClient.calls.resend.length === 1;
      if ((result.status === 'resent') !== (resendWasCalled && expectResent)) allHold = false;
      if (resendWasCalled !== expectResent) allHold = false;
    }
    check(allHold, 'no false "email sent" success state: across every account state, status === "resent" if and only if a real resend call happened and succeeded');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
