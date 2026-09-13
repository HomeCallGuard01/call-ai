// Structural tests for the in-app account deletion UI (Apple Guideline
// 5.1.1(v)): mobile/app/(tabs)/account/delete-account.tsx, plus its entry
// point from mobile/app/(tabs)/account/index.tsx. Reading source as text
// and asserting on it, matching this codebase's existing convention for
// screen content with no React Native Testing Library/Jest harness (see
// tests/get-protected-now-button.test.mjs, tests/subscribe-screen-legal-
// links.test.mjs).
//
// Run with: node tests/account-deletion-screen.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenSource = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'account', 'delete-account.tsx'),
  'utf8'
);
const accountIndexSource = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'account', 'index.tsx'),
  'utf8'
);
const layoutSource = readFileSync(
  path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'account', '_layout.tsx'),
  'utf8'
);

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- entry point: a clear Delete Account row inside the authenticated
// Account area (not just a link out to the website) ---

check(
  accountIndexSource.includes('label="Delete Account"'),
  'the Account screen has a clearly-labelled "Delete Account" row'
);

check(
  accountIndexSource.includes('router.push("/(tabs)/account/delete-account")'),
  'the Delete Account row navigates to the in-app delete-account screen, not out to a website or a mailto: link'
);

check(
  layoutSource.includes('name="delete-account"'),
  'the delete-account screen is registered in the Account stack layout'
);

// --- mobile UI confirmation exists, and explains the irreversible
// effect (requirement: not a silent one-tap delete) ---

check(
  screenSource.includes('deleteAccount('),
  'the screen calls the real deleteAccount() API function (lib/api.ts), not a stub'
);

check(
  /permanently|cannot be undone|irreversible/i.test(screenSource),
  'the screen\'s own copy names the deletion as permanent/irreversible, not vague wording'
);

check(
  screenSource.includes('Alert.alert') && screenSource.includes('window.confirm'),
  'an explicit confirmation step exists on both native (Alert.alert) and web (window.confirm) before deletion actually runs — matching the same dual-path pattern already used for Log out'
);

// The confirmation call itself (performDeletion) must only ever be
// reachable from inside that explicit confirm step — never wired
// directly to the button's own onPress, which would make deletion a
// single accidental tap.
check(
  !screenSource.includes('onPress={performDeletion}'),
  'performDeletion is never wired directly to a button\'s onPress — it can only be reached through the confirmation step (confirmAndDelete)'
);

check(
  screenSource.includes('onPress={confirmAndDelete}'),
  'the visible button goes through the confirmation step, not straight to deletion'
);

// --- Apple-specific honesty requirement: must not claim HCG cancels an
// Apple/RevenueCat subscription — must tell the customer to do it
// themselves ---

check(
  /Apple.*cancel|cancel.*Apple/i.test(screenSource) && screenSource.includes('Settings'),
  'the screen tells an Apple-subscribed customer to cancel via Settings themselves, rather than implying account deletion alone stops Apple\'s billing'
);

// --- user is signed out after successful deletion ---

const performDeletionStart = screenSource.indexOf('async function performDeletion');
const performDeletionEnd = screenSource.indexOf('\n  }', performDeletionStart);
const performDeletionBody = screenSource.slice(performDeletionStart, performDeletionEnd);

check(
  performDeletionStart !== -1 && performDeletionBody.includes('supabase.auth.signOut()'),
  'performDeletion signs the device out (supabase.auth.signOut()) after a successful deletion call'
);

check(
  performDeletionBody.indexOf('deleteAccount(') < performDeletionBody.indexOf('supabase.auth.signOut()'),
  'sign-out happens only after the deletion call, in that order — never signed out first and deleted second'
);

// PR #25 (2026-09-07) established that every sign-out path must reset
// voiceClient.ts's module-level registration state, not just clear the
// Supabase session — otherwise a different household signing into this
// same device afterwards silently never registers for incoming calls
// (registerForIncomingCalls()'s `if (registered) return` guard). Account
// deletion is a sign-out path too, so it must follow the same rule.
check(
  performDeletionBody.includes('resetVoiceRegistrationState()'),
  'performDeletion resets Voice SDK registration state (resetVoiceRegistrationState()), the same as the existing Log out path — a different household signing into this device next must still be able to register'
);

check(
  performDeletionBody.indexOf('resetVoiceRegistrationState()') < performDeletionBody.indexOf('supabase.auth.signOut()'),
  'Voice SDK registration state is reset before signing out, matching account/index.tsx\'s established signOutAndResetVoiceRegistration order'
);

check(
  screenSource.includes('import { resetVoiceRegistrationState } from "../../../lib/voiceClient"'),
  'resetVoiceRegistrationState is imported from lib/voiceClient, the same real function account/index.tsx uses — not a local stub'
);

// --- deletion failures must never sign the user out or claim success ---

const catchStart = screenSource.indexOf('} catch (err) {', performDeletionStart);
const catchEnd = screenSource.indexOf('\n  }', catchStart);
const catchBody = screenSource.slice(catchStart, catchEnd);

check(
  catchStart !== -1 && !catchBody.includes('supabase.auth.signOut'),
  'the catch block never signs the device out — a failed deletion (e.g. stripe_cancel_failed) must leave the customer signed in, on an untouched account, able to see the error and retry'
);

check(
  catchBody.includes('nothing has changed') || catchBody.includes("couldn't delete"),
  'the error copy itself is explicit that nothing was deleted / nothing changed on failure, not a vague message that could be misread as partial success'
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
