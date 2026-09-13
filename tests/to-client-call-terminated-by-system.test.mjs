// server.js's toClientCall() — the shared shaping function behind both
// the web dashboard's /dashboard-data and the mobile app's
// GET /api/v1/me/dashboard "activity" list.
//
// 2026-09-13 fix: a call terminated mid-call by live monitoring (real
// risk detected, e.g. a PIN/credential request) was previously
// indistinguishable, on the wire, from an ordinary all-clear call —
// database/calls.js's recordMonitoringOutcome deliberately never
// rewrites `result` (still "SAFE", the pre-monitoring optimistic value),
// and toClientCall never exposed terminated_by_system at all. This adds
// exactly one additive field; every existing field/semantic is
// unchanged.
//
// Extracted and evaluated as a real, pure function directly from
// server.js — not reimplemented — matching this codebase's established
// convention for testing an internal, unexported server.js function
// (see tests/live-monitoring-stream-track.test.mjs).
//
// Run with: node tests/to-client-call-terminated-by-system.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const fnMatch = serverSrc.match(/function toClientCall\(call\) \{[\s\S]*?\n\}/);
check(Boolean(fnMatch), 'sanity check: toClientCall function body is found in server.js');

const toClientCall = new Function(`${fnMatch ? fnMatch[0] : ''}\nreturn toClientCall;`)();

function run() {
  // --- ordinary SAFE unknown call remains ordinary/all-clear data ---
  {
    const result = toClientCall({
      number: '+447700900123',
      status: 'Unknown',
      result: 'SAFE',
      created_at: '2026-09-13T09:00:00.000Z',
      terminated_by_system: false,
    });
    check(
      result.status === 'Unknown' && result.result === 'SAFE' && result.terminatedBySystem === false,
      'an ordinary SAFE unknown call reports terminatedBySystem: false, all other fields unchanged'
    );
  }

  // --- system-terminated call returns terminatedBySystem: true ---
  {
    const result = toClientCall({
      number: '+447700900199',
      status: 'Unknown',
      result: 'SAFE', // deliberately still "SAFE" — recordMonitoringOutcome never rewrites this
      created_at: '2026-09-13T09:46:00.000Z',
      terminated_by_system: true,
      termination_reason: 'credential_or_otp_request',
    });
    check(
      result.terminatedBySystem === true,
      'a call the system terminated mid-call reports terminatedBySystem: true, even though result is still "SAFE"'
    );
    check(
      result.result === 'SAFE',
      'result itself is never altered by this fix — still exactly what recordMonitoringOutcome left it as'
    );
    check(
      !('termination_reason' in result) && !('terminationReason' in result),
      'termination_reason (the internal signal id) is never exposed to the client — only the boolean fact'
    );
  }

  // --- trusted-contact data remains unchanged ---
  {
    const result = toClientCall({
      number: '+447700900456',
      status: 'Known',
      result: 'SAFE',
      created_at: '2026-09-13T10:00:00.000Z',
      terminated_by_system: false,
    });
    check(
      result.status === 'Known' && result.result === 'SAFE' && result.terminatedBySystem === false,
      'a trusted-contact call is completely unaffected by this fix'
    );
  }

  // --- existing API consumers remain compatible: every previously-existing
  // field is still present with its exact previous name/value, for both a
  // terminated and a non-terminated row ---
  {
    const inputs = [
      { number: '+447700900001', status: 'Unknown', result: 'SCAM', created_at: '2026-09-13T11:00:00.000Z', terminated_by_system: false },
      { number: '+447700900002', status: 'Unknown', result: 'SAFE', created_at: '2026-09-13T12:00:00.000Z', terminated_by_system: true },
    ];
    for (const input of inputs) {
      const result = toClientCall(input);
      check(
        result.number === input.number && result.status === input.status && result.result === input.result && result.time === input.created_at,
        `existing fields (number/status/result/time) are byte-for-byte unchanged for input ${JSON.stringify(input)}`
      );
    }
  }

  // --- historic rows where terminated_by_system is missing/undefined never crash ---
  {
    const result = toClientCall({
      number: '+447700900321',
      status: 'Unknown',
      result: 'SAFE',
      created_at: '2026-09-01T09:00:00.000Z',
      // terminated_by_system intentionally omitted — a row predating this column's introduction
    });
    check(
      result.terminatedBySystem === false,
      'a historic row with terminated_by_system missing/undefined normalises to terminatedBySystem: false, never null/undefined/a crash'
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll toClientCall terminatedBySystem checks passed.');
  }
}

run();
