// Releases Twilio numbers whose grace period (see
// supabase/migrations/017_household_twilio_number_lifecycle.sql) has
// passed with no reactivation. Nothing in this codebase invokes this on
// a schedule yet — there is no cron/job runner configured in this
// project today. This script exists to be run periodically (e.g. once a
// day) by whatever scheduling mechanism the hosting platform provides
// (a Railway Cron Job, or any external scheduler pointed at
// `node scripts/release-expired-twilio-numbers.js`), or manually.
// See docs/launch/TWILIO_NUMBER_LIFECYCLE.md for the operational detail.
//
// Safe to run repeatedly and concurrently: every actual release still
// goes through release_household_twilio_number's atomic, row-locked
// eligibility check (supabase/migrations/017), so running this script
// twice at once, or re-running it after a partial failure, never
// double-releases a number or acts on one that's no longer eligible.
//
// Run with: node scripts/release-expired-twilio-numbers.js

require("dotenv").config();

const { supabaseAdmin } = require("../services/supabaseClients");
const { releaseExpiredTwilioNumber } = require("../services/twilioProvisioning");

async function findHouseholdsPendingRelease() {
  const { data, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .not("twilio_number_pending_release_at", "is", null)
    .lte("twilio_number_pending_release_at", new Date().toISOString());

  if (error) {
    throw error;
  }

  return data || [];
}

async function main() {
  if (!supabaseAdmin) {
    console.error("RELEASE SCRIPT ABORTED: Supabase admin client not configured");
    process.exitCode = 1;
    return;
  }

  const households = await findHouseholdsPendingRelease();
  console.log(`Found ${households.length} household(s) past their Twilio number grace period.`);

  let released = 0;
  let skipped = 0;

  for (const household of households) {
    const result = await releaseExpiredTwilioNumber(household);
    if (result.released) {
      released += 1;
    } else {
      skipped += 1;
      if (result.error) {
        console.error("RELEASE SCRIPT: failed for household", household.id, result.error);
      }
    }
  }

  console.log(`Released: ${released}. Skipped/not yet eligible/failed: ${skipped}.`);
}

main().catch(err => {
  console.error("RELEASE SCRIPT FATAL:", err.message);
  process.exitCode = 1;
});
