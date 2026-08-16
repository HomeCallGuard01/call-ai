// Unit tests for services/liveMonitoring/mulawWav.js — the minimal WAV
// header wrapper for raw mulaw audio.
//
// Run with: node tests/live-monitoring-mulaw-wav.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wrapMulawAsWav } = require('../services/liveMonitoring/mulawWav.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

const mulawData = Buffer.from([1, 2, 3, 4, 5]);
const wav = wrapMulawAsWav(mulawData);

check(wav.length === 44 + mulawData.length, 'output is exactly a 44-byte header plus the original mulaw data length');
check(wav.subarray(0, 4).toString('ascii') === 'RIFF', 'starts with the RIFF magic bytes');
check(wav.subarray(8, 12).toString('ascii') === 'WAVE', 'declares itself as WAVE format');
check(wav.subarray(36, 40).toString('ascii') === 'data', 'has a data chunk header');
check(wav.readUInt32LE(40) === mulawData.length, 'data chunk size field matches the actual mulaw payload length');
check(wav.subarray(44).equals(mulawData), 'the original mulaw bytes are appended unchanged after the header');
check(wav.readUInt16LE(20) === 7, 'format code is 7 (WAVE_FORMAT_MULAW)');
check(wav.readUInt32LE(24) === 8000, 'sample rate is 8000Hz, matching Twilio Media Streams');
check(wav.readUInt16LE(22) === 1, 'channel count is mono, matching Twilio Media Streams');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll live-monitoring mulaw-wav checks passed.');
}
