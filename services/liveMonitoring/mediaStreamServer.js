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

const MEDIA_STREAM_PATH = '/media-stream';

/**
 * @param {import('http').Server} httpServer - the same server app.listen() returns
 * @param {object} deps - forwarded to createMediaStreamHandler
 */
function attachMediaStreamServer(httpServer, deps) {
  const handler = createMediaStreamHandler(deps);
  const wss = new WebSocketServer({ server: httpServer, path: MEDIA_STREAM_PATH });

  wss.on('connection', ws => {
    ws.on('message', data => {
      handler.handleMessage(data.toString()).catch(err => {
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
