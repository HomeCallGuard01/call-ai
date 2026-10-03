// P0 voice-surface security regression test (2026-10-01).
//
// Black-box: boots the REAL server.js in a child process against a local
// fake Supabase (records every request). NO Twilio REST credentials, NO
// OpenAI key and NO email key are set, so no real call, SMS, AI request or
// email can happen. Signed requests are signed exactly as Twilio does
// (twilio.getExpectedTwilioSignature) with a test auth token.
//
// It asserts the SECURE behaviour, so it FAILS against the pre-fix code
// (recorded in docs/security/VOICE_SURFACE_P0_REMEDIATION.md) and passes
// once the remediation is in place.
//
// Run with: node tests/voice-surface-security.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFortressBridge } from './helpers/pgliteRestBridge.mjs';

const require = createRequire(import.meta.url);
const twilio = require('twilio');
const WebSocket = require('ws');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake data (synthetic, not real people) ───────────────────────────────
const HH_ID = '11111111-2222-4333-8444-555555555555';
const HCG_NUMBER = '+441615550100';
const CUSTOMER_MOBILE = '+447700900123';
const TRUSTED = '+447700900555';
const UNKNOWN = '+447700900777';
const AUTH_TOKEN = 'test_twilio_auth_token_0001';
const APP_URL = 'https://hcg.test';
const ALT_HOST = 'www.hcg.test';

const household = {
  id: HH_ID, twilio_number: HCG_NUMBER, phone_number: CUSTOMER_MOBILE, email: 'synthetic@example.invalid',
  voice_client_registered_at: new Date().toISOString(), auth_user_id: null, activation_verified_at: null,
};

// ── Fake Supabase (PostgREST subset) ─────────────────────────────────────
const dbLog = [];
const aiLog = [];
// Integration 2026-10-03: RPCs run the real 056 + Financial Fortress SQL on
// PGlite (tests/helpers/pgliteRestBridge.mjs) with a pinned test budget, so
// a signed call is authorised by the real financial authority.
const bridge = await createFortressBridge({
  households: [household],
  entitlements: [{ household_id: HH_ID, source: 'stripe' }],
  profile: { budget: 50, reserve: 5, scope: 'trusted_only', essential: 0.1 },
});
function startFakeSupabase() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname.startsWith('/rest/v1/rpc/')) {
          dbLog.push({ method: req.method, table: u.pathname.replace('/rest/v1/', ''), query: u.search });
          const r = await bridge.rpc(u.pathname.slice('/rest/v1/rpc/'.length), body);
          res.setHeader('content-type', 'application/json');
          res.statusCode = r.status; res.end(r.body); return;
        }
        if (u.pathname.startsWith('/v1/')) {
          // Local OpenAI stand-in: counts every attempted (paid) AI call.
          aiLog.push(u.pathname);
          res.setHeader('content-type', 'application/json');
          if (u.pathname.includes('audio/transcriptions')) { res.end(JSON.stringify({ text: 'this is your bank, please read me the code' })); return; }
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'SAFE' }, finish_reason: 'stop' }] }));
          return;
        }
        const table = u.pathname.replace('/rest/v1/', '');
        dbLog.push({ method: req.method, table, query: u.search });
        const single = String(req.headers.accept || '').includes('vnd.pgrst.object');
        let rows = [];
        if (req.method === 'GET') {
          if (table === 'households') rows = [household];
          else if (table === 'contacts') rows = [{ id: 'c1', household_id: HH_ID, name: 'Synthetic', number: TRUSTED }];
          else if (table === 'entitlements') rows = [{ id: 'e1', household_id: HH_ID, status: 'active', entitlement_type: 'paid_subscription', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null }];
        }
        res.setHeader('content-type', 'application/json');
        if (single) {
          if (rows.length) { res.end(JSON.stringify(rows[0])); } else { res.statusCode = 406; res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows' })); }
          return;
        }
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end(JSON.stringify(rows));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ── Boot server.js ───────────────────────────────────────────────────────
async function bootServer(supabasePort, port) {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    PORT: String(port),
    SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
    SUPABASE_ANON_KEY: 'anon-test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    APP_URL,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_WEBHOOK_ALLOWED_HOSTS: ALT_HOST,
    OPENAI_API_KEY: 'sk-test-local-stub',
    OPENAI_BASE_URL: `http://127.0.0.1:${supabasePort}/v1`,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { await request(port, 'GET', '/health'); return { child, logs: () => out }; } catch { /* not up yet */ }
  }
  throw new Error(`server.js did not start:\n${out.slice(-2000)}`);
}

const form = (params) => new URLSearchParams(params).toString();
// http.request (not fetch) so the Host header can be set: server.js redirects
// localhost-addressed requests to APP_URL.
function request(port, method, p, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: 'hcg.test', ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function post(port, p, params, { sign = false, host = 'hcg.test', badSig = false, ip } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = badSig ? 'AAAA' : twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://${host}${p}`, params);
  if (ip) headers['x-forwarded-for'] = ip;
  return request(port, 'POST', p, { headers, body: form(params) });
}
const callParams = (over = {}) => ({ CallSid: `CA${Math.random().toString(16).slice(2).padEnd(32, '0')}`, From: UNKNOWN, To: HCG_NUMBER, AccountSid: 'ACtest', ...over });
const dbSince = (n) => dbLog.slice(n);
const writes = (entries) => entries.filter((e) => e.method !== 'GET');

function wsProbe(port, startMessage, { holdMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
    let closedByServer = false; let opened = false;
    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ event: 'connected', protocol: 'Call' }));
      ws.send(JSON.stringify(startMessage));
      // ~5 s of loud µ-law audio then ~1.2 s of silence: enough for the
      // speech segmenter (≥ 3 s segments) to emit a transcription request.
      const loud = Buffer.alloc(160, 0x80).toString('base64');
      const quiet = Buffer.alloc(160, 0xff).toString('base64');
      for (let i = 0; i < 250; i++) ws.send(JSON.stringify({ event: 'media', streamSid: startMessage.streamSid, media: { payload: loud } }));
      for (let i = 0; i < 60; i++) ws.send(JSON.stringify({ event: 'media', streamSid: startMessage.streamSid, media: { payload: quiet } }));
    });
    ws.on('close', () => { closedByServer = true; });
    ws.on('error', () => { closedByServer = true; });
    setTimeout(() => { const state = { opened, closedByServer }; try { ws.close(); } catch { /* */ } resolve(state); }, holdMs);
  });
}

// ── Run ──────────────────────────────────────────────────────────────────
const supa = await startFakeSupabase();
const port = 40000 + Math.floor(Math.random() * 10000);
const { child, logs } = await bootServer(supa.address().port, port);

try {
  // 1. /voice unsigned: no data, no DB, no call flow.
  let mark = dbLog.length;
  const u1 = await post(port, '/voice', callParams());
  check(u1.status === 403, `unsigned /voice is refused with 403 (got ${u1.status})`);
  check(!u1.text.includes(CUSTOMER_MOBILE) && !u1.text.includes(HH_ID), 'unsigned /voice response contains no customer mobile number or household id');
  check(dbSince(mark).length === 0, `unsigned /voice performs no database access (saw ${dbSince(mark).length})`);
  check(!/<Dial|<Stream|<Client/.test(u1.text), 'unsigned /voice does not progress into the call flow (no Dial/Stream/Client TwiML)');

  // 2. Trusted-contact oracle.
  const uTrusted = await post(port, '/voice', callParams({ From: TRUSTED }));
  const uUnknown = await post(port, '/voice', callParams({ From: UNKNOWN }));
  check(uTrusted.status === uUnknown.status && uTrusted.text === uUnknown.text, 'unsigned /voice responses are identical for a trusted and an unknown caller (no contact-list oracle)');

  // 3. Wrong signature, and signature for a host not on the allowlist.
  const bad = await post(port, '/voice', callParams(), { sign: true, badSig: true });
  check(bad.status === 403, 'a /voice request with an invalid signature is refused');
  const evil = await post(port, '/voice', callParams(), { sign: true, host: 'evil.example' });
  check(evil.status === 403, 'a signature computed for a non-allowlisted host is refused');

  // 4. Genuine signed call still works (canonical and allowlisted alternate host).
  const p4 = callParams();
  const s4 = await post(port, '/voice', p4, { sign: true });
  check(s4.status === 200 && /<Dial/.test(s4.text) && /<Client>/.test(s4.text), 'a genuinely signed /voice for an unknown caller is delivered (Dial/Client)');
  check(/<Stream/.test(s4.text) && /name="streamToken"/.test(s4.text), 'the signed /voice attaches monitoring with a server-issued stream token');
  check(!s4.text.includes(CUSTOMER_MOBILE), 'the /voice TwiML no longer carries the customer\'s mobile number in stream parameters');
  const s4alt = await post(port, '/voice', callParams(), { sign: true, host: ALT_HOST });
  check(s4alt.status === 200 && /<Dial/.test(s4alt.text), 'a request signed for an allowlisted alternate host (e.g. www/apex) is accepted');
  const sTrusted = await post(port, '/voice', callParams({ From: TRUSTED }), { sign: true });
  check(sTrusted.status === 200 && /<Dial/.test(sTrusted.text) && !/<Stream/.test(sTrusted.text), 'a signed trusted-contact call is delivered without monitoring');

  // 5. Client-originated request (TwiML App pointed at /voice) cannot impersonate an inbound call.
  const sClient = await post(port, '/voice', callParams({ From: 'client:household_x', To: HCG_NUMBER }), { sign: true });
  check(sClient.status === 200 && /<Reject/.test(sClient.text) && !/<Dial|<Stream/.test(sClient.text), 'a signed client:-originated /voice request is rejected (no paid monitoring, no ring)');

  // 6. Dial action callbacks.
  await sleep(400); // let fire-and-forget writes from earlier signed requests land first
  mark = dbLog.length;
  const cdf = await post(port, '/call-delivery-failed', { CallSid: p4.CallSid, DialCallStatus: 'completed', DialCallDuration: '999' });
  check(cdf.status === 403 && writes(dbSince(mark)).length === 0, 'unsigned /call-delivery-failed is refused and writes nothing (no fake delivery verification)');
  await sleep(400); // let fire-and-forget writes from earlier signed requests land first
  mark = dbLog.length;
  const cs = await post(port, '/call-status', { CallSid: p4.CallSid, DialCallStatus: 'completed', DialCallDuration: '999' });
  check(cs.status === 403 && writes(dbSince(mark)).length === 0, 'unsigned /call-status is refused and writes nothing');
  const cdfSigned = await post(port, '/call-delivery-failed', { CallSid: p4.CallSid, DialCallStatus: 'completed', DialCallDuration: '12' }, { sign: true });
  check(cdfSigned.status === 200 && /<Hangup/.test(cdfSigned.text), 'a signed /call-delivery-failed is still handled');

  // 7. Legacy /process.
  await sleep(400); // let fire-and-forget writes from earlier signed requests land first
  mark = dbLog.length;
  const aiBefore = aiLog.length;
  const pr = await post(port, '/process', { ...callParams(), SpeechResult: 'hello this is your bank calling about your account' });
  check(pr.status === 403 && dbSince(mark).length === 0, 'unsigned /process is refused before any database work');
  check(aiLog.length === aiBefore, `unsigned /process makes no AI call (saw ${aiLog.length - aiBefore})`);

  // 8. /red-line-terminate (Twilio-fetched TwiML) also requires a signature.
  const rl = await post(port, '/red-line-terminate', { CallSid: p4.CallSid });
  check(rl.status === 403, 'unsigned /red-line-terminate is refused');

  // 9. /media-stream: a forged stream never starts monitoring.
  const aiBeforeForged = aiLog.length;
  const forged = await wsProbe(port, { event: 'start', streamSid: 'MZforged', start: { streamSid: 'MZforged', callSid: 'CAforged', customParameters: { householdId: HH_ID, toNumber: '+447700900999', protectedNumber: HCG_NUMBER } } });
  check(forged.closedByServer, 'a forged /media-stream start (no stream token) is closed by the server');
  check(!/"event":"media_stream_started"[^\n]*"streamSid":"MZforged"/.test(logs()), 'a forged stream never reaches media_stream_started (no monitor, transcription or SMS path)');
  await sleep(1500);
  check(aiLog.length === aiBeforeForged, `a forged stream causes no transcription request (saw ${aiLog.length - aiBeforeForged})`);

  // 10. A genuine token works once, only for its own call.
  const tokenOf = (twiml) => (twiml.match(/name="streamToken" value="([^"]+)"/) || [])[1];
  const p10 = callParams();
  const s10 = await post(port, '/voice', p10, { sign: true });
  const tok = tokenOf(s10.text);
  const wrongCall = await wsProbe(port, { event: 'start', streamSid: 'MZwrong', start: { streamSid: 'MZwrong', callSid: 'CAsomeoneelse', customParameters: { streamToken: tok } } });
  check(wrongCall.closedByServer, 'a valid token presented for a different CallSid is refused');
  const good = await wsProbe(port, { event: 'start', streamSid: 'MZgood', start: { streamSid: 'MZgood', callSid: p10.CallSid, customParameters: { streamToken: tok, toNumber: '+447700900999' } } });
  check(!good.closedByServer && /"event":"media_stream_started"[^\n]*"streamSid":"MZgood"/.test(logs()), 'the genuine stream (token + matching CallSid) starts monitoring');
  check(aiLog.some((x) => x.includes('audio/transcriptions')), 'control: an authorised stream does reach transcription (so the no-AI checks above are meaningful)');
  const replay = await wsProbe(port, { event: 'start', streamSid: 'MZreplay', start: { streamSid: 'MZreplay', callSid: p10.CallSid, customParameters: { streamToken: tok } } });
  check(replay.closedByServer, 'replaying a used stream token is refused');

  // 11. Repeated forged requests from one source are throttled cheaply.
  let throttled = 0;
  for (let i = 0; i < 40; i++) { const r = await post(port, '/voice', callParams(), { ip: '198.51.100.7' }); if (r.status === 429) throttled++; }
  check(throttled > 0, `repeated signature failures from one IP are throttled (429 seen ${throttled}×)`);

  // 12. Rejections never log request bodies.
  check(!logs().includes(CUSTOMER_MOBILE) && !logs().includes('+447700900999'), 'no customer or attacker-supplied phone number appears in server logs');
} finally {
  child.kill('SIGTERM');
  supa.close();
  await bridge.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
