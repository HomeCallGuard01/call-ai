// Unit tests for services/registrationRequest.js — shared by both the
// web app (server.js's /register and /resend-confirmation) and the
// mobile app (routes/mobileApi.js's /api/v1/register and
// /api/v1/register/resend). Originally mobile-only
// (services/mobileRegistration.js, tests/mobile-registration.test.mjs);
// renamed and widened after the exact same false-success defect was
// found on web's /resend-confirmation too (it called
// supabase.auth.resend() unconditionally and always redirected to
// "?state=resent" regardless of outcome).
//
// Root cause this whole file exists to prevent: mobile/app/(auth)/
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
// Run with: node tests/registration-request.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handleRegisterRequest, handleResendConfirmationRequest } = require('../services/registrationRequest.js');

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
        return signUpError ? { data: null, error: { message: signUpError } } : { data: { user: { id: 'new-user' }, session: null }, error: null };
      },
      async resend(args) {
        calls.resend.push(args);
        return resendError ? { data: null, error: { message: resendError } } : { data: {}, error: null };
      },
    },
  };
}

async function run() {
  // === handleRegisterRequest ===

  // Item 1: brand-new account
  {
    const admin = makeFakeAdminClient([]);
    const authClient = makeFakeAuthClient();
    const result = await handleRegisterRequest({ email: 'brand-new@example.com', password: 'pw1', adminClient: admin, authClient });
    check(result.status === 'pending_confirmation', 'new account: status is pending_confirmation');
    check(authClient.calls.signUp.length === 1 && authClient.calls.signUp[0].email === 'brand-new@example.com', 'new account: signUp is called exactly once, with the submitted email');
    check(authClient.calls.resend.length === 0, 'new account: resend is never called');
  }

  // Item 2: existing unconfirmed account
  {
    const admin = makeFakeAdminClient([{ email: 'pending@example.com', email_confirmed_at: null }]);
    const authClient = makeFakeAuthClient();
    const result = await handleRegisterRequest({ email: 'pending@example.com', password: 'a-different-password', adminClient: admin, authClient });
    check(result.status === 'pending_confirmation', 'existing unconfirmed account: status is pending_confirmation (identical to a new account — anti-enumeration)');
    check(authClient.calls.resend.length === 1, 'existing unconfirmed account: resend is called');
    check(authClient.calls.signUp.length === 0, 'existing unconfirmed account: signUp is never called again — the documented Supabase quirk (silently keeps the original password) is never triggered');
  }

  // Item 3: existing confirmed account
  {
    const admin = makeFakeAdminClient([{ email: 'confirmed@example.com', email_confirmed_at: '2026-07-31T15:32:47Z' }]);
    const authClient = makeFakeAuthClient();
    const result = await handleRegisterRequest({ email: 'confirmed@example.com', password: 'whatever-they-typed', adminClient: admin, authClient });
    check(result.status === 'already_registered', 'existing confirmed account: status is already_registered');
    check(authClient.calls.signUp.length === 0 && authClient.calls.resend.length === 0, 'existing confirmed account: neither signUp nor resend is ever called — no email sent, nothing pretended');
  }

  // Item 4: different password entered for an existing (confirmed) account
  {
    // The exact scenario reported 2026-08-05: same email, a password that
    // does NOT match whatever was used on the original 2026-07-31
    // registration. The password value itself must make no difference to
    // the outcome — an already-confirmed account is never touched.
    const admin = makeFakeAdminClient([{ email: 'andrewdeane_uk@yahoo.co.uk', email_confirmed_at: '2026-07-31T15:32:47Z' }]);
    const authClient = makeFakeAuthClient();
    const result = await handleRegisterRequest({ email: 'andrewdeane_uk@yahoo.co.uk', password: 'a-brand-new-different-password', adminClient: admin, authClient });
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

    const first = await handleRegisterRequest({ email: 'duplicate-check@example.com', password: 'pw1', adminClient: admin, authClient });
    check(first.status === 'pending_confirmation' && authClient.calls.signUp.length === 1, 'duplicate-household prevention, step 1: first registration for a new email does sign up');

    // Now the account exists (as Supabase itself would report it).
    users.push({ email: 'duplicate-check@example.com', email_confirmed_at: null });
    const second = await handleRegisterRequest({ email: 'duplicate-check@example.com', password: 'pw2-different', adminClient: admin, authClient });
    check(second.status === 'pending_confirmation' && authClient.calls.signUp.length === 1, 'duplicate-household prevention, step 2: resubmitting the same email never calls signUp a second time — only one auth user (and so only one possible household bootstrap) can ever exist for this email');
    check(authClient.calls.resend.length === 1, 'duplicate-household prevention, step 2: the second attempt correctly resends instead');
  }

  {
    const admin = makeFakeAdminClient([]);
    const authClient = makeFakeAuthClient({ signUpError: 'simulated Supabase outage' });
    const result = await handleRegisterRequest({ email: 'will-fail@example.com', password: 'pw1', adminClient: admin, authClient });
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
    const newResult = await handleRegisterRequest({ email: 'brand-new-2@example.com', password: 'pw', adminClient: adminNew, authClient: authClient1 });
    const resendResult = await handleRegisterRequest({ email: 'x@example.com', password: 'pw', adminClient: adminExisting, authClient: authClient2 });
    check(
      newResult.status === resendResult.status,
      'anti-enumeration: a new account and a resend-to-existing-unconfirmed produce the identical status — "pending_confirmation" either way'
    );
  }

  {
    // Web needs emailRedirectTo passed through to Supabase; mobile omits
    // it. Both must work.
    const admin = makeFakeAdminClient([]);
    const authClient = makeFakeAuthClient();
    await handleRegisterRequest({ email: 'web-flow@example.com', password: 'pw', adminClient: admin, authClient, emailRedirectTo: 'https://homecallguard.co.uk/confirmed.html' });
    check(
      authClient.calls.signUp[0].options?.emailRedirectTo === 'https://homecallguard.co.uk/confirmed.html',
      'emailRedirectTo is passed through to signUp() when the caller (web) supplies one'
    );

    const authClient2 = makeFakeAuthClient();
    await handleRegisterRequest({ email: 'mobile-flow@example.com', password: 'pw', adminClient: admin, authClient: authClient2 });
    check(
      authClient2.calls.signUp[0].options === undefined,
      'no emailRedirectTo is sent at all when the caller (mobile) omits one — not even as an empty object'
    );
  }

  // === handleResendConfirmationRequest ===

  // Item 6: resend for an existing unconfirmed account
  {
    const admin = makeFakeAdminClient([{ email: 'pending@example.com', email_confirmed_at: null }]);
    const authClient = makeFakeAuthClient();
    const result = await handleResendConfirmationRequest({ email: 'pending@example.com', adminClient: admin, authClient });
    check(result.status === 'resent', 'resend for an existing unconfirmed account: status is resent');
    check(authClient.calls.resend.length === 1, 'resend for an existing unconfirmed account: Supabase resend is actually called');
  }

  // Item 5: resend when already confirmed
  {
    const admin = makeFakeAdminClient([{ email: 'confirmed@example.com', email_confirmed_at: '2026-07-31T15:32:47Z' }]);
    const authClient = makeFakeAuthClient();
    const result = await handleResendConfirmationRequest({ email: 'confirmed@example.com', adminClient: admin, authClient });
    check(result.status === 'already_registered', 'resend when already confirmed: status is already_registered, never "resent"');
    check(authClient.calls.resend.length === 0, 'resend when already confirmed: Supabase resend is never called — no false "sent again" is possible, because nothing was sent');
  }

  {
    const admin = makeFakeAdminClient([]);
    const authClient = makeFakeAuthClient();
    const result = await handleResendConfirmationRequest({ email: 'never-registered@example.com', adminClient: admin, authClient });
    check(result.status === 'no_action', 'resend for an email with no pending registration at all: status is no_action, not resent');
    check(authClient.calls.resend.length === 0, 'resend for an email with no pending registration: Supabase resend is never called');
  }

  {
    const admin = makeFakeAdminClient([{ email: 'flaky@example.com', email_confirmed_at: null }]);
    const authClient = makeFakeAuthClient({ resendError: 'simulated Supabase outage' });
    const result = await handleResendConfirmationRequest({ email: 'flaky@example.com', adminClient: admin, authClient });
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
      const result = await handleResendConfirmationRequest({ email: 'a@example.com', adminClient: admin, authClient });
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
