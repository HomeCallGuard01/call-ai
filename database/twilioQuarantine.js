// Thin wrapper around the twilio_number_quarantine table (migration 037)
// — matching this codebase's established database/*.js convention (see
// database/households.js). Purely internal, service-role-only table; no
// RPC layer needed (unlike households' SECURITY DEFINER functions) since
// nothing outside the app's own trusted backend ever touches it — same
// trust boundary as database/adminMetrics.js.
const { supabaseAdmin } = require("../services/supabaseClients");

// Called by services/twilioProvisioning.js's releaseExpiredTwilioNumber
// and releaseTwilioNumberImmediately INSTEAD OF calling Twilio's real
// .remove() API — see migration 037's own header for why. Returns the
// inserted row (id needed later to confirm/mark-released). twilioSid is
// optional — captured once, eagerly, by the caller (a single Twilio API
// lookup at quarantine time, not a hot path) so a future release doesn't
// depend solely on re-searching Twilio by phone number; omit it (leaves
// the column null) when that lookup wasn't available and the release-time
// fallback search should be used instead.
async function quarantineHouseholdTwilioNumber(householdId, twilioNumber, releaseReason, twilioSid = null) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin
    .from("twilio_number_quarantine")
    .insert({
      household_id: householdId,
      twilio_number: twilioNumber,
      twilio_sid: twilioSid,
      release_reason: releaseReason,
    })
    .select()
    .single();

  if (error) {
    console.error("TWILIO NUMBER QUARANTINE INSERT ERROR:", error);
    throw error;
  }

  return data;
}

// Human-invoked (support/admin, after manually verifying with the
// customer that carrier-level forwarding is actually off) — no automatic
// caller exists anywhere in this batch. See migration 037's own header.
async function confirmTwilioNumberDeactivation(quarantineId, method) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin
    .from("twilio_number_quarantine")
    .update({
      deactivation_confirmed: true,
      deactivation_confirmed_at: new Date().toISOString(),
      deactivation_confirmed_method: method || null,
    })
    .eq("id", quarantineId)
    .is("released_at", null)
    .select()
    .single();

  if (error) {
    console.error("TWILIO NUMBER QUARANTINE CONFIRM ERROR:", error);
    throw error;
  }

  return data;
}

// The only set of rows the release runner is ever allowed to act on —
// confirmed AND not yet released. An unconfirmed row is never returned
// here regardless of how long it has been quarantined.
async function findConfirmedUnreleasedQuarantine() {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin
    .from("twilio_number_quarantine")
    .select("*")
    .eq("deactivation_confirmed", true)
    .is("released_at", null);

  if (error) {
    console.error("TWILIO NUMBER QUARANTINE LIST ERROR:", error);
    throw error;
  }

  return data || [];
}

async function markTwilioNumberQuarantineReleased(quarantineId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { error } = await supabaseAdmin
    .from("twilio_number_quarantine")
    .update({ released_at: new Date().toISOString() })
    .eq("id", quarantineId);

  if (error) {
    console.error("TWILIO NUMBER QUARANTINE RELEASE-MARK ERROR:", error);
    throw error;
  }
}

module.exports = {
  quarantineHouseholdTwilioNumber,
  confirmTwilioNumberDeactivation,
  findConfirmedUnreleasedQuarantine,
  markTwilioNumberQuarantineReleased,
};
