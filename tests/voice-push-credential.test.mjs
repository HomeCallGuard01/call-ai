// Unit tests for services/voicePushCredential.js — the Android-vs-iOS
// Twilio Push Credential split (2026-08-2X, iOS pre-flight). Pure
// function, no network/Twilio account involved.
//
// Run with: node tests/voice-push-credential.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolvePushCredentialSid } = require('../services/voicePushCredential.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const env = {
  TWILIO_VOICE_PUSH_CREDENTIAL_SID: 'CR860503ff17f9d384b46f75726dce61e0',
  TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS: 'CR5d1b76c5b4e41ce2edd5db4a4578d4c4',
};

// --- android receives exactly the FCM SID ---

{
  const result = resolvePushCredentialSid('android', env);
  check(result.ok === true, 'android: resolves ok');
  check(result.sid === env.TWILIO_VOICE_PUSH_CREDENTIAL_SID, 'android: resolves to the FCM SID');
  check(result.sid !== env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS, 'android: never resolves to the iOS SID');
}

// --- ios receives exactly the APN SID ---

{
  const result = resolvePushCredentialSid('ios', env);
  check(result.ok === true, 'ios: resolves ok');
  check(result.sid === env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS, 'ios: resolves to the APN/VoIP SID');
  check(result.sid !== env.TWILIO_VOICE_PUSH_CREDENTIAL_SID, 'ios: never resolves to the Android FCM SID');
}

// --- an unsupported or missing platform fails closed, never defaults ---

{
  const result = resolvePushCredentialSid('windows', env);
  check(result.ok === false, 'unsupported platform ("windows"): fails closed');
  check(result.sid === null, 'unsupported platform: no SID of any kind is returned');
}

{
  const result = resolvePushCredentialSid(undefined, env);
  check(result.ok === false, 'missing platform (undefined): fails closed, not defaulted to android');
  check(result.sid === null, 'missing platform: no SID of any kind is returned');
}

{
  const result = resolvePushCredentialSid('', env);
  check(result.ok === false, 'empty-string platform: fails closed');
}

{
  // Case sensitivity matters here: silently accepting "iOS"/"Android" as
  // equivalent to "ios"/"android" would be a second, harder-to-notice way
  // for a client bug to slip past the fail-closed check.
  const result = resolvePushCredentialSid('iOS', env);
  check(result.ok === false, 'wrong-case platform ("iOS"): fails closed, not treated as "ios"');
}

// --- a platform's own credential can independently be unset without
// affecting the other platform, and without becoming "unsupported" ---

{
  const androidOnlyEnv = { TWILIO_VOICE_PUSH_CREDENTIAL_SID: env.TWILIO_VOICE_PUSH_CREDENTIAL_SID };
  const result = resolvePushCredentialSid('ios', androidOnlyEnv);
  check(result.ok === true, 'ios with no TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS set: still resolves ok (degrades, does not fail closed)');
  check(result.sid === undefined, 'ios with no env var set: sid is undefined, not the android SID or a thrown error');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
