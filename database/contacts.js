const { supabaseAdmin } = require("../services/supabaseClients");

async function getContacts(householdId) {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("*")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("SUPABASE CONTACT READ ERROR:", error);
    return [];
  }

  return data || [];
}

async function insertContacts(householdId, contacts) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const rows = contacts.map(c => ({ ...c, household_id: householdId }));

  const { data, error } = await supabaseAdmin.from("contacts").insert(rows).select();

  if (error) {
    console.error("SUPABASE CONTACT UPLOAD ERROR:", error);
    throw error;
  }

  return data;
}

module.exports = { getContacts, insertContacts };
