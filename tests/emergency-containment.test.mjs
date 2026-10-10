// Emergency containment (2026-10-10, hotfix/prod-containment-2026-10-10).
// Boots the REAL server.js twice in child processes (inert credentials; any
// OpenAI request is pointed at a local counter) and proves:
//   default (flags unset): POST /process → 404 with zero OpenAI requests; a
//   WebSocket to /media-stream is refused (no endpoint), so a forged stream
//   can trigger neither transcription nor SMS; /health still answers.
//   HCG_LIVE_MONITORING_ENABLED=true: /media-stream accepts the upgrade again
//   (the switch restores the previous behaviour; nothing else changed).
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

let openaiHits = 0;
const fakeOpenAI = http.createServer((req, res) => { openaiHits += 1; res.writeHead(500); res.end('{}'); });
await new Promise((r) => fakeOpenAI.listen(0, '127.0.0.1', r));

async function boot(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), APP_URL: `http://127.0.0.1:${port}`,
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x',
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000', TWILIO_AUTH_TOKEN: 'x',
      OPENAI_API_KEY: 'x', OPENAI_BASE_URL: `http://127.0.0.1:${fakeOpenAI.address().port}/v1`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (/Server running on port/.test(log)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, log: () => log };
}
const request = (port, method, p, body = '') => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
  });
  r.on('error', (e) => resolve({ status: 0, text: e.message })); r.end(body);
});
const wsTry = (port) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
  const done = (v) => { try { ws.terminate(); } catch {} resolve(v); };
  ws.on('open', () => {
    ws.send(JSON.stringify({ event: 'start', streamSid: 'MZforged', start: { streamSid: 'MZforged', callSid: 'CAforged', customParameters: { householdId: 'attacker', toNumber: '+447700900999', protectedNumber: '+447700900998' } } }));
    setTimeout(() => done('open'), 300);
  });
  ws.on('error', () => done('refused'));
  ws.on('unexpected-response', () => done('refused'));
  setTimeout(() => done('timeout'), 3000);
});

const base = 41000 + Math.floor(Math.random() * 8000);
const A = await boot(base, {});
try {
  check(/EMERGENCY CONTAINMENT: live monitoring is OFF/.test(A.log()), 'default boot logs that live monitoring is OFF');
  const h = await request(base, 'GET', '/health');
  check(h.status === 200 || h.status === 503, `server answers /health (status ${h.status})`);
  const p = await request(base, 'POST', '/process', 'SpeechResult=hello%20this%20is%20your%20bank%20calling&From=%2B447700900111&To=%2B441234560000&CallSid=CAx');
  await new Promise((r) => setTimeout(r, 500));
  check(p.status === 404 && openaiHits === 0, `unsigned POST /process → 404 and 0 OpenAI requests (status ${p.status}, hits ${openaiHits})`);
  const w = await wsTry(base);
  await new Promise((r) => setTimeout(r, 500));
  check(w !== 'open' && openaiHits === 0, `forged /media-stream connection is refused (${w}); 0 OpenAI requests`);
} finally { A.child.kill(); }

const B = await boot(base + 1, { HCG_LIVE_MONITORING_ENABLED: 'true' });
try {
  check(!/EMERGENCY CONTAINMENT: live monitoring is OFF/.test(B.log()), 'with HCG_LIVE_MONITORING_ENABLED=true the containment notice is absent');
  const w = await wsTry(base + 1);
  check(w === 'open', `with the switch on, /media-stream accepts upgrades again (${w}) — the switch only restores the previous behaviour`);
} finally { B.child.kill(); fakeOpenAI.close(); }

console.log(failures === 0 ? '\nEmergency containment: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
