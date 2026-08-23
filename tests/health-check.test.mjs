// Unit tests for services/healthCheck.js — proves the exact behaviour
// the /health endpoint depends on: a slow (not down) Supabase call must
// never make the check itself take longer than the bound, and a genuine
// error is reported distinctly from a timeout, without ever throwing.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkSupabaseHealth } = require('../services/healthCheck.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function fakeSupabaseClient(behavior) {
  return {
    from() {
      return {
        select() {
          return {
            limit() {
              return behavior();
            },
          };
        },
      };
    },
  };
}

async function run() {
  // --- healthy, fast response ---
  {
    const client = fakeSupabaseClient(() => Promise.resolve({ error: null }));
    const result = await checkSupabaseHealth(client, 2000);
    check(result === 'ok', 'a fast, error-free query reports "ok"');
  }

  // --- genuine Supabase error, still fast ---
  {
    const client = fakeSupabaseClient(() => Promise.resolve({ error: { message: 'connection refused' } }));
    const result = await checkSupabaseHealth(client, 2000);
    check(result === 'error', 'a query that resolves with an error reports "error"');
  }

  // --- query throws synchronously/rejects ---
  {
    const client = fakeSupabaseClient(() => Promise.reject(new Error('network error')));
    const result = await checkSupabaseHealth(client, 2000);
    check(result === 'error', 'a rejected query reports "error", not an uncaught rejection');
  }

  // --- slow dependency: must resolve at the timeout bound, never hang ---
  {
    const start = Date.now();
    const client = fakeSupabaseClient(() => new Promise(() => {})); // never resolves
    const result = await checkSupabaseHealth(client, 200);
    const elapsed = Date.now() - start;
    check(result === 'timeout', 'a dependency that never responds reports "timeout", not "error" or "ok"');
    check(elapsed < 500, `the check itself bails out at the bound (took ${elapsed}ms for a 200ms timeout), never hangs waiting on the slow dependency`);
  }

  // --- a genuinely broken client (throws building the query) never throws out ---
  {
    const brokenClient = { from() { throw new Error('client misconfigured'); } };
    let threw = false;
    let result;
    try {
      result = await checkSupabaseHealth(brokenClient, 2000);
    } catch {
      threw = true;
    }
    check(threw === false, 'a client that throws while building the query is caught, not propagated');
    check(result === 'error', 'and still reports "error" rather than silently resolving ok');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
