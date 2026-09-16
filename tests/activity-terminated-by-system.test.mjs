// describeActivity (app/(tabs)/index.tsx, Home Recent Activity) and
// describeOutcome (app/(tabs)/activity.tsx, full Activity tab) —
// 2026-09-13 fix: a call live monitoring terminated mid-call for
// detected risk (e.g. a PIN/credential request) previously displayed as
// an ordinary all-clear call, because result stays "SAFE" (see backend's
// database/calls.js recordMonitoringOutcome, which deliberately never
// rewrites it) and neither function knew about terminatedBySystem at
// all.
//
// Both functions are plain, self-contained TypeScript (no React Native/
// JSX inside the function bodies themselves) extracted directly from the
// real .tsx source and evaluated after stripping only the two TS type
// annotations on each signature — the type annotations have zero runtime
// effect (TypeScript erases them at compile time in the real app too),
// so this executes the exact real branching logic, not a reimplementation.
//
// Run with: node tests/activity-terminated-by-system.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function extractFunction(source, signatureRegex) {
  const startMatch = source.match(signatureRegex);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const bodyStart = startIdx + startMatch[0].length;
  // Find the matching closing brace by simple depth counting from bodyStart.
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  return source.slice(startIdx, i);
}

function stripTypeAnnotations(fnSource) {
  return fnSource
    .replace(/item: DashboardActivityItem/, 'item')
    .replace(/: \{ label: string; isWarning: boolean \}/, '')
    .replace(/: \{ text: string; tone: "neutral" \| "positive" \| "warning" \}/, '');
}

function run() {
  // --- Home Recent Activity: describeActivity ---
  const indexSrc = readFileSync(path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'index.tsx'), 'utf8');
  const describeActivityRaw = extractFunction(indexSrc, /function describeActivity\(item: DashboardActivityItem\): \{ label: string; isWarning: boolean \} \{/);
  check(Boolean(describeActivityRaw), 'sanity check: describeActivity is found in app/(tabs)/index.tsx');
  const describeActivity = describeActivityRaw
    ? new Function(`${stripTypeAnnotations(describeActivityRaw)}\nreturn describeActivity;`)()
    : null;

  // --- Full Activity tab: describeOutcome ---
  const activitySrc = readFileSync(path.join(__dirname, '..', 'mobile', 'app', '(tabs)', 'activity.tsx'), 'utf8');
  const describeOutcomeRaw = extractFunction(activitySrc, /function describeOutcome\(item: DashboardActivityItem\): \{ text: string; tone: "neutral" \| "positive" \| "warning" \} \{/);
  check(Boolean(describeOutcomeRaw), 'sanity check: describeOutcome is found in app/(tabs)/activity.tsx');
  const describeOutcome = describeOutcomeRaw
    ? new Function(`${stripTypeAnnotations(describeOutcomeRaw)}\nreturn describeOutcome;`)()
    : null;

  const trusted = { number: '+447700900000', status: 'Known', result: 'SAFE', time: '2026-09-13T09:00:00.000Z', terminatedBySystem: false };
  const safeUnknown = { number: '+447700900001', status: 'Unknown', result: 'SAFE', time: '2026-09-13T09:10:00.000Z', terminatedBySystem: false };
  const scamButNotTerminated = { number: '+447700900002', status: 'Unknown', result: 'SCAM', time: '2026-09-13T09:20:00.000Z', terminatedBySystem: false };
  const terminated = { number: '+447700900003', status: 'Unknown', result: 'SAFE', time: '2026-09-13T09:46:00.000Z', terminatedBySystem: true };
  const terminatedHistoricUndefined = { number: '+447700900004', status: 'Unknown', result: 'SAFE', time: '2026-08-01T09:00:00.000Z' }; // terminatedBySystem omitted entirely

  // --- Home: describeActivity ---
  if (describeActivity) {
    check(describeActivity(trusted).label === 'Trusted contact called' && describeActivity(trusted).isWarning === false, 'Home: trusted contact keeps its existing wording');
    check(describeActivity(safeUnknown).label === 'Checked an unknown caller — all clear' && describeActivity(safeUnknown).isWarning === false, 'Home: unknown safe call → "Checked an unknown caller — all clear"');
    check(describeActivity(scamButNotTerminated).label === 'Blocked a suspected scam call' && describeActivity(scamButNotTerminated).isWarning === true, 'Home: existing result === "SCAM" behaviour still applies when not terminated');
    check(describeActivity(terminated).label === 'High risk — call stopped' && describeActivity(terminated).isWarning === true, 'Home: an actual HCG system termination → "High risk — call stopped"');
    check(
      describeActivity({ ...terminated, result: 'SAFE' }).label === 'High risk — call stopped',
      'Home: result=SAFE + terminatedBySystem=true still displays "High risk — call stopped" (the exact real-world shape of a terminated call)'
    );
    check(
      describeActivity(terminatedHistoricUndefined).label === 'Checked an unknown caller — all clear',
      'Home: a historic row with terminatedBySystem missing/undefined falls through to existing all-clear behaviour, never crashes'
    );
  }

  // --- Activity tab: describeOutcome ---
  if (describeOutcome) {
    check(describeOutcome(trusted).text === 'Rang straight through' && describeOutcome(trusted).tone === 'neutral', 'Activity tab: trusted contact keeps its existing wording');
    check(describeOutcome(safeUnknown).text === 'Screened, no concerns' && describeOutcome(safeUnknown).tone === 'positive', 'Activity tab: unknown safe call keeps its existing wording');
    check(describeOutcome(scamButNotTerminated).text === 'Screened — high risk, call ended' && describeOutcome(scamButNotTerminated).tone === 'warning', 'Activity tab: existing result === "SCAM" behaviour still applies when not terminated');
    check(describeOutcome(terminated).text === 'High risk — call stopped' && describeOutcome(terminated).tone === 'warning', 'Activity tab: an actual HCG system termination → "High risk — call stopped", consistent with the Home screen\'s wording');
    check(
      describeOutcome({ ...terminated, result: 'SAFE' }).text === 'High risk — call stopped',
      'Activity tab: result=SAFE + terminatedBySystem=true still displays "High risk — call stopped"'
    );
    check(
      describeOutcome(terminatedHistoricUndefined).text === 'Screened, no concerns',
      'Activity tab: a historic row with terminatedBySystem missing/undefined falls through to existing behaviour, never crashes'
    );
  }

  // --- both screens must represent the SAME terminated call consistently ---
  if (describeActivity && describeOutcome) {
    check(
      describeActivity(terminated).label === describeOutcome(terminated).text,
      'Home and the Activity tab display identical wording for the same system-terminated call'
    );
  }

  // --- no detection keywords, PIN phrase, risk rules, or internal
  // termination details are ever exposed in either function's source ---
  check(
    !/PIN|pin_request|credential_or_otp|termination_reason|terminationReason|isolation_from|urgency_or_threat/i.test(describeActivityRaw || ''),
    'describeActivity source never references a detection signal id, keyword, or internal termination-reason field'
  );
  check(
    !/PIN|pin_request|credential_or_otp|termination_reason|terminationReason|isolation_from|urgency_or_threat/i.test(describeOutcomeRaw || ''),
    'describeOutcome source never references a detection signal id, keyword, or internal termination-reason field'
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll activity terminatedBySystem checks passed.');
  }
}

run();
