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

// Every write below goes through the narrow RPCs from
// supabase/migrations/016_household_twilio_provisioning.sql — never a
// direct `.from("households").update(...)`. service_role has no UPDATE
// grant on households at all (migration 012); the RPCs are the only
// write path for these columns, same as stripe_customer_id above.

// Sets households.twilio_number via the RPC. Idempotent: a call with the
// same value that's already set is a no-op success (returns true). A call
// where a *different* value is already assigned returns false rather than
// throwing — see the RPC's own comment: the caller just purchased a
// now-redundant Twilio number and must release it.
async function assignHouseholdTwilioNumber(householdId, twilioNumber) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin.rpc("assign_household_twilio_number", {
    p_household_id: householdId,
    p_twilio_number: twilioNumber,
  });

  if (error) {
    console.error("TWILIO NUMBER ASSIGN ERROR:", error);
    throw error;
  }

  return data === true;
}

// Records a failed Twilio provisioning attempt via the RPC — increments
// the attempt counter and flags the household for retry/administrative
// attention. Never downgrades a household that already has a number (see
// the RPC's own comment).
async function recordTwilioProvisioningFailure(householdId, errorMessage) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { error } = await supabaseAdmin.rpc("record_household_twilio_provisioning_failure", {
    p_household_id: householdId,
    p_error_message: errorMessage,
  });

  if (error) {
    console.error("TWILIO PROVISIONING FAILURE RECORD ERROR:", error);
    throw error;
  }
}

// Lifecycle RPCs from supabase/migrations/017_household_twilio_number_lifecycle.sql
// — see that migration's header for the grace-period-vs-immediate-release
// reasoning. Same rule as above: never a direct table write.

// Starts the grace-period clock on a household that just lost its
// entitlement but still holds a number. Idempotent: does not push the
// deadline out further if one is already pending (see RPC comment).
async function markTwilioNumberPendingRelease(householdId, gracePeriodDays = 30) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin.rpc("mark_household_twilio_number_pending_release", {
    p_household_id: householdId,
    p_grace_period: `${gracePeriodDays} days`,
  });

  if (error) {
    console.error("TWILIO NUMBER PENDING-RELEASE MARK ERROR:", error);
    throw error;
  }

  return data === true;
}

// Cancels a pending release — called when a household becomes entitled
// again before its grace-period deadline, so it keeps the same number.
async function cancelTwilioNumberPendingRelease(householdId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { error } = await supabaseAdmin.rpc("cancel_household_twilio_number_pending_release", {
    p_household_id: householdId,
  });

  if (error) {
    console.error("TWILIO NUMBER PENDING-RELEASE CANCEL ERROR:", error);
    throw error;
  }
}

// Releases a household's number once its grace period has actually
// passed. Returns false (and releases nothing) if the deadline hasn't
// arrived yet, there was no deadline, or the number no longer matches —
// the caller must only release the number via Twilio's own API when this
// returns true.
async function releaseHouseholdTwilioNumber(householdId, expectedNumber) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin.rpc("release_household_twilio_number", {
    p_household_id: householdId,
    p_expected_number: expectedNumber,
  });

  if (error) {
    console.error("TWILIO NUMBER RELEASE ERROR:", error);
    throw error;
  }

  return data === true;
}

// Unconditional release, no grace period — intended for a future account
// deletion feature, not called from anywhere in this codebase yet (see
// the RPC's own comment). Returns the released number (for the caller to
// release via Twilio's API) or null if the household had none.
async function releaseHouseholdTwilioNumberImmediately(householdId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin.rpc("release_household_twilio_number_immediately", {
    p_household_id: householdId,
  });

  if (error) {
    console.error("TWILIO NUMBER IMMEDIATE RELEASE ERROR:", error);
    throw error;
  }

  return data || null;
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
  assignHouseholdTwilioNumber,
  recordTwilioProvisioningFailure,
  markTwilioNumberPendingRelease,
  cancelTwilioNumberPendingRelease,
  releaseHouseholdTwilioNumber,
  releaseHouseholdTwilioNumberImmediately,
  setUserRole,
  getUserRole,
};
