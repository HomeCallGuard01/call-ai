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

import { deriveLoadOutcome, isSettingUp, computeHomeProtectionState, hasProvenActivation } from '../mobile/lib/homeStatus.ts';
import { extractForwardingNumberFromCode, formatUkPhoneForDisplay } from '../mobile/lib/forwardingNumber.ts';
import { computePageIndex, shouldResyncScrollPosition, scrollOffsetForPage } from '../mobile/lib/carousel.ts';
import {
  addPickedContact,
  removePickedContact,
  usableNumbers,
  looksLikePhoneNumber,
  contactsStillNeedingSave,
  describeSaveFailure,
  isEntitlementTimingIssue,
  buildSelectableContacts,
  toggleContactSelection,
} from '../mobile/lib/contactSelection.ts';
import { shouldTriggerBootstrap } from '../mobile/lib/bootstrapTrigger.ts';
import { resumeSetupAt, stepIndexForScreen, SETUP_STEPS } from '../mobile/lib/setupFlow.ts';
import { canAutoOpenDialer, buildDialerUrl } from '../mobile/lib/dialerLink.ts';
import { outcomeContent, planResendEffect } from '../mobile/lib/registrationOutcome.ts';
import { computeProvisioningStages, shouldAutoAdvance, isProvisioningFailed, shouldShowManualRetry } from '../mobile/lib/provisioningStages.ts';
import { resolveAuthToken } from '../mobile/lib/resolveAuthToken.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    isSettingUp({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: false } }) === true,
    'isSettingUp is true when activation has never been verified and no real delivery has ever been proven'
  );

  check(
    isSettingUp({ protection: { activationVerifiedAt: '2026-07-31T00:00:00Z', endToEndDeliveryVerified: false } }) === false,
    'isSettingUp is false once activation is genuinely confirmed by the backend'
  );

  // --- hasProvenActivation (2026-09-12: a real delivered call is
  // equally valid proof that setup is done, added after a real physical
  // test proved endToEndDeliveryVerified can be true while
  // activationVerifiedAt stays permanently null — see
  // mobile/lib/homeStatus.ts's own comment for the full mechanism) ---

  check(
    hasProvenActivation({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: false } }) === false,
    'hasProvenActivation: neither fact present is not proven'
  );
  check(
    hasProvenActivation({ protection: { activationVerifiedAt: '2026-07-31T00:00:00Z', endToEndDeliveryVerified: false } }) === true,
    'hasProvenActivation: the legacy activationVerifiedAt fact alone is still sufficient'
  );
  check(
    hasProvenActivation({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: true } }) === true,
    'hasProvenActivation: real delivery evidence alone is sufficient, even with activationVerifiedAt still null — the exact real-world case (2026-09-12 physical test) this exists to cover'
  );
  check(
    hasProvenActivation({ protection: { activationVerifiedAt: '2026-07-31T00:00:00Z', endToEndDeliveryVerified: true } }) === true,
    'hasProvenActivation: both facts present is obviously still proven'
  );

  // --- computeHomeProtectionState (2026-09-07: activationVerifiedAt alone must never produce "protected";
  // 2026-09-12: a genuinely fullyProtected household must never be told to "Finish setup") ---

  check(
    computeHomeProtectionState({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: false, deliveryReady: false, fullyProtected: false } }) === 'setting_up',
    'computeHomeProtectionState: no activation and no delivery evidence at all is "setting_up" — a genuinely new/unproven household can still enter required setup'
  );

  check(
    computeHomeProtectionState({ protection: { activationVerifiedAt: '2026-07-31T00:00:00Z', endToEndDeliveryVerified: false, deliveryReady: true, fullyProtected: false } }) === 'confirming_delivery',
    'computeHomeProtectionState: activation verified but no delivery evidence is "confirming_delivery", never "protected" — the exact case this whole change series exists to prevent'
  );

  check(
    computeHomeProtectionState({ protection: { activationVerifiedAt: '2026-07-31T00:00:00Z', endToEndDeliveryVerified: true, deliveryReady: true, fullyProtected: true } }) === 'protected',
    'computeHomeProtectionState: activation verified AND real delivery evidence is "protected"'
  );

  // 2026-09-12 correction: this used to assert "setting_up" as "defence
  // in depth... should be unreachable in practice" — a real physical
  // test (giffgaff/Android, 2026-09-12) proved this state IS reachable
  // (a customer who dials the forwarding code manually, outside the
  // in-app guided flow, gets real delivery proof with activation_verified_at
  // still null) and that the old "setting_up" result was the actual bug:
  // it factually contradicted the backend's own fullyProtected:true,
  // sending an already-fully-working customer back through device-picker.
  check(
    computeHomeProtectionState({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: true, deliveryReady: true, fullyProtected: true } }) === 'protected',
    'computeHomeProtectionState: a household with fullyProtected:true must never see "setting_up"/be routed to device-picker, even with the legacy activationVerifiedAt field still null — real case, 2026-09-12 physical test'
  );

  // --- "reconnect_needed" (2026-09-12): historical delivery proof, but
  // currently-stale Voice SDK reachability, must not be told to redo
  // call forwarding — distinct from "never proven" (setting_up) ---
  check(
    computeHomeProtectionState({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: true, deliveryReady: false, fullyProtected: false } }) === 'reconnect_needed',
    'computeHomeProtectionState: delivery proven before but the Voice SDK client is not currently reachable is "reconnect_needed", never "setting_up" — the app recovering registration is all that is needed, not redoing MMI setup'
  );
  check(
    computeHomeProtectionState({ protection: { activationVerifiedAt: '2026-07-31T00:00:00Z', endToEndDeliveryVerified: true, deliveryReady: false, fullyProtected: false } }) === 'reconnect_needed',
    'computeHomeProtectionState: reconnect_needed applies identically regardless of the legacy activationVerifiedAt value, as long as real delivery was once proven and current reachability has lapsed'
  );
  check(
    computeHomeProtectionState({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: false, deliveryReady: false, fullyProtected: false } }) !== 'reconnect_needed',
    'computeHomeProtectionState: a household that has never had delivery proven at all is "setting_up", never "reconnect_needed" — these are genuinely distinct states'
  );
}

// --- forwardingNumber (2026-09-12 physical-test finding): the customer
// must never have to parse the HCG number out of an MMI string ---

{
  check(
    extractForwardingNumberFromCode('**21*01389317533#') === '01389317533',
    'extractForwardingNumberFromCode: parses the plain national number out of a standard mobile activation code'
  );
  check(
    extractForwardingNumberFromCode('**21*001389317533#') === '001389317533',
    'extractForwardingNumberFromCode: also handles the Virgin landline extra-leading-zero variant (one more digit, same shape)'
  );
  check(
    extractForwardingNumberFromCode('#61#') === null,
    'extractForwardingNumberFromCode: a code with no embedded number (e.g. a deactivation-only code) returns null, never a wrong guess'
  );
  check(
    extractForwardingNumberFromCode('') === null,
    'extractForwardingNumberFromCode: an empty string returns null, never throws'
  );

  check(
    formatUkPhoneForDisplay('01389317533') === '01389 317533',
    'formatUkPhoneForDisplay: groups an 11-digit UK number as 5+6, matching the web dashboard\'s own formatUkPhoneForDisplay convention — the underlying number is never altered, only its display grouping'
  );
  check(
    formatUkPhoneForDisplay('01389317533').replace(' ', '') === '01389317533',
    'formatUkPhoneForDisplay: the formatted output contains exactly the same digits as the input, just with one space inserted — never alters the actual number'
  );
  check(
    formatUkPhoneForDisplay('123') === '123',
    'formatUkPhoneForDisplay: an unexpected length falls back to the raw digits rather than producing a visibly wrong split'
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

// --- Multi-select "Choose from my iPhone/Android contacts" (2026-08-08) ---

{
  const deviceContacts = [
    { id: '1', name: 'Zoe Baker', phoneNumbers: [{ number: '07700900001' }] },
    { id: '2', name: 'Amir Khan', phoneNumbers: [{ number: '07700900002' }, { number: '07700900003' }] },
    { id: '3', name: 'No Number Nora', phoneNumbers: [] },
    { id: '4', firstName: 'Beth', lastName: 'Chan', phoneNumbers: [{ number: '07700900004' }] },
    { id: null, name: 'Missing Id', phoneNumbers: [{ number: '07700900005' }] },
    { id: '6', name: '', phoneNumbers: [{ number: '07700900006' }] },
  ];

  const selectable = buildSelectableContacts(deviceContacts);

  check(
    selectable.length === 4,
    'buildSelectableContacts: keeps only contacts with both a real id and at least one usable number (4 of 6 fixtures)'
  );

  check(
    selectable.map(c => c.name).join(',') === 'Amir Khan,Beth Chan,Unnamed contact,Zoe Baker',
    'buildSelectableContacts: sorts alphabetically by name'
  );

  check(
    selectable.find(c => c.id === '6')?.name === 'Unnamed contact',
    'buildSelectableContacts: a device contact with no usable name falls back to "Unnamed contact" rather than being dropped'
  );

  check(
    selectable.find(c => c.id === '2')?.number === '07700900002',
    'buildSelectableContacts: a contact with multiple numbers uses the first usable one for its list row'
  );

  check(
    selectable.find(c => c.id === '4')?.name === 'Beth Chan',
    'buildSelectableContacts: falls back to firstName + lastName when no display name is set'
  );

  check(
    !selectable.some(c => c.id === '3'),
    'buildSelectableContacts: excludes a contact with zero usable phone numbers'
  );

  check(
    !selectable.some(c => c.number === '07700900005'),
    'buildSelectableContacts: excludes a contact with no device-assigned id'
  );

  check(buildSelectableContacts(undefined).length === 0, 'buildSelectableContacts: undefined input is treated as an empty list, not a crash');
  check(buildSelectableContacts(null).length === 0, 'buildSelectableContacts: null input is treated as an empty list, not a crash');
  check(buildSelectableContacts([]).length === 0, 'buildSelectableContacts: a genuinely empty device address book produces an empty list');

  check(
    toggleContactSelection([], 'a').join(',') === 'a',
    'toggleContactSelection: selecting an unselected id adds it'
  );
  check(
    toggleContactSelection(['a'], 'b').join(',') === 'a,b',
    'toggleContactSelection: selecting a second id keeps the first and appends the second'
  );
  check(
    toggleContactSelection(['a', 'b'], 'a').join(',') === 'b',
    'toggleContactSelection: selecting an already-selected id removes it (standard checklist toggle behaviour)'
  );
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

  // Regression for the real bug found during Build 8 production testing
  // (2026-08-30): both contacts showed "Nothing was saved" while the
  // screen simultaneously still displayed both contacts and offered
  // "Continue with 2 contacts" — traced to the "everyone failed" branch
  // never filtering `selected` the way the "some failed" branch already
  // did, plus a genuine 402 (entitlement not yet created — the
  // subscription webhook hadn't landed server-side yet) being
  // indistinguishable from a real per-contact failure.
  const allNotEntitled = [
    { key: 'a', name: 'Mum', outcome: 'not_entitled' },
    { key: 'b', name: 'Dad', outcome: 'not_entitled' },
  ];
  check(
    contactsStillNeedingSave(allNotEntitled).length === 2,
    'contactsStillNeedingSave: not_entitled counts as still needing save, same as invalid/failed — never silently dropped'
  );
  check(
    describeSaveFailure({ key: 'a', name: 'Mum', outcome: 'not_entitled' }) ===
      'Mum — still finishing setting up your subscription',
    'describeSaveFailure: not_entitled gets its own honest, non-alarming message, distinct from a genuine failure'
  );
  check(
    isEntitlementTimingIssue(allNotEntitled) === true,
    'isEntitlementTimingIssue: true when every remaining failure is the entitlement-timing race'
  );
  check(
    isEntitlementTimingIssue([{ key: 'a', name: 'Mum', outcome: 'not_entitled' }, { key: 'b', name: 'Dad', outcome: 'failed' }]) === false,
    'isEntitlementTimingIssue: false as soon as any remaining failure is a genuine one, not just entitlement timing'
  );
  check(
    isEntitlementTimingIssue([]) === false,
    'isEntitlementTimingIssue: false for an empty list — nothing failed, so there is no "issue" to describe'
  );
}

// --- Onboarding redesign: setup resume/progress logic ---

{
  // resumeSetupAt is the single decision point both B1 (on arrival) and
  // the Home dashboard ("Finish setup") use to send a customer to the
  // actual next unfinished step - critical that this reflects the new
  // contacts-before-activation order, not the old one.

  check(
    resumeSetupAt({ isEntitled: false, contactCount: 0, isActivationProven: false }).screen === 'subscribe',
    'resumeSetupAt: no entitlement at all sends the customer to Subscribe first'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 0, isActivationProven: false }).screen === 'contacts',
    'resumeSetupAt: entitled but zero contacts sends the customer to Trusted Contacts next - this is the core reordering this redesign makes'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 1, isActivationProven: false }).screen === 'device-picker',
    'resumeSetupAt: contacts already added but activation not yet proven (neither legacy verification nor real delivery) sends the customer to the device picker — a genuinely new/unproven household can still enter required setup'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 3, isActivationProven: true }).screen === 'complete',
    'resumeSetupAt: everything done sends the customer to the completion screen, not back through steps already finished'
  );

  check(
    resumeSetupAt({ isEntitled: true, contactCount: 0, isActivationProven: true }).screen === 'contacts',
    'resumeSetupAt: activation proven but somehow zero contacts (e.g. the honest "skip for now" path) still surfaces the contacts step as unfinished, not "complete"'
  );

  // 2026-09-12: isActivationProven must be computed via
  // hasProvenActivation (activationVerifiedAt OR endToEndDeliveryVerified)
  // by the caller, not activationVerifiedAt alone — this is what stops a
  // household with real delivery proof but a null legacy field from
  // being sent back to device-picker forever.
  check(
    resumeSetupAt({
      isEntitled: true,
      contactCount: 3,
      isActivationProven: hasProvenActivation({ protection: { activationVerifiedAt: null, endToEndDeliveryVerified: true } }),
    }).screen === 'complete',
    'resumeSetupAt: a household proven only via real delivery evidence (activationVerifiedAt null) reaches "complete", not "device-picker" — real case, 2026-09-12 physical test'
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

  check(
    outcomeContent('pending_confirmation').title === 'Check your email to finish creating your account',
    'outcomeContent: pending_confirmation (new account or resend to unconfirmed) uses the exact required title'
  );
  check(
    JSON.stringify(outcomeContent('pending_confirmation').paragraphs) === JSON.stringify([
      "If this is a new account, we've sent you a confirmation email.",
      "If you already have a Home Call Guard account, sign in with your existing password or reset it if you've forgotten it.",
    ]),
    'outcomeContent: pending_confirmation uses the exact required body text, in order'
  );
  check(
    outcomeContent('already_registered').title === 'You may already have an account — sign in or reset your password',
    'outcomeContent: already_registered uses the exact required title — hedged, never a definitive claim the account exists'
  );
  check(
    JSON.stringify(outcomeContent('already_registered').paragraphs) === JSON.stringify([
      'Try signing in with your existing password. The password you just entered has not replaced your existing password.',
    ]),
    'outcomeContent: already_registered uses the exact required body text'
  );
  check(
    !/confirmed|subscription|entitlement|household/i.test(outcomeContent('already_registered').paragraphs.join(' ')),
    'outcomeContent: already_registered reveals no account detail beyond the hedge itself'
  );

  check(
    planResendEffect('already_registered').kind === 'switch_to_already_registered',
    'planResendEffect: already_registered switches the whole screen to the already-registered content — never a false "sent again" notice'
  );
  check(
    planResendEffect('resent').kind === 'show_notice' && planResendEffect('resent').message.length > 0,
    'planResendEffect: resent (a real resend happened) shows a genuine notice'
  );
  check(
    planResendEffect('resent').message === planResendEffect('no_action').message,
    'planResendEffect: resent and no_action deliberately share the same hedged, conditional wording — honest either way (true when a real resend happened, vacuously true when nothing did), matching public/register.html\'s resentNotice text exactly'
  );
  check(
    planResendEffect('no_action').message === 'If that email is registered and unconfirmed, a new confirmation email has been sent.',
    'planResendEffect: no_action never claims success outright — the exact hedged wording already shipped on web'
  );
}

// --- B4 provisioning-wait screen: truthful stage-based progress (2026-08-08) ---
// Replaces the old dead-end "Still setting up your line" / "Check again"
// state, found broken in a real iPhone test — the customer had to
// manually retry with no real progress shown.

{
  const pendingStages = computeProvisioningStages('pending');
  check(
    pendingStages.find(s => s.key === 'membership').state === 'done' &&
      pendingStages.find(s => s.key === 'contacts').state === 'done',
    'computeProvisioningStages: membership and trusted contacts are always shown done — both are guaranteed true by the time this screen is reachable'
  );
  check(
    pendingStages.find(s => s.key === 'number').state === 'in_progress',
    'computeProvisioningStages: while pending, "Getting your Home Call Guard number ready" is the in-progress stage'
  );
  check(
    pendingStages.find(s => s.key === 'activationCode').state === 'pending',
    'computeProvisioningStages: the activation code stage has not started until the number itself is ready'
  );

  const activeStages = computeProvisioningStages('active');
  check(
    activeStages.find(s => s.key === 'number').state === 'done',
    'computeProvisioningStages: once the number is ready, that stage flips to done'
  );
  check(
    activeStages.find(s => s.key === 'activationCode').state === 'in_progress',
    'computeProvisioningStages: the activation code stage becomes in-progress the moment the number is ready — never skipped straight to done, since the real instructions call hasn\'t succeeded yet'
  );

  check(shouldAutoAdvance('active') === true, 'shouldAutoAdvance: true the moment the number is confirmed ready — this is what re-triggers the activation-instructions call with no tap needed');
  check(shouldAutoAdvance('pending') === false, 'shouldAutoAdvance: false while genuinely still pending');
  check(shouldAutoAdvance('failed') === false, 'shouldAutoAdvance: false on a genuine failure — never auto-retries into a call that will just fail again');

  check(isProvisioningFailed('failed') === true, 'isProvisioningFailed: true only for a genuine terminal failure');
  check(isProvisioningFailed('pending') === false, 'isProvisioningFailed: a normal pending state is never mistaken for a failure');
  check(isProvisioningFailed('active') === false, 'isProvisioningFailed: an active/ready state is never mistaken for a failure');

  check(shouldShowManualRetry(0) === false, 'shouldShowManualRetry: no manual retry while polling is working normally — this is the exact dead-end pattern being replaced, and it must not come back for the common case');
  check(shouldShowManualRetry(1) === false, 'shouldShowManualRetry: a single poll failure (e.g. one dropped request) does not yet show a manual retry');
  check(shouldShowManualRetry(2) === true, 'shouldShowManualRetry: repeated poll failures (polling itself broken, e.g. offline) do surface a manual retry — the one legitimate fallback case');
}

// --- resolveAuthToken: explicit-token path vs getSession() fallback path ---
// (2026-08-27) The bug: authorizedFetch() in lib/api.ts always re-derived
// the session via supabase.auth.getSession(), which was already known
// (from the earlier Voice SDK registration fix) to intermittently return
// null on a real Android device even with a genuinely valid session held
// in AuthContext — causing GET /api/v1/me/dashboard and every other
// authenticated call to fail closed with a local 401, never reaching the
// server at all. Every screen was updated to pass its already-held
// session token through explicitly; this is the pure decision of which
// token wins.

{
  check(
    resolveAuthToken('explicit-token', 'fallback-token') === 'explicit-token',
    'resolveAuthToken: an explicit token always wins over the fallback session token, even when both are present'
  );
  check(
    resolveAuthToken(undefined, 'fallback-token') === 'fallback-token',
    'resolveAuthToken: falls back to the session-derived token when no explicit token is passed — preserves the exact previous behaviour for any call site not yet updated'
  );
  check(
    resolveAuthToken(undefined, undefined) === null,
    'resolveAuthToken: no explicit token and no session at all resolves to null — authorizedFetch turns this into the same 401 "unauthenticated" ApiError as before, never a silent request with no auth header'
  );
  check(
    resolveAuthToken(undefined, null) === null,
    'resolveAuthToken: a null fallback (e.g. session?.access_token when session itself is null) is treated the same as undefined, not as a truthy value'
  );
  check(
    resolveAuthToken('', 'fallback-token') === 'fallback-token',
    'resolveAuthToken: an empty-string explicit token is not treated as "provided" — falls back to the session token rather than sending an empty Authorization header'
  );
}

// --- Static structure check: contacts.tsx's "everyone failed" branch ---
// (2026-08-30 fix — see the isEntitlementTimingIssue checks above for the
// pure-logic half of this same fix)

{
  const contactsSource = readFileSync(
    path.join(__dirname, '..', 'mobile', 'app', '(setup)', 'contacts.tsx'),
    'utf8'
  );

  check(
    contactsSource.includes('NotEntitledError'),
    'contacts.tsx recognises NotEntitledError specifically, rather than treating a not-yet-entitled 402 as a generic failure'
  );

  const setSelectedCallCount = (contactsSource.match(/setSelected\(prev => prev\.filter\(/g) || []).length;
  check(
    setSelectedCallCount === 1,
    `setSelected(...filter...) is called from exactly one place (found ${setSelectedCallCount}) — a single, unconditional filter that always runs before any error message is chosen, so the "everyone failed" case can never again skip it the way the original bug did`
  );

  const nothingWasSavedIndex = contactsSource.indexOf('Nothing was saved');
  const setSelectedIndex = contactsSource.indexOf('setSelected(prev => prev.filter(');
  check(
    nothingWasSavedIndex !== -1 && setSelectedIndex !== -1 && setSelectedIndex < nothingWasSavedIndex,
    '`selected` is filtered down to what still needs saving BEFORE the "Nothing was saved" message is ever chosen, not after — so the visible contact list and button label can never disagree with the error shown'
  );
}

// --- Static structure check: Voice SDK registration reporting + sign-out
// reset (2026-09-07, migration 036) ---
//
// lib/voiceClient.ts imports @twilio/voice-react-native-sdk (a native
// module), so — like the rest of this file's other native-dependent
// screens — it's verified by static source/string checks rather than
// direct import, matching activation-screen-navigation.test.mjs's
// established two-layer pattern for screens with no rendering harness.

{
  const voiceClientSource = readFileSync(
    path.join(__dirname, '..', 'mobile', 'lib', 'voiceClient.ts'),
    'utf8'
  );

  check(
    voiceClientSource.includes('import { fetchVoiceToken, reportVoiceRegistered } from "./api"'),
    'voiceClient.ts imports reportVoiceRegistered from lib/api.ts'
  );

  const registerCallIndex = voiceClientSource.indexOf('await voice.register(token);');
  const reportCallIndex = voiceClientSource.indexOf('reportVoiceRegistered(accessToken)');
  check(
    registerCallIndex !== -1 && reportCallIndex !== -1 && registerCallIndex < reportCallIndex,
    'reportVoiceRegistered is called after voice.register(token) resolves, not before — only a genuine successful registration is ever reported'
  );

  check(
    voiceClientSource.includes('reportVoiceRegistered(accessToken).catch((err) => {'),
    'reportVoiceRegistered is fire-and-forget (caught, not awaited into the main try/catch) — a reporting failure can never undo or delay the real registration voice.register() already achieved'
  );

  check(
    voiceClientSource.includes('export function resetVoiceRegistrationState(): void {') &&
      voiceClientSource.includes('registered = false;'),
    'voiceClient.ts exports resetVoiceRegistrationState, which resets the module-level `registered` flag'
  );

  const resetFnSource = voiceClientSource.slice(voiceClientSource.indexOf('export function resetVoiceRegistrationState'));
  check(
    !resetFnSource.slice(0, 400).includes('voice.unregister('),
    'resetVoiceRegistrationState does not call voice.unregister() (it requires the original token, which this module never retains) — resetting the flag alone is sufficient, matching scheduleRefresh\'s own established precedent'
  );
}

// --- Static structure check: audio-quality fix — Speaker for ringing,
// Earpiece once connected (2026-09-13, physical-test finding) ---
//
// The real getAudioDevices()/.select() API and Call/CallInvite event
// wiring are native-dependent, same reasoning as the block above — this
// is checked structurally against the real source, not executed.

{
  const voiceClientSource = readFileSync(
    path.join(__dirname, '..', 'mobile', 'lib', 'voiceClient.ts'),
    'utf8'
  );

  // Registration/ringing still selects Speaker (unchanged) — proves this
  // fix didn't regress the original audibility fix.
  check(
    voiceClientSource.includes('async function selectSpeakerForRinging(): Promise<void> {') &&
      voiceClientSource.includes('device.type === AudioDevice.Type.Speaker'),
    'selectSpeakerForRinging still exists and still selects the Speaker device for ringing — unchanged by the connected-call Earpiece fix'
  );

  const speakerCallIndex = voiceClientSource.indexOf('await selectSpeakerForRinging();');
  const nearestAndroidGuardBeforeSpeakerCall = voiceClientSource.lastIndexOf('if (Platform.OS === "android")', speakerCallIndex);
  check(
    speakerCallIndex !== -1 &&
      nearestAndroidGuardBeforeSpeakerCall !== -1 &&
      // No closing brace between the guard and the call — still the same block.
      !voiceClientSource.slice(nearestAndroidGuardBeforeSpeakerCall, speakerCallIndex).includes('}'),
    'selectSpeakerForRinging is still only called on Android, at registration time, unaffected by the new connected-call handling'
  );

  // Answered/connected call selects Earpiece.
  check(
    voiceClientSource.includes('async function selectEarpieceForConnectedCall(): Promise<void> {') &&
      voiceClientSource.includes('device.type === AudioDevice.Type.Earpiece'),
    'a new selectEarpieceForConnectedCall function exists and selects the Earpiece device'
  );

  // The switch does not happen before connection: selectEarpieceForConnectedCall
  // must be called from inside a Call.Event.Connected listener, itself
  // registered inside a CallInvite.Event.Accepted listener — never called
  // directly from the top-level CallInvite handler or from
  // selectSpeakerForRinging's own ringing-time code path.
  const acceptedListenerIndex = voiceClientSource.indexOf('callInvite.on(CallInvite.Event.Accepted');
  const connectedListenerIndex = voiceClientSource.indexOf('call.on(Call.Event.Connected');
  const earpieceCallIndex = voiceClientSource.indexOf('selectEarpieceForConnectedCall();');
  check(
    acceptedListenerIndex !== -1 && connectedListenerIndex !== -1 && earpieceCallIndex !== -1 &&
      acceptedListenerIndex < connectedListenerIndex && connectedListenerIndex < earpieceCallIndex,
    'selectEarpieceForConnectedCall is only ever invoked from inside a Call.Event.Connected listener, itself only ever registered inside a CallInvite.Event.Accepted listener — the switch cannot fire before the call is genuinely connected'
  );
  check(
    !voiceClientSource.slice(0, acceptedListenerIndex).includes('selectEarpieceForConnectedCall();'),
    'selectEarpieceForConnectedCall is never called anywhere before the CallInvite.Event.Accepted wiring — no earlier/eager call path exists'
  );
  const selectSpeakerFnStart = voiceClientSource.indexOf('async function selectSpeakerForRinging(): Promise<void> {');
  const selectSpeakerFnEnd = voiceClientSource.indexOf('\n}', selectSpeakerFnStart);
  check(
    selectSpeakerFnStart !== -1 && selectSpeakerFnEnd !== -1 &&
      !voiceClientSource.slice(selectSpeakerFnStart, selectSpeakerFnEnd).includes('selectEarpieceForConnectedCall'),
    'selectSpeakerForRinging\'s own function body never references the Earpiece switch — the two are genuinely separate, independently-triggered steps'
  );

  // iOS is untouched: the whole Accepted/Connected/Earpiece wiring block
  // is Android-only, matching selectSpeakerForRinging's own scoping.
  check(
    acceptedListenerIndex !== -1 &&
      voiceClientSource.slice(Math.max(0, acceptedListenerIndex - 200), acceptedListenerIndex).includes('Platform.OS === "android"'),
    'the CallInvite.Event.Accepted / Call.Event.Connected / Earpiece-switch wiring is gated behind Platform.OS === "android" — iOS behaviour is completely unchanged'
  );
}

// --- Static structure check: earliest-possible PushKit initialization
// (2026-09-09, Twilio GitHub issue #668 / Build 9 locked-screen crash) ---
//
// iOS requires a VoIP push to be reported to CallKit in the same run loop
// as the native PushKit callback; the native PKPushRegistry that receives
// that callback doesn't exist until voice.initializePushRegistry() has
// run at least once. This must happen independently of any session/auth
// state, and as early in the JS lifecycle as this app's entry point
// allows — not gated behind (tabs)/_layout.tsx mounting.

{
  const voiceClientSource = readFileSync(
    path.join(__dirname, '..', 'mobile', 'lib', 'voiceClient.ts'),
    'utf8'
  );
  const rootLayoutSource = readFileSync(
    path.join(__dirname, '..', 'mobile', 'app', '_layout.tsx'),
    'utf8'
  );

  check(
    voiceClientSource.includes('export function initializePushKitEarly(): Promise<void> {'),
    'voiceClient.ts exports initializePushKitEarly'
  );

  // Must be reachable with zero arguments — proves it depends on no
  // session/token/identity, unlike registerForIncomingCalls(accessToken?).
  check(
    /function initializePushKitEarly\(\)\s*:/.test(voiceClientSource),
    'initializePushKitEarly takes no parameters — it must not depend on any session/auth state to run'
  );

  // The real proof this isn't dependent on (tabs)/_layout.tsx mounting:
  // an unconditional, top-level (module-scope) call exists in
  // voiceClient.ts itself, so merely importing this module triggers it —
  // independent of whether any React component, screen, or the (tabs)
  // route group ever mounts at all.
  const fnBodyEnd = voiceClientSource.indexOf('\n}', voiceClientSource.indexOf('export function initializePushKitEarly'));
  const afterFnDeclaration = voiceClientSource.slice(fnBodyEnd);
  const topLevelCallIndex = afterFnDeclaration.search(/^initializePushKitEarly\(\);$/m);
  check(
    topLevelCallIndex !== -1,
    'a bare, unconditional, module-scope call to initializePushKitEarly() exists (not inside any function/component) — importing voiceClient.ts alone triggers it'
  );

  // Idempotency: a shared/cached promise, not a boolean re-checked on
  // each call — so a concurrent caller (e.g. performRegistration's own
  // defensive call, below) awaits the exact same in-flight attempt
  // rather than returning early before the real native call resolves.
  check(
    voiceClientSource.includes('let pushRegistryInitPromise: Promise<void> | null = null;') &&
      voiceClientSource.includes('if (!pushRegistryInitPromise) {'),
    'initializePushKitEarly caches a single shared promise — calling it more than once (module re-evaluation, or performRegistration\'s own call) never triggers a second native voice.initializePushRegistry() call'
  );

  // performRegistration must route through the shared function, not call
  // the native SDK directly a second time — otherwise the early call and
  // the authenticated flow could each create their own registration. The
  // one legitimate call site is inside initializePushKitEarly itself.
  const nativeCallCount = (voiceClientSource.match(/await voice\.initializePushRegistry\(\);/g) || []).length;
  check(
    nativeCallCount === 1,
    `voice.initializePushRegistry() (the real native call) appears exactly once, inside initializePushKitEarly only (found ${nativeCallCount}) — performRegistration must go through that same shared, idempotent function, never call the SDK directly itself`
  );
  check(
    voiceClientSource.includes('await initializePushKitEarly();'),
    'performRegistration() calls initializePushKitEarly() (idempotently) as its own safety net, rather than assuming the early module-level call already completed'
  );

  // app/_layout.tsx — the actual earliest Expo Router entry point in this
  // app (mounted before (auth)/(setup)/(tabs) and before AuthProvider) —
  // must import voiceClient.ts, and as its first import, so this fires
  // before Supabase session hydration and before any navigation.
  check(
    rootLayoutSource.includes('import "../lib/voiceClient";'),
    'the root app/_layout.tsx imports lib/voiceClient.ts'
  );

  const voiceClientImportIndex = rootLayoutSource.indexOf('import "../lib/voiceClient";');
  const authProviderImportIndex = rootLayoutSource.indexOf('import { AuthProvider }');
  check(
    voiceClientImportIndex !== -1 &&
      authProviderImportIndex !== -1 &&
      voiceClientImportIndex < authProviderImportIndex,
    'voiceClient.ts is imported before AuthContext in app/_layout.tsx — its module-level PushKit init runs before Supabase session hydration can even begin, not after'
  );

  // And the negative case that made this a real bug: (tabs)/_layout.tsx
  // is not part of this import chain at all — app/_layout.tsx (the root)
  // never imports the (tabs) group directly (Expo Router resolves routes
  // by file convention, not by explicit import), so this early
  // initialization is provably independent of whether the user ever
  // reaches the (tabs) group.
  check(
    !rootLayoutSource.includes('(tabs)/_layout'),
    'app/_layout.tsx has no dependency on (tabs)/_layout.tsx — the early PushKit init cannot be gated on that screen mounting, because nothing here references it'
  );
}

{
  const accountScreenSource = readFileSync(
    path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'account', 'index.tsx'),
    'utf8'
  );

  check(
    accountScreenSource.includes('import { resetVoiceRegistrationState } from "../../../lib/voiceClient"'),
    'account/index.tsx imports resetVoiceRegistrationState'
  );

  const signOutFnIndex = accountScreenSource.indexOf('function signOutAndResetVoiceRegistration()');
  check(signOutFnIndex !== -1, 'account/index.tsx defines a single signOutAndResetVoiceRegistration function, rather than duplicating the reset call at each sign-out site');

  // Exactly one bare `supabase.auth.signOut()` call is expected: inside
  // signOutAndResetVoiceRegistration itself. If either UI call site (web
  // window.confirm branch, native Alert.alert branch) called
  // supabase.auth.signOut() directly instead of going through that
  // function, this count would be 2 — proving the registration-state
  // reset would be skipped on that path.
  const bareSignOutCallCount = (accountScreenSource.match(/supabase\.auth\.signOut\(\)/g) || []).length;
  check(
    bareSignOutCallCount === 1,
    `supabase.auth.signOut() is called from exactly one place (found ${bareSignOutCallCount}) — inside signOutAndResetVoiceRegistration — never directly from either UI sign-out site`
  );

  check(
    accountScreenSource.includes('window.confirm("Log out?")) {\n        signOutAndResetVoiceRegistration();'),
    'the web (window.confirm) sign-out path calls signOutAndResetVoiceRegistration, not a bare supabase.auth.signOut()'
  );

  check(
    accountScreenSource.includes('onPress: signOutAndResetVoiceRegistration,'),
    'the native (Alert.alert) sign-out path calls signOutAndResetVoiceRegistration, not a bare supabase.auth.signOut()'
  );

  check(
    signOutFnIndex < accountScreenSource.indexOf('function handleLogout'),
    'signOutAndResetVoiceRegistration is defined before handleLogout uses it'
  );
}

{
  const voiceClientWebStubSource = readFileSync(
    path.join(__dirname, '..', 'mobile', 'lib', 'voiceClient.web.ts'),
    'utf8'
  );
  check(
    voiceClientWebStubSource.includes('export function resetVoiceRegistrationState(): void {'),
    'voiceClient.web.ts (the Metro-preferred web stub) also exports resetVoiceRegistrationState, matching the real module — account/index.tsx runs on web too, and Metro would otherwise fail to resolve the import there'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
