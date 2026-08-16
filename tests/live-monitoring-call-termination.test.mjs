// Unit tests for services/liveMonitoring/callTermination.js — the
// bounded, 3-attempt red-line termination sequence added 2026-08-15.
// Uses a fake Twilio REST client only; never a real API call.
//
// Run with: node tests/live-monitoring-call-termination.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { terminateCall } = require('../services/liveMonitoring/callTermination.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// scriptedOutcomes: array of 'succeed' | 'fail', one per .update() call,
// in order. Records every call made for inspection.
function makeFakeTwilioClient(scriptedOutcomes) {
  const madeCalls = [];
  let i = 0;
  return {
    calls: (sid) => ({
      update: async (params) => {
        const outcome = scriptedOutcomes[i] ?? 'succeed';
        i += 1;
        madeCalls.push({ sid, params });
        if (outcome === 'fail') throw new Error(`simulated Twilio failure (attempt ${i})`);
        return { sid };
      },
    }),
    getCalls: () => madeCalls,
  };
}

async function run() {
  // --- attempt 1 succeeds: exactly one REST call, graceful redirect ---
  {
    const client = makeFakeTwilioClient(['succeed']);
    const result = await terminateCall({ client, callSid: 'CA1', redirectUrl: 'https://example.test/red-line-terminate', reason: 'isolation_from_bank' });

    check(result.terminated === true, 'attempt 1 success: terminated is true');
    check(result.method === 'redirect', 'attempt 1 success: method is "redirect"');
    check(result.attempts === 1, 'attempt 1 success: exactly 1 attempt recorded');
    check(client.getCalls().length === 1, 'attempt 1 success: exactly one REST call was made, no retry attempted');
    check(client.getCalls()[0].params.url === 'https://example.test/red-line-terminate', 'the redirect targets the correct TwiML URL');
  }

  // --- attempt 1 fails, attempt 2 (retry) succeeds ---
  {
    const client = makeFakeTwilioClient(['fail', 'succeed']);
    const result = await terminateCall({ client, callSid: 'CA2', redirectUrl: 'https://example.test/red-line-terminate', reason: 'isolation_from_bank' });

    check(result.terminated === true, 'attempt 2 success: terminated is true');
    check(result.method === 'redirect', 'attempt 2 success: method is still "redirect" (same request retried)');
    check(result.attempts === 2, 'attempt 2 success: exactly 2 attempts recorded');
    check(client.getCalls().length === 2, 'attempt 2 success: exactly two REST calls were made — one retry, not more');
  }

  // --- both redirect attempts fail, forced-complete fallback succeeds ---
  {
    const client = makeFakeTwilioClient(['fail', 'fail', 'succeed']);
    const result = await terminateCall({ client, callSid: 'CA3', redirectUrl: 'https://example.test/red-line-terminate', reason: 'financial_redirection' });

    check(result.terminated === true, 'forced-complete fallback: terminated is true');
    check(result.method === 'forced_complete', 'forced-complete fallback: method is "forced_complete", a different primitive from the retry');
    check(result.attempts === 3, 'forced-complete fallback: exactly 3 attempts recorded');
    check(client.getCalls().length === 3, 'forced-complete fallback: exactly three REST calls total');
    check(client.getCalls()[2].params.status === 'completed', 'the third attempt uses status:completed, not another redirect');
  }

  // --- all three attempts fail: bounded, never throws, never loops ---
  {
    const client = makeFakeTwilioClient(['fail', 'fail', 'fail']);
    let threw = false;
    let result;
    try {
      result = await terminateCall({ client, callSid: 'CA4', redirectUrl: 'https://example.test/red-line-terminate', reason: 'credential_or_otp_request' });
    } catch (err) {
      threw = true;
    }

    check(threw === false, 'all three attempts failing never throws');
    check(result.terminated === false, 'all three attempts failing: terminated is false');
    check(result.attempts === 3, 'all three attempts failing: exactly 3 attempts recorded, not a 4th or a retry loop');
    check(client.getCalls().length === 3, 'all three attempts failing: exactly three REST calls total — bounded, no uncontrolled retry');
    check(typeof result.error === 'string', 'the final failure reason is reported');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll live-monitoring call-termination checks passed.');
  }
}

run();
