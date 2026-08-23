// Releases Twilio numbers whose grace period (see
// supabase/migrations/017_household_twilio_number_lifecycle.sql) has
// passed with no reactivation. Kept as a standalone script for manual
// runs or an external scheduler (a Railway Cron Job, etc.) even though
// server.js now also runs this same logic in-process once a day
// (services/twilioNumberReleaseRunner.js) — running both is harmless,
// since every actual release goes through the same atomic, row-locked
// RPC, so this is always safe to run repeatedly, concurrently, or
// alongside the in-process scheduler without ever double-releasing a
// number.
// See docs/launch/TWILIO_NUMBER_LIFECYCLE.md for the operational detail.
//
// Run with: node scripts/release-expired-twilio-numbers.js

require("dotenv").config();

const { supabaseAdmin } = require("../services/supabaseClients");
const { releaseExpiredTwilioNumber } = require("../services/twilioProvisioning");
const { runExpiredTwilioNumberRelease } = require("../services/twilioNumberReleaseRunner");

async function main() {
  if (!supabaseAdmin) {
    console.error("RELEASE SCRIPT ABORTED: Supabase admin client not configured");
    process.exitCode = 1;
    return;
  }

  const result = await runExpiredTwilioNumberRelease({ supabaseAdmin, releaseExpiredTwilioNumber });

  console.log(`Found ${result.found} household(s) past their Twilio number grace period.`);
  for (const { householdId, error } of result.errors) {
    console.error("RELEASE SCRIPT: failed for household", householdId, error);
  }
  console.log(`Released: ${result.released}. Skipped/not yet eligible/failed: ${result.skipped}.`);
}

main().catch(err => {
  console.error("RELEASE SCRIPT FATAL:", err.message);
  process.exitCode = 1;
});
