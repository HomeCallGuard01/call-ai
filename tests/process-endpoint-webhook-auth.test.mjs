// Legacy POST /process must refuse requests without a valid Twilio
// signature (2026-09-29). The route is unreachable for real calls (no
// <Gather action="/process"> in /voice) but was publicly POSTable: an
// arbitrary SpeechResult + To=<customer Twilio number> spent OpenAI credit
// and wrote a fabricated row into that customer's Activity list.
//
// Structural checks against the real server.js source (matching
// tests/account-classification.test.mjs's convention — server.js can't be
// booted in a unit test), plus a real-signature round trip through the
// same helper the route uses.
//
// Run with: node tests/process-endpoint-webhook-auth.test.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const twilio = require('twilio');
const { buildWebhookUrl, isGenuineTwilioRequest } = require('../services/twilioWebhookAuth.js');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const start = server.indexOf('app.post("/process", async (req, res) => {');
const end = server.indexOf('\napp.post(', start + 10);
const route = server.slice(start, end);
const code = route.replace(/^\s*\/\/.*$/gm, '');
check(start !== -1 && end > start, 'found the /process route');

const gate = code.indexOf('isGenuineTwilioRequest(');
const refuse = code.indexOf('res.status(403)');
check(gate !== -1 && refuse > gate, '/process verifies the Twilio signature and returns 403 when it is not genuine');
for (const [label, needle] of [
  ['household lookup', 'getHouseholdByTwilioNumber('],
  ['contacts lookup', 'getContacts('],
  ['OpenAI classification', 'openai.chat.completions.create('],
  ['call-log write', 'logCall('],
  ['TwiML construction', 'new VoiceResponse()'],
]) {
  const at = code.indexOf(needle);
  check(at !== -1 && refuse < at, `the 403 refusal happens before the ${label}`);
}
check(/signature:\s*req\.get\("X-Twilio-Signature"\)/.test(code) && /url:\s*buildWebhookUrl\(APP_URL, req\.originalUrl\)/.test(code) && /authToken:\s*process\.env\.TWILIO_AUTH_TOKEN/.test(code),
  'uses the same signature inputs as /voice (X-Twilio-Signature, APP_URL-based URL, TWILIO_AUTH_TOKEN)');
const rejectLog = (code.slice(gate, refuse + 80).match(/console\.error\(([^)]*)\)/) || [, ''])[1];
check(rejectLog && !/req\.body|SpeechResult|speech|From|To\b/.test(rejectLog), 'the rejection log line contains no request-body data');

// Real round trip through the same helper: a genuinely signed request passes,
// an unsigned or tampered one does not.
const token = 'test_auth_token_000';
const url = buildWebhookUrl('https://homecallguard.example', '/process');
const params = { SpeechResult: 'hello', From: '+447700900001', To: '+447700900002' };
const sig = twilio.getExpectedTwilioSignature(token, url, params);
check(isGenuineTwilioRequest({ authToken: token, signature: sig, url, params }) === true, 'a genuinely signed Twilio request is accepted (rollback path still works)');
check(isGenuineTwilioRequest({ authToken: token, signature: undefined, url, params }) === false, 'an unsigned request is refused');
check(isGenuineTwilioRequest({ authToken: token, signature: sig, url, params: { ...params, SpeechResult: 'forged' } }) === false, 'a request with a tampered body is refused');
check(isGenuineTwilioRequest({ authToken: undefined, signature: sig, url, params }) === false, 'fails closed when TWILIO_AUTH_TOKEN is not configured');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
