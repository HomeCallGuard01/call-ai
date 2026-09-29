// Tests for database/deliveryEvidence.js (2026-09-29) against an
// in-memory Supabase fake — behaviour, not source text. Covers the
// child/parent CallSid fix for app invite reports (zero production rows
// had client_invite_received_at before it), household scoping, SID
// validation, push-failure recording idempotence, and graceful behaviour
// before migration 055 is applied.
//
// Run with: node tests/delivery-evidence.test.mjs

import { createRequire } from 'node:module';
import { createFakeSupabase, createFakeTwilio } from './helpers/fakeSupabase.mjs';

const require = createRequire(import.meta.url);
const evidence = require('../database/deliveryEvidence.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

const sid = c => 'CA' + c.repeat(32);
const PARENT = sid('a');
const CHILD = sid('b');
const OTHER_PARENT = sid('c');
const OTHER_CHILD = sid('d');
const HH = 'hh-1';
const OTHER_HH = 'hh-2';

function freshTables() {
  return {
    calls: [
      { call_sid: PARENT, household_id: HH, created_at: '2026-09-26T14:05:24Z', dial_call_status: 'no-answer', client_invite_received_at: null, client_outcome: null, dial_call_sid: null, push_failure: null },
      { call_sid: OTHER_PARENT, household_id: OTHER_HH, created_at: '2026-09-26T14:06:00Z', dial_call_status: 'completed', client_invite_received_at: null, client_outcome: null, dial_call_sid: null, push_failure: null },
    ],
    households: [{ id: HH, voice_client_registered_at: '2026-09-20T00:00:00Z' }],
  };
}

async function main() {
  // --- SID validation (the .or() filter is string-built) ---
  check(evidence.isValidCallSid(PARENT), 'a real-shaped CallSid is valid');
  check(!evidence.isValidCallSid('CA123'), 'short SID rejected');
  check(!evidence.isValidCallSid(`${PARENT},household_id.eq.${OTHER_HH}`), 'filter-injection attempt rejected');
  check(!evidence.isValidCallSid(null), 'null rejected');

  // --- the production bug: app reports the CHILD SID ---
  {
    const t = freshTables();
    const supabase = createFakeSupabase(t);
    const twilioClient = createFakeTwilio({ parents: { [CHILD]: PARENT } });
    const ok = await evidence.recordInviteReceived({ supabase, twilioClient, callSid: CHILD, householdId: HH, now: new Date('2026-09-26T14:05:26Z') });
    check(ok === true, 'invite reported with the child SID is recorded (previously matched zero rows)');
    check(t.calls[0].client_invite_received_at === '2026-09-26T14:05:26.000Z', 'client_invite_received_at written to the PARENT row');
    check(t.calls[0].dial_call_sid === CHILD, 'child↔parent pairing remembered in dial_call_sid');
    check(twilioClient.fetched.length === 1, 'one Twilio lookup for the first report');

    const outcome = await evidence.recordInviteOutcome({ supabase, twilioClient, callSid: CHILD, householdId: HH, outcome: 'rejected' });
    check(outcome && t.calls[0].client_outcome === 'rejected', 'outcome for the same child SID recorded');
    check(twilioClient.fetched.length === 1, 'second report resolves via dial_call_sid — no further Twilio lookup');
  }

  // --- backwards compatible: a parent SID still works directly ---
  {
    const t = freshTables();
    const supabase = createFakeSupabase(t);
    const twilioClient = createFakeTwilio();
    const ok = await evidence.recordInviteReceived({ supabase, twilioClient, callSid: PARENT, householdId: HH });
    check(ok && t.calls[0].client_invite_received_at, 'a parent SID still matches directly');
    check(twilioClient.fetched.length === 0, 'no Twilio lookup needed for a direct match');
  }

  // --- household scoping: cannot write another household's call ---
  {
    const t = freshTables();
    const supabase = createFakeSupabase(t);
    const twilioClient = createFakeTwilio({ parents: { [OTHER_CHILD]: OTHER_PARENT } });
    const ok = await evidence.recordInviteReceived({ supabase, twilioClient, callSid: OTHER_CHILD, householdId: HH });
    check(ok === false, "a child SID whose parent belongs to another household is refused");
    check(t.calls[1].client_invite_received_at === null && t.calls[1].dial_call_sid === null, "the other household's row is untouched");
    const ok2 = await evidence.recordInviteReceived({ supabase, twilioClient, callSid: OTHER_PARENT, householdId: HH });
    check(ok2 === false && t.calls[1].client_invite_received_at === null, "another household's parent SID is refused");
  }

  // --- invalid / unknown SIDs ---
  {
    const t = freshTables();
    const supabase = createFakeSupabase(t);
    const twilioClient = createFakeTwilio();
    check(await evidence.recordInviteReceived({ supabase, twilioClient, callSid: 'CA-bogus', householdId: HH }) === false, 'malformed SID refused');
    check(twilioClient.fetched.length === 0, 'malformed SID never reaches Twilio');
    check(await evidence.recordInviteReceived({ supabase, twilioClient, callSid: sid('e'), householdId: HH }) === false, 'unknown SID (Twilio 404) refused without throwing');
  }

  // --- before migration 055: parent SID still works, child fails soft ---
  {
    const t = freshTables();
    const supabase = createFakeSupabase(t, { missingColumns: ['dial_call_sid', 'push_failure', 'push_failure_at'] });
    const twilioClient = createFakeTwilio({ parents: { [CHILD]: PARENT } });
    const ok = await evidence.recordInviteReceived({ supabase, twilioClient, callSid: PARENT, householdId: HH });
    check(ok, 'pre-055: parent SID still recorded via the fallback query');
    const okChild = await evidence.recordInviteReceived({ supabase, twilioClient, callSid: CHILD, householdId: HH });
    check(okChild, 'pre-055: child SID still recorded (resolved via Twilio; pairing write fails soft)');
    const attempts = await evidence.getRecentDeliveryAttempts({ supabase, householdId: HH });
    check(attempts.length === 1 && attempts[0].call_sid === PARENT, 'pre-055: attempts read falls back to existing columns');
    check((await evidence.recordPushFailure({ supabase, dialCallSid: CHILD, failure: 'fcm:NotRegistered' })) === null, 'pre-055: push failure write fails soft (null, no throw)');
  }

  // --- push failure recording ---
  {
    const t = freshTables();
    t.calls[0].dial_call_sid = CHILD;
    const supabase = createFakeSupabase(t);
    const hh = await evidence.recordPushFailure({ supabase, dialCallSid: CHILD, failure: 'fcm:NotRegistered', at: '2026-09-26T14:05:27Z' });
    check(hh === HH && t.calls[0].push_failure === 'fcm:NotRegistered', 'push failure attached to the call with that client leg');
    const again = await evidence.recordPushFailure({ supabase, dialCallSid: CHILD, failure: 'fcm:NotRegistered', at: '2026-09-26T14:10:00Z' });
    check(again === null && t.calls[0].push_failure_at === '2026-09-26T14:05:27Z', 'recording the same alert twice is a no-op (idempotent polling)');
    check((await evidence.recordPushFailure({ supabase, dialCallSid: sid('f'), failure: 'fcm:NotRegistered' })) === null, 'unmatched client leg → null');
  }

  // --- recordDialCallSid validation ---
  {
    const t = freshTables();
    const supabase = createFakeSupabase(t);
    check((await evidence.recordDialCallSid({ supabase, parentCallSid: PARENT, dialCallSid: 'junk' })) === false && t.calls[0].dial_call_sid === null,
      'malformed DialCallSid is never stored');
  }

  // --- read model ---
  {
    const t = freshTables();
    t.calls[0].push_failure = 'fcm:NotRegistered';
    t.calls[0].created_at = '2026-09-26T14:05:24Z';
    const supabase = createFakeSupabase(t);
    const health = await evidence.getHouseholdDeliveryHealth({ supabase, household: { id: HH, voice_client_registered_at: '2026-09-20T00:00:00Z' } });
    check(health.state === 'UNREACHABLE' && health.customerStatus === 'unavailable', 'read model: dead-token failure after registration → UNREACHABLE');
    const healthy = await evidence.getHouseholdDeliveryHealth({ supabase, household: { id: OTHER_HH, voice_client_registered_at: '2026-09-20T00:00:00Z' } });
    check(healthy.state === 'HEALTHY', "read model is per-household (other household's delivered call → HEALTHY)");
    check(await evidence.hasVerifiedInviteReporting({ supabase, householdId: HH }) === false, 'invite reporting unverified until a report is recorded');
    t.calls[0].client_invite_received_at = '2026-09-26T14:05:26Z';
    check(await evidence.hasVerifiedInviteReporting({ supabase, householdId: HH }) === true, 'invite reporting verified once one is recorded');
  }

  if (failures) {
    console.error(`\n✗ ${failures} delivery-evidence checks FAILED`);
    process.exit(1);
  }
  console.log('\n✓ All delivery-evidence checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
