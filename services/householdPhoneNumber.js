// Shared by both the web (server.js) and mobile (routes/mobileApi.js)
// setup flows — the one sanctioned way to write households.phone_number,
// via the narrow set_household_phone_number RPC (supabase/migrations/
// 023_set_household_phone_number_rpc.sql). Validates and normalises to
// E.164 before ever reaching the database, so a malformed value can never
// be stored and later handed to Twilio's dial() (services/callRouting.js).
const { supabaseAdmin } = require("./supabaseClients");
const { normaliseUkPhoneToE164 } = require("./phone");

async function setHouseholdPhoneNumber(householdId, rawPhoneNumber, deps = {}) {
  const admin = deps.admin || supabaseAdmin;

  const normalised = normaliseUkPhoneToE164(rawPhoneNumber);
  if (!normalised) {
    return { ok: false, error: "invalid_input" };
  }

  if (!admin) {
    return { ok: false, error: "failed" };
  }

  const { error } = await admin.rpc("set_household_phone_number", {
    p_household_id: householdId,
    p_phone_number: normalised,
  });

  if (error) {
    console.error("SET HOUSEHOLD PHONE NUMBER ERROR:", error.message);
    return { ok: false, error: "failed" };
  }

  return { ok: true, number: normalised };
}

module.exports = { setHouseholdPhoneNumber };
