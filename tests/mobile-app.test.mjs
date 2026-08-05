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
import {
  addPickedContact,
  removePickedContact,
  usableNumbers,
  looksLikePhoneNumber,
  contactsStillNeedingSave,
  describeSaveFailure,
} from '../mobile/lib/contactSelection.ts';
import { shouldTriggerBootstrap } from '../mobile/lib/bootstrapTrigger.ts';
import { resumeSetupAt, stepIndexForScreen, SETUP_STEPS } from '../mobile/lib/setupFlow.ts';
import { canAutoOpenDialer, buildDialerUrl } from '../mobile/lib/dialerLink.ts';

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

  check(looksLikePhoneNumber('07700 900123') === true, 'looksLikePhoneNumber: accepts a normal UK mobile number with spaces');
  check(looksLikePhoneNumber('+44 7700 900123') === true, 'looksLikePhoneNumber: accepts an international-format number');
  check(looksLikePhoneNumber('12345') === false, 'looksLikePhoneNumber: rejects an obviously too-short number');
  check(looksLikePhoneNumber('not a number') === false, 'looksLikePhoneNumber: rejects letters with no real digits');
  check(looksLikePhoneNumber('') === false, 'looksLikePhoneNumber: rejects an empty string');
}

// --- Batch contact save: per-contact outcomes (parallel save, task #40 hardening) ---

{
  // Regression for a real bug: the original implementation filtered the
  // retry list by `failures.some(f => f.startsWith(c.name))`, a
  // name-prefix string match. Two contacts where one name is a prefix of
  // the other (e.g. "Jo" and "Jo Smith") would misclassify which one
  // failed, since "Jo Smith — reason".startsWith("Jo") is true. Outcomes
  // are now tracked by each contact's own stable `key`.
  const results = [
    { key: 'a', name: 'Jo', outcome: 'failed' },
    { key: 'b', name: 'Jo Smith', outcome: 'saved' },
  ];
  const stillNeeded = contactsStillNeedingSave(results);
  check(
    stillNeeded.length === 1 && stillNeeded[0] === 'a',
    'contactsStillNeedingSave: keyed by contact key, not name-prefix matching — "Jo Smith" saving does not hide "Jo" failing'
  );

  // Regression for a real bug: a "duplicate" result (the contact is
  // already trusted server-side, just saved via a different action) was
  // previously treated as a blocking failure that stayed in the retry
  // list forever, with no way to clear it short of manually pressing
  // Remove. It should be treated the same as a fresh save success.
  const withDuplicate = [
    { key: 'a', name: 'Mum', outcome: 'duplicate' },
    { key: 'b', name: 'Dad', outcome: 'saved' },
  ];
  check(
    contactsStillNeedingSave(withDuplicate).length === 0,
    'contactsStillNeedingSave: a duplicate (already saved elsewhere) is a complete outcome, not a failure to retry'
  );

  const withMixed = [
    { key: 'a', name: 'Mum', outcome: 'invalid' },
    { key: 'b', name: 'Dad', outcome: 'failed' },
    { key: 'c', name: 'Aunt Jo', outcome: 'duplicate' },
    { key: 'd', name: 'Uncle Jo', outcome: 'saved' },
  ];
  const mixedStillNeeded = contactsStillNeedingSave(withMixed);
  check(
    mixedStillNeeded.length === 2 && mixedStillNeeded.includes('a') && mixedStillNeeded.includes('b'),
    'contactsStillNeedingSave: with a mix of outcomes, only genuine failures (invalid/failed) remain'
  );

  check(
    describeSaveFailure({ key: 'a', name: 'Mum', outcome: 'invalid' }) === "Mum — that number doesn't look right",
    'describeSaveFailure: invalid_input produces a specific, actionable message'
  );
  check(
    describeSaveFailure({ key: 'b', name: 'Dad', outcome: 'failed' }) === "Dad — couldn't be saved",
    'describeSaveFailure: an unexpected error falls back to a generic per-contact message'
  );
}

// --- Onboarding redesign: setup resume/progress logic ---

{
  // resumeSetupAt is the single decision point both B1 (on arrival) and
  // the Home dashboard ("Finish setup") use to send a customer to the
  // actual next unfinished step - critical that this reflects the new
  // contacts-before-activation order, not the old one.

  check(
    resumeSetupAt({ isEntitled: false, contactCount: 0, isActivationVerified: false }).screen === 'subscribe',
    'resumeSetupAt: no entitlement at all sends the customer to Subscribe first'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 0, isActivationVerified: false }).screen === 'contacts',
    'resumeSetupAt: entitled but zero contacts sends the customer to Trusted Contacts next - this is the core reordering this redesign makes'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 1, isActivationVerified: false }).screen === 'device-picker',
    'resumeSetupAt: contacts already added but not yet activated sends the customer to the device picker'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 3, isActivationVerified: true }).screen === 'complete',
    'resumeSetupAt: everything done sends the customer to the completion screen, not back through steps already finished'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 0, isActivationVerified: true }).screen === 'contacts',
    'resumeSetupAt: activation verified but somehow zero contacts (e.g. the honest "skip for now" path) still surfaces the contacts step as unfinished, not "complete"'
  );

  check(
    stepIndexForScreen('subscribe') === 1 && stepIndexForScreen('contacts') === 2,
    'stepIndexForScreen: subscribe and contacts map to their own distinct macro-steps'
  );
  check(
    stepIndexForScreen('device-picker') === 3 &&
      stepIndexForScreen('activate') === 3 &&
      stepIndexForScreen('verify') === 3,
    'stepIndexForScreen: device-picker, activate, and verify all collapse into the same visible "Activate" macro-step'
  );
  check(
    stepIndexForScreen('welcome') === null && stepIndexForScreen('complete') === null,
    'stepIndexForScreen: screens outside the guided flow (welcome, complete) have no step number at all'
  );
  check(SETUP_STEPS.length === 3, 'SETUP_STEPS: exactly three macro-steps are shown, matching the progress indicator');

  check(
    canAutoOpenDialer('iphone') === true && canAutoOpenDialer('android') === true,
    'canAutoOpenDialer: iphone and android are the customer\'s own line — safe to auto-open the dialer'
  );
  check(
    canAutoOpenDialer('landline') === false,
    'canAutoOpenDialer: landline must never auto-open this device\'s dialer — the code has to be dialled from the physical landline handset, a different device entirely, or it would silently forward the wrong line'
  );

  check(
    buildDialerUrl('*21*07700900000#') === 'tel:*21*07700900000%23',
    'buildDialerUrl: percent-encodes the trailing # (so URL-parsing layers cannot treat it as a fragment separator and truncate the code) and produces the exact expected tel: URL for a real forwarding code'
  );
  check(
    buildDialerUrl('##21#') === 'tel:%23%2321%23',
    'buildDialerUrl: encodes every # in the string, not just the first (the cancel code starts with two)'
  );
  check(
    buildDialerUrl('*21*07700900000#').includes('*') && !buildDialerUrl('*21*07700900000#').includes('%2A'),
    'buildDialerUrl: leaves * unencoded — not a reserved URI character, matches Apple\'s own documented tel: feature-code examples'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
