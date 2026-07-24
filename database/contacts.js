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

// Scoped by householdId in the same query as the id, not just the id alone
// — a contactId belonging to a different household matches zero rows
// (returns []) rather than ever updating/deleting someone else's contact.
async function updateContact(householdId, contactId, { name, number }) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .update({ name, number })
    .eq("id", contactId)
    .eq("household_id", householdId)
    .select();

  if (error) {
    console.error("SUPABASE CONTACT UPDATE ERROR:", error);
    throw error;
  }

  return data;
}

async function deleteContact(householdId, contactId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .delete()
    .eq("id", contactId)
    .eq("household_id", householdId)
    .select();

  if (error) {
    console.error("SUPABASE CONTACT DELETE ERROR:", error);
    throw error;
  }

  return data;
}

module.exports = { getContacts, insertContacts, updateContact, deleteContact };
