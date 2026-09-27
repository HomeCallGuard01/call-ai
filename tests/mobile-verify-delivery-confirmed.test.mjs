// Regression coverage for the mobile-UI half of the "deliveryConfirmed"
// launch-hardening fix (2026-09-27) — the backend half
// (routes/mobileApi.js reporting deliveryConfirmed, tested in
// tests/activation-verify-delivery-confirmed.test.mjs) is not enough on
// its own: a new customer must not see "Verified"/"protected" wording
// unless the APP itself checks the stricter signal, not just `verified`.
//
// Real gap this closes: mobile/app/(setup)/verify.tsx previously showed
// "Verified! Your calls are now forwarding correctly." based only on
// `result.verified` — true as soon as ANY call reached Home Call Guard's
// own number, with no evidence it could ever reach the customer's phone.
// A household whose Voice SDK client never once registered (a real,
// already-traced production case) would have seen this exact same
// falsely-reassuring "Verified!" screen.
//
// Same convention as the rest of this project (no RN test tooling):
// verify.tsx is checked as source.
//
// Run with: node tests/mobile-verify-delivery-confirmed.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.join(__dirname, '..', 'mobile');
const src = readFileSync(path.join(mobileRoot, 'app', '(setup)', 'verify.tsx'), 'utf8');
const typesSource = readFileSync(path.join(mobileRoot, 'lib', 'types.ts'), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- the response type honestly carries the new field ---
const typeMatch = typesSource.match(/export interface ActivationVerifyResponse \{[\s\S]*?\n\}/);
check(Boolean(typeMatch), 'sanity check: ActivationVerifyResponse type is found');
check(
  Boolean(typeMatch) && /deliveryConfirmed\??:\s*boolean/.test(typeMatch[0]),
  'ActivationVerifyResponse carries the new deliveryConfirmed field — the app-side type is not silently stuck on the old shape'
);

// --- a three-state model exists, not just verified/not_yet ---
check(
  /type CheckState = "checking" \| "verified" \| "forwarding_only" \| "not_yet";/.test(src),
  'a third, distinct "forwarding_only" state exists — the app can represent "reached HCG but not confirmed reaching the phone" as something other than either extreme'
);

// --- runCheck's branching genuinely reads deliveryConfirmed — not just
// declares the state and never reaches it ---
const runCheckMatch = src.match(/async function runCheck\(\) \{[\s\S]*?\n  \}/);
check(Boolean(runCheckMatch), 'sanity check: runCheck() function body is found');
const runCheckBody = runCheckMatch ? runCheckMatch[0] : '';

check(
  /if \(!result\.verified\) \{\s*setState\("not_yet"\);/.test(runCheckBody),
  'an unverified result (forwarding never reached HCG at all) still goes to "not_yet", exactly as before'
);
check(
  /result\.deliveryConfirmed[\s\S]{0,40}setState\("verified"\)/.test(runCheckBody),
  'the "verified" state is now only reached when deliveryConfirmed is also true — verified alone is no longer sufficient'
);
check(
  /setState\("forwarding_only"\)/.test(runCheckBody),
  'a verified-but-not-delivery-confirmed result routes to the new "forwarding_only" state instead of silently being treated as fully "verified"'
);

// --- the strong "Verified!"/"forwarding correctly" claim only renders
// for the genuine deliveryConfirmed state, never the weaker one ---
const verifiedBlockMatch = src.match(/if \(state === "verified"\) \{[\s\S]*?\n  \}/);
check(Boolean(verifiedBlockMatch), 'sanity check: the state === "verified" render block is found');
check(
  Boolean(verifiedBlockMatch) && /Verified!/.test(verifiedBlockMatch[0]),
  'the strong "Verified!" claim still exists, gated behind the now-stricter "verified" state'
);

const forwardingOnlyBlockMatch = src.match(/if \(state === "forwarding_only"\) \{[\s\S]*?\n  \}/);
check(Boolean(forwardingOnlyBlockMatch), 'sanity check: the new state === "forwarding_only" render block is found');
const forwardingOnlyBody = forwardingOnlyBlockMatch ? forwardingOnlyBlockMatch[0] : '';
check(
  !/Verified!/.test(forwardingOnlyBody) && !/protected/i.test(forwardingOnlyBody),
  'the "forwarding_only" screen never uses the words "Verified!" or "protected" — it cannot be mistaken for the full-confidence claim'
);
check(
  /Almost there/.test(forwardingOnlyBody),
  'the "forwarding_only" screen uses plain, non-alarming, non-technical wording ("Almost there") rather than exposing deliveryConfirmed/Voice SDK jargon to the customer'
);
check(
  /onPress=\{runCheck\}/.test(forwardingOnlyBody),
  'the "forwarding_only" screen still offers a "Check again" action wired to the real runCheck function, not a dead end'
);
check(
  /router\.replace\("\/\(tabs\)"\)/.test(forwardingOnlyBody),
  'the "forwarding_only" screen still offers a way back to Home, matching this screen\'s existing never-a-hard-gate convention'
);

console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} mobile-verify-delivery-confirmed checks ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
