const { supabaseAdmin } = require("../services/supabaseClients");
const { normaliseNumber } = require("../services/phone");

async function getHouseholdByAuthUserId(authUserId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE HOUSEHOLD READ ERROR:", error);
    return null;
  }

  return data;
}

// Resolves which household owns an inbound call from the Twilio "To" number.
// Falls back to null (unmatched) rather than throwing — /voice and /process
// must keep working even for a number that isn't registered to a household yet.
async function getHouseholdByTwilioNumber(twilioNumber) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin.from("households").select("*");

  if (error) {
    console.error("SUPABASE HOUSEHOLD READ ERROR:", error);
    return null;
  }

  const targetNorm = normaliseNumber(twilioNumber);

  return (
    (data || []).find(
      h => h.twilio_number && normaliseNumber(h.twilio_number) === targetNorm
    ) || null
  );
}

// Registration bootstrap: before Sprint 7, one placeholder household exists
// (created by migration 004) with auth_user_id = null, holding the real
// twilio_number/phone_number. Per Decision 010, the very first person to
// ever register claims that row instead of getting a brand new one — this
// path is self-disabling (guarded by claimedCount === 0) so it can only ever
// fire once, for the founder's own registration, and never for a later
// customer. Every registration after that always creates a fresh row.
async function claimOrCreateHousehold({ authUserId, email }) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { count: claimedCount, error: countError } = await supabaseAdmin
    .from("households")
    .select("id", { count: "exact", head: true })
    .not("auth_user_id", "is", null);

  if (countError) {
    console.error("SUPABASE HOUSEHOLD COUNT ERROR:", countError);
    throw countError;
  }

  if (claimedCount === 0) {
    const { data: unclaimed, error: findError } = await supabaseAdmin
      .from("households")
      .select("*")
      .is("auth_user_id", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (findError) {
      console.error("SUPABASE HOUSEHOLD LOOKUP ERROR:", findError);
      throw findError;
    }

    if (unclaimed) {
      const { data, error } = await supabaseAdmin
        .from("households")
        .update({ auth_user_id: authUserId, email })
        .eq("id", unclaimed.id)
        .select()
        .single();

      if (error) {
        console.error("SUPABASE HOUSEHOLD CLAIM ERROR:", error);
        throw error;
      }

      return data;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("households")
    .insert({ auth_user_id: authUserId, email, status: "active" })
    .select()
    .single();

  if (error) {
    console.error("SUPABASE HOUSEHOLD CREATE ERROR:", error);
    throw error;
  }

  return data;
}

async function setUserRole(authUserId, role = "household") {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { error } = await supabaseAdmin
    .from("user_roles")
    .upsert({ auth_user_id: authUserId, role }, { onConflict: "auth_user_id" });

  if (error) {
    console.error("SUPABASE USER ROLE WRITE ERROR:", error);
    throw error;
  }
}

async function getUserRole(authUserId) {
  if (!supabaseAdmin) return "household";

  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE USER ROLE READ ERROR:", error);
    return "household";
  }

  return data ? data.role : "household";
}

module.exports = {
  getHouseholdByAuthUserId,
  getHouseholdByTwilioNumber,
  claimOrCreateHousehold,
  setUserRole,
  getUserRole,
};
