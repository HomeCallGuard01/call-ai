// Stream track hygiene fix (2026-09-12 audio-quality investigation):
// attachLiveMonitoring's <Start><Stream> previously left `track` unset,
// relying on Twilio's undocumented-in-this-repo default. This adds an
// explicit track: "inbound_track" — the smallest possible hygiene change,
// with no effect on call routing or <Dial><Client> (confirmed by the
// investigation report: Media Streams is a one-way fork Twilio performs
// independently of the primary Dial'd leg).
//
// Source-string assertions against server.js, matching this codebase's
// established convention (see tests/live-monitoring-scenarios.test.mjs) —
// there is no HTTP test tooling in this project.
//
// Run with: node tests/live-monitoring-stream-track.test.mjs

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

  const attachLiveMonitoringMatch = serverSrc.match(
    /function attachLiveMonitoring\(twiml, \{ household, twilioNumber \}\) \{[\s\S]*?\n\}/
  );
  check(Boolean(attachLiveMonitoringMatch), 'sanity check: attachLiveMonitoring function body is found in server.js');
  const fnBody = attachLiveMonitoringMatch ? attachLiveMonitoringMatch[0] : '';

  // --- Part 1: explicit inbound_track ---
  check(
    /start\.stream\(\{\s*url:\s*buildMediaStreamUrl\(APP_URL\),\s*track:\s*["']inbound_track["']\s*\}\)/.test(fnBody),
    'attachLiveMonitoring\'s <Start><Stream> explicitly sets track: "inbound_track"'
  );
  const streamCallMatch = fnBody.match(/start\.stream\(\{[^}]*\}\)/);
  check(
    Boolean(streamCallMatch) && !/both_tracks|outbound_track/.test(streamCallMatch[0]),
    'the actual start.stream(...) call never requests both_tracks or outbound_track — only the caller\'s inbound speech is forked to the monitor'
  );

  // --- existing stream parameters remain unchanged ---
  check(fnBody.includes('stream.parameter({ name: "householdId", value: household.id })'), 'the householdId stream parameter is unchanged');
  check(fnBody.includes('stream.parameter({ name: "toNumber", value: destination.number })'), 'the toNumber stream parameter is unchanged');
  check(fnBody.includes('stream.parameter({ name: "protectedNumber", value: twilioNumber })'), 'the protectedNumber stream parameter is unchanged');
  check(fnBody.includes('buildMediaStreamUrl(APP_URL)'), 'the stream URL still comes from buildMediaStreamUrl(APP_URL), unchanged');

  // --- trusted-contact calls still never start a monitoring stream, and
  // <Dial><Client> routing is untouched (reusing /voice's known-contact
  // vs unknown-caller split, matching live-monitoring-scenarios.test.mjs's
  // own established approach) ---
  const voiceRouteMatch = serverSrc.match(/app\.post\("\/voice",[\s\S]*?\n\}\);/);
  check(Boolean(voiceRouteMatch), 'sanity check: the /voice route handler is found in server.js');
  const voiceSrc = voiceRouteMatch ? voiceRouteMatch[0] : '';

  const EARLY_RETURN = 'return res.type("text/xml").send(twiml.toString());';
  const firstReturnIdx = voiceSrc.indexOf(EARLY_RETURN);
  check(firstReturnIdx !== -1, 'sanity check: /voice contains the known-contact branch\'s early return');
  const knownContactBranch = firstReturnIdx === -1 ? '' : voiceSrc.slice(0, firstReturnIdx);

  check(
    !knownContactBranch.includes('attachLiveMonitoring'),
    'trusted-contact calls still never call attachLiveMonitoring — no monitoring stream is started for them, track hygiene change included'
  );
  check(
    knownContactBranch.includes('dialHouseholdOrFailClosed(twiml, household)'),
    'trusted-contact calls still route through dialHouseholdOrFailClosed unchanged'
  );

  // --- dialHouseholdOrFailClosed / <Dial><Client> itself is byte-for-byte
  // unchanged by this fix — this task never touches it ---
  const dialFnMatch = serverSrc.match(/function dialHouseholdOrFailClosed\(twiml, household\) \{[\s\S]*?\n\}\n/);
  check(Boolean(dialFnMatch), 'sanity check: dialHouseholdOrFailClosed function body is found in server.js');
  const dialFnBody = dialFnMatch ? dialFnMatch[0] : '';
  check(
    dialFnBody.includes('dial.client(plan.clientIdentity)'),
    'dialHouseholdOrFailClosed still dials the Voice SDK client identity — unchanged by the stream track hygiene fix'
  );
  check(
    !/track/.test(dialFnBody),
    'dialHouseholdOrFailClosed contains no track-related change — this fix is confined to attachLiveMonitoring\'s <Stream>'
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring stream-track checks passed.');
  }
}

run();
