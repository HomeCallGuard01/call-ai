// Unit tests for services/twilioWebhookAuth.js — added 2026-09-10 in
// response to a review finding: /voice (and every other Twilio-facing
// webhook in this codebase) had no signature validation at all, which
// directly contradicted P0 Batch 1's activation-auto-stamp design
// treating a POST to /voice as "Twilio-authenticated" evidence.
//
// The real-signature tests below use twilio.getExpectedTwilioSignature —
// the SDK's own SIGNING function — to construct a genuine signature, then
// feed it through isGenuineTwilioRequest (built on twilio.validateRequest,
// the SDK's VERIFYING function). Using the SDK's two independent
// functions against each other is a real, non-tautological check that
// this module's wrapper genuinely delegates to correct Twilio signature
// logic — not just "returns whatever a fully-mocked function returns."
//
// Run with: node tests/twilio-webhook-auth.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const twilio = require('twilio');
const { buildWebhookUrl, isGenuineTwilioRequest } = require('../services/twilioWebhookAuth.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- buildWebhookUrl ---

check(
  buildWebhookUrl('https://www.homecallguard.co.uk', '/voice') === 'https://www.homecallguard.co.uk/voice',
  'buildWebhookUrl concatenates APP_URL and the request path directly'
);
check(
  buildWebhookUrl('https://www.homecallguard.co.uk', '/voice?foo=bar') === 'https://www.homecallguard.co.uk/voice?foo=bar',
  'buildWebhookUrl preserves a query string on originalUrl'
);

// --- isGenuineTwilioRequest: real signature round-trip (SDK sign, SDK-backed verify) ---

const REAL_AUTH_TOKEN = 'test-auth-token-not-a-real-secret';
const REAL_URL = 'https://www.homecallguard.co.uk/voice';
const REAL_PARAMS = { CallSid: 'CA123', From: '+447700900001', To: '+447700900002' };

{
  const genuineSignature = twilio.getExpectedTwilioSignature(REAL_AUTH_TOKEN, REAL_URL, REAL_PARAMS);
  const result = isGenuineTwilioRequest({
    authToken: REAL_AUTH_TOKEN,
    signature: genuineSignature,
    url: REAL_URL,
    params: REAL_PARAMS,
  });
  check(result === true, 'a genuine Twilio signature (constructed via the SDK\'s own signing function) validates as true, using the real twilio.validateRequest by default');
}

{
  const genuineSignature = twilio.getExpectedTwilioSignature(REAL_AUTH_TOKEN, REAL_URL, REAL_PARAMS);
  const tamperedParams = { ...REAL_PARAMS, From: '+447700900999' }; // an attacker changing the caller ID after the fact
  const result = isGenuineTwilioRequest({
    authToken: REAL_AUTH_TOKEN,
    signature: genuineSignature,
    url: REAL_URL,
    params: tamperedParams,
  });
  check(result === false, 'a signature computed for one set of params does not validate against tampered params — this is the actual spoofing protection');
}

{
  const genuineSignature = twilio.getExpectedTwilioSignature(REAL_AUTH_TOKEN, REAL_URL, REAL_PARAMS);
  const result = isGenuineTwilioRequest({
    authToken: 'a-completely-different-wrong-token',
    signature: genuineSignature,
    url: REAL_URL,
    params: REAL_PARAMS,
  });
  check(result === false, 'validation against the wrong auth token fails, even with an otherwise-correct signature');
}

{
  const genuineSignature = twilio.getExpectedTwilioSignature(REAL_AUTH_TOKEN, REAL_URL, REAL_PARAMS);
  const result = isGenuineTwilioRequest({
    authToken: REAL_AUTH_TOKEN,
    signature: genuineSignature,
    url: 'https://www.homecallguard.co.uk/voice?spoofed=1', // wrong URL — e.g. a proxy/trust-proxy misconfiguration
    params: REAL_PARAMS,
  });
  check(result === false, 'a mismatched URL (e.g. from an unreliable req.protocol/req.hostname behind a proxy) fails validation — this is exactly why buildWebhookUrl uses APP_URL, not request-derived values');
}

// --- isGenuineTwilioRequest: fail-closed on missing pieces, never throws ---

check(isGenuineTwilioRequest({ authToken: null, signature: 'sig', url: REAL_URL, params: {} }) === false, 'missing authToken (e.g. TWILIO_AUTH_TOKEN not configured) fails closed, not open');
check(isGenuineTwilioRequest({ authToken: REAL_AUTH_TOKEN, signature: null, url: REAL_URL, params: {} }) === false, 'missing signature header fails closed');
check(isGenuineTwilioRequest({ authToken: REAL_AUTH_TOKEN, signature: 'sig', url: null, params: {} }) === false, 'missing url fails closed');
check(isGenuineTwilioRequest({ authToken: undefined, signature: undefined, url: undefined, params: undefined }) === false, 'everything missing at once fails closed, not throws');

{
  let threw = false;
  try {
    isGenuineTwilioRequest({
      authToken: REAL_AUTH_TOKEN,
      signature: 'not-a-real-signature',
      url: REAL_URL,
      params: REAL_PARAMS,
      validate: () => { throw new Error('validator exploded'); },
    });
  } catch {
    threw = true;
  }
  check(!threw, 'an exception from the underlying validator is caught, not propagated — a malformed request must never crash the handler');
}

// --- isGenuineTwilioRequest: injectable validate dependency (for tests that don't want real crypto) ---

{
  const calls = [];
  const fakeValidate = (authToken, signature, url, params) => {
    calls.push({ authToken, signature, url, params });
    return true;
  };
  const result = isGenuineTwilioRequest({
    authToken: 'tok',
    signature: 'sig',
    url: 'https://example.com/voice',
    params: { CallSid: 'CA1' },
    validate: fakeValidate,
  });
  check(result === true, 'an injected validate function is used in place of the real twilio.validateRequest');
  check(
    calls.length === 1 &&
      calls[0].authToken === 'tok' &&
      calls[0].signature === 'sig' &&
      calls[0].url === 'https://example.com/voice' &&
      calls[0].params.CallSid === 'CA1',
    'the injected validator receives the exact authToken/signature/url/params passed in, in the correct order'
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
