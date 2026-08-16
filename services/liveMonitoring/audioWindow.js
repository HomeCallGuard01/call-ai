// audioWindow.js — pure, dependency-free buffering of fixed-size audio
// frames (Twilio Media Streams sends 20ms mulaw frames) into overlapping
// transcription windows.
//
// Deliberately frame-count-based, not wall-clock-based: Twilio's frame
// size/interval is fixed and known (20ms), so counting frames is simpler
// and fully deterministic for testing than timing real audio.

'use strict';

const DEFAULT_FRAME_MS = 20;
const DEFAULT_WINDOW_MS = 4000; // within the requested 3-5s range
// Raised from 1000ms to 2000ms on 2026-08-16 after a real call: a
// standalone-red-line phrase ("don't speak to your bank or your family")
// spoken across a window boundary was transcribed correctly up to the
// boundary, then mistranscribed on the far side with virtually no shared
// audio between the two windows to anchor it. Doubling the overlap gives
// each window roughly twice as much of the preceding audio to anchor a
// phrase that starts near the previous boundary, at the cost of ~1.5x
// more transcription calls per call (window duration is unchanged, so
// first-detection latency is unchanged too — see the 2026-08-16 report
// for the full cost/latency trade-off). This is deliberately not the
// only fix — see transcribeChunk.js's prompt
// parameter, which targets the same failure mode from the transcription
// side rather than the audio side.
const DEFAULT_OVERLAP_MS = 2000;

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs]
 * @param {number} [opts.overlapMs]
 * @param {number} [opts.frameMs]
 * @returns {{ addFrame: (frame: Buffer) => Buffer|null }}
 */
function createWindowBuffer({
  windowMs = DEFAULT_WINDOW_MS,
  overlapMs = DEFAULT_OVERLAP_MS,
  frameMs = DEFAULT_FRAME_MS,
} = {}) {
  if (overlapMs >= windowMs) {
    throw new Error('overlapMs must be smaller than windowMs');
  }

  const framesPerWindow = Math.round(windowMs / frameMs);
  const overlapFrames = Math.round(overlapMs / frameMs);
  let frames = [];

  function addFrame(frame) {
    frames.push(frame);

    if (frames.length < framesPerWindow) {
      return null;
    }

    const windowFrames = frames.slice(0, framesPerWindow);
    // Slide forward, keeping the trailing overlapFrames as the start of
    // the next window so a word spoken right at the boundary isn't split
    // across two windows with neither containing it whole.
    frames = frames.slice(framesPerWindow - overlapFrames);

    return Buffer.concat(windowFrames);
  }

  return { addFrame };
}

module.exports = { createWindowBuffer, DEFAULT_WINDOW_MS, DEFAULT_OVERLAP_MS, DEFAULT_FRAME_MS };
