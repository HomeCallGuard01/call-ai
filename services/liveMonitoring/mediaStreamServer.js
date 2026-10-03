// mediaStreamServer.js — the one piece of real new infrastructure this
// feature needs: a WebSocket endpoint Twilio's <Stream> can connect to.
// Deliberately thin — all real logic lives in mediaStreamHandler.js and is
// tested there without any real socket; this file only wires a real `ws`
// server to that handler and is not itself unit tested (nothing here is
// pure logic).

'use strict';

const { WebSocketServer } = require('ws');
const { createMediaStreamHandler } = require('./mediaStreamHandler');
const { logEvent } = require('./structuredLog');
const { describeMediaStreamSignatureCheck } = require('../twilioWebhookAuth');

const MEDIA_STREAM_PATH = '/media-stream';

/**
 * @param {import('http').Server} httpServer - the same server app.listen() returns
 * @param {object} deps - forwarded to createMediaStreamHandler, plus:
 * @param {string} [deps.twilioAuthToken] - for the shadow-mode signature
 *   check below. Omit to skip the check entirely (e.g. in tests).
 * @param {string} [deps.appUrl] - this app's own external base URL
 *   (server.js's APP_URL), used the same way services/twilioWebhookAuth.js
 *   already uses it for /voice — never req-derived values, which cannot
 *   be trusted behind Railway's unconfigured proxy.
 */
function attachMediaStreamServer(httpServer, deps) {
  const handler = createMediaStreamHandler(deps);
  const wss = new WebSocketServer({ server: httpServer, path: MEDIA_STREAM_PATH });

  // P0 remediation (2026-10-01): bound unauthenticated sockets. A socket
  // that has not sent a "start" event within startTimeoutMs is closed, and
  // connections beyond maxSockets are refused outright. Authentication
  // itself is the stream token checked in mediaStreamHandler (streamAuth.js).
  const maxSockets = deps.maxSockets || 400;
  const startTimeoutMs = deps.startTimeoutMs || 10000;

  wss.on('connection', (ws, req) => {
    if (wss.clients.size > maxSockets) {
      logEvent('media_stream_socket_limit_reached', { sockets: wss.clients.size, maxSockets });
      try { ws.close(1013); } catch { /* already closing */ }
      return;
    }
    let sawStart = false;
    const startTimer = setTimeout(() => {
      if (!sawStart) {
        logEvent('media_stream_no_start_timeout', {});
        try { ws.close(); } catch { /* already closing */ }
      }
    }, startTimeoutMs);
    ws.on('close', () => clearTimeout(startTimer));

    // Shadow-mode Twilio signature check (2026-09-27) — observes and
    // logs only, NEVER rejects or closes a connection. See
    // services/twilioWebhookAuth.js's describeMediaStreamSignatureCheck
    // for the full reasoning. Wrapped in try/catch as a hard guarantee
    // this diagnostic can never itself become a new way to drop a
    // genuine call — a bug here must fail silent, not fail closed.
    if (deps.twilioAuthToken && deps.appUrl) {
      try {
        const result = describeMediaStreamSignatureCheck({
          authToken: deps.twilioAuthToken,
          signature: req.headers['x-twilio-signature'],
          appUrl: deps.appUrl,
          path: req.url,
        });
        logEvent('media_stream_signature_check', result);
      } catch (err) {
        logEvent('media_stream_signature_check_error', { error: err.message });
      }
    }

    ws.on('message', data => {
      if (!sawStart && /"event"\s*:\s*"start"/.test(String(data).slice(0, 200))) sawStart = true;
      // closeConnection lets handleMessage stop this specific stream's
      // WebSocket once the per-call monitoring safety limit is reached
      // (services/liveMonitoring/monitoringLimit.js) — closing our end
      // stops Twilio sending further Media Streams data/billing for this
      // call, and has no effect whatsoever on the underlying <Dial>'d
      // call, which is a completely independent TwiML action.
      handler.handleMessage(data.toString(), { closeConnection: () => ws.close() }).catch(err => {
        // handleMessage already catches internally; this is a final
        // backstop so a truly unexpected error can never crash the
        // process or the live call it's monitoring.
        logEvent('media_stream_unhandled_error', { error: err.message });
      });
    });

    ws.on('error', err => {
      logEvent('media_stream_socket_error', { error: err.message });
    });
  });

  return wss;
}

module.exports = { attachMediaStreamServer, MEDIA_STREAM_PATH };
