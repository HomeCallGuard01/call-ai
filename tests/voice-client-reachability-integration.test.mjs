// Structural proof that server.js's dialHouseholdOrFailClosed correctly
// wires the 2026-09-13 reachability-model fix (services/callRouting.js's
// hasVoiceClientRegistrationHistory, replacing isVoiceClientReachable) —
// matching this codebase's established convention for testing server.js
// internals (source-string assertions; server.js is never required
// directly in tests, since doing so would start the real app.listen()).
//
// hasVoiceClientRegistrationHistory's own decision logic (null/undefined/
// recent/hours-old/days-old) is exhaustively unit-tested in
// tests/call-routing.test.mjs — this file only proves the integration
// point: server.js calls the new function (not the old one, and not with
// a re-introduced time-window comparison), and that <Say>/<Dial><Client>
// and trusted-contact routing are completely untouched by this change.
//
// Run with: node tests/voice-client-reachability-integration.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

function run() {
  const serverSrc = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  check(
    serverSrc.includes('hasVoiceClientRegistrationHistory,') && serverSrc.includes('require("./services/callRouting");'),
    'server.js imports hasVoiceClientRegistrationHistory from services/callRouting'
  );
  check(
    !/isVoiceClientReachable\(/.test(serverSrc),
    'server.js no longer calls the old isVoiceClientReachable function anywhere (a plain-prose mention in an explanatory comment about the rename is fine and expected)'
  );

  const dialFnMatch = serverSrc.match(/function dialHouseholdOrFailClosed\(twiml, household\) \{[\s\S]*?\n\}\n/);
  check(Boolean(dialFnMatch), 'sanity check: dialHouseholdOrFailClosed function body is found in server.js');
  const fnBody = dialFnMatch ? dialFnMatch[0] : '';

  // --- the new function is called with only the registration timestamp —
  // no `new Date()`/now argument re-introducing a time comparison ---
  const callMatch = fnBody.match(/hasVoiceClientRegistrationHistory\(\s*household && household\.voice_client_registered_at\s*\)/);
  check(
    Boolean(callMatch),
    'dialHouseholdOrFailClosed calls hasVoiceClientRegistrationHistory with exactly the registration timestamp — no second "now" argument, no time-window comparison re-introduced'
  );
  check(
    !fnBody.includes('new Date()'),
    'dialHouseholdOrFailClosed no longer constructs a "now" value at all — confirms no time-window logic remains in this function'
  );

  // --- decideCallDeliveryPlan's own contract/call site is unchanged ---
  check(
    fnBody.includes('decideCallDeliveryPlan(household, clientIdentity, { voiceClientReachable })'),
    'decideCallDeliveryPlan is still called with the same shape — its own contract (true -> dial, false -> self-protecting-unreachable) is untouched by this fix'
  );

  // --- <Dial><Client> structure itself is untouched ---
  check(
    fnBody.includes('const dial = twiml.dial({ action: "/call-delivery-failed", timeout: 20 });') &&
      fnBody.includes('dial.client(plan.clientIdentity);'),
    '<Dial><Client> construction (action, timeout, client identity) is byte-for-byte unchanged'
  );

  // --- trusted-contact routing is untouched: the known-contact branch of
  // /voice never references reachability at all, and still calls
  // dialHouseholdOrFailClosed the same way it always has ---
  const voiceRouteMatch = serverSrc.match(/app\.post\("\/voice",[\s\S]*?\n\}\);/);
  check(Boolean(voiceRouteMatch), 'sanity check: the /voice route handler is found in server.js');
  const voiceSrc = voiceRouteMatch ? voiceRouteMatch[0] : '';
  const EARLY_RETURN = 'return res.type("text/xml").send(twiml.toString());';
  const firstReturnIdx = voiceSrc.indexOf(EARLY_RETURN);
  const knownContactBranch = firstReturnIdx === -1 ? '' : voiceSrc.slice(0, firstReturnIdx);
  check(
    knownContactBranch.includes('dialHouseholdOrFailClosed(twiml, household);') &&
      !knownContactBranch.includes('hasVoiceClientRegistrationHistory') &&
      !knownContactBranch.includes('attachLiveMonitoring'),
    'trusted-contact (known-contact) routing is unaffected: it still calls dialHouseholdOrFailClosed the same way, with no direct reference to the reachability check or monitoring'
  );

  // --- attachLiveMonitoring (screened-call routing) has no reference to
  // the reachability check either — genuinely separate concerns ---
  const attachLiveMonitoringMatch = serverSrc.match(
    /function attachLiveMonitoring\(twiml, \{ household, twilioNumber \}\) \{[\s\S]*?\n\}/
  );
  check(
    Boolean(attachLiveMonitoringMatch) && !attachLiveMonitoringMatch[0].includes('hasVoiceClientRegistrationHistory'),
    'attachLiveMonitoring (screened-call monitoring) has no reference to the reachability check — genuinely unaffected by this fix'
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll voice-client-reachability integration checks passed.');
  }
}

run();
