// harness.mjs — Level 2 end-to-end harness for Magrathea → Twilio BYOC
// inbound calls (WS7, 2026-10-11).
//
// Boots the REAL server.js in a child process, exactly like
// tests/unauthorised-cost-adversarial.test.mjs Part 2 and
// tests/telephony-abuse-attacks.test.mjs:
//   * Supabase → a local fake. Table GETs are answered from in-memory
//     fixtures (households / contacts / entitlements, filtered the way
//     PostgREST would filter them); every POST /rest/v1/rpc/<fn> runs the
//     REAL SQL (056 admission + Financial Fortress ledger) on PGlite through
//     tests/helpers/pgliteRestBridge.mjs.
//   * OpenAI → the same fake (/v1/*), counted.
//   * Twilio REST → answered locally (byocProviderPreload.cjs), with a
//     test-controlled "live calls" provider truth per account.
//   * Every other network request is refused by the preload (NET_BLOCKED).
// No real service, call, SMS, AI request or number purchase can happen.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFortressBridge } from '../pgliteRestBridge.mjs';

const require = createRequire(import.meta.url);
const twilio = require('twilio');
const WebSocket = require('ws');

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PRELOAD = path.join(ROOT, 'tests/helpers/byoc/byocProviderPreload.cjs');
export const APP_URL = 'https://hcg.test';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SCAM_TRANSCRIPT = 'please read me the code from the text we just sent you, do not tell anyone';
export const LOUD = Buffer.alloc(160, 0x80).toString('base64');
export const QUIET = Buffer.alloc(160, 0xff).toString('base64');

function decode(v) { try { return decodeURIComponent(v); } catch { return v; } }

/** PostgREST-ish filter for the fixtures the server reads on the /voice path. */
function filterRows(rows, search) {
  const sp = new URLSearchParams(search);
  let out = rows;
  for (const [key, raw] of sp.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const v = decode(raw);
    if (v.startsWith('eq.')) { const want = v.slice(3); out = out.filter((r) => String(r[key]) === want); }
    else if (v.startsWith('in.(') && v.endsWith(')')) {
      const set = new Set(v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')));
      out = out.filter((r) => r[key] != null && set.has(String(r[key])));
    } else if (v === 'not.is.null') out = out.filter((r) => r[key] != null);
    else if (v === 'is.null') out = out.filter((r) => r[key] == null);
  }
  return out;
}

/**
 * @param {object} o
 * @param {Array} o.households   fixture rows (id, twilio_number, phone_number, …)
 * @param {Array} o.contacts     fixture rows (id, household_id, name, number)
 * @param {Array} o.entitlements household ids given an active stripe entitlement
 * @param {object} o.profile     pinned Fortress budget profile (pgliteRestBridge)
 */
export async function createByocWorld({ households, contacts = [], entitledHouseholdIds = null, profile = { budget: 50, reserve: 5, scope: 'trusted_only', essential: 0.1 } }) {
  const entitled = entitledHouseholdIds || households.map((h) => h.id);
  const bridge = await createFortressBridge({
    households,
    entitlements: entitled.map((id) => ({ household_id: id, source: 'stripe' })),
    profile,
  });
  const entitlementRows = entitled.map((id, i) => ({ id: `e${i}`, household_id: id, status: 'active', entitlement_type: 'paid_subscription', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null }));
  const aiLog = [];
  const tableReads = [];

  const fake = await new Promise((resolve) => {
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
        if (u.pathname.startsWith('/v1/')) { // local OpenAI stand-in: each request here would be paid in production
          aiLog.push(u.pathname);
          if (u.pathname.includes('audio/transcriptions')) { res.end(JSON.stringify({ text: SCAM_TRANSCRIPT })); return; }
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'SAFE' }, finish_reason: 'stop' }] }));
          return;
        }
        const table = u.pathname.replace('/rest/v1/', '');
        const single = String(req.headers.accept || '').includes('vnd.pgrst.object');
        let rows = [];
        if (req.method === 'GET') {
          tableReads.push({ table, search: u.search });
          if (table === 'households') rows = filterRows(households, u.search);
          else if (table === 'contacts') rows = filterRows(contacts, u.search);
          else if (table === 'entitlements') rows = filterRows(entitlementRows, u.search);
        }
        if (single) { if (rows.length) res.end(JSON.stringify(rows[0])); else { res.statusCode = 406; res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows' })); } return; }
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end(JSON.stringify(rows));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });

  const liveCallsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hcg-byoc-e2e-')), 'live-calls.json');
  const setProviderLiveCalls = (calls) => fs.writeFileSync(liveCallsFile, JSON.stringify({ calls }));
  setProviderLiveCalls([]);

  return {
    bridge,
    q: bridge.q,
    aiLog,
    tableReads,
    fakePort: fake.address().port,
    liveCallsFile,
    setProviderLiveCalls,
    async close() { fake.close(); await bridge.close(); },
  };
}

export function request(port, method, p, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: 'hcg.test', ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}

/**
 * Boot the real server.js. `accountEnv` carries the Twilio account config
 * under test (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_BYOC_*).
 */
export async function bootServer(world, accountEnv, extraEnv = {}) {
  const port = 43000 + Math.floor(Math.random() * 9000);
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port),
    SUPABASE_URL: `http://127.0.0.1:${world.fakePort}`, SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x',
    APP_URL,
    OPENAI_API_KEY: 'x', OPENAI_BASE_URL: `http://127.0.0.1:${world.fakePort}/v1`,
    BYOC_SPY_LIVE_CALLS_FILE: world.liveCallsFile,
    // No STRIPE_SECRET_KEY, no email key: nothing billable/emailable is configured.
    ...accountEnv,
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['-r', PRELOAD, 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    try { await request(port, 'GET', '/health'); return { port, child, logs: () => out, stop: () => child.kill('SIGKILL') }; } catch { /* not up */ }
  }
  child.kill('SIGKILL');
  throw new Error(`server.js did not start:\n${out.slice(-3000)}`);
}

export const form = (params) => new URLSearchParams(params).toString();

/** POST a Twilio webhook signed with `token` (null → unsigned) exactly as Twilio signs it. */
export function postSigned(port, p, params, token) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (token) headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(token, `${APP_URL}${p}`, params);
  return request(port, 'POST', p, { headers, body: form(params) });
}

// ── TwiML predicates (same semantics as the sibling harnesses) ───────────
export const isReject = (t) => /<Reject\b/.test(t) && !/<Dial|<Say|<Stream|<Play/.test(t);
export const connectsTo = (t, hh) => new RegExp(`<Client>household_${hh.id}</Client>`).test(t);
export const monitored = (t) => /<Start><Stream /.test(t);
export const announced = (t) => /<Say\b|<Play\b/.test(t);
export const noPstn = (t) => !/<Number|<Sip|<Conference|<Queue|<Enqueue|<Refer|<Sim/.test(t);
export const timeLimit = (t) => { const m = /<Dial[^>]*timeLimit="(\d+)"/.exec(t); return m ? Number(m[1]) : null; };
export const streamTokenOf = (t) => (t.match(/name="streamToken" value="([^"]+)"/) || [])[1];

// ── WebSocket media-stream probe ─────────────────────────────────────────
export const startFrame = (streamSid, callSid, customParameters) => ({ event: 'start', streamSid, start: { streamSid, callSid, customParameters } });
export function wsProbe(port, frames, { holdMs = 1500, speakAfterStart = true } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
    const st = { opened: false, closedByServer: false, closeCode: null };
    ws.on('open', () => {
      st.opened = true;
      for (const f of frames) ws.send(typeof f === 'string' ? f : JSON.stringify(f));
      const start = frames.find((f) => f && f.event === 'start');
      if (start && speakAfterStart) {
        for (let i = 0; i < 300; i++) ws.send(JSON.stringify({ event: 'media', streamSid: start.streamSid, media: { payload: LOUD } }));
        for (let i = 0; i < 60; i++) ws.send(JSON.stringify({ event: 'media', streamSid: start.streamSid, media: { payload: QUIET } }));
      }
    });
    ws.on('close', (code) => { if (!st.closedByServer) { st.closedByServer = true; st.closeCode = code; } });
    ws.on('error', () => { st.closedByServer = true; });
    setTimeout(() => { const snap = { ...st }; try { ws.terminate(); } catch { /* */ } resolve(snap); }, holdMs);
  });
}

// ── Result accounting: strict checks + the WS6 expected-fail section ─────
//
// check()       — part of today's contract; a failure fails the run.
// expectWs6()   — depends on not-yet-merged WS6 BYOC code. By default the
//                 outcome is REPORTED (PASS-TODAY / EXPECTED-FAIL) and never
//                 changes the exit code. With BYOC_E2E_STRICT=1 it is a
//                 normal strict check (run this after merging ws6).
export function createReporter({ strict = process.env.BYOC_E2E_STRICT === '1' } = {}) {
  const results = [];
  let failures = 0;
  const check = (c, m) => {
    results.push({ kind: 'core', pass: Boolean(c), m });
    if (c) console.log(`✓ ${m}`); else { console.error(`✗ FAIL ${m}`); failures++; }
  };
  const expectWs6 = (id, c, m) => {
    results.push({ kind: 'ws6', id, pass: Boolean(c), m });
    if (strict) {
      if (c) console.log(`✓ [${id}] ${m}`); else { console.error(`✗ FAIL [${id}] ${m}`); failures++; }
    } else if (c) console.log(`✓ [${id} PASS-TODAY] ${m}`);
    else console.log(`○ [${id} EXPECTED-FAIL-UNTIL-WS6] ${m}`);
  };
  const section = (t) => console.log(`\n── ${t} ──`);
  const summary = () => {
    const core = results.filter((r) => r.kind === 'core');
    const ws6 = results.filter((r) => r.kind === 'ws6');
    console.log(`\nCore: ${core.filter((r) => r.pass).length}/${core.length} passed.`);
    console.log(`WS6 contract (${strict ? 'STRICT' : 'report-only'}): ${ws6.filter((r) => r.pass).length}/${ws6.length} pass today.`);
    for (const r of ws6) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.m}`);
    return { failures, core, ws6, strict };
  };
  return { check, expectWs6, section, summary, get failures() { return failures; } };
}
