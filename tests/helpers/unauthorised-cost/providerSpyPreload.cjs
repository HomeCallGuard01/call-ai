// providerSpyPreload.cjs — loaded with `node -r` into the REAL server.js child
// process by tests/unauthorised-cost-adversarial.test.mjs.
//
// 1. Twilio REST spy: every Twilio REST request (SMS, call fetch/update,
//    number purchase …) is answered locally and logged as one line
//      TWILIO_SPY {"method":"post","uri":"…/Messages.json","to":"…","from":"…"}
//    Nothing reaches api.twilio.com.
// 2. Network guard: any http(s)/fetch request to a non-loopback host is
//    refused and logged as NET_BLOCKED (OpenAI is pointed at a local stand-in
//    via OPENAI_BASE_URL; Supabase at a local fake). No real service is ever
//    contacted, whatever the code under test tries.
'use strict';

const http = require('http');
const https = require('https');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const hostOf = (arg) => {
  try {
    if (typeof arg === 'string') return new URL(arg).hostname;
    if (arg instanceof URL) return arg.hostname;
    if (arg && typeof arg === 'object') return arg.hostname || String(arg.host || '').replace(/:\d+$/, '');
  } catch { /* fallthrough */ }
  return '';
};
for (const mod of [http, https]) {
  for (const fn of ['request', 'get']) {
    const orig = mod[fn];
    mod[fn] = function guarded(...args) {
      const h = hostOf(args[0]);
      if (!LOOPBACK.has(h)) {
        process.stderr.write(`NET_BLOCKED ${JSON.stringify({ host: h, via: fn, stack: String(new Error().stack).split('\n').slice(2, 6).map((x) => x.trim()) })}\n`);
        throw new Error(`network blocked by test preload: ${h}`);
      }
      return orig.apply(this, args);
    };
  }
}
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const target = typeof input === 'string' || input instanceof URL ? String(input) : String((input && input.url) || '');
    // data: URLs are local (openai's FormData feature probe does fetch('data:,')).
    const h = hostOf(target);
    if (!/^data:/i.test(target) && !LOOPBACK.has(h)) {
      process.stderr.write(`NET_BLOCKED ${JSON.stringify({ host: h, via: 'fetch', inputType: input && input.constructor && input.constructor.name, href: input && (input.href || input.url) ? String(input.href || input.url).replace(/\?.*$/, '') : null, stack: String(new Error().stack).split('\n').slice(2, 6).map((x) => x.trim()) })}\n`);
      return Promise.reject(new Error(`network blocked by test preload: ${h}`));
    }
    return origFetch(input, init);
  };
}

const RequestClient = require('twilio/lib/base/RequestClient');
const RC = RequestClient.default || RequestClient;
RC.prototype.request = async function spyRequest(opts) {
  const data = opts.data || {};
  process.stderr.write(`TWILIO_SPY ${JSON.stringify({ method: String(opts.method).toLowerCase(), uri: opts.uri, to: data.To || null, from: data.From || null })}\n`);
  const body = /Messages\.json$/.test(String(opts.uri))
    ? { sid: 'SMspy00000000000000000000000000000', status: 'queued', to: data.To, from: data.From }
    : { sid: 'CAspy00000000000000000000000000000', status: 'in-progress' };
  return { statusCode: 201, body, headers: {} };
};
