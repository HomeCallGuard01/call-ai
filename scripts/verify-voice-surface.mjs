// Verifies the voice-surface P0 remediation against a DEPLOYED service.
//
//   MODE=production  (default) — sends ONLY unsigned / forged traffic. Safe
//                    post-deployment smoke test: nothing it sends can pass
//                    the guard, create data or cost money.
//   MODE=staging     — additionally sends correctly signed synthetic Twilio
//                    requests (needs TWILIO_AUTH_TOKEN) and drives real
//                    WebSocket streams, checking database effects in the
//                    STAGING Supabase project and the staging server log.
//
// Env: TARGET_URL (https://host), MODE, TEST_NUMBER (an HCG number routed to
// the target), and for staging: TWILIO_AUTH_TOKEN, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (staging only — refused otherwise), HOUSEHOLD_ID,
// TRUSTED_FROM, SERVER_LOG (path to the staging server log).
// Run: node scripts/verify-voice-surface.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const twilio = require('twilio');
const WebSocket = require('ws');

const TARGET = String(process.env.TARGET_URL || '').replace(/\/$/, '');
const MODE = process.env.MODE || 'production';
const TO = process.env.TEST_NUMBER;
const STAGING = MODE === 'staging';
if (!TARGET || !TO) { console.error('TARGET_URL and TEST_NUMBER are required'); process.exit(2); }
if (STAGING && !/tigwgmayeuisrxjjykqd/.test(process.env.SUPABASE_URL || '')) { console.error('REFUSED: staging mode requires the STAGING Supabase project'); process.exit(2); }

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = new URL(TARGET).host;
const sid = (p = 'CA') => `${p}${[...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;
const log = () => (process.env.SERVER_LOG ? readFileSync(process.env.SERVER_LOG, 'utf8') : '');

async function post(path, params, { sign = false, signHost = host, badSig = false } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'ngrok-skip-browser-warning': '1' };
  if (sign) headers['x-twilio-signature'] = badSig ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' : twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, `https://${signHost}${path}`, params);
  const r = await fetch(`${TARGET}${path}`, { method: 'POST', headers, body: new URLSearchParams(params).toString(), redirect: 'manual' });
  return { status: r.status, text: await r.text() };
}

function ws(startMessage, { holdMs = 1500, frames = 0, sendStart = true } = {}) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`${TARGET.replace(/^https/, 'wss')}/media-stream`, { headers: { 'ngrok-skip-browser-warning': '1' } });
    let closed = false; let opened = false; let closedAt = null; const t0 = Date.now();
    sock.on('open', () => {
      opened = true;
      if (!sendStart) return;
      sock.send(JSON.stringify({ event: 'connected', protocol: 'Call' }));
      sock.send(JSON.stringify(startMessage));
      const loud = Buffer.alloc(160, 0x80).toString('base64');
      for (let i = 0; i < frames; i++) sock.send(JSON.stringify({ event: 'media', streamSid: startMessage.streamSid, media: { payload: loud } }));
    });
    sock.on('close', () => { if (!closed) { closed = true; closedAt = Date.now() - t0; } });
    sock.on('error', () => { if (!closed) { closed = true; closedAt = Date.now() - t0; } });
    setTimeout(() => { const s = { opened, closed, closedAt, sock }; resolve(s); }, holdMs);
  });
}
const stopStream = (s, streamSid) => { try { s.sock.send(JSON.stringify({ event: 'stop', streamSid, stop: {} })); s.sock.close(); } catch { /* */ } };

let db = null;
if (STAGING) {
  const { createClient } = require('@supabase/supabase-js');
  db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}
const callRow = async (callSid) => (db ? (await db.from('calls').select('call_sid, household_id, status, dial_call_status, duration_seconds').eq('call_sid', callSid).maybeSingle()).data : null);
const PII = ['+447700900456'];

// ── Unsigned / forged (both modes) ───────────────────────────────────────
const unsignedSid = sid();
const u = await post('/voice', { CallSid: unsignedSid, From: '+447700900777', To: TO, AccountSid: 'ACforged' });
check(u.status === 403, `unsigned /voice → 403 (got ${u.status})`);
check(u.text === '' && !/<Dial|<Stream|<Client|household_/.test(u.text), 'unsigned /voice returns an empty body (no TwiML, no identifiers)');
const uTrusted = await post('/voice', { CallSid: sid(), From: process.env.TRUSTED_FROM || '+447700900555', To: TO });
check(uTrusted.status === u.status && uTrusted.text === u.text, 'unsigned /voice response is identical for a trusted and an unknown caller');
for (const p of ['/process', '/call-delivery-failed', '/call-status', '/red-line-terminate']) {
  const r = await post(p, { CallSid: unsignedSid, From: '+447700900777', To: TO, SpeechResult: 'please read me the code we just sent you', DialCallStatus: 'completed', DialCallDuration: '999' });
  check(r.status === 403 && r.text === '', `unsigned ${p} → 403, empty body`);
}
const forged = await ws({ event: 'start', streamSid: 'MZforged0001', start: { streamSid: 'MZforged0001', callSid: 'CAforged0001', customParameters: { householdId: process.env.HOUSEHOLD_ID || 'x', toNumber: '+447700900999', protectedNumber: TO } } }, { frames: 100 });
check(forged.closed, 'forged /media-stream start (no token) is closed by the server');

if (STAGING) {
  await sleep(800);
  check(!(await callRow(unsignedSid)), 'no calls row was created for the unsigned /voice CallSid');
  const L0 = log();
  check(/media_stream_unauthorised_start[^\n]*MZforged0001/.test(L0) && !/media_stream_started[^\n]*MZforged0001/.test(L0), 'server log: forged stream rejected, never started');

  // Invalid signature / non-allowlisted host.
  check((await post('/voice', { CallSid: sid(), From: '+447700900777', To: TO }, { sign: true, badSig: true })).status === 403, 'invalid signature → 403');
  check((await post('/voice', { CallSid: sid(), From: '+447700900777', To: TO }, { sign: true, signHost: 'evil.example' })).status === 403, 'signature for a non-allowlisted host → 403');

  // Genuine signed flows.
  const unknownSid = sid();
  const s1 = await post('/voice', { CallSid: unknownSid, From: '+447700900777', To: TO, AccountSid: 'ACstaging' }, { sign: true });
  check(s1.status === 200 && /<Dial/.test(s1.text) && /<Client>household_/.test(s1.text), 'signed unknown-caller /voice → Dial/Client');
  check(/<Stream[^>]*>/.test(s1.text) && /name="streamToken"/.test(s1.text), 'signed unknown-caller /voice → monitoring stream with a server-issued token');
  check(!PII.some((p) => s1.text.includes(p)) && !/name="(toNumber|householdId|protectedNumber)"/.test(s1.text), 'TwiML carries no customer mobile number / household / destination parameters');
  await sleep(800);
  const row1 = await callRow(unknownSid);
  check(row1 && row1.status === 'Unknown' && row1.household_id === process.env.HOUSEHOLD_ID, 'signed call logged once, against the right household');
  const trustedSid = sid();
  const s2 = await post('/voice', { CallSid: trustedSid, From: process.env.TRUSTED_FROM, To: TO }, { sign: true });
  check(s2.status === 200 && /<Dial/.test(s2.text) && !/<Stream/.test(s2.text), 'signed trusted-contact /voice → delivered, no monitoring');
  const s3 = await post('/voice', { CallSid: sid(), From: 'client:household_x', To: TO }, { sign: true });
  check(s3.status === 200 && /<Reject/.test(s3.text) && !/<Dial|<Stream/.test(s3.text), 'signed client:-originated /voice → Reject');

  // Callbacks: forged ones changed nothing; signed one is handled.
  await post('/call-delivery-failed', { CallSid: unknownSid, DialCallStatus: 'completed', DialCallDuration: '999' });
  await sleep(600);
  const row2 = await callRow(unknownSid);
  check(row2 && row2.dial_call_status == null && !row2.duration_seconds, 'a forged /call-delivery-failed did not change the call row');
  const cb = await post('/call-delivery-failed', { CallSid: unknownSid, DialCallStatus: 'no-answer', DialCallDuration: '0' }, { sign: true });
  check(cb.status === 200 && /<Hangup/.test(cb.text), 'signed /call-delivery-failed → handled (Hangup)');
  await sleep(600);
  check((await callRow(unknownSid))?.dial_call_status === 'no-answer', 'signed callback recorded the dial outcome');
  const rl = await post('/red-line-terminate', { CallSid: unknownSid }, { sign: true });
  check(rl.status === 200 && /<Hangup/.test(rl.text), 'signed /red-line-terminate → termination TwiML');

  // Stream tokens.
  const tokenOf = (t) => (t.match(/name="streamToken" value="([^"]+)"/) || [])[1];
  const callA = sid(); const tA = tokenOf((await post('/voice', { CallSid: callA, From: '+447700900777', To: TO }, { sign: true })).text);
  const wrong = await ws({ event: 'start', streamSid: 'MZwrongcall01', start: { streamSid: 'MZwrongcall01', callSid: sid(), customParameters: { streamToken: tA } } });
  check(wrong.closed, 'a valid token presented with a different CallSid is refused');
  const good = await ws({ event: 'start', streamSid: 'MZgoodstream1', start: { streamSid: 'MZgoodstream1', callSid: callA, customParameters: { streamToken: tA, householdId: 'attacker-household', toNumber: '+447700900999', protectedNumber: '+441615559999' } } }, { holdMs: 2000 });
  check(good.opened && !good.closed, 'the genuine token + matching CallSid starts a stream');
  const L1 = log();
  const startedLine = (L1.match(/[^\n]*media_stream_started[^\n]*MZgoodstream1[^\n]*/) || [''])[0];
  check(startedLine.includes(process.env.HOUSEHOLD_ID) && !startedLine.includes('attacker-household'), 'server-established household identity is used; attacker customParameters ignored');
  stopStream(good, 'MZgoodstream1');
  const replay = await ws({ event: 'start', streamSid: 'MZreplay00001', start: { streamSid: 'MZreplay00001', callSid: callA, customParameters: { streamToken: tA } } });
  check(replay.closed, 'replaying a used token is refused');
  const junk = await ws({ event: 'start', streamSid: 'MZjunktoken01', start: { streamSid: 'MZjunktoken01', callSid: callA, customParameters: { streamToken: 'not-a-real-token' } } });
  check(junk.closed, 'an invalid token is refused');

  // Per-household concurrent stream cap (default 2).
  const opened = [];
  for (let i = 0; i < 3; i++) {
    const c = sid(); const t = tokenOf((await post('/voice', { CallSid: c, From: '+447700900777', To: TO }, { sign: true })).text);
    opened.push([await ws({ event: 'start', streamSid: `MZcap0000000${i}`, start: { streamSid: `MZcap0000000${i}`, callSid: c, customParameters: { streamToken: t } } }, { holdMs: 1200 }), `MZcap0000000${i}`]);
  }
  check(!opened[0][0].closed && !opened[1][0].closed && opened[2][0].closed, 'third simultaneous stream for one household is refused (cap 2)');
  for (const [s, id] of opened) stopStream(s, id);

  // No-start timeout.
  const idle = await ws(null, { sendStart: false, holdMs: 12500 });
  check(idle.closed && idle.closedAt >= 9000, `a socket that never sends start is closed after ~10 s (closed at ${idle.closedAt} ms)`);

  // Logs: no PII from forged traffic, no exceptions.
  const L2 = log();
  check(!PII.concat(['+447700900999']).some((p) => L2.includes(p)), 'staging log contains no customer or attacker-supplied phone number');
  check(!/UNCAUGHT|unhandled_error|TypeError|ReferenceError/.test(L2), 'staging log shows no exceptions');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
