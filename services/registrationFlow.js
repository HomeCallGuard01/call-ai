// Extracted from the /register route (server.js) so the actual defect
// fix — never calling supabase.auth.signUp() a second time for an email
// that already has a pending account — can be unit tested directly, with
// injected fake collaborators, matching this codebase's established
// pattern (see services/twilioProvisioning.js).
//
// Background: Supabase's signUp() has documented behaviour
// (github.com/supabase/supabase/issues/29347) where calling it again for
// an email that already exists but is still unconfirmed resends the
// confirmation email but silently KEEPS the password from the very first
// signup attempt — it never updates it, with no indication of this to
// the caller. A customer who resubmitted registration (typo fix,
// impatience, a double-click) saw an identical "check your email"
// success message while their new password was silently discarded —
// indistinguishable from success until they tried to log in with it.

// Pure decision: given whatever findExistingAuthUser() found (or null),
// decide what /register should do next. No I/O, no Supabase — this is
// the actual fix, testable in isolation from everything else.
function decideRegistrationAction(existingUser) {
  if (!existingUser) {
    return { action: "signup" };
  }

  if (!existingUser.email_confirmed_at) {
    return { action: "resend" };
  }

  return { action: "already_registered" };
}

// Looks up an existing auth user by email via the Admin API (requires a
// service-role client — auth.admin.* is not reachable with an anon key).
// Fails open (returns null, so /register proceeds exactly as it always
// did — a normal signUp() attempt) if no admin client is available or
// the lookup itself errors, rather than blocking registration entirely
// over a diagnostic check.
async function findExistingAuthUser(email, deps = {}) {
  const { adminClient = null, perPage = 1000 } = deps;

  if (!adminClient) return null;

  const target = email.trim().toLowerCase();
  let page = 1;

  while (true) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });

    if (error) {
      console.error("SUPABASE LIST USERS ERROR:", error.message);
      return null;
    }

    const match = data.users.find(u => u.email?.toLowerCase() === target);
    if (match) return match;

    if (data.users.length < perPage) return null;
    page += 1;
  }
}

module.exports = {
  decideRegistrationAction,
  findExistingAuthUser,
};
