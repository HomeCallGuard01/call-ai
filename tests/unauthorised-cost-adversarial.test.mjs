// Unauthorised-cost adversarial verification (2026-10-09, controlled-launch RC).
//
// Question: can an UNAUTHENTICATED party make Home Call Guard spend money
// (OpenAI transcription/classification, Twilio SMS) through /media-stream or
// POST /process on the release candidate?  Production (eb43368) could: its
// mediaStreamHandler trusted householdId/toNumber/protectedNumber from the
// WebSocket "start" customParameters, and its /process had no signature check
// and called gpt-4o-mini.  See docs/launch/2026-10-09-UNAUTHORISED-COST-VERIFICATION.md.
//
// Already covered elsewhere (NOT duplicated here, referenced in the report):
//   tests/voice-surface-security.test.mjs      — unsigned /voice 403, forged stream w/o token, wrong-CallSid, replay, unsigned /process
//   tests/media-stream-auth-and-cost-caps.test.mjs — registry rules, per-household stream/transcription/SMS caps
//   tests/media-stream-concurrent-stream-cap.test.mjs, media-stream-handler-crash-hardening.test.mjs
//   tests/launch-config-safety.test.mjs        — report mode / PROCESS_ROUTE_ENABLED fatal in production
//
// Added here:
//   Part 1 (in-process, real handler + real registry, spy clients): random/
//     non-string/expired tokens, Fortress attach refusal/throw/slow-refusal ⇒
//     zero transcription, malformed/huge frames, recordOutcome household.
//   Part 2 (REAL server.js child process, Fortress SQL on PGlite, Twilio REST
//     replaced by a spy preload, OpenAI pointed at a local counter, all other
//     network blocked): forged/random/foreign/replayed tokens over a real
//     WebSocket, forged destination with a VALID token ⇒ SMS spy recipient,
//     Fortress household hold ⇒ zero transcription, no-start timeout, frame
//     floods, socket cap, /process unsigned/bad-sig/disabled/enabled+refused.
//   Part 3 (units): missing TWILIO_AUTH_TOKEN fails closed; report mode and a
//     missing token are fatal in production launch config.
//
// Every forged case asserts zero OpenAI requests and zero Twilio SMS creations.
// Checks tagged [GAP] document a residual weakness found in the RC; they are
// reported but do not change the exit code (none of them causes spend).
//
// Run with: node tests/unauthorised-cost-adversarial.test.mjs

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
const PRELOAD = path.join(ROOT, 'tests/helpers/unauthorised-cost/providerSpyPreload.cjs');

const { createMediaStreamHandler } = require('../services/liveMonitoring/mediaStreamHandler.js');
const { createStreamAuthRegistry } = require('../services/liveMonitoring/streamAuth.js');
const { createTwilioWebhookGuard } = require('../services/twilioWebhookGuard.js');
const { evaluateLaunchConfig, enforceLaunchConfig } = require('../services/config/launchConfig.js');

let failures = 0;
const results = [];
const gaps = [];
const check = (c, m) => { results.push([c ? 'PASS' : 'FAIL', m]); if (c) console.log(`✓ ${m}`); else { console.error(`✗ FAIL ${m}`); failures++; } };
const gap = (observed, m) => { gaps.push(m); console.log(`${observed ? '⚠ [GAP confirmed]' : '✓ [GAP not reproduced]'} ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n── ${t} ──`);

const SCAM = 'please read me the code from the text we just sent you, do not tell anyone';
const LOUD = Buffer.alloc(160, 0x80).toString('base64');
const QUIET = Buffer.alloc(160, 0xff).toString('base64');
const ATTACKER_MOBILE = '+447700900999';
const ATTACKER_HH = '99999999-9999-4999-8999-999999999999';

// ═════════════════════════════════════════════════════════════════════════
// PART 1 — handler level (real createMediaStreamHandler + real streamAuth)
// ═════════════════════════════════════════════════════════════════════════
section('Part 1: /media-stream handler with real stream-token registry');

function rig({ authorizeStream, usageMeter = null } = {}) {
  const transcriptions = []; const sms = []; const outcomes = []; let closed = 0;
  const h = createMediaStreamHandler({
    transcribeClient: { transcribe: async () => { transcriptions.push(1); return SCAM; } },
    smsClient: { messages: { create: async (p) => { sms.push(p); return { sid: 'SMfake' }; } } },
    fromNumber: '+441615550199',
    sendAlert: async () => true,
    recordOutcome: async (o) => { outcomes.push(o); },
    authorizeStream,
    usageMeter,
  });
  return { h, transcriptions, sms, outcomes, close: () => { closed++; }, closed: () => closed };
}
const startMsg = (sid, callSid, customParameters) => JSON.stringify({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid, customParameters } });
async function speak(h, sid, seconds = 5) {
  for (let i = 0; i < seconds * 50; i++) await h.handleMessage(JSON.stringify({ event: 'media', streamSid: sid, media: { payload: LOUD } }));
  for (let i = 0; i < 60; i++) await h.handleMessage(JSON.stringify({ event: 'media', streamSid: sid, media: { payload: QUIET } }));
  await sleep(30);
}
const forgedParams = { householdId: ATTACKER_HH, toNumber: ATTACKER_MOBILE, protectedNumber: '+441615559999', fromNumber: '+441615559999' };

{
  let clock = 1_000_000;
  const reg = createStreamAuthRegistry({ ttlMs: 60_000, now: () => clock });
  const realToken = reg.issue({ callSid: 'CAreal', householdId: 'hh-real', toNumber: '+447700900123', fromNumber: '+441615550100' });

  const cases = [
    ['H1 no token, attacker customParameters', startMsg('MZh1', 'CAreal', forgedParams)],
    ['H2 random 256-bit token', startMsg('MZh2', 'CAreal', { ...forgedParams, streamToken: require('crypto').randomBytes(32).toString('base64url') })],
    ['H3 token as object (type confusion)', startMsg('MZh3', 'CAreal', { ...forgedParams, streamToken: { $ne: null } })],
    ['H3b token as array', startMsg('MZh3b', 'CAreal', { streamToken: [realToken] })],
    ['H3c callSid as object with real token', JSON.stringify({ event: 'start', streamSid: 'MZh3c', start: { streamSid: 'MZh3c', callSid: { toString: 'CAreal' }, customParameters: { streamToken: realToken } } })],
    ['H4 real token presented for a different CallSid', startMsg('MZh4', 'CAattacker', { ...forgedParams, streamToken: realToken })],
  ];
  for (const [name, msg] of cases) {
    const r = rig({ authorizeStream: reg.authorize });
    await r.h.handleMessage(msg, { closeConnection: r.close });
    await speak(r.h, JSON.parse(msg).start.streamSid);
    check(r.closed() === 1 && r.transcriptions.length === 0 && r.sms.length === 0, `${name} → socket closed, 0 OpenAI, 0 SMS`);
  }
  check(reg._size() === 1, 'H4b failed presentations (wrong CallSid) did not consume or leak the genuine token');

  // Expired token (fake clock).
  const expiring = reg.issue({ callSid: 'CAexp', householdId: 'hh-exp', toNumber: '+447700900123' });
  clock += 60_001;
  {
    const r = rig({ authorizeStream: reg.authorize });
    await r.h.handleMessage(startMsg('MZh5', 'CAexp', { streamToken: expiring }), { closeConnection: r.close });
    await speak(r.h, 'MZh5');
    check(r.closed() === 1 && r.transcriptions.length === 0 && r.sms.length === 0, 'H5 expired token (TTL+1ms) → closed, 0 OpenAI, 0 SMS');
  }

  // Replay after a genuine use (with an always-ok meter so the first use is genuinely monitored).
  const okMeter = { attach: async () => ({ ok: true, periodStart: 'p0', periodEnd: 'p1' }), progress: async () => ({ ok: true }), recordIntervention: async () => {} };
  const tok = reg.issue({ callSid: 'CArep', householdId: 'hh-rep', toNumber: '+447700900123', fromNumber: '+441615550100' });
  {
    const r = rig({ authorizeStream: reg.authorize, usageMeter: okMeter });
    await r.h.handleMessage(startMsg('MZh6a', 'CArep', { streamToken: tok, ...forgedParams }), { closeConnection: r.close });
    await speak(r.h, 'MZh6a', 8);
    await sleep(50);
    check(r.transcriptions.length > 0 && r.closed() === 0, 'H6 control: genuine token + matching CallSid IS monitored (so the zero-spend checks are meaningful)');
    check(r.sms.length >= 1 && r.sms.every((m) => m.to === '+447700900123' && m.from === '+441615550100'), `H6 forged toNumber/protectedNumber ignored: every SMS (${r.sms.length}) went to the server-side destination, none to ${ATTACKER_MOBILE}`);
    await r.h.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZh6a', stop: {} }));
    await sleep(50);
    check(r.outcomes.length === 1 && r.outcomes[0].callSid === 'CArep' && !JSON.stringify(r.outcomes).includes(ATTACKER_HH) && !JSON.stringify(r.outcomes).includes(ATTACKER_MOBILE), 'H6 recorded outcome is keyed to the token\'s CallSid and carries nothing from the forged customParameters');
    const r2 = rig({ authorizeStream: reg.authorize, usageMeter: okMeter });
    await r2.h.handleMessage(startMsg('MZh6b', 'CArep', { streamToken: tok }), { closeConnection: r2.close });
    await speak(r2.h, 'MZh6b');
    check(r2.closed() === 1 && r2.transcriptions.length === 0 && r2.sms.length === 0, 'H7 replay of a used token → closed, 0 OpenAI, 0 SMS');
  }

  // Valid token but the Fortress / 056 attach refuses.
  const refusals = [
    ['containment_monitoring_not_authorized', { attach: async () => ({ ok: false, reason: 'containment_monitoring_not_authorized' }) }],
    ['attach throws (DB down)', { attach: async () => { throw new Error('db down'); } }],
    ['slow refusal (audio arrives while attach pending)', { attach: () => sleep(300).then(() => ({ ok: false, reason: 'no_reservation' })) }],
    ['attach returns null', { attach: async () => null }],
  ];
  for (const [name, m] of refusals) {
    const t = reg.issue({ callSid: `CAf${name.length}`, householdId: 'hh-f', toNumber: '+447700900123', fromNumber: '+441615550100' });
    const r = rig({ authorizeStream: reg.authorize, usageMeter: { ...m, progress: async () => ({ ok: true }), recordIntervention: async () => {} } });
    await r.h.handleMessage(startMsg('MZf', `CAf${name.length}`, { streamToken: t }), { closeConnection: r.close });
    await speak(r.h, 'MZf', 6);
    await sleep(400);
    check(r.transcriptions.length === 0 && r.sms.length === 0 && r.closed() >= 1, `H8 valid token but Fortress/meter refuses (${name}) → 0 OpenAI, 0 SMS, stream closed`);
  }

  // Malformed / hostile frames never throw and never spend.
  {
    const r = rig({ authorizeStream: reg.authorize });
    const deep = '['.repeat(200000) + ']'.repeat(200000);
    const frames = ['null', '[]', '"start"', '42', '{', '{"event":"start"}', '{"event":"start","start":null}', '{"event":"start","start":[]}',
      '{"event":"start","start":{"streamSid":"MZm","callSid":"CAm","customParameters":null}}',
      '{"event":"media","streamSid":"MZm","media":{"payload":"' + LOUD + '"}}', '{"event":"media"}', '{"event":{"x":1}}', '{"__proto__":{"event":"start"}}',
      deep, 'x'.repeat(8 * 1024 * 1024), JSON.stringify({ event: 'media', streamSid: 'MZnone', media: { payload: 'A'.repeat(4 * 1024 * 1024) } })];
    let threw = 0;
    for (const f of frames) { try { await r.h.handleMessage(f, { closeConnection: r.close }); } catch { threw++; } }
    check(threw === 0 && r.transcriptions.length === 0 && r.sms.length === 0, `H9 ${frames.length} malformed/huge/deeply-nested frames → no throw, 0 OpenAI, 0 SMS`);
  }

  // No authoriser wired at all → fail closed even with a "valid-looking" token.
  {
    const r = rig({ authorizeStream: undefined });
    await r.h.handleMessage(startMsg('MZh10', 'CAx', { streamToken: 'anything', ...forgedParams }), { closeConnection: r.close });
    await speak(r.h, 'MZh10');
    check(r.closed() === 1 && r.transcriptions.length === 0 && r.sms.length === 0, 'H10 no authoriser configured → fail closed');
  }
}

// ═════════════════════════════════════════════════════════════════════════
// PART 2 — REAL server.js
// ═════════════════════════════════════════════════════════════════════════
section('Part 2: real server.js (Fortress on PGlite, Twilio REST spy, local OpenAI counter, network blocked)');

const HH_ID = '11111111-2222-4333-8444-555555555555';
const HCG_NUMBER = '+441615550100';
const CUSTOMER_MOBILE = '+447700900123';
const TRUSTED = '+447700900555';
const UNKNOWN = '+447700900777';
const AUTH_TOKEN = 'test_twilio_auth_token_0001';
const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const APP_URL = 'https://hcg.test';
const household = { id: HH_ID, twilio_number: HCG_NUMBER, phone_number: CUSTOMER_MOBILE, email: 'synthetic@example.invalid', voice_client_registered_at: new Date().toISOString(), auth_user_id: null, activation_verified_at: null };

const aiLog = [];
const bridge = await createFortressBridge({
  households: [household],
  entitlements: [{ household_id: HH_ID, source: 'stripe' }],
  profile: { budget: 50, reserve: 5, scope: 'trusted_only', essential: 0.1 },
});
function startFake() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const u = new URL(req.url, 'http://x');
        res.setHeader('content-type', 'application/json');
        if (u.pathname.startsWith('/rest/v1/rpc/')) {
          const r = await bridge.rpc(u.pathname.slice('/rest/v1/rpc/'.length), body);
          res.statusCode = r.status; res.end(r.body); return;
        }
        if (u.pathname.startsWith('/v1/')) { // local OpenAI stand-in: every request here would be paid in production
          aiLog.push(u.pathname);
          if (u.pathname.includes('audio/transcriptions')) { res.end(JSON.stringify({ text: SCAM })); return; }
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'SAFE' }, finish_reason: 'stop' }] }));
          return;
        }
        const table = u.pathname.replace('/rest/v1/', '');
        const single = String(req.headers.accept || '').includes('vnd.pgrst.object');
        let rows = [];
        if (req.method === 'GET') {
          if (table === 'households') rows = [household];
          else if (table === 'contacts') rows = [{ id: 'c1', household_id: HH_ID, name: 'Synthetic', number: TRUSTED }];
          else if (table === 'entitlements') rows = [{ id: 'e1', household_id: HH_ID, status: 'active', entitlement_type: 'paid_subscription', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null }];
        }
        if (single) { if (rows.length) res.end(JSON.stringify(rows[0])); else { res.statusCode = 406; res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows' })); } return; }
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end(JSON.stringify(rows));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function request(port, method, p, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: 'hcg.test', ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function bootServer(fakePort, port, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port),
    SUPABASE_URL: `http://127.0.0.1:${fakePort}`, SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x',
    APP_URL, TWILIO_ACCOUNT_SID: ACCOUNT_SID, TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    OPENAI_API_KEY: 'x', OPENAI_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['-r', PRELOAD, 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    try { await request(port, 'GET', '/health'); return { child, logs: () => out }; } catch { /* not up */ }
  }
  child.kill('SIGKILL');
  throw new Error(`server.js did not start:\n${out.slice(-3000)}`);
}
const form = (params) => new URLSearchParams(params).toString();
async function post(port, p, params, { sign = false, badSig = false, ip } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = badSig ? twilio.getExpectedTwilioSignature('wrong_token', `https://hcg.test${p}`, params) : twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://hcg.test${p}`, params);
  if (ip) headers['x-forwarded-for'] = ip;
  return request(port, 'POST', p, { headers, body: form(params) });
}
let sidSeq = 0;
const callParams = (over = {}) => ({ CallSid: `CA${(++sidSeq).toString(16).padStart(4, '0')}${Math.random().toString(16).slice(2).padEnd(28, '0')}`.slice(0, 34), From: UNKNOWN, To: HCG_NUMBER, AccountSid: ACCOUNT_SID, ...over });
const tokenOf = (twiml) => (twiml.match(/name="streamToken" value="([^"]+)"/) || [])[1];
const smsSpy = (logs) => logs().split('\n').filter((l) => l.startsWith('TWILIO_SPY ')).map((l) => JSON.parse(l.slice(11))).filter((e) => e.method === 'post' && /Messages\.json$/.test(e.uri));
const netBlocked = (logs) => logs().split('\n').filter((l) => l.startsWith('NET_BLOCKED '));

function wsProbe(port, frames, { holdMs = 1500, speakAfterStart = true } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
    const st = { opened: false, closedByServer: false, closeCode: null, closedAtMs: null };
    const t0 = Date.now();
    ws.on('open', () => {
      st.opened = true;
      for (const f of frames) ws.send(typeof f === 'string' || Buffer.isBuffer(f) ? f : JSON.stringify(f));
      const start = frames.find((f) => f && f.event === 'start');
      if (start && speakAfterStart) {
        for (let i = 0; i < 300; i++) ws.send(JSON.stringify({ event: 'media', streamSid: start.streamSid, media: { payload: LOUD } }));
        for (let i = 0; i < 60; i++) ws.send(JSON.stringify({ event: 'media', streamSid: start.streamSid, media: { payload: QUIET } }));
      }
    });
    ws.on('close', (code) => { if (!st.closedByServer) { st.closedByServer = true; st.closeCode = code; st.closedAtMs = Date.now() - t0; } });
    ws.on('error', () => { st.closedByServer = true; });
    setTimeout(() => { const snap = { ...st }; try { ws.terminate(); } catch { /* */ } resolve(snap); }, holdMs);
  });
}
const startFrame = (sid, callSid, customParameters) => ({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid, customParameters } });

const fake = await startFake();
const portA = 40000 + Math.floor(Math.random() * 9000);
const portB = portA + 1;
const A = await bootServer(fake.address().port, portA);
let B = null; let C = null;
try {
  // ── /voice ─────────────────────────────────────────────────────────────
  const v1 = await post(portA, '/voice', callParams());
  check(v1.status === 403 && !tokenOf(v1.text) && !/<Stream/.test(v1.text), 'S1 unsigned /voice → 403, no <Stream>, no stream token issued');
  const v2 = await post(portA, '/voice', callParams(), { sign: true, badSig: true });
  check(v2.status === 403 && !tokenOf(v2.text), 'S1b /voice signed with the wrong auth token → 403, no stream token issued');
  const v3 = await post(portA, '/voice', callParams({ AccountSid: 'AC11111111111111111111111111111111' }), { sign: true });
  check(v3.status !== 200 || !tokenOf(v3.text), `S1c /voice correctly signed but for another Twilio account → no stream token (status ${v3.status})`);

  // ── forged /media-stream (the production vulnerability) ───────────────
  const aiBefore = aiLog.length; const smsBefore = smsSpy(A.logs).length;
  const f1 = await wsProbe(portA, [{ event: 'connected' }, startFrame('MZforged1', 'CAforged1', forgedParams)]);
  check(f1.closedByServer, 'S2 forged start, no token, attacker householdId/toNumber/protectedNumber → server closes socket');
  const f2 = await wsProbe(portA, [startFrame('MZforged2', 'CAforged2', { ...forgedParams, streamToken: require('crypto').randomBytes(32).toString('base64url') })]);
  check(f2.closedByServer, 'S3 forged start with a random token → closed');
  const pReal = callParams();
  const sReal = await post(portA, '/voice', pReal, { sign: true });
  const tReal = tokenOf(sReal.text);
  check(sReal.status === 200 && Boolean(tReal), 'S4 control: a genuinely signed /voice issues a stream token');
  const f3 = await wsProbe(portA, [startFrame('MZforged3', 'CAforged3', { ...forgedParams, streamToken: tReal })]);
  check(f3.closedByServer, 'S4 stolen valid token presented with a different CallSid → closed');
  await sleep(1500);
  check(!/"event":"media_stream_started"[^\n]*MZforged/.test(A.logs()), 'S2–S4 no forged stream ever reached media_stream_started');
  check(aiLog.length === aiBefore && smsSpy(A.logs).length === smsBefore, `S2–S4 forged streams: 0 OpenAI requests (saw ${aiLog.length - aiBefore}), 0 Twilio SMS (saw ${smsSpy(A.logs).length - smsBefore})`);

  // ── valid token, forged destination: SMS recipient must be server-side ─
  const g = await wsProbe(portA, [startFrame('MZgood', pReal.CallSid, { ...forgedParams, streamToken: tReal })], { holdMs: 3500 });
  await sleep(1500);
  const smsAfterGood = smsSpy(A.logs).slice(smsBefore);
  check(!g.closedByServer && aiLog.some((x) => x.includes('audio/transcriptions')), 'S5 control: genuine token + its CallSid is monitored and transcribed');
  check(smsAfterGood.length >= 1, `S5 control: the scam transcript produced a warning SMS through the real guarded path (count ${smsAfterGood.length})`);
  check(smsAfterGood.every((m) => m.to === CUSTOMER_MOBILE && m.from === HCG_NUMBER), `S5 every SMS went to the household's own server-side mobile from its own HCG number; none to attacker ${ATTACKER_MOBILE} (recipients: ${[...new Set(smsAfterGood.map((m) => m.to))].join(',') || 'none'})`);

  const aiBefore2 = aiLog.length; const smsBefore2 = smsSpy(A.logs).length;
  const rp = await wsProbe(portA, [startFrame('MZreplay', pReal.CallSid, { streamToken: tReal })]);
  check(rp.closedByServer, 'S6 replay of the used token on a new socket → closed');

  // ── Fortress refuses monitoring after the token was issued ─────────────
  const pHold = callParams();
  const sHold = await post(portA, '/voice', pHold, { sign: true });
  const tHold = tokenOf(sHold.text);
  await bridge.q("select public.fc_set_household_hold($1, true, 'adversarial test', 'test', 'admin')", [HH_ID]);
  const h1 = await wsProbe(portA, [startFrame('MZhold', pHold.CallSid, { streamToken: tHold })], { holdMs: 3000 });
  await bridge.q("select public.fc_set_household_hold($1, false, 'adversarial test done', 'test', 'admin')", [HH_ID]);
  check(Boolean(tHold) && h1.closedByServer, 'S7 valid token but Fortress household hold refuses monitoring → stream closed');
  check(/monitoring_safety_stop[^\n]*MZhold|MZhold[^\n]*monitoring_safety_stop/.test(A.logs()), 'S7 the refusal is the Fortress/meter safety stop (not an incidental close)');

  // ── no start / fake start / floods ─────────────────────────────────────
  const [idle, fakeStart] = await Promise.all([
    wsProbe(portA, [{ event: 'connected', protocol: 'Call' }], { holdMs: 12500 }),
    wsProbe(portA, ['{"event":"start","start":"not-an-object"}'], { holdMs: 12500 }),
  ]);
  check(idle.closedByServer && idle.closedAtMs >= 9000 && idle.closedAtMs <= 12000, `S8 socket that never sends "start" is closed by the start timeout (closed after ${idle.closedAtMs} ms)`);
  check(fakeStart.closedByServer, `S8b a malformed start (start not an object) is CLOSED by the server (hardened 2026-10-09; closed: ${fakeStart.closedByServer})`);

  const big = 16 * 1024 * 1024;
  const flood = await wsProbe(portA, ['x'.repeat(big), Buffer.alloc(1024 * 1024, 0xff), '['.repeat(100000), { event: 'media', streamSid: 'MZnone', media: { payload: LOUD } }], { holdMs: 2500, speakAfterStart: false });
  const health = await request(portA, 'GET', '/health');
  check(health.status === 200 || health.status === 503, `S9 16 MiB text frame + 1 MiB binary + deep-nesting frame: server still answers /health (status ${health.status})`);
  check(flood.closedByServer, `S9b a 16 MiB frame on an unauthenticated socket is refused (ws maxPayload 64 KiB, hardened 2026-10-09; closed: ${flood.closedByServer})`);

  // Socket cap (maxSockets 400): open 410 idle unauthenticated sockets.
  const sockets = []; const capCloses = [];
  await Promise.all(Array.from({ length: 410 }, () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${portA}/media-stream`);
    sockets.push(ws);
    ws.on('close', (code) => { if (code === 1013) capCloses.push(code); });
    ws.on('open', resolve); ws.on('error', resolve);
    setTimeout(resolve, 5000);
  })));
  await sleep(500);
  check(capCloses.length >= 5, `S10 socket cap: of 410 simultaneous unauthenticated sockets, ${capCloses.length} were refused with 1013 (cap 400)`);
  for (const ws of sockets) { try { ws.terminate(); } catch { /* */ } }
  await sleep(500);
  const healthAfter = await request(portA, 'GET', '/health');
  check(healthAfter.status === 200 || healthAfter.status === 503, 'S10b server healthy after the socket flood');

  await sleep(1000);
  check(aiLog.length === aiBefore2 && smsSpy(A.logs).length === smsBefore2, `S6–S10 forged/refused streams: 0 OpenAI requests (saw ${aiLog.length - aiBefore2}), 0 Twilio SMS (saw ${smsSpy(A.logs).length - smsBefore2})`);

  // ── /process on the default RC config (PROCESS_ROUTE_ENABLED unset) ────
  const aiP = aiLog.length;
  const speech = 'hello this is your bank, please read me the one time passcode';
  const p1 = await post(portA, '/process', { ...callParams(), SpeechResult: speech });
  check(p1.status === 403, `P1 unsigned /process → 403 (got ${p1.status})`);
  const p2 = await post(portA, '/process', { ...callParams(), SpeechResult: speech }, { sign: true, badSig: true });
  check(p2.status === 403, `P2 /process with a bad signature → 403 (got ${p2.status})`);
  const p3 = await post(portA, '/process', { ...callParams(), SpeechResult: speech }, { sign: true });
  check(p3.status === 200 && /<Hangup/.test(p3.text) && !/<Dial|<Stream/.test(p3.text), 'P3 correctly signed /process with PROCESS_ROUTE_ENABLED unset → refused with <Hangup/> (dormant)');
  await sleep(500);
  check(aiLog.length === aiP, `P1–P3 0 OpenAI requests (saw ${aiLog.length - aiP})`);

  check(netBlocked(A.logs).length === 0, `server A attempted no non-loopback network request (blocked: ${netBlocked(A.logs).join(' | ') || 'none'})`);

  // ── /process with PROCESS_ROUTE_ENABLED=true (test env only) ───────────
  B = await bootServer(fake.address().port, portB, { PROCESS_ROUTE_ENABLED: 'true' });
  const aiB = aiLog.length;
  const pb1 = await post(portB, '/process', { ...callParams(), SpeechResult: speech });
  check(pb1.status === 403, 'P4 enabled route, unsigned → 403');
  await bridge.q("select public.fc_set_kill_switch(true, 'adversarial test', 'test')");
  const pb2 = await post(portB, '/process', { ...callParams(), SpeechResult: speech }, { sign: true });
  await sleep(500);
  check(pb2.status === 200 && aiLog.length === aiB, `P5 enabled + signed but Fortress refuses 'ai' (kill switch) → 0 OpenAI requests (status ${pb2.status}, saw ${aiLog.length - aiB})`);
  check(/\/process AI CLASSIFICATION NOT AUTHORISED/.test(B.logs()), 'P5 the refusal is the Fortress authorizeSpend(ai) decision (logged "AI CLASSIFICATION NOT AUTHORISED")');
  await bridge.q("select public.fc_set_kill_switch(false, 'adversarial test done', 'test')");
  const pb3 = await post(portB, '/process', { ...callParams(), SpeechResult: speech }, { sign: true });
  await sleep(500);
  check(pb3.status === 200 && aiLog.filter((x) => x.includes('chat/completions')).length >= 1 && aiLog.length > aiB, 'P6 control: enabled + signed + Fortress allows → the classifier IS called (so P5 is meaningful)');
  check(netBlocked(B.logs).length === 0, 'server B attempted no non-loopback network request');
  B.child.kill('SIGTERM');

  // ── Defence in depth: emergency report mode (test env; FATAL in prod) ──
  C = await bootServer(fake.address().port, portB + 1, { TWILIO_WEBHOOK_AUTH_MODE: 'report', PROCESS_ROUTE_ENABLED: 'true' });
  const aiC = aiLog.length; const smsC = smsSpy(C.logs).length;
  const rv = await post(portB + 1, '/voice', callParams());
  const rTok = tokenOf(rv.text);
  check(!rTok, `R1 report mode: an UNSIGNED /voice that the guard lets through still gets no stream token (status ${rv.status}, <Stream>: ${/<Stream/.test(rv.text)})`);
  if (rTok) {
    await wsProbe(portB + 1, [startFrame('MZrep', 'CAx', { streamToken: rTok })], { holdMs: 2500 });
  }
  const rp1 = await post(portB + 1, '/process', { ...callParams(), SpeechResult: speech });
  await sleep(800);
  check(aiLog.length === aiC, `R2 report mode + PROCESS_ROUTE_ENABLED=true: unsigned /process (status ${rp1.status}) makes 0 OpenAI requests (isSignedTwilioRequest gate)`);
  check(smsSpy(C.logs).length === smsC && netBlocked(C.logs).length === 0, 'R3 report mode: 0 Twilio SMS, no non-loopback network');
} finally {
  A.child.kill('SIGTERM');
  if (B) B.child.kill('SIGTERM');
  if (C) C.child.kill('SIGTERM');
  fake.close();
  await bridge.close();
}

// ═════════════════════════════════════════════════════════════════════════
// PART 3 — fail-closed configuration
// ═════════════════════════════════════════════════════════════════════════
section('Part 3: signature guard and launch configuration');
{
  const params = { CallSid: 'CA1', From: UNKNOWN, To: HCG_NUMBER };
  const sig = twilio.getExpectedTwilioSignature('', 'https://hcg.test/process', params);
  const sig2 = twilio.getExpectedTwilioSignature('some_token', 'https://hcg.test/process', params);
  for (const [label, authToken] of [['undefined', undefined], ['empty string', '']]) {
    const guard = createTwilioWebhookGuard({ authToken, appUrl: APP_URL, log: () => {} });
    for (const s of [sig, sig2]) {
      let status = null; let nextCalled = false;
      const req = { body: params, originalUrl: '/process', path: '/process', get: (h) => (h.toLowerCase() === 'x-twilio-signature' ? s : undefined), socket: { remoteAddress: '203.0.113.1' } };
      const res = { status: (c) => { status = c; return { end: () => {} }; } };
      guard(req, res, () => { nextCalled = true; });
      check(!nextCalled && status === 403, `C1 TWILIO_AUTH_TOKEN ${label}: guard refuses (403) even a signature computed with ${s === sig ? 'an empty key' : 'a guessed key'}`);
    }
  }
  const PROD = { APP_URL: 'https://www.homecallguard.co.uk', SUPABASE_URL: 'https://psbzynxplxfbyrbdidmn.supabase.co', HCG_DEPLOYMENT: 'production', TWILIO_ACCOUNT_SID: ACCOUNT_SID, TWILIO_AUTH_TOKEN: 'x' };
  const fatalIds = (env) => evaluateLaunchConfig(env).fatal.map((f) => f.id);
  check(fatalIds({ ...PROD, TWILIO_WEBHOOK_AUTH_MODE: 'report' }).includes('twilio_webhook_auth_enforced'), 'C2 TWILIO_WEBHOOK_AUTH_MODE=report is FATAL in production launch config');
  check(fatalIds({ ...PROD, TWILIO_WEBHOOK_AUTH_MODE: 'REPORT' }).includes('twilio_webhook_auth_enforced'), 'C2b … case-insensitively');
  check(fatalIds({ ...PROD, HCG_DEPLOYMENT: undefined, TWILIO_WEBHOOK_AUTH_MODE: 'report' }).includes('twilio_webhook_auth_enforced'), 'C2c … also when production is only detected (not declared)');
  check(fatalIds({ ...PROD, TWILIO_AUTH_TOKEN: undefined }).includes('twilio_core'), 'C3 a missing TWILIO_AUTH_TOKEN is FATAL in production');
  check(fatalIds({ ...PROD, PROCESS_ROUTE_ENABLED: 'true' }).includes('process_route_disabled'), 'C4 PROCESS_ROUTE_ENABLED=true is FATAL in production');
  let code = null;
  enforceLaunchConfig({ env: { ...PROD, TWILIO_WEBHOOK_AUTH_MODE: 'report' }, log: () => {}, exit: (c) => { code = c; } });
  check(code === 1, 'C5 enforceLaunchConfig exits(1) for report mode in production');
  gap(evaluateLaunchConfig({ ...PROD, TWILIO_WEBHOOK_AUTH_MODE: 'report', HCG_CONFIG_ACKNOWLEDGE: 'twilio_webhook_auth_enforced' }).fatal.every((f) => f.id !== 'twilio_webhook_auth_enforced'),
    '[GAP] C6 HCG_CONFIG_ACKNOWLEDGE=twilio_webhook_auth_enforced lets production start in report mode (alerted, by design) — see R1–R3 for what unsigned requests can then reach');
}

console.log(`\n${results.filter((r) => r[0] === 'PASS').length} PASS, ${failures} FAIL, ${gaps.length} residual-gap observations.`);
console.log(failures === 0 ? 'All unauthorised-cost checks passed.' : `${failures} check(s) FAILED — see ✗ lines.`);
process.exit(failures === 0 ? 0 : 1);
