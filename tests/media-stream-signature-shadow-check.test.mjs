// Coverage for the SHADOW-MODE Twilio Media Streams signature check
// (2026-09-27, P0 launch hardening) — services/twilioWebhookAuth.js's
// describeMediaStreamSignatureCheck and its wiring into
// services/liveMonitoring/mediaStreamServer.js.
//
// This answers the explicit design question "how can genuine Twilio
// Media Stream connections be authenticated or cryptographically
// validated" using Twilio's own documented mechanism (X-Twilio-Signature)
// — but deliberately does NOT enforce it yet: Twilio's own troubleshooting
// docs note a WebSocket-handshake-specific trailing-slash quirk for this
// exact header, and this app cannot originate a real Twilio Media Stream
// connection in any pre-production environment to confirm which URL form
// Twilio actually signs against. Enforcing on an unverified guess risks
// rejecting every genuine call — a full live-monitoring outage, strictly
// worse than the crash bug this same pass fixed. So this only observes
// and logs; every test below proves that a connection is NEVER rejected
// or closed, regardless of whether the signature matches, is wrong, or is
// missing entirely.
//
// Run with: node tests/media-stream-signature-shadow-check.test.mjs

import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);
const twilio = require('twilio');
const { describeMediaStreamSignatureCheck } = require('../services/twilioWebhookAuth');
const { attachMediaStreamServer } = require('../services/liveMonitoring/mediaStreamServer');
const WebSocket = require('ws');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- pure unit coverage: describeMediaStreamSignatureCheck itself ---

{
  const authToken = 'test-auth-token-1';
  const appUrl = 'https://app.example.com';
  const path = '/media-stream';
  const genuineWssUrl = 'wss://app.example.com/media-stream';
  const signature = twilio.getExpectedTwilioSignature(authToken, genuineWssUrl, {});

  const result = describeMediaStreamSignatureCheck({ authToken, signature, appUrl, path });
  check(result.hasSignatureHeader === true, 'a genuine signature is reported as present');
  check(result.matchedVariant === 'wss', 'a signature computed against the exact wss:// <Stream> URL is correctly identified as the "wss" variant — this is the URL server.js actually gives Twilio');
}

{
  const authToken = 'test-auth-token-2';
  const appUrl = 'https://app.example.com';
  const path = '/media-stream';
  const httpsUrlWithSlash = 'https://app.example.com/media-stream/';
  const signature = twilio.getExpectedTwilioSignature(authToken, httpsUrlWithSlash, {});

  const result = describeMediaStreamSignatureCheck({ authToken, signature, appUrl, path });
  check(result.matchedVariant === 'https-trailing-slash', 'a signature computed against the https:// form WITH a trailing slash is correctly identified as its own distinct variant — proves the trailing-slash quirk mentioned in Twilio\'s own troubleshooting docs is actually covered, not just mentioned in a comment');
}

{
  const result = describeMediaStreamSignatureCheck({
    authToken: 'test-auth-token-3',
    signature: 'this-does-not-match-any-variant',
    appUrl: 'https://app.example.com',
    path: '/media-stream',
  });
  check(result.hasSignatureHeader === true, 'a present-but-wrong signature is still reported as "header present"');
  check(result.matchedVariant === null, 'a present-but-wrong signature reports no matched variant, rather than throwing or silently passing');
}

{
  const result = describeMediaStreamSignatureCheck({
    authToken: 'test-auth-token-4',
    signature: undefined,
    appUrl: 'https://app.example.com',
    path: '/media-stream',
  });
  check(result.hasSignatureHeader === false, 'a missing signature header is reported honestly as absent, not conflated with "present but wrong"');
  check(result.matchedVariant === null, 'a missing signature header never matches any variant');
}

{
  let threw = false;
  let result;
  try {
    result = describeMediaStreamSignatureCheck({ authToken: null, signature: null, appUrl: null, path: null });
  } catch (err) {
    threw = true;
  }
  check(threw === false, 'missing authToken/appUrl (e.g. local dev with no Twilio credentials configured) never throws');
  check(Boolean(result) && result.matchedVariant === null, 'missing authToken/appUrl safely reports "nothing checked" rather than a false match');
}

// --- real-socket integration coverage: the shadow check never blocks a
// connection, end to end, through the actual mediaStreamServer.js wiring
// (this file is explicitly NOT unit tested elsewhere — "nothing here is
// pure logic" per its own header comment — so this is the one place its
// actual connection-acceptance behaviour is proven against a real
// WebSocketServer, not just read as source) ---

function startTestServer(deps) {
  return new Promise(resolve => {
    const httpServer = http.createServer();
    attachMediaStreamServer(httpServer, deps);
    httpServer.listen(0, () => resolve(httpServer));
  });
}

function connectAndAwaitOpen(port, { withSignature } = {}) {
  return new Promise((resolve, reject) => {
    const headers = withSignature ? { 'X-Twilio-Signature': withSignature } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`, { headers });
    const timeout = setTimeout(() => reject(new Error('connection timed out — shadow check must have blocked it')), 2000);
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function runIntegrationChecks() {
  const baseDeps = {
    transcribeClient: null,
    smsClient: null,
    fromNumber: '+441000000000',
    twilioAuthToken: 'integration-test-token',
    appUrl: 'https://app.example.com',
  };

  // Case 1: no signature header at all — must still connect.
  {
    const server = await startTestServer(baseDeps);
    const port = server.address().port;
    let connected = false;
    try {
      const ws = await connectAndAwaitOpen(port);
      connected = true;
      ws.close();
    } catch (err) {
      connected = false;
    }
    check(connected === true, 'a connection with NO X-Twilio-Signature header at all is still accepted (shadow mode never rejects for a missing header)');
    server.close();
  }

  // Case 2: a garbage/wrong signature — must still connect.
  {
    const server = await startTestServer(baseDeps);
    const port = server.address().port;
    let connected = false;
    try {
      const ws = await connectAndAwaitOpen(port, { withSignature: 'totally-wrong-signature' });
      connected = true;
      ws.close();
    } catch (err) {
      connected = false;
    }
    check(connected === true, 'a connection with an INVALID X-Twilio-Signature header is still accepted (shadow mode never rejects for a bad signature — this is the entire point: it only observes)');
    server.close();
  }

  // Case 3: twilioAuthToken/appUrl not configured at all (e.g. local dev)
  // — the check must be skipped entirely, never throw, connection proceeds.
  {
    const server = await startTestServer({ transcribeClient: null, smsClient: null, fromNumber: '+441000000000' });
    const port = server.address().port;
    let connected = false;
    try {
      const ws = await connectAndAwaitOpen(port);
      connected = true;
      ws.close();
    } catch (err) {
      connected = false;
    }
    check(connected === true, 'with no twilioAuthToken/appUrl configured at all, the shadow check is skipped and the connection still succeeds');
    server.close();
  }

  // Case 4: a genuinely valid signature — must ALSO still connect (proves
  // this is not accidentally a blocking gate that only happens to pass
  // for valid signatures in the other tests).
  {
    const server = await startTestServer(baseDeps);
    const port = server.address().port;
    const genuineUrl = 'wss://app.example.com/media-stream';
    const validSignature = twilio.getExpectedTwilioSignature(baseDeps.twilioAuthToken, genuineUrl, {});
    let connected = false;
    try {
      const ws = await connectAndAwaitOpen(port, { withSignature: validSignature });
      connected = true;
      ws.close();
    } catch (err) {
      connected = false;
    }
    check(connected === true, 'a connection with a genuinely VALID signature also connects normally — the handler pipeline is completely unaffected by this diagnostic either way');
    server.close();
  }
}

runIntegrationChecks()
  .then(() => {
    console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures}`} media-stream-signature-shadow-check checks ${failures === 0 ? 'passed' : 'FAILED'}`);
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch(err => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  });
