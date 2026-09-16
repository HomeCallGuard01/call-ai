// Shared "run once" logic for releasing Twilio numbers whose grace
// period has passed — used by both the manual/cron-invoked CLI script
// (scripts/release-expired-twilio-numbers.js) and the in-process daily
// scheduler (server.js), so there is exactly one place this orchestration
// is written, not two copies that could drift. The actual release itself
// (services/twilioProvisioning.js's releaseExpiredTwilioNumber) already
// goes through the atomic, row-locked RPC — this file only finds
// candidates and loops, it makes no release-eligibility decisions itself.
'use strict';

async function findHouseholdsPendingRelease(supabaseAdmin, now = new Date()) {
  const { data, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .not("twilio_number_pending_release_at", "is", null)
    .lte("twilio_number_pending_release_at", now.toISOString());

  if (error) {
    throw error;
  }

  return data || [];
}

// deps.supabaseAdmin and deps.releaseExpiredTwilioNumber are required;
// deps.now is injectable for tests. Never throws for an individual
// household's release failure — those are collected in `errors` and
// counted in `skipped`, exactly matching the CLI script's existing
// behaviour. Only a failure to even list candidates (a genuine DB
// connectivity problem) propagates, since there is nothing useful to do
// without that list.
//
// Since migration 037 (quarantine), releaseExpiredTwilioNumber's success
// path no longer genuinely releases anything via Twilio — it quarantines
// (result.quarantined: true), never result.released. `released` is kept
// as its own counter for a case that no longer occurs through this
// runner (a real .remove() only happens via runConfirmedQuarantineRelease
// below now) rather than removed, so this stays accurate if that ever
// changes again; `quarantined` is the count that actually matters here
// today.
async function runExpiredTwilioNumberRelease(deps) {
  const { supabaseAdmin, releaseExpiredTwilioNumber, now } = deps;

  const households = await findHouseholdsPendingRelease(supabaseAdmin, now);

  let released = 0;
  let quarantined = 0;
  let skipped = 0;
  const errors = [];

  for (const household of households) {
    const result = await releaseExpiredTwilioNumber(household);
    if (result.released) {
      released += 1;
    } else if (result.quarantined) {
      quarantined += 1;
    } else {
      skipped += 1;
      if (result.error) {
        errors.push({ householdId: household.id, error: result.error });
      }
    }
  }

  return { found: households.length, released, quarantined, skipped, errors };
}

// Stage 2 of the quarantine lifecycle (migration 037) — finds quarantine
// rows a human has explicitly confirmed deactivation for, and actually
// releases them via Twilio's real API
// (services/twilioProvisioning.js's releaseQuarantinedTwilioNumber).
// Unconfirmed rows are never returned by deps.findConfirmed regardless of
// how long they've been quarantined — see database/twilioQuarantine.js's
// findConfirmedUnreleasedQuarantine and migration 037's own header. In
// practice, until something in a future batch actually calls
// confirmTwilioNumberDeactivation, this finds zero candidates — that is
// the correct, intended behaviour for this foundation, not a bug.
async function runConfirmedQuarantineRelease(deps) {
  const { findConfirmed, releaseQuarantinedTwilioNumber } = deps;

  const rows = await findConfirmed();

  let released = 0;
  let skipped = 0;
  const errors = [];

  for (const row of rows) {
    const result = await releaseQuarantinedTwilioNumber(row);
    if (result.released) {
      released += 1;
    } else {
      skipped += 1;
      if (result.error) {
        errors.push({ quarantineId: row.id, householdId: row.household_id, error: result.error });
      }
    }
  }

  return { found: rows.length, released, skipped, errors };
}

module.exports = {
  findHouseholdsPendingRelease,
  runExpiredTwilioNumberRelease,
  runConfirmedQuarantineRelease,
};
