const { supabaseAdmin } = require("../services/supabaseClients");

// One reusable insert for every waiting-list reason (migration 042) —
// unauthenticated by design (see that migration's own header): a
// prospective customer signing up for this has no household/session yet.
// reason is validated by the caller (routes), not here, matching this
// codebase's existing convention of owning validation at the route layer
// and keeping the database layer a thin, trusting write.
async function insertWaitingListSignup({ email, reason, providerKey = null, deviceType = null }) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin
    .from("waiting_list_signups")
    .insert([{ email, reason, provider_key: providerKey, device_type: deviceType }])
    .select()
    .single();

  if (error) {
    console.error("WAITING LIST SIGNUP INSERT ERROR:", error);
    throw error;
  }

  return data;
}

module.exports = { insertWaitingListSignup };
