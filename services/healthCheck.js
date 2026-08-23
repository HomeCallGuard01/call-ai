// Pure, directly-testable health-check logic — extracted from the
// /health route so the "bounded timeout, never let a slow dependency
// hang or fail the whole check" behaviour can be proven without a real
// Supabase connection or a running Express server.
'use strict';

async function checkSupabaseHealth(supabaseClient, timeoutMs) {
  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
    const ping = supabaseClient
      .from("households")
      .select("id", { head: true, count: "exact" })
      .limit(1)
      .then(({ error }) => (error ? "error" : "ok"))
      .catch(() => "error");

    return await Promise.race([ping, timeout]);
  } catch {
    return "error";
  }
}

module.exports = { checkSupabaseHealth };
