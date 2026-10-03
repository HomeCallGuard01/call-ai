// Tests for services/callDeliveryFallback.js (2026-09-29) — what a caller
// hears when an approved call could not reach the household's app.
// Proves production behaviour is byte-identical to the previous inline
// /call-delivery-failed response, and that the voicemail PROTOTYPE can
// never activate with NODE_ENV=production.
//
// Run with: node tests/call-delivery-fallback.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const fallback = require('../services/callDeliveryFallback.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

// The exact pre-2026-09-29 route body, reproduced verbatim.
function legacyResponse(dialCallStatus) {
  const twiml = new VoiceResponse();
  if (dialCallStatus !== 'completed') {
    twiml.say(
      { voice: 'Polly.Amy', language: 'en-GB' },
      "We're sorry, this call cannot be connected right now. Please try again later."
    );
  }
  twiml.hangup();
  return twiml.toString();
}

const build = (dialCallStatus, mode) => fallback.buildDeliveryFailedResponse(new VoiceResponse(), { dialCallStatus, mode }).toString();

for (const status of ['completed', 'no-answer', 'busy', 'failed', 'canceled', undefined]) {
  check(build(status, fallback.MODES.OFF) === legacyResponse(status), `mode off is byte-identical to the legacy response for DialCallStatus=${status}`);
  check(build(status) === legacyResponse(status), `default mode is off (DialCallStatus=${status})`);
}

// --- production hard guard ---
check(fallback.resolveFallbackMode({ NODE_ENV: 'production', CALL_DELIVERY_FALLBACK_MODE: 'voicemail_prototype' }) === 'off',
  'NODE_ENV=production forces mode off even when the prototype is requested');
check(fallback.resolveFallbackMode({}) === 'off', 'unset → off');
check(fallback.resolveFallbackMode({ CALL_DELIVERY_FALLBACK_MODE: 'something-else' }) === 'off', 'unknown value → off');
check(fallback.resolveFallbackMode({ NODE_ENV: 'development', CALL_DELIVERY_FALLBACK_MODE: 'voicemail_prototype' }) === 'voicemail_prototype',
  'prototype only selectable outside production');

// --- prototype behaviour ---
const vm = build('no-answer', fallback.MODES.VOICEMAIL_PROTOTYPE);
check(vm.includes('<Record') && vm.includes(`maxLength="${fallback.VOICEMAIL_MAX_SECONDS}"`) && vm.includes(`action="${fallback.VOICEMAIL_COMPLETE_PATH}"`),
  'prototype: records a bounded message with a completion action');
check(vm.includes('leave a short message'), 'prototype: caller is told they are being recorded before the tone');
check(!/<Dial|<Number/.test(vm), 'prototype: never dials a PSTN number (the household mobile would divert straight back — loop)');
check(build('completed', fallback.MODES.VOICEMAIL_PROTOTYPE) === legacyResponse('completed'), 'prototype: a connected call is untouched');
check(!build('canceled', fallback.MODES.VOICEMAIL_PROTOTYPE).includes('<Record'), 'prototype: no recording when the caller already hung up');
check(build('busy', fallback.MODES.VOICEMAIL_PROTOTYPE).includes('<Record'), 'prototype: customer declined/busy → caller may leave a message');

// --- server.js wiring ---
const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = (server.match(/app\.post\("\/call-delivery-failed"[\s\S]*?\n\}\);\n/) || [''])[0];
check(route.includes('buildDeliveryFailedResponse(twiml, { dialCallStatus, mode: CALL_DELIVERY_FALLBACK_MODE });'), '/call-delivery-failed uses the builder');
check(!route.includes('twiml.say('), '/call-delivery-failed no longer has its own inline Say (single implementation)');
check(route.includes('sendCriticalAlert(') && route.includes('"approved_call_delivery_failed"'), 'the existing per-call alert is unchanged');
check(route.includes('.then(() => evaluateAfterDeliveryOutcome({'), 'delivery-health evaluation is chained after the outcome write');
check(/const CALL_DELIVERY_FALLBACK_MODE = resolveFallbackMode\(\);/.test(server), 'mode resolved once at startup through the production-guarded resolver');
check(/if \(CALL_DELIVERY_FALLBACK_MODE === FALLBACK_MODES\.VOICEMAIL_PROTOTYPE\) \{\n(?:  \/\/[^\n]*\n)*  app\.post\(VOICEMAIL_COMPLETE_PATH, twilioSignatureGuard, twilioWebhookIntegrity,/.test(server),
  'the voicemail completion route is only registered in prototype mode');

if (failures) {
  console.error(`\n✗ ${failures} call-delivery-fallback checks FAILED`);
  process.exit(1);
}
console.log('\n✓ All call-delivery-fallback checks passed');
