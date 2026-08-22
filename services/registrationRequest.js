// Shared registration/resend request handling for BOTH the web app
// (server.js's /register and /resend-confirmation routes) and the mobile
// app (routes/mobileApi.js's /api/v1/register and /api/v1/register/resend
// routes). Reuses services/registrationFlow.js's decision logic
// (findExistingAuthUser / decideRegistrationAction) exactly, rather than
// two separately maintained sets of rules for the two clients.
//
// Originally mobile-only (services/mobileRegistration.js) — renamed and
// widened 2026-08-05 after the same underlying defect was found on the
// web side too: server.js's /resend-confirmation called
// supabase.auth.resend() unconditionally and always redirected to
// "?state=resent", regardless of whether Supabase actually sent anything
// — the exact same false-success shape as the mobile bug this file was
// first written to fix.
//
// Background: mobile/app/(auth)/register.tsx used to call
// supabase.auth.signUp() directly and only check for an error. Supabase's
// signUp() returns success with no error, and sends no email at all,
// when called for an email that's already registered AND confirmed
// (deliberate anti-enumeration behaviour, not a bug in Supabase) — the
// customer was pushed to "check your email" and left waiting forever.
// Found 2026-08-05 via andrewdeane_uk@yahoo.co.uk, already confirmed on
// staging since 2026-07-31.
const { findExistingAuthUser, decideRegistrationAction } = require("./registrationFlow");

// Returns "pending_confirmation" for BOTH a genuinely new signup and a
// resend to an existing-but-unconfirmed email — deliberately identical,
// matching the same anti-enumeration design already shipped on web
// (commit 51350cd): the customer sees the exact same outcome either way,
// so nothing about the app's response reveals whether the account was
// new or already existed. Only an existing, CONFIRMED account is ever
// distinguished ("already_registered") — necessary so the customer isn't
// left waiting for an email that will never come.
// emailRedirectTo is optional — the web app sets it (confirmed.html);
// the mobile app deliberately doesn't (it detects confirmation via
// AuthContext's onAuthStateChange + app-foreground, not a deep link into
// the confirmation click itself — see mobile/app/(auth)/confirm-email.tsx).
//
// Returns the raw signUp() data.session/data.user on a genuinely new
// signup so callers that need it (server.js's own rare "email
// confirmation is turned off, a session came back immediately" branch)
// can act on it — the mobile client's caller simply ignores these extra
// fields, since it always requires email confirmation.
async function handleRegisterRequest({ email, password, adminClient, authClient, emailRedirectTo }) {
  const existing = await findExistingAuthUser(email, { adminClient });
  const decision = decideRegistrationAction(existing);
  const options = emailRedirectTo ? { emailRedirectTo } : undefined;

  if (decision.action === "already_registered") {
    // Never call signUp() or resend() here — there is nothing to send,
    // and calling signUp() again would only rediscover the documented
    // "silently keeps the original password" behaviour this whole fix
    // exists to avoid. Whatever password was just entered is not, and
    // was never, applied to this account.
    return { status: "already_registered" };
  }

  if (decision.action === "resend") {
    const { error } = await authClient.auth.resend({ type: "signup", email, options });
    if (error) {
      console.error("REGISTER RESEND ERROR:", error.message);
      // Fails open into the same neutral pending state as a real resend —
      // matches this codebase's established fail-open convention
      // (findExistingAuthUser itself does the same on lookup failure)
      // rather than surfacing a raw error for something the customer
      // can't act on differently either way.
    }
    return { status: "pending_confirmation" };
  }

  // decision.action === "signup" — genuinely new email.
  const { data, error } = await authClient.auth.signUp({ email, password, options });
  if (error) {
    console.error("REGISTER SIGNUP ERROR:", error.message);
    return { status: "error", error: error.message };
  }
  return { status: "pending_confirmation", session: data?.session ?? null, user: data?.user ?? null };
}

// Powers the "Resend confirmation email" button on both clients (mobile
// confirm-email.tsx, web register.html and login.html). Never claims
// success unless Supabase actually accepted a resend for a real,
// existing, unconfirmed account.
async function handleResendConfirmationRequest({ email, adminClient, authClient, emailRedirectTo }) {
  const existing = await findExistingAuthUser(email, { adminClient });
  const decision = decideRegistrationAction(existing);
  const options = emailRedirectTo ? { emailRedirectTo } : undefined;

  if (decision.action === "already_registered") {
    return { status: "already_registered" };
  }

  if (decision.action === "resend") {
    const { error } = await authClient.auth.resend({ type: "signup", email, options });
    if (error) {
      console.error("RESEND CONFIRMATION ERROR:", error.message);
      return { status: "no_action" };
    }
    return { status: "resent" };
  }

  // decision.action === "signup" — no pending registration exists for
  // this email at all (e.g. it was never actually submitted, or the
  // account was since removed). Nothing to resend; deliberately not
  // distinguished from a real "nothing happened" outcome in the response
  // shape, so this can't be used to probe whether an email was ever
  // registered.
  return { status: "no_action" };
}

module.exports = {
  handleRegisterRequest,
  handleResendConfirmationRequest,
};
