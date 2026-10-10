// Manually maintained DDI inventory (migration 078, DRAFT — NOT APPLIED).
// WS6 Magrathea → Twilio BYOC, 2026-10-11. Thin wrappers over the 078 RPCs;
// every rule (UK 01/02/03 only, one per household, never a held/quarantined
// number, cooling-off) is enforced inside the database.

"use strict";

const { supabaseAdmin } = require("../services/supabaseClients");

// PostgREST: relation/function not in the schema cache (078 not applied).
function isMissingObject(error) {
  const code = error && error.code;
  return code === "PGRST205" || code === "PGRST202" || code === "42P01" || code === "42883";
}

function requireAdmin(admin) {
  if (!admin) throw new Error("Supabase admin client not configured");
  return admin;
}

/** @returns {Promise<string|null>} the claimed E.164 DDI, or null when none is claimable. THROWS when unreadable. */
async function claimInventoryNumber(householdId, providerCode = "magrathea", { admin = supabaseAdmin } = {}) {
  const { data, error } = await requireAdmin(admin).rpc("claim_inventory_number", { p_household_id: householdId, p_provider_code: providerCode });
  if (error) throw new Error(`claim_inventory_number unavailable: ${error.message || error.code || error}`);
  return typeof data === "string" && data ? data : null;
}

/** Undo a claim the household assignment did not complete. THROWS when unreadable. */
async function returnUnassignedInventoryNumber(e164, householdId, { admin = supabaseAdmin } = {}) {
  const { data, error } = await requireAdmin(admin).rpc("return_unassigned_inventory_number", { p_e164: e164, p_household_id: householdId });
  if (error) throw new Error(`return_unassigned_inventory_number unavailable: ${error.message || error.code || error}`);
  return data === true;
}

/** Quarantine release confirmed → back to the pool after cooling-off. THROWS when unreadable. */
async function releaseInventoryNumberAfterQuarantine(e164, coolingOffDays = 30, { admin = supabaseAdmin } = {}) {
  const { data, error } = await requireAdmin(admin).rpc("release_inventory_number_after_quarantine", { p_e164: e164, p_cooling_off_days: coolingOffDays });
  if (error) throw new Error(`release_inventory_number_after_quarantine unavailable: ${error.message || error.code || error}`);
  return data === true;
}

/**
 * Which provider hosts this number according to the inventory: the provider
 * code, or null when the number is not an inventory number (incl. 078 not
 * applied — then every number is a Twilio-hosted number, as today).
 * THROWS on any other read failure (callers fail closed).
 */
async function getInventoryProviderForNumber(e164, { admin = supabaseAdmin } = {}) {
  const { data, error } = await requireAdmin(admin)
    .from("number_inventory")
    .select("provider_code")
    .eq("e164_number", e164)
    .limit(1);
  if (error) {
    if (isMissingObject(error)) return null;
    throw new Error(`number_inventory unreadable: ${error.message || error.code || error}`);
  }
  return data && data[0] ? data[0].provider_code : null;
}

module.exports = {
  claimInventoryNumber,
  returnUnassignedInventoryNumber,
  releaseInventoryNumberAfterQuarantine,
  getInventoryProviderForNumber,
  isMissingObject,
};
