// Telephony abuse P0 — black-box adversarial attacks against the REAL
// server.js (2026-10-03).
//
// Same harness discipline as tests/voice-surface-security.test.mjs: the
// real server.js boots in a child process against a local fake Supabase.
// NO Twilio REST credentials (TWILIO_ACCOUNT_SID unset → no REST client),
// NO real OpenAI key, NO email key — no real call, SMS, AI request, number
// purchase or email can happen. Webhooks are signed exactly as Twilio
// signs them, with a test auth token. All numbers are Ofcom drama-range or
// otherwise synthetic.
//
// Run with: node tests/telephony-abuse-attacks.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const twilio = require('twilio');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const results = [];
const check = (c, m) => { results.push([c, m]); if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTH_TOKEN = 'test_twilio_auth_token_abuse';
const APP_URL = 'https://hcg.test';

// Six synthetic households, each with its own HCG (Twilio) number.
const households = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  twilio_number: `+44161555020${i}`,
  phone_number: `+44770090020${i}`,
  email: `synthetic-${k}@example.invalid`,
  voice_client_registered_at: new Date().toISOString(),
  auth_user_id: null,
  activation_verified_at: null,
}));
const [HA, HB, HC, HD, HE, HF, HG] = households;
const TRUSTED_UK = '+447700900555';
const contacts = [
  { id: 'c1', household_id: HA.id, name: 'Synthetic UK (legacy 10-digit row)', number: '7700900555' },
  { id: 'c2', household_id: HA.id, name: 'Synthetic premium-rate', number: '9098790123' },
  { id: 'c3', household_id: HA.id, name: 'Synthetic abroad', number: '+33612345678' },
];

function startFakeSupabase() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        res.setHeader('content-type', 'application/json');
        if (u.pathname.startsWith('/v1/')) { res.end(JSON.stringify({ text: '' })); return; }
        const table = u.pathname.replace('/rest/v1/', '');
        const single = String(req.headers.accept || '').includes('vnd.pgrst.object');
        let rows = [];
        if (req.method === 'GET') {
          if (table === 'households') rows = households;
          else if (table === 'contacts') {
            const hh = /household_id=eq\.([^&]+)/.exec(u.search);
            rows = hh ? contacts.filter((c) => c.household_id === decodeURIComponent(hh[1])) : contacts;
          } else if (table === 'entitlements') rows = [{ id: 'e1', household_id: HA.id, status: 'active', entitlement_type: 'paid_subscription', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null }];
        }
        if (single) {
          if (rows.length) res.end(JSON.stringify(rows[0])); else { res.statusCode = 406; res.end(JSON.stringify({ code: 'PGRST116' })); }
          return;
        }
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

async function bootServer(supabasePort, port, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port),
    SUPABASE_URL: `http://127.0.0.1:${supabasePort}`, SUPABASE_ANON_KEY: 'anon-test', SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    APP_URL, TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    OPENAI_API_KEY: 'sk-test-local-stub', OPENAI_BASE_URL: `http://127.0.0.1:${supabasePort}/v1`,
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { await request(port, 'GET', '/health'); return { child, logs: () => out }; } catch { /* not up */ }
  }
  throw new Error(`server.js did not start:\n${out.slice(-2000)}`);
}

const form = (params) => new URLSearchParams(params).toString();
function post(port, p, params, { sign = true } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `https://hcg.test${p}`, params);
  return request(port, 'POST', p, { headers, body: form(params) });
}
let sidCounter = 0;
const sid = () => `CA${(++sidCounter).toString(16).padStart(8, '0')}${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}${'0'.repeat(16)}`;
const call = (port, over) => post(port, '/voice', { CallSid: sid(), From: '+447700900777', To: HA.twilio_number, AccountSid: 'ACtest', Direction: 'inbound', ...over });
const ended = (port, callSid) => post(port, '/call-delivery-failed', { CallSid: callSid, DialCallStatus: 'completed', DialCallDuration: '5', AccountSid: 'ACtest' });

const isReject = (t) => /<Reject\s*\/>/.test(t) && !/<Dial|<Say|<Stream/.test(t);
const connectsToOwnClient = (t, hh) => new RegExp(`<Client>household_${hh.id}</Client>`).test(t);
const monitored = (t) => /<Stream /.test(t);
const noPstn = (t) => !/<Number|<Sip|<Conference|<Queue|<Enqueue|<Refer|<Sim/.test(t);

async function callAndEnd(port, over) {
  const params = { CallSid: sid(), From: '+447700900777', To: HA.twilio_number, AccountSid: 'ACtest', Direction: 'inbound', ...over };
  const r = await post(port, '/voice', params);
  if (!isReject(r.text)) await ended(port, params.CallSid);
  return r;
}

const supa = await startFakeSupabase();
const port = 41000 + Math.floor(Math.random() * 8000);
const { child, logs } = await bootServer(supa.address().port, port);
const allTwiml = [];
const track = (r) => { allTwiml.push(r.text); return r; };

try {
  // ── Trusted-contact bypass cannot be abused ──────────────────────────
  const t1 = track(await callAndEnd(port, { From: TRUSTED_UK }));
  check(connectsToOwnClient(t1.text, HA) && !monitored(t1.text) && noPstn(t1.text), 'trusted contact (legacy 10-digit row) still gets the bypass: own-household Client only, unmonitored, no PSTN leg');

  const t2 = track(await callAndEnd(port, { From: '+449098790123' }));
  check(connectsToOwnClient(t2.text, HA) && noPstn(t2.text), 'premium-rate number marked trusted: HCG creates NO leg to it (only the household\'s own Client)');
  check(monitored(t2.text), 'premium-rate "trusted" CLI does not get the monitoring bypass (caller_class_not_trustable)');

  const t3 = track(await callAndEnd(port, { From: '+337700900555' }));
  check(monitored(t3.text) && connectsToOwnClient(t3.text, HA), 'international caller sharing the last 10 digits of a UK trusted contact is NOT trusted (old last-10 collision closed) — monitored, still delivered');

  const t4 = track(await callAndEnd(port, { From: '+33612345678' }));
  check(!monitored(t4.text) && connectsToOwnClient(t4.text, HA) && noPstn(t4.text), 'international trusted contact stored as E.164 is trusted (identity match only), and is never dialled');

  const t5 = track(await callAndEnd(port, { From: TRUSTED_UK, StirVerstat: 'TN-Validation-Failed-B' }));
  check(monitored(t5.text) && connectsToOwnClient(t5.text, HA), 'spoofed trusted CLI with failed STIR verification: bypass suspended → monitored, still delivered');

  const spoofRuns = [];
  for (let i = 0; i < 6; i++) spoofRuns.push(track(await callAndEnd(port, { From: '+447700900555' })));
  // Two earlier calls (t1, t5) from this CLI are already in the 5-minute
  // window, so these are calls 3..8: the bypass holds while the window
  // count is ≤ 4 (ABUSE_TRUSTED_BYPASS_BURST) and is suspended from call 5.
  check(spoofRuns.slice(0, 2).every((r) => !monitored(r.text)) && spoofRuns.slice(2).every((r) => monitored(r.text) && connectsToOwnClient(r.text, HA)), 'repeated calls presenting a trusted CLI: bypass suspended after the burst threshold (monitored, still delivered)');

  // ── Loops ─────────────────────────────────────────────────────────────
  check(isReject(track(await call(port, { From: HA.twilio_number, To: HA.twilio_number })).text), 'self-forward loop (From == To == HCG number) → unbilled <Reject>');
  check(isReject(track(await call(port, { From: HB.twilio_number, To: HA.twilio_number })).text), 'two-number loop (HCG number B calling HCG number A) → <Reject>');
  check(isReject(track(await call(port, { From: '0161 555 0202'.replace(/^0/, '+44').replace(/ /g, ''), To: HA.twilio_number })).text), 'multi-household loop (another household\'s HCG number as caller, normalisation variant) → <Reject>');
  check(isReject(track(await call(port, { From: '+447700900888', ForwardedFrom: HB.twilio_number, To: HA.twilio_number })).text), 'carrier-visible redirect from an HCG number (ForwardedFrom) → <Reject>');
  check(isReject(track(await call(port, { From: '+447700900889', ParentCallSid: 'CA' + 'f'.repeat(32) })).text), 'call carrying a ParentCallSid (created by our own account) → <Reject> (hop limit 0)');

  // ── Unknown / malformed ──────────────────────────────────────────────
  const noHh = track(await call(port, { To: '+441615559999' }));
  check(isReject(noHh.text), 'call to a number owned by no household → unbilled <Reject> (was a billed <Say>)');
  const mal = track(await callAndEnd(port, { From: '+44+7700900123' }));
  check(connectsToOwnClient(mal.text, HA) && monitored(mal.text), 'malformed caller E.164: still delivered (could be a real caller), never trusted, monitored');

  // ── 100 rapid calls, same caller → one household ─────────────────────
  const rapid = [];
  for (let i = 0; i < 100; i++) rapid.push(track(await callAndEnd(port, { From: '+447700900301', To: HB.twilio_number })));
  const connected = rapid.filter((r) => !isReject(r.text)).length;
  check(connected === 8 && rapid.slice(8).every((r) => isReject(r.text)), `100 rapid calls from one caller: first 8 delivered, remaining 92 refused unbilled (delivered ${connected})`);
  const otherCaller = track(await callAndEnd(port, { From: '+447700900302', To: HB.twilio_number }));
  check(connectsToOwnClient(otherCaller.text, HB), 'victim not locked out: a different caller to the same household is still delivered during the flood cooldown');

  // ── Same caller attacking many households ────────────────────────────
  const fan = [];
  for (const hh of [HA, HB, HC, HD, HE, HF]) fan.push(track(await callAndEnd(port, { From: '+447700900401', To: hh.twilio_number })));
  check(fan.slice(0, 5).every((r) => !isReject(r.text)) && isReject(fan[5].text), 'same caller reaching a 6th household in the window is refused (fan-out limit 5)');
  check(isReject(track(await call(port, { From: '+447700900401', To: HA.twilio_number })).text), 'fan-out caller stays refused across ALL households for the cooldown');
  check(connectsToOwnClient(track(await callAndEnd(port, { From: '+447700900402', To: HF.twilio_number })).text, HF), 'other callers to those households are unaffected by the fan-out cooldown');

  // ── Many callers attacking one household (no lockout) ────────────────
  const many = [];
  for (let i = 0; i < 30; i++) many.push(track(await callAndEnd(port, { From: `+4477009005${String(i).padStart(2, '0')}`, To: HC.twilio_number })));
  check(many.every((r) => connectsToOwnClient(r.text, HC)), '30 distinct callers flooding one household: every call is still delivered (no victim lockout)');
  check(/household_elevated_volume/.test(logs()), 'the flood is detected and audited as household_elevated_volume');

  // ── Concurrency ──────────────────────────────────────────────────────
  const open = [];
  for (let i = 0; i < 3; i++) open.push(track(await call(port, { From: `+4477009006${i}0`, To: HD.twilio_number })));
  const fourth = track(await call(port, { From: '+447700900699', To: HD.twilio_number }));
  check(open.every((r) => connectsToOwnClient(r.text, HD)) && isReject(fourth.text), '4th simultaneous call to one household → <Reject> (engaged-line equivalent; no provider to verify in this harness)');

  // ── Webhook abuse ────────────────────────────────────────────────────
  const unsigned = await post(port, '/voice', { CallSid: sid(), From: '+447700900777', To: HE.twilio_number, AccountSid: 'ACtest' }, { sign: false });
  check(unsigned.status === 403, 'forged (unsigned) /voice → 403 (Security P0 guard reused)');
  const replayParams = { CallSid: sid(), From: '+447700900778', To: HG.twilio_number, AccountSid: 'ACtest' };
  const first = track(await post(port, '/voice', replayParams));
  const replay = await post(port, '/voice', replayParams);
  check(first.status === 200 && replay.text === first.text, 'replayed signed /voice gets the identical cached TwiML (no second stream token, no second count)');
  check(/webhook_duplicate/.test(logs()), 'the replay is audited as webhook_duplicate');
  const dupCb1 = await ended(port, replayParams.CallSid);
  const dupCb2 = await ended(port, replayParams.CallSid);
  check(dupCb1.status === 200 && dupCb2.status === 200 && dupCb2.text === dupCb1.text, 'duplicate provider callback is answered identically and its side effects are skipped');
  const pollutedBody = 'CallSid=' + sid() + '&From=%2B447700900779&From=%2B447700900780&To=' + encodeURIComponent(HG.twilio_number) + '&AccountSid=ACtest';
  const pollutedSig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, 'https://hcg.test/voice', Object.fromEntries(new URLSearchParams(pollutedBody)));
  const polluted = await request(port, 'POST', '/voice', { headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': pollutedSig }, body: pollutedBody });
  check(polluted.status === 400 || polluted.status === 403, `parameter pollution (duplicate From) is refused before routing (status ${polluted.status})`);
  const badSid = await post(port, '/voice', { CallSid: 'not-a-sid', From: '+447700900781', To: HG.twilio_number, AccountSid: 'ACtest' });
  check(badSid.status === 400, 'malformed CallSid is refused (400)');
  const huge = await post(port, '/voice', { CallSid: sid(), From: '+447700900782', To: HG.twilio_number, AccountSid: 'ACtest', Junk: 'x'.repeat(5000) });
  check(huge.status === 413, 'oversized parameter value is refused (413)');

  // ── Egress invariant across every response in this run ───────────────
  check(allTwiml.every(noPstn), `no response in this run contained a PSTN/SIP/conference leg (${allTwiml.length} responses)`);
  const auditLines = logs().split('\n').filter((l) => l.startsWith('ABUSE DECISION'));
  check(auditLines.length > 0 && auditLines.every((l) => !/\+447700900\d{3}"/.test(l) && /"correlationId":"/.test(l) && /"reasonCode":"/.test(l)), `audit records carry reasonCode + correlationId and never a full caller number (${auditLines.length} records)`);
} finally {
  child.kill();
}

// ── Global incident mode (separate boots) ──────────────────────────────
for (const [level, expectDelivered, expectMonitored] of [['contain', true, true], ['suspend_paid', true, false], ['full_stop', false, false]]) {
  const p2 = 41000 + Math.floor(Math.random() * 8000);
  const s2 = await bootServer(supa.address().port, p2, { HCG_INCIDENT_MODE: level });
  try {
    const r = await post(p2, '/voice', { CallSid: sid(), From: '+447700900901', To: HA.twilio_number, AccountSid: 'ACtest' });
    const delivered = connectsToOwnClient(r.text, HA);
    check(delivered === expectDelivered && monitored(r.text) === expectMonitored && (expectDelivered || isReject(r.text)),
      `HCG_INCIDENT_MODE=${level}: delivered=${expectDelivered}, new paid monitoring=${expectMonitored}${expectDelivered ? '' : ' (<Reject>, unbilled)'}`);
  } finally {
    s2.child.kill();
  }
}

supa.close();
console.log(`\n${failures === 0 ? 'All telephony-abuse attack checks passed' : `${failures} telephony-abuse attack check(s) FAILED`} (${results.length} checks)`);
process.exitCode = failures === 0 ? 0 : 1;
