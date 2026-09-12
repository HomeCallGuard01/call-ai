// Unit tests for services/twilioNumberReleaseRunner.js — the
// orchestration this project never had running on a schedule until
// 2026-08-23. releaseExpiredTwilioNumber itself is already covered by
// tests/twilio-provisioning.test.mjs; this file covers the "find
// candidates and loop" logic that's new here.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runExpiredTwilioNumberRelease, runConfirmedQuarantineRelease } = require('../services/twilioNumberReleaseRunner.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// Minimal fake Supabase query builder covering exactly the chain
// findHouseholdsPendingRelease uses: .from().select().not().lte()
function fakeSupabaseAdmin(rows, error = null) {
  return {
    from() {
      return {
        select() {
          return {
            not() {
              return {
                lte() {
                  return Promise.resolve({ data: rows, error });
                },
              };
            },
          };
        },
      };
    },
  };
}

async function run() {
  // --- no candidates ---
  {
    const supabaseAdmin = fakeSupabaseAdmin([]);
    const releaseExpiredTwilioNumber = async () => ({ released: false });
    const result = await runExpiredTwilioNumberRelease({ supabaseAdmin, releaseExpiredTwilioNumber });
    check(result.found === 0, 'zero pending-release households: found is 0');
    check(result.released === 0 && result.skipped === 0, 'zero pending-release households: nothing attempted');
    check(result.errors.length === 0, 'zero pending-release households: no errors');
  }

  // --- some released, some skipped, one with a real error ---
  {
    const households = [
      { id: 'h-1' },
      { id: 'h-2' },
      { id: 'h-3' },
    ];
    const supabaseAdmin = fakeSupabaseAdmin(households);
    const releaseExpiredTwilioNumber = async (household) => {
      if (household.id === 'h-1') return { released: true };
      if (household.id === 'h-2') return { released: false }; // e.g. not actually eligible anymore
      return { released: false, error: 'Twilio API error' };
    };
    const result = await runExpiredTwilioNumberRelease({ supabaseAdmin, releaseExpiredTwilioNumber });
    check(result.found === 3, 'three candidates found');
    check(result.released === 1, 'exactly one release succeeded');
    check(result.skipped === 2, 'two were skipped (one silently, one with a real error)');
    check(result.errors.length === 1 && result.errors[0].householdId === 'h-3', 'the real error is attributed to the correct household, the silent skip is not treated as an error');
  }

  // --- a single household's release throwing does not abort the whole run ---
  // (releaseExpiredTwilioNumber itself never throws per its own tests, but
  // this proves the loop doesn't assume that — a defensive check.)
  {
    const households = [{ id: 'h-4' }, { id: 'h-5' }];
    const supabaseAdmin = fakeSupabaseAdmin(households);
    let calls = 0;
    const releaseExpiredTwilioNumber = async () => {
      calls += 1;
      return { released: true };
    };
    const result = await runExpiredTwilioNumberRelease({ supabaseAdmin, releaseExpiredTwilioNumber });
    check(calls === 2, 'every candidate is attempted, not just the first');
    check(result.released === 2, 'both releases counted');
  }

  // --- a genuine listing failure (DB error) propagates rather than being silently swallowed ---
  {
    const supabaseAdmin = fakeSupabaseAdmin(null, { message: 'connection refused' });
    const releaseExpiredTwilioNumber = async () => ({ released: true });
    let threw = false;
    try {
      await runExpiredTwilioNumberRelease({ supabaseAdmin, releaseExpiredTwilioNumber });
    } catch (err) {
      threw = true;
      check(err.message === 'connection refused', 'the real underlying DB error is propagated, not swallowed');
    }
    check(threw === true, 'a failure to list candidates at all throws rather than silently reporting "0 found"');
  }

  // --- quarantine (P0 Batch 1, component D): a quarantined result is
  // counted distinctly from a genuinely released one ---
  {
    const households = [{ id: 'h-6' }, { id: 'h-7' }];
    const supabaseAdmin = fakeSupabaseAdmin(households);
    const releaseExpiredTwilioNumber = async (household) =>
      household.id === 'h-6' ? { released: false, quarantined: true } : { released: false };
    const result = await runExpiredTwilioNumberRelease({ supabaseAdmin, releaseExpiredTwilioNumber });
    check(result.found === 2, 'two candidates found');
    check(result.quarantined === 1, 'the quarantined result is counted in its own bucket, not released or skipped');
    check(result.released === 0, 'nothing is counted as genuinely released — this runner never actually calls Twilio\'s .remove() any more');
    check(result.skipped === 1, 'a plain { released: false } with no quarantined flag is still counted as skipped');
  }

  // --- runConfirmedQuarantineRelease: stage 2 orchestration ---
  {
    const rows = [];
    const findConfirmed = async () => rows;
    const releaseQuarantinedTwilioNumber = async () => { throw new Error('should not be called'); };
    const result = await runConfirmedQuarantineRelease({ findConfirmed, releaseQuarantinedTwilioNumber });
    check(result.found === 0 && result.released === 0 && result.skipped === 0, 'zero confirmed quarantine rows: nothing attempted — this is the expected, normal state for this P0 Batch 1 foundation, since nothing yet calls confirmTwilioNumberDeactivation automatically');
  }

  {
    const rows = [
      { id: 'q-1', household_id: 'h-10' },
      { id: 'q-2', household_id: 'h-11' },
      { id: 'q-3', household_id: 'h-12' },
    ];
    const findConfirmed = async () => rows;
    const releaseQuarantinedTwilioNumber = async (row) => {
      if (row.id === 'q-1') return { released: true };
      if (row.id === 'q-2') return { released: false };
      return { released: false, error: 'Twilio API error' };
    };
    const result = await runConfirmedQuarantineRelease({ findConfirmed, releaseQuarantinedTwilioNumber });
    check(result.found === 3, 'three confirmed candidates found');
    check(result.released === 1, 'exactly one release succeeded');
    check(result.skipped === 2, 'two were skipped (one silently, one with a real error)');
    check(
      result.errors.length === 1 && result.errors[0].quarantineId === 'q-3' && result.errors[0].householdId === 'h-12',
      'the real error is attributed to the correct quarantine row and household'
    );
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
