// Unit tests for services/alerting.js — the minimal critical-alert
// emailer added 2026-08-23. Covers exactly the contract that matters:
// fail-open (never throws, never blocks the caller), rate-limiting/dedup
// so one outage doesn't send hundreds of emails, and that the payload
// sent never contains anything obviously sensitive.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sendCriticalAlert, _resetForTests } = require('../services/alerting.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function fakePost(calls) {
  return async (payload) => {
    calls.push(payload);
    return true;
  };
}

async function run() {
  // --- basic send ---
  {
    _resetForTests();
    const calls = [];
    const result = await sendCriticalAlert('test_type_a', 'Something broke', { householdId: 'h-1' }, { post: fakePost(calls) });
    check(result === true, 'a fresh alert type sends successfully');
    check(calls.length === 1, 'exactly one post() call was made');
    check(calls[0].subject.includes('test_type_a'), 'subject includes the alert type');
    check(calls[0].text.includes('Something broke'), 'body includes the message');
    check(calls[0].text.includes('h-1'), 'body includes the passed context');
  }

  // --- rate limiting / dedup ---
  {
    _resetForTests();
    const calls = [];
    await sendCriticalAlert('test_type_b', 'first', {}, { post: fakePost(calls) });
    await sendCriticalAlert('test_type_b', 'second (same type, immediately after)', {}, { post: fakePost(calls) });
    await sendCriticalAlert('test_type_b', 'third (same type, immediately after)', {}, { post: fakePost(calls) });
    check(calls.length === 1, 'three rapid alerts of the same type only send one email');
  }

  // --- different types are independent ---
  {
    _resetForTests();
    const calls = [];
    await sendCriticalAlert('test_type_c', 'c', {}, { post: fakePost(calls) });
    await sendCriticalAlert('test_type_d', 'd', {}, { post: fakePost(calls) });
    check(calls.length === 2, 'two different alert types both send — dedup is per-type, not global');
  }

  // --- fail-open: post() rejecting must never throw ---
  {
    _resetForTests();
    const throwingPost = async () => { throw new Error('Resend is down'); };
    let threw = false;
    try {
      await sendCriticalAlert('test_type_e', 'e', {}, { post: throwingPost });
    } catch {
      threw = true;
    }
    check(threw === false, 'a post() that throws is swallowed — sendCriticalAlert never throws');
  }

  // --- fail-open: no API key configured must never throw (real postToResend path) ---
  {
    _resetForTests();
    const originalKey = process.env.Resend_API_Key;
    delete process.env.Resend_API_Key;
    let threw = false;
    let result;
    try {
      result = await sendCriticalAlert('test_type_f', 'f', {});
    } catch {
      threw = true;
    } finally {
      if (originalKey !== undefined) process.env.Resend_API_Key = originalKey;
    }
    check(threw === false, 'missing Resend_API_Key never throws (real code path, not injected)');
    check(result === false, 'missing Resend_API_Key resolves false rather than pretending success');
  }

  // --- payload never includes anything the caller didn't explicitly pass ---
  {
    _resetForTests();
    const calls = [];
    await sendCriticalAlert('test_type_g', 'g', { householdId: 'h-2', callSid: 'CA123' }, { post: fakePost(calls) });
    check(!calls[0].text.includes('password'), 'alert body never contains the literal word "password"');
    check(!calls[0].text.includes('api_key') && !calls[0].text.includes('apiKey'), 'alert body never contains an api key field');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
