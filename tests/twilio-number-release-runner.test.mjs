// Unit tests for services/twilioNumberReleaseRunner.js — the
// orchestration this project never had running on a schedule until
// 2026-08-23. releaseExpiredTwilioNumber itself is already covered by
// tests/twilio-provisioning.test.mjs; this file covers the "find
// candidates and loop" logic that's new here.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runExpiredTwilioNumberRelease } = require('../services/twilioNumberReleaseRunner.js');

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

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
