// structuredLog.js — the smallest possible structured logging: one JSON
// object per line to stdout. No logging library, per "avoid unnecessary
// abstractions and infrastructure" — this project has no existing logging
// framework to be consistent with, and a real one can replace this single
// call site later if ever needed.

'use strict';

function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

module.exports = { logEvent };
