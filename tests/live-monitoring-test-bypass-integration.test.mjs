// Structural proof that server.js's attachLiveMonitoring correctly wires
// the TEST-ONLY diagnostic bypass (services/monitoringTestBypass.js) —
// matching this codebase's established convention for testing server.js
// internals (source-string assertions against the real file; see
// tests/live-monitoring-stream-track.test.mjs, tests/live-monitoring-
// scenarios.test.mjs). shouldBypassMonitoringForTest's own decision logic
// (unset/empty/wrong household/malformed/wildcard/multiple ids) is
// exhaustively unit-tested in tests/monitoring-test-bypass.test.mjs —
// this file only proves the integration point itself: where the check is
// called, what happens when it says yes, and that everything else
// (<Say>, <Dial><Client>, the normal Stream-building code) is completely
// unaffected.
//
// Run with: node tests/live-monitoring-test-bypass-integration.test.mjs

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
    serverSrc.includes('const { shouldBypassMonitoringForTest } = require("./services/monitoringTestBypass");'),
    'server.js imports shouldBypassMonitoringForTest from services/monitoringTestBypass'
  );

  const attachLiveMonitoringMatch = serverSrc.match(
    /function attachLiveMonitoring\(twiml, \{ household, twilioNumber \}\) \{[\s\S]*?\n\}/
  );
  check(Boolean(attachLiveMonitoringMatch), 'sanity check: attachLiveMonitoring function body is found in server.js');
  const fnBody = attachLiveMonitoringMatch ? attachLiveMonitoringMatch[0] : '';

  // --- the bypass check happens first, right after the existing
  // !household guard, and before anything else in the function ---
  const nullHouseholdGuardIdx = fnBody.indexOf('if (!household) return;');
  const bypassCheckIdx = fnBody.indexOf('if (shouldBypassMonitoringForTest(household.id, process.env)) {');
  const startCallIdx = fnBody.indexOf('const start = twiml.start();');
  check(
    nullHouseholdGuardIdx !== -1 && bypassCheckIdx !== -1 && startCallIdx !== -1 &&
      nullHouseholdGuardIdx < bypassCheckIdx && bypassCheckIdx < startCallIdx,
    'the bypass check runs after the null-household guard and before twiml.start() — a bypass genuinely prevents <Start><Stream> from ever being constructed'
  );

  // --- a bypass returns immediately, never falling through to the real
  // stream-building code ---
  const bypassBlockMatch = fnBody.match(/if \(shouldBypassMonitoringForTest\(household\.id, process\.env\)\) \{[\s\S]*?\n  \}/);
  check(
    Boolean(bypassBlockMatch) && bypassBlockMatch[0].includes('return;'),
    'the bypass branch itself returns — it cannot fall through into the real stream-building code below it'
  );

  // --- the bypass log line names the household id only — no phone
  // number, audio, or transcript content, and clearly says "TEST" ---
  check(
    Boolean(bypassBlockMatch) &&
      bypassBlockMatch[0].includes('console.error("TEST MONITORING BYPASS: skipping live monitoring for diagnostic test household", household.id);'),
    'the bypass log line clearly identifies itself as a TEST bypass and logs only the household id'
  );
  check(
    Boolean(bypassBlockMatch) &&
      !/toNumber|protectedNumber|twilio_number|phone/i.test(bypassBlockMatch[0]),
    'the bypass log line never includes a phone number or any other call-identifying field beyond the household id'
  );

  // --- the normal (non-bypassed) stream-building code is completely
  // unconditional and unchanged: inbound_track and all three parameters
  // still always run when there is no bypass ---
  check(
    fnBody.includes('start.stream({ url: buildMediaStreamUrl(APP_URL), track: "inbound_track" })'),
    'the real <Start><Stream> call (with the inbound_track hygiene fix from PR #31) is unconditional and unchanged outside the bypass branch'
  );
  check(
    fnBody.includes('stream.parameter({ name: "householdId", value: household.id })') &&
      fnBody.includes('stream.parameter({ name: "toNumber", value: destination.number })') &&
      fnBody.includes('stream.parameter({ name: "protectedNumber", value: twilioNumber })'),
    'all three existing stream parameters are unconditional and unchanged'
  );

  // --- <Say> and <Dial><Client> remain completely untouched: the /voice
  // route's announcement and dialHouseholdOrFailClosed call sites are
  // byte-for-byte the same as before this change, and are never inside
  // attachLiveMonitoring at all (so a bypass of this function cannot
  // possibly affect them) ---
  const voiceRouteMatch = serverSrc.match(/app\.post\("\/voice",[\s\S]*?\n\}\);/);
  check(Boolean(voiceRouteMatch), 'sanity check: the /voice route handler is found in server.js');
  const voiceSrc = voiceRouteMatch ? voiceRouteMatch[0] : '';

  check(
    voiceSrc.includes('"This number is monitored and protected by Home Call Guard."'),
    '<Say> — the fixed monitoring announcement — is still present in /voice, completely unchanged'
  );
  check(
    voiceSrc.includes('dialHouseholdOrFailClosed(twiml, household);'),
    'dialHouseholdOrFailClosed (the <Dial><Client> call site) is still called from /voice, completely unchanged'
  );

  const sayIdx = voiceSrc.indexOf('This number is monitored and protected by Home Call Guard.');
  const attachIdx = voiceSrc.indexOf('attachLiveMonitoring(twiml');
  const dialIdx = voiceSrc.lastIndexOf('dialHouseholdOrFailClosed(twiml, household);');
  check(
    sayIdx !== -1 && attachIdx !== -1 && dialIdx !== -1 && sayIdx < attachIdx && attachIdx < dialIdx,
    'ordering is unchanged: announcement, then attachLiveMonitoring (which may internally bypass just the Stream), then the customer is still always dialled — a monitoring bypass never skips or reorders <Say> or <Dial><Client>'
  );

  // --- the bypass mechanism cannot reach screening/contact-classification
  // logic either: attachLiveMonitoring's own function body has no
  // reference to contact matching, OpenAI classification, or the isKnown
  // check — those live entirely outside this function, earlier in /voice ---
  check(
    !/isKnown|classifyCall|openai/i.test(fnBody),
    'attachLiveMonitoring has no way to affect contact classification or the known/unknown-caller decision — that logic is entirely outside this function'
  );

  // --- dialHouseholdOrFailClosed itself (the actual <Dial><Client> verb)
  // has no reference to the bypass mechanism at all — it is genuinely a
  // separate, untouched function ---
  const dialFnMatch = serverSrc.match(/function dialHouseholdOrFailClosed\(twiml, household\) \{[\s\S]*?\n\}\n/);
  check(Boolean(dialFnMatch), 'sanity check: dialHouseholdOrFailClosed function body is found in server.js');
  check(
    Boolean(dialFnMatch) && !dialFnMatch[0].includes('shouldBypassMonitoringForTest'),
    'dialHouseholdOrFailClosed never references the diagnostic bypass — <Dial><Client> is completely independent of it'
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring test-bypass integration checks passed.');
  }
}

run();
