// Mobile registration/resend request handling. Reuses services/
// registrationFlow.js's decision logic (findExistingAuthUser /
// decideRegistrationAction) exactly — the same rules server.js's own
// web /register route already uses — rather than a second, separately
// maintained set of rules for the mobile client.
//
// Background: mobile/app/(auth)/register.tsx used to call
// supabase.auth.signUp() directly from the client, with no equivalent of
// the web fix below. Supabase's signUp() has documented anti-enumeration
// behaviour: called again for an email that's already registered AND
// confirmed, it returns success with no error and sends no email at all
// (it can't reveal the account exists). The mobile screen only checked
// `if (signUpError)`, saw none, and pushed the customer to a "check your
// email" screen that then waited forever for an email Supabase never
// queued — the exact defect reported 2026-08-05 (andrewdeane_uk@yahoo.co.uk,
// already confirmed on staging since 2026-07-31).
//
// Deliberately kept server-side (called only from routes/mobileApi.js,
// which alone holds the service-role client) rather than letting the
// mobile client do this lookup itself — the mobile client must never
// receive or use the Supabase service-role key.
const { findExistingAuthUser, decideRegistrationAction } = require("./registrationFlow");

// Returns "pending_confirmation" for BOTH a genuinely new signup and a
// resend to an existing-but-unconfirmed email — deliberately identical,
// matching the same anti-enumeration design already shipped on web
// (commit 51350cd): the customer sees the exact same outcome either way,
// so nothing about the app's response reveals whether the account was
// new or already existed. Only an existing, CONFIRMED account is ever
// distinguished ("already_registered") — the same minimal disclosure the
// web login flow already makes (hedged wording, not a definitive claim),
// necessary so the customer isn't left waiting for an email that will
// never come.
async function handleMobileRegister({ email, password, adminClient, authClient }) {
  const existing = await findExistingAuthUser(email, { adminClient });
  const decision = decideRegistrationAction(existing);

  if (decision.action === "already_registered") {
    // Never call signUp() or resend() here — there is nothing to send,
    // and calling signUp() again would only rediscover the documented
    // "silently keeps the original password" behaviour this whole fix
    // exists to avoid. Whatever password was just entered is not, and
    // was never, applied to this account.
    return { status: "already_registered" };
  }

  if (decision.action === "resend") {
    const { error } = await authClient.auth.resend({ type: "signup", email });
    if (error) {
      console.error("MOBILE REGISTER RESEND ERROR:", error.message);
      // Fails open into the same neutral pending state as a real resend —
      // matches this codebase's established fail-open convention
      // (findExistingAuthUser itself does the same on lookup failure)
      // rather than surfacing a raw error for something the customer
      // can't act on differently either way.
    }
    return { status: "pending_confirmation" };
  }

  // decision.action === "signup" — genuinely new email.
  const { error } = await authClient.auth.signUp({ email, password });
  if (error) {
    console.error("MOBILE REGISTER SIGNUP ERROR:", error.message);
    return { status: "error", error: error.message };
  }
  return { status: "pending_confirmation" };
}

// Powers the "Resend confirmation email" button on the mobile confirm-
// email screen. Never claims success unless Supabase actually accepted a
// resend for a real, existing, unconfirmed account — the direct fix for
// the other half of the same defect (the old code called
// supabase.auth.resend() unconditionally and showed the same "sent
// again" notice regardless of what actually happened).
async function handleMobileResendConfirmation({ email, adminClient, authClient }) {
  const existing = await findExistingAuthUser(email, { adminClient });
  const decision = decideRegistrationAction(existing);

  if (decision.action === "already_registered") {
    return { status: "already_registered" };
  }

  if (decision.action === "resend") {
    const { error } = await authClient.auth.resend({ type: "signup", email });
    if (error) {
      console.error("MOBILE RESEND CONFIRMATION ERROR:", error.message);
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
  handleMobileRegister,
  handleMobileResendConfirmation,
};
