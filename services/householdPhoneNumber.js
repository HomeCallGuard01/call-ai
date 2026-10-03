// Shared by both the web (server.js) and mobile (routes/mobileApi.js)
// setup flows — the one sanctioned way to write households.phone_number,
// via the narrow set_household_phone_number RPC (supabase/migrations/
// 023_set_household_phone_number_rpc.sql). Validates and normalises to
// E.164 before ever reaching the database, so a malformed value can never
// be stored and later handed to Twilio's dial() (services/callRouting.js).
//
// Telephony abuse P0 (2026-10-03): households.phone_number is the
// destination of HCG-paid warning SMS, so it now also passes the central
// destination policy (services/abuse/numberPolicy.js, purpose
// HOUSEHOLD_PHONE: UK mobile or UK geographic only — no premium, 070
// personal, 076 paging, 084/087 revenue-share, Crown Dependency,
// international or satellite numbers) and must not be any HCG-owned number
// (a forwarding cycle: customer → HCG number → "customer" number = HCG).
// A refusal is reported as the same `invalid_input` the routes already map
// to 400, so no client contract changes; the policy reason is logged only.
const { supabaseAdmin } = require("./supabaseClients");
const { normaliseUkPhoneToE164 } = require("./phone");
const { evaluateNumberForPurpose, PURPOSES, maskE164 } = require("./abuse/numberPolicy");

// Is this E.164 number one HCG holds (assigned or in quarantine)? Throws
// when the state cannot be read — the caller fails closed.
async function isHcgOwnedNumber(admin, e164) {
  if (!admin || typeof admin.from !== "function") return false; // unit-test fakes expose rpc() only
  const [assigned, quarantined] = await Promise.all([
    admin.from("households").select("id").eq("twilio_number", e164).limit(1),
    admin.from("twilio_number_quarantine").select("id").eq("twilio_number", e164).is("released_at", null).limit(1),
  ]);
  if (assigned.error || quarantined.error) throw new Error("hcg number lookup failed");
  return (assigned.data || []).length > 0 || (quarantined.data || []).length > 0;
}

async function setHouseholdPhoneNumber(householdId, rawPhoneNumber, deps = {}) {
  const admin = deps.admin || supabaseAdmin;

  const normalised = normaliseUkPhoneToE164(rawPhoneNumber);
  if (!normalised) {
    return { ok: false, error: "invalid_input" };
  }

  const verdict = evaluateNumberForPurpose(PURPOSES.HOUSEHOLD_PHONE, normalised);
  if (!verdict.allowed || verdict.number.e164 !== normalised) {
    console.error("HOUSEHOLD PHONE NUMBER REFUSED BY DESTINATION POLICY:", householdId, verdict.reason, maskE164(normalised));
    return { ok: false, error: "invalid_input", policyReason: verdict.reason || "canonical_mismatch" };
  }

  if (!admin) {
    return { ok: false, error: "failed" };
  }

  try {
    const isHcg = deps.isHcgNumber ? await deps.isHcgNumber(normalised) : await isHcgOwnedNumber(admin, normalised);
    if (isHcg) {
      console.error("HOUSEHOLD PHONE NUMBER REFUSED: is an HCG-owned number (forwarding cycle)", householdId);
      return { ok: false, error: "invalid_input", policyReason: "hcg_owned_number" };
    }
  } catch (err) {
    console.error("HOUSEHOLD PHONE NUMBER CHECK FAILED (fail closed):", err.message);
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

module.exports = { setHouseholdPhoneNumber, isHcgOwnedNumber };
