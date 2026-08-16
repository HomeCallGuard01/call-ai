// mulawWav.js — wraps raw mulaw-encoded audio (the format Twilio Media
// Streams sends: 8kHz, mono, 8-bit mulaw) in a minimal valid WAV header so
// it can be handed to a transcription API as a file.
//
// Pure, no I/O. Flagged honestly: this has not been validated against a
// real transcription call on real audio — that is exactly the kind of
// thing this cannot be verified from code alone and needs a real test
// call before it's trusted in production.

'use strict';

const MULAW_FORMAT_CODE = 7; // WAVE_FORMAT_MULAW
const SAMPLE_RATE = 8000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 8;

/**
 * @param {Buffer} mulawData
 * @returns {Buffer} a complete .wav file (RIFF header + mulaw data)
 */
function wrapMulawAsWav(mulawData) {
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const dataSize = mulawData.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(MULAW_FORMAT_CODE, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, mulawData]);
}

module.exports = { wrapMulawAsWav, MULAW_FORMAT_CODE, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE };
