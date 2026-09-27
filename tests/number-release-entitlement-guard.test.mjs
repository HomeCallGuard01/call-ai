// Code-level half of migration 049: the two release paths that run in
// Node (the provider release of a confirmed quarantine row, and account
// deletion) must re-check the household's CURRENT entitlement immediately
// before acting, fail closed if that check can't be completed, and make a
// blocked release loud (critical alert / runner error), never silent.
// The SQL half (stale cancellation vs current entitlement, the #8 replay)
// is exercised against the real migration in tests/migrations.pglite.test.mjs.
//
// Run with: node tests/number-release-entitlement-guard.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const { releaseQuarantinedTwilioNumber, releaseTwilioNumberImmediately } = require('../services/twilioProvisioning.js');
const { runConfirmedQuarantineRelease } = require('../services/twilioNumberReleaseRunner.js');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function fakeTwilio() {
  const removed = [];
  const client = { incomingPhoneNumbers: (sid) => ({ remove: async () => { removed.push(sid); return true; } }) };
  return { client, removed };
}

// The real #8 quarantine row: confirmed would make it releasable, but the
// household (30f01a7a in production) holds an open-ended complimentary
// entitlement.
const n8Row = {
  id: 'q-n8', household_id: 'household-n8', twilio_number: '+441700000510', twilio_sid: 'PN_n8',
  deactivation_confirmed: true, released_at: null,
};

// ---------- provider release of a quarantined number ----------
{
  const { client, removed } = fakeTwilio();
  const marked = [];
  const result = await releaseQuarantinedTwilioNumber(n8Row, {
    client,
    markReleased: async (id) => { marked.push(id); },
    blocksRelease: async (householdId) => householdId === 'household-n8',
  });
  check(result.released === false && result.blocked === 'household_entitled', '#8: a confirmed quarantine row is NOT released while its household is currently entitled');
  check(removed.length === 0, '#8: the provider release API is never called');
  check(marked.length === 0, '#8: the row is never marked released');
  check(typeof result.error === 'string', '#8: the blocked release is reported as an error, so the daily runner raises a critical alert');
}

{
  const { client, removed } = fakeTwilio();
  const result = await releaseQuarantinedTwilioNumber(n8Row, {
    client,
    markReleased: async () => {},
    blocksRelease: async () => { throw new Error('database unreachable'); },
  });
  check(result.released === false && removed.length === 0, 'fails closed: if the entitlement check errors, nothing is released');
}

{
  const { client, removed } = fakeTwilio();
  const marked = [];
  const result = await releaseQuarantinedTwilioNumber(
    { ...n8Row, id: 'q-cancelled', household_id: 'household-cancelled', twilio_sid: 'PN_cancelled' },
    { client, markReleased: async (id) => { marked.push(id); }, blocksRelease: async () => false }
  );
  check(result.released === true && removed[0] === 'PN_cancelled' && marked[0] === 'q-cancelled',
    'a confirmed row whose household has no current entitlement is still released normally (behaviour unchanged)');
}

{
  const checked = [];
  const { client, removed } = fakeTwilio();
  const result = await releaseQuarantinedTwilioNumber(
    { ...n8Row, id: 'q-unconfirmed', deactivation_confirmed: false },
    { client, markReleased: async () => {}, blocksRelease: async (id) => { checked.push(id); return false; } }
  );
  check(result.released === false && removed.length === 0 && checked.length === 0,
    'an unconfirmed row is still refused before the entitlement check (quarantine safety unchanged)');
}

// ---------- daily runner surfaces a blocked release ----------
{
  const outcome = await runConfirmedQuarantineRelease({
    findConfirmed: async () => [n8Row],
    releaseQuarantinedTwilioNumber: (row) => releaseQuarantinedTwilioNumber(row, {
      client: fakeTwilio().client,
      markReleased: async () => {},
      blocksRelease: async () => true,
    }),
  });
  check(outcome.released === 0 && outcome.errors.length === 1 && outcome.errors[0].householdId === 'household-n8',
    'the daily quarantine runner records the blocked #8 release as an error (server.js then sends a critical alert)');
}

// ---------- account deletion ----------
{
  const alerts = [];
  let released = false;
  const result = await releaseTwilioNumberImmediately(
    { id: 'household-still-entitled', twilio_number: '+441700000999' },
    {
      blocksRelease: async () => true,
      releaseImmediately: async () => { released = true; return '+441700000999'; },
      quarantine: async () => { throw new Error('should not be called'); },
      sendAlert: async (type, message, details) => { alerts.push({ type, details }); },
    }
  );
  check(result.blocked === 'household_entitled' && !released, 'account deletion never takes the number while an entitlement is still in force');
  check(alerts.length === 1 && alerts[0].type === 'number_release_blocked_entitled' && alerts[0].details.householdId === 'household-still-entitled',
    'account deletion blocked by an entitlement sends a critical alert (no silent leftover number)');
}

{
  const alerts = [];
  let released = false;
  const result = await releaseTwilioNumberImmediately(
    { id: 'household-check-fails', twilio_number: '+441700000998' },
    {
      blocksRelease: async () => { throw new Error('timeout'); },
      releaseImmediately: async () => { released = true; return '+441700000998'; },
      quarantine: async () => {},
      sendAlert: async (type) => { alerts.push(type); },
    }
  );
  check(result.blocked === 'household_entitled' && !released && alerts.length === 1, 'account deletion fails closed and alerts when the entitlement check itself fails');
}

{
  const quarantined = [];
  const result = await releaseTwilioNumberImmediately(
    { id: 'household-revoked', twilio_number: '+441700000997' },
    {
      blocksRelease: async () => false,
      releaseImmediately: async () => '+441700000997',
      quarantine: async (id, number, reason) => { quarantined.push({ id, number, reason }); },
      client: undefined,
      sendAlert: async () => { throw new Error('should not alert'); },
    }
  );
  check(result.quarantined === true && quarantined[0].reason === 'account_deletion', 'account deletion after the entitlement is revoked still quarantines as before');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
