// /media-stream socket hardening (2026-10-09), against the REAL ws server
// (attachMediaStreamServer) and the REAL handler, on a loopback HTTP server.
// Before: any frame whose first 200 bytes matched "event":"start" disarmed the
// no-start timeout, so a malformed start held an unauthenticated socket open
// (filling the 400-socket cap blinds monitoring for genuine calls), and frames
// up to ws's 100 MiB default were accepted. Now: only a start the handler
// AUTHORISES disarms the timer; a malformed start is closed; frames above
// 64 KiB are refused. The decisive regression check is that a GENUINE
// authorised stream stays open past the timeout.
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { attachMediaStreamServer } = require(path.join(ROOT, 'services', 'liveMonitoring', 'mediaStreamServer.js'));
const WebSocket = require('ws');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const START_TIMEOUT_MS = 400;
let transcriptions = 0;
const authorizeStream = ({ callSid, streamToken }) => (streamToken === 'valid-token' ? { householdId: `hh-${callSid}`, toNumber: '+447700900123', fromNumber: '+441234560000' } : null);
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = attachMediaStreamServer(server, {
  authorizeStream,
  startTimeoutMs: START_TIMEOUT_MS,
  transcribeClient: { audio: { transcriptions: { create: async () => { transcriptions += 1; return { text: '' }; } } } },
  smsClient: null,
  fromNumber: '+441234560000',
  recordOutcome: async () => {},
  sendAlert: async () => true,
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function probe(frames, holdMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
    const st = { closedByServer: false, code: null, atMs: null };
    const t0 = Date.now();
    ws.on('open', () => { for (const f of frames) ws.send(typeof f === 'string' ? f : JSON.stringify(f)); });
    ws.on('close', (code) => { st.closedByServer = true; st.code = code; st.atMs = Date.now() - t0; });
    ws.on('error', () => {});
    setTimeout(() => { try { ws.close(); } catch {} resolve(st); }, holdMs);
  });
}
const start = (sid, token) => ({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid: `CA${sid}`, customParameters: { streamToken: token } } });
const HOLD = START_TIMEOUT_MS * 3;

try {
  const [genuine, idle, malformed, lookalike, forged] = await Promise.all([
    probe([{ event: 'connected', protocol: 'Call' }, start('MZgenuine', 'valid-token')], HOLD),
    probe([{ event: 'connected', protocol: 'Call' }], HOLD),
    probe(['{"event":"start","start":"not-an-object"}'], HOLD),
    probe(['{"event":"start"} padding that is not json'], HOLD),
    probe([start('MZforged', 'wrong-token')], HOLD),
  ]);
  check(!genuine.closedByServer, `a GENUINE authorised stream stays open past the start timeout (held ${HOLD} ms)`);
  check(idle.closedByServer && idle.atMs >= START_TIMEOUT_MS - 50, `a socket that never starts is closed by the timeout (after ${idle.atMs} ms)`);
  check(malformed.closedByServer && malformed.atMs < START_TIMEOUT_MS, `a malformed start ("start" not an object) is closed immediately (after ${malformed.atMs} ms)`);
  check(lookalike.closedByServer, 'a non-JSON frame that merely contains "event":"start" does not disarm the timeout (closed)');
  check(forged.closedByServer && forged.atMs < START_TIMEOUT_MS, 'an unauthorised start is closed immediately');

  const big = await probe(['x'.repeat(256 * 1024)], HOLD);
  check(big.closedByServer && big.code === 1009, `a 256 KiB frame is refused by maxPayload (close code ${big.code}, 1009 = message too big)`);
  const media = { event: 'media', streamSid: 'MZgenuine2', media: { payload: Buffer.alloc(160, 0x7f).toString('base64') } };
  const okSize = await probe([start('MZgenuine2', 'valid-token'), media, media], HOLD);
  check(!okSize.closedByServer, 'genuine-sized media frames on an authorised stream are accepted');
  check(transcriptions === 0, 'no transcription was triggered by any refused socket');

  // F-1 (2026-10-10): a refused peer that never answers the close frame is
  // terminated after the 2 s grace, not left counted against maxSockets.
  const silent = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
  silent.on('error', () => {});
  await new Promise((r) => silent.on('open', r));
  silent._socket.pause(); // stop reading: the close frame is never processed or answered
  silent._socket.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0])); // masked empty text frame (malformed start-less JSON) to keep it honest
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < START_TIMEOUT_MS + 4000) {
    if (wss.clients.size === 0) { gone = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  check(gone && Date.now() - t0 < START_TIMEOUT_MS + 3000, `a silent refused socket is force-terminated after the close grace (gone after ${Date.now() - t0} ms; clients ${wss.clients.size})`);
  silent.terminate();
} finally {
  server.close();
}
console.log(failures === 0 ? '\nMedia stream start timeout / payload: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 50).unref();
