// Unit tests for services/liveMonitoring/audioWindow.js — the pure,
// frame-count-based overlapping window buffer.
//
// Run with: node tests/live-monitoring-audio-window.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindowBuffer } = require('../services/liveMonitoring/audioWindow.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function makeFrame(byte) {
  return Buffer.from([byte]);
}

// --- basic windowing ---

{
  // windowMs=100, frameMs=20 -> 5 frames per window; overlapMs=20 -> 1 overlap frame
  const buf = createWindowBuffer({ windowMs: 100, overlapMs: 20, frameMs: 20 });

  check(buf.addFrame(makeFrame(1)) === null, 'no window emitted before enough frames accumulate (1/5)');
  check(buf.addFrame(makeFrame(2)) === null, 'no window emitted (2/5)');
  check(buf.addFrame(makeFrame(3)) === null, 'no window emitted (3/5)');
  check(buf.addFrame(makeFrame(4)) === null, 'no window emitted (4/5)');

  const firstWindow = buf.addFrame(makeFrame(5));
  check(
    Buffer.isBuffer(firstWindow) && firstWindow.equals(Buffer.from([1, 2, 3, 4, 5])),
    'exactly 5 frames concatenated in order once the window fills'
  );
}

// --- overlap behaviour ---

{
  const buf = createWindowBuffer({ windowMs: 100, overlapMs: 20, frameMs: 20 });
  for (const b of [1, 2, 3, 4, 5]) buf.addFrame(makeFrame(b));

  // Overlap = 1 frame, so the next window should start with frame 5
  // (the last frame of the previous window) and need 4 more new frames.
  check(buf.addFrame(makeFrame(6)) === null, 'after a window closes, the overlap frame carries into the next window (1/5 with overlap)');
  check(buf.addFrame(makeFrame(7)) === null, 'still accumulating second window (2/5)');
  check(buf.addFrame(makeFrame(8)) === null, 'still accumulating second window (3/5)');

  const secondWindow = buf.addFrame(makeFrame(9));
  check(
    Buffer.isBuffer(secondWindow) && secondWindow.equals(Buffer.from([5, 6, 7, 8, 9])),
    'second window includes the overlapping last frame of the first window (5) followed by the 4 new frames'
  );
}

// --- configuration validation ---

{
  let threw = false;
  try {
    createWindowBuffer({ windowMs: 1000, overlapMs: 1000 });
  } catch (err) {
    threw = true;
  }
  check(threw, 'overlapMs equal to windowMs is rejected (would never produce new audio in a window)');
}

// --- realistic Twilio framing: 20ms frames, 3-5s window range ---

{
  const buf = createWindowBuffer(); // defaults: 4000ms window, 1000ms overlap, 20ms frames -> 200 frames/window, 50 overlap
  let windowsEmitted = 0;
  for (let i = 0; i < 200; i++) {
    const w = buf.addFrame(Buffer.from([i % 256]));
    if (w) windowsEmitted++;
  }
  check(windowsEmitted === 1, 'default config (4s window) emits exactly one window after 200 20ms frames = 4000ms of audio');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll live-monitoring audio-window checks passed.');
}
