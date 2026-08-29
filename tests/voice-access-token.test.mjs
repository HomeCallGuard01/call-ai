// Unit tests for services/voiceAccessToken.js — the mobile Voice SDK
// delivery mechanism that replaces PSTN dial-back for SAFE/known-contact
// calls. Pure function, no network/Twilio account involved: constructs
// and decodes a real JWT locally, so these checks would fail if the
// grant shape ever silently drifted from what the Voice SDK expects.
//
// Run with: node tests/voice-access-token.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildVoiceClientIdentity, buildVoiceAccessToken, DEFAULT_TTL_SECONDS } = require('../services/voiceAccessToken.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- identity ---

{
  check(
    buildVoiceClientIdentity('abc-123') === 'household_abc-123',
    'identity is household_<householdId>, never the phone number'
  );
  check(
    !buildVoiceClientIdentity('abc-123').match(/\+?\d{6,}/),
    'identity never contains anything that looks like a phone number'
  );
}

// --- token construction ---

const FAKE_CREDS = {
  accountSid: 'AC00000000000000000000000000000000',
  apiKeySid: 'SK00000000000000000000000000000000',
  apiKeySecret: 'fake-secret-for-tests-only',
  twimlAppSid: 'AP00000000000000000000000000000000',
};

function decodeJwtPayload(jwt) {
  const payloadB64 = jwt.split('.')[1];
  const json = Buffer.from(payloadB64, 'base64').toString('utf8');
  return JSON.parse(json);
}

{
  const result = buildVoiceAccessToken({ ...FAKE_CREDS, householdId: 'household-x' });

  check(typeof result.token === 'string' && result.token.split('.').length === 3, 'produces a real JWT (three dot-separated segments)');
  check(result.identity === 'household_household-x', 'returns the same identity it embedded in the token');
  check(result.ttlSeconds === DEFAULT_TTL_SECONDS, 'defaults to the documented TTL when none is passed');

  const payload = decodeJwtPayload(result.token);
  check(payload.grants?.identity === 'household_household-x', "JWT payload's grants.identity matches");
  check(payload.grants?.voice?.incoming?.allow === true, 'VoiceGrant has incomingAllow: true — required to receive calls');
  check(payload.grants?.voice?.outgoing?.application_sid === FAKE_CREDS.twimlAppSid, 'VoiceGrant carries the TwiML App SID');
  check(payload.iss === FAKE_CREDS.apiKeySid, 'token is issued (signed) with the API Key SID, not the Account SID/Auth Token');
  check(payload.sub === FAKE_CREDS.accountSid, 'token subject is the Account SID');
}

{
  const custom = buildVoiceAccessToken({ ...FAKE_CREDS, householdId: 'household-y', ttlSeconds: 60 });
  check(custom.ttlSeconds === 60, 'a custom TTL is honoured');
  const payload = decodeJwtPayload(custom.token);
  check(payload.exp - payload.iat === 60, 'the JWT itself expires exactly ttlSeconds after issuance');
}

// --- two different households never collide ---

{
  const a = buildVoiceAccessToken({ ...FAKE_CREDS, householdId: 'household-a' });
  const b = buildVoiceAccessToken({ ...FAKE_CREDS, householdId: 'household-b' });
  check(a.identity !== b.identity, 'two different households get two different identities');
}

// --- fails closed on missing config, never issues a malformed/partial token ---

{
  for (const missing of ['accountSid', 'apiKeySid', 'apiKeySecret', 'twimlAppSid']) {
    const creds = { ...FAKE_CREDS };
    delete creds[missing];
    let threw = false;
    try {
      buildVoiceAccessToken({ ...creds, householdId: 'household-z' });
    } catch {
      threw = true;
    }
    check(threw, `missing ${missing}: throws rather than issuing a token with an undefined field`);
  }
}

{
  let threw = false;
  try {
    buildVoiceAccessToken({ ...FAKE_CREDS, householdId: undefined });
  } catch {
    threw = true;
  }
  check(threw, 'missing householdId: throws rather than issuing an identity-less token');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
