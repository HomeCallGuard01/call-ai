// Unit tests for the mobile app fixes from the first physical-device
// test round: household bootstrap self-healing on app start,
// fail-closed protection status (never show "Protected" without
// backend-confirmed data), carousel paging math, and contact-selection
// dedup logic.
//
// These import directly from mobile/lib/*.ts — plain, dependency-free
// (no react-native, no expo-router, no native modules) TypeScript
// modules extracted specifically so they're testable this way, without
// a React Native Testing Library / Jest harness. Node's native TS
// support handles the import directly; no build step.
//
// The original household-bootstrap backend bug (the wrong process —
// main's server.js, which has no mobile API at all — was running
// against staging) has no unit test here, since it was an operational
// defect, not a logic bug: evidenced instead by a live, real end-to-end
// reproduction against staging (exact HTTP request/response captured
// both before and after, plus direct database verification) — see the
// session record and docs/mobile-app/RC1_HANDOVER.md. The *trigger*
// logic below (when bootstrap should fire, including on app start with
// an existing session) is a real, testable decision function, and is
// covered directly.
//
// Run with: node tests/mobile-app.test.mjs

import { deriveLoadOutcome, isSettingUp } from '../mobile/lib/homeStatus.ts';
import { computePageIndex, shouldResyncScrollPosition, scrollOffsetForPage } from '../mobile/lib/carousel.ts';
import { addPickedContact, removePickedContact, usableNumbers } from '../mobile/lib/contactSelection.ts';
import { shouldTriggerBootstrap } from '../mobile/lib/bootstrapTrigger.ts';

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- Priority 1 follow-up: household bootstrap self-heals on app start ---

{
  // The bug: bootstrap only fired on SIGNED_IN/PASSWORD_RECOVERY, so
  // reopening the app with an already-valid session (Supabase's
  // INITIAL_SESSION event) never retried a household that failed to get
  // created. This is the fix's core claim: app start + existing session +
  // no prior bootstrap this lifetime => bootstrap fires.
  check(
    shouldTriggerBootstrap({ event: 'INITIAL_SESSION', userId: 'user-1', alreadyBootstrappedUserId: null }) === true,
    'app starting with an existing valid session (INITIAL_SESSION) triggers bootstrap — the exact self-heal this fix adds'
  );

  check(
    shouldTriggerBootstrap({ event: 'SIGNED_IN', userId: 'user-1', alreadyBootstrappedUserId: null }) === true,
    'SIGNED_IN still triggers bootstrap (existing behaviour preserved)'
  );

  check(
    shouldTriggerBootstrap({ event: 'PASSWORD_RECOVERY', userId: 'user-1', alreadyBootstrappedUserId: null }) === true,
    'PASSWORD_RECOVERY still triggers bootstrap (existing behaviour preserved)'
  );

  check(
    shouldTriggerBootstrap({ event: 'INITIAL_SESSION', userId: null, alreadyBootstrappedUserId: null }) === false,
    'app starting with NO session (INITIAL_SESSION carrying a null session) never triggers bootstrap'
  );

  check(
    shouldTriggerBootstrap({ event: 'TOKEN_REFRESHED', userId: 'user-1', alreadyBootstrappedUserId: null }) === false,
    'TOKEN_REFRESHED does not trigger bootstrap — unrelated to a genuinely new session'
  );

  check(
    shouldTriggerBootstrap({ event: 'SIGNED_OUT', userId: null, alreadyBootstrappedUserId: 'user-1' }) === false,
    'SIGNED_OUT never triggers bootstrap'
  );

  // No duplicate bootstrap: once a user id has been (successfully or
  // currently-in-flight) bootstrapped this client lifetime, a repeat
  // trigger event for the *same* user is refused.
  check(
    shouldTriggerBootstrap({ event: 'INITIAL_SESSION', userId: 'user-1', alreadyBootstrappedUserId: 'user-1' }) === false,
    'a repeat trigger for the same already-bootstrapped user does not fire a duplicate bootstrap call'
  );
  check(
    shouldTriggerBootstrap({ event: 'SIGNED_IN', userId: 'user-1', alreadyBootstrappedUserId: 'user-1' }) === false,
    'dedup applies across different trigger event types too, not just repeats of the same event'
  );

  // A genuine account switch must NOT inherit the previous user's
  // "already handled" state — see Priority 5 (no cached identity from a
  // previous session).
  check(
    shouldTriggerBootstrap({ event: 'SIGNED_IN', userId: 'user-2', alreadyBootstrappedUserId: 'user-1' }) === true,
    'a different user id (account switch) still triggers bootstrap even if another user was already bootstrapped this session'
  );
}

// --- Priority 2: fail-closed protection status ---

{
  // The exact bug: `isSettingUp = data && !data.protection.activationVerifiedAt`
  // was falsy both when activation was genuinely confirmed AND when
  // `data` was simply null (never loaded) — both rendered "Protected".
  // deriveLoadOutcome must never produce "has_data" from a failure with
  // no prior data, which is the only way that confusion could recur.

  check(
    deriveLoadOutcome({ succeeded: true, isNotEntitledError: false, hadPriorData: false }).kind === 'has_data',
    'a successful fetch (first load) produces has_data'
  );

  check(
    deriveLoadOutcome({ succeeded: true, isNotEntitledError: false, hadPriorData: false }).isStale === false,
    'a successful fetch is never marked stale'
  );

  const firstLoadFailure = deriveLoadOutcome({ succeeded: false, isNotEntitledError: false, hadPriorData: false });
  check(
    firstLoadFailure.kind === 'unavailable',
    'a failed fetch with no prior data produces unavailable, never has_data — this is the exact bug: bootstrap/dashboard failing on first load must never fall through to "Protected"'
  );

  const refreshFailureWithPriorData = deriveLoadOutcome({ succeeded: false, isNotEntitledError: false, hadPriorData: true });
  check(
    refreshFailureWithPriorData.kind === 'has_data' && refreshFailureWithPriorData.isStale === true,
    'a failed refresh WITH real prior data keeps showing it, flagged stale (E3: a connectivity blip must never look like a protection problem)'
  );

  check(
    deriveLoadOutcome({ succeeded: false, isNotEntitledError: true, hadPriorData: false }).kind === 'not_entitled',
    'a 409/NotEntitledError is its own distinct outcome, not lumped in with unavailable'
  );

  check(
    deriveLoadOutcome({ succeeded: false, isNotEntitledError: true, hadPriorData: true }).kind === 'not_entitled',
    'not_entitled takes priority even if stale prior data exists — a lapsed membership must not keep showing old Protected data'
  );

  check(
    isSettingUp({ protection: { activationVerifiedAt: null } }) === true,
    'isSettingUp is true when activation has never been verified'
  );

  check(
    isSettingUp({ protection: { activationVerifiedAt: '2026-07-31T00:00:00Z' } }) === false,
    'isSettingUp is false once activation is genuinely confirmed by the backend'
  );
}

// --- Priority 3: carousel slide width/paging logic ---

{
  check(computePageIndex(0, 390) === 0, 'computePageIndex: offset 0 is page 0');
  check(computePageIndex(390, 390) === 1, 'computePageIndex: offset exactly one page width is page 1');
  check(computePageIndex(780, 390) === 2, 'computePageIndex: offset two page widths is page 2');
  check(computePageIndex(385, 390) === 1, 'computePageIndex: rounds to the nearest page, not floors (a near-complete swipe still counts as arrived)');
  check(computePageIndex(100, 0) === 0, 'computePageIndex: an unmeasured (zero) width never divides-by-zero into NaN/Infinity');

  check(scrollOffsetForPage(0, 390) === 0, 'scrollOffsetForPage: page 0 is offset 0');
  check(scrollOffsetForPage(2, 390) === 780, 'scrollOffsetForPage: page 2 at width 390 is offset 780');

  check(
    shouldResyncScrollPosition(0, 390) === false,
    'shouldResyncScrollPosition: the first-ever measurement (previous width 0) never triggers a resync — nothing to resync from'
  );
  check(
    shouldResyncScrollPosition(390, 390) === false,
    'shouldResyncScrollPosition: an unchanged width never triggers a resync'
  );
  check(
    shouldResyncScrollPosition(390, 844) === true,
    'shouldResyncScrollPosition: a genuine width change (e.g. rotation, iPad Split View resize) does trigger a resync'
  );
}

// --- Priority 4: contact selection (add from phone contacts) ---

{
  const empty = [];
  const withOne = addPickedContact(empty, 'Jane Doe', '07700900123');
  check(withOne.length === 1 && withOne[0].name === 'Jane Doe' && withOne[0].number === '07700900123', 'addPickedContact: adds a new contact');

  const withDuplicateNumber = addPickedContact(withOne, 'Jane D.', '07700900123');
  check(withDuplicateNumber.length === 1, 'addPickedContact: picking the same number again (e.g. the same contact chosen twice) does not duplicate it');

  const withSecond = addPickedContact(withOne, 'John Smith', '07700900456');
  check(withSecond.length === 2, 'addPickedContact: a genuinely different number is added alongside the first');

  const withoutNumber = addPickedContact(empty, 'No Number', '');
  check(withoutNumber.length === 0, 'addPickedContact: refuses to add a contact with an empty/missing number');

  const afterRemove = removePickedContact(withSecond, withSecond[0].key);
  check(afterRemove.length === 1 && afterRemove[0].name === 'John Smith', 'removePickedContact: removes exactly the targeted contact, keeps the rest');

  check(usableNumbers(undefined).length === 0, 'usableNumbers: undefined phoneNumbers list is treated as empty, not a crash');
  check(usableNumbers(null).length === 0, 'usableNumbers: null phoneNumbers list is treated as empty');
  check(usableNumbers([]).length === 0, 'usableNumbers: a genuinely empty list stays empty');
  check(
    usableNumbers([{ number: '07700900123' }, { number: undefined }, { number: '' }]).length === 1,
    'usableNumbers: filters out entries with a missing or empty number, never passes a fake blank number through'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
