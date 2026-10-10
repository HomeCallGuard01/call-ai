// byocProviderPreload.cjs — loaded with `node -r` into the REAL server.js
// child process by tests/byoc-e2e.test.mjs (WS7, 2026-10-11).
//
// Reuses tests/helpers/unauthorised-cost/providerSpyPreload.cjs (network
// guard: any non-loopback request is refused and logged NET_BLOCKED; Twilio
// REST answered locally and logged TWILIO_SPY) and adds ONE thing: a
// provider-truth answer for `GET …/Accounts/<sid>/Calls.json` (the abuse
// layer's countLiveCalls, services/abuse/index.js twilioLiveCallCounter).
//
// Without it the spy answers a list with a single non-list object, the live
// count reads as 0, and verifiedOverLimit() would CLEAR the household
// concurrency leases — the harness would then be testing a provider that
// claims no call is live. Here the test controls provider truth through a
// JSON file (BYOC_SPY_LIVE_CALLS_FILE):
//   { "calls": [ { "accountSid": "AC…", "to": "+44…", "from": "+44…", "status": "ringing" } ] }
// The answer is filtered by the ACCOUNT in the request URI (the REST client
// is bound to TWILIO_ACCOUNT_SID — a call living in another (sub)account is
// invisible to it, exactly as on Twilio), by To/From, and by Status.
// Nothing here talks to a network service.
'use strict';

require('../unauthorised-cost/providerSpyPreload.cjs');

const fs = require('fs');
const RequestClient = require('twilio/lib/base/RequestClient');
const RC = RequestClient.default || RequestClient;
const spyRequest = RC.prototype.request;

function readLiveCalls() {
  const file = process.env.BYOC_SPY_LIVE_CALLS_FILE;
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.calls) ? parsed.calls : [];
  } catch {
    return [];
  }
}

RC.prototype.request = async function byocSpyRequest(opts) {
  const uri = String(opts.uri || '');
  const method = String(opts.method || '').toLowerCase();
  const m = /\/Accounts\/(AC[0-9a-fA-F]{32})\/Calls\.json$/.exec(uri);
  if (method === 'get' && m) {
    const params = opts.params || {};
    const calls = readLiveCalls()
      .filter((c) => c.accountSid === m[1])
      .filter((c) => !params.To || c.to === params.To)
      .filter((c) => !params.From || c.from === params.From)
      .filter((c) => !params.Status || (c.status || 'in-progress') === params.Status)
      .map((c, i) => ({ sid: `CAlive${String(i).padStart(28, '0')}`, account_sid: m[1], to: c.to, from: c.from, status: c.status || 'in-progress', direction: 'inbound' }));
    process.stderr.write(`TWILIO_SPY ${JSON.stringify({ method, uri, to: params.To || null, from: params.From || null, status: params.Status || null, answered: calls.length })}\n`);
    return {
      statusCode: 200,
      body: { calls, meta: { key: 'calls', page: 0, page_size: 50, first_page_url: null, next_page_url: null, previous_page_url: null, url: uri } },
      headers: {},
    };
  }
  return spyRequest.call(this, opts);
};
