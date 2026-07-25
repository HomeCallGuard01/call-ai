// Extracted from server.js so this logic can be unit tested directly
// (server.js has no exports and calls app.listen() at module load time,
// so it can never be require()'d from a test without actually starting a
// server — the same reason services/registrationFlow.js exists).
//
// Ensures the signed-in user has a household and a user_roles row, using
// only that user's own authenticated session — no service-role key
// anywhere in this path. Relies on the policies added in
// supabase/migrations/006_authenticated_household_self_service.sql.
// Idempotent: a no-op if both already exist. Called from every place a
// real, verified session first exists for a user — /register (when email
// confirmation is off), /login, and /reset-password-complete — since any
// of the three can be the first time a given customer is truly
// authenticated.
async function ensureHouseholdAndRole(userClient, userId, email, logPrefix) {
  const log = msg => {
    if (logPrefix) console.log(`${logPrefix} ${msg}`);
  };

  log("Checking household");
  const { data: existingHousehold, error: householdSelectError } = await userClient
    .from("households")
    .select("id")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (householdSelectError) throw householdSelectError;

  log(`Household exists? ${!!existingHousehold}`);

  if (!existingHousehold) {
    log("Creating household...");

    // Try to claim the pre-existing unclaimed default household first.
    const { data: claimed, error: claimError } = await userClient
      .from("households")
      .update({ auth_user_id: userId, email })
      .is("auth_user_id", null)
      .select();

    if (claimError) throw claimError;

    if (!claimed || claimed.length === 0) {
      // Nothing unclaimed to take — create a brand-new household instead.
      const { error: insertError } = await userClient
        .from("households")
        .insert({ auth_user_id: userId, email, status: "active" });

      if (insertError) throw insertError;
    }

    log("Household created");
  }

  const { data: existingRole, error: roleSelectError } = await userClient
    .from("user_roles")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (roleSelectError) throw roleSelectError;

  if (!existingRole) {
    log("Creating role...");

    const { error: roleInsertError } = await userClient
      .from("user_roles")
      .insert({ auth_user_id: userId, role: "household" });

    if (roleInsertError) throw roleInsertError;

    log("Role created");
  }
}

module.exports = {
  ensureHouseholdAndRole,
};
