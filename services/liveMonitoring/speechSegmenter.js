// speechSegmenter.js — pure, dependency-free buffering of Twilio Media
// Streams' 20ms mulaw frames into NON-overlapping, pause-aligned
// transcription segments. Replaces audioWindow.js's fixed 4s-window /
// 2s-overlap buffer as the live monitoring pipeline's segmenter
// (2026-09-26 transcription-efficiency fix).
//
// Why not fixed windows: audioWindow.js cut every window at a fixed
// frame count, i.e. usually straight through a word. The 2026-08-16 real
// staging call (CA4107acfc3b9146a7cb6c4129b69b0c83) showed the
// consequence — "don't speak to your | bank" cut mid-phrase, continuation
// mistranscribed — and the fix then was a 2s overlap, so every word
// appeared whole in at least one window. That worked, but sent every
// second of audio to paid transcription twice.
//
// This module removes the cause instead of covering it: a segment is
// only ever cut where the audio is quietest — normally a real pause
// between words — so no word is split and nothing needs re-sending.
// Every frame is emitted in exactly one segment, in order.
//
// Cut rule, per segment:
//   1. Never before minSegmentMs (3s — keeps each Whisper request close
//      to the old 4s window's length, so per-request accuracy is
//      comparable, and avoids tiny chunks Whisper handles poorly).
//   2. From minSegmentMs on, cut as soon as the most recent pauseMs of
//      audio is quiet (a genuine pause — typically the end of a phrase,
//      which is also the best moment to score it).
//   3. At maxSegmentMs (4s — no segment is ever longer than the old
//      window, bounding worst-case detection latency) with no pause yet,
//      cut at the quietest smoothed point between minSegmentMs and
//      maxSegmentMs — in continuous speech, almost always a between-word
//      gap. The frames after that point carry forward into the next
//      segment (never duplicated, never dropped).
//
// Frame-count-based, not wall-clock-based, exactly like audioWindow.js:
// Twilio's 20ms framing is fixed, so this stays fully deterministic.

'use strict';

const DEFAULT_FRAME_MS = 20;
const DEFAULT_MIN_SEGMENT_MS = 3000;
const DEFAULT_MAX_SEGMENT_MS = 4000;
const DEFAULT_PAUSE_MS = 200;
// Smoothing span used to find the quietest cut point when no pause
// arrives (rule 3) — a single 20ms frame can be quiet mid-syllable;
// 100ms of low energy is a real inter-word gap.
const DEFAULT_SMOOTHING_MS = 100;
// Mean absolute decoded amplitude (16-bit linear scale, ±32124 for
// G.711 mulaw) below which a 20ms frame counts as quiet — roughly
// -38 dBFS: above typical PSTN line noise, below soft speech. Only
// affects WHEN a segment is cut (rule 2); a line too noisy to ever
// register as quiet still segments correctly via rule 3.
const DEFAULT_QUIET_MEAN_ABS = 350;

// G.711 mulaw -> |linear sample|, precomputed for all 256 byte values.
const MULAW_ABS = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    table[i] = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  }
  return table;
})();

function frameEnergy(frame) {
  if (!frame || frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += MULAW_ABS[frame[i]];
  return sum / frame.length;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.minSegmentMs]
 * @param {number} [opts.maxSegmentMs]
 * @param {number} [opts.pauseMs]
 * @param {number} [opts.smoothingMs]
 * @param {number} [opts.quietMeanAbs]
 * @param {number} [opts.frameMs]
 * @returns {{ addFrame: (frame: Buffer) => Buffer|null, bufferedFrameCount: () => number }}
 */
function createSpeechSegmenter({
  minSegmentMs = DEFAULT_MIN_SEGMENT_MS,
  maxSegmentMs = DEFAULT_MAX_SEGMENT_MS,
  pauseMs = DEFAULT_PAUSE_MS,
  smoothingMs = DEFAULT_SMOOTHING_MS,
  quietMeanAbs = DEFAULT_QUIET_MEAN_ABS,
  frameMs = DEFAULT_FRAME_MS,
} = {}) {
  if (!(minSegmentMs > 0) || maxSegmentMs < minSegmentMs) {
    throw new Error('maxSegmentMs must be >= minSegmentMs > 0');
  }

  const minFrames = Math.round(minSegmentMs / frameMs);
  const maxFrames = Math.round(maxSegmentMs / frameMs);
  const pauseFrames = Math.max(1, Math.round(pauseMs / frameMs));
  const smoothingFrames = Math.max(1, Math.round(smoothingMs / frameMs));

  let frames = [];
  let energies = [];

  function emit(cutIndex) {
    const segment = Buffer.concat(frames.slice(0, cutIndex));
    frames = frames.slice(cutIndex);
    energies = energies.slice(cutIndex);
    return segment;
  }

  function endsInPause() {
    if (frames.length < pauseFrames) return false;
    for (let i = frames.length - pauseFrames; i < frames.length; i++) {
      if (energies[i] >= quietMeanAbs) return false;
    }
    return true;
  }

  // Rule 3: the cut index (exclusive end of the emitted segment) at the
  // centre of the quietest smoothingFrames-long stretch, searched only
  // within [minFrames, maxFrames] so the emitted segment always respects
  // both bounds. Centred, not trailing: a trailing-only window scores
  // "just after the gap" (first frame of the next word) almost as quiet
  // as "inside the gap", which put forced cuts at word onsets in
  // testing. Ties resolve to the latest point (longest segment).
  const smoothingBefore = Math.floor(smoothingFrames / 2);
  const smoothingAfter = smoothingFrames - smoothingBefore;
  function quietestCutIndex() {
    const lastCandidate = Math.max(minFrames, Math.min(maxFrames, frames.length - smoothingAfter));
    let bestIndex = lastCandidate;
    let bestEnergy = Infinity;
    for (let cut = minFrames; cut <= lastCandidate; cut++) {
      const from = Math.max(0, cut - smoothingBefore);
      const to = Math.min(frames.length, cut + smoothingAfter);
      let sum = 0;
      for (let i = from; i < to; i++) sum += energies[i];
      const avg = sum / (to - from);
      if (avg <= bestEnergy) {
        bestEnergy = avg;
        bestIndex = cut;
      }
    }
    return bestIndex;
  }

  function addFrame(frame) {
    frames.push(frame);
    energies.push(frameEnergy(frame));

    if (frames.length < minFrames) return null;
    if (endsInPause()) return emit(frames.length);
    if (frames.length >= maxFrames) return emit(quietestCutIndex());
    return null;
  }

  return { addFrame, bufferedFrameCount: () => frames.length };
}

module.exports = {
  createSpeechSegmenter,
  frameEnergy,
  DEFAULT_MIN_SEGMENT_MS,
  DEFAULT_MAX_SEGMENT_MS,
  DEFAULT_PAUSE_MS,
  DEFAULT_QUIET_MEAN_ABS,
  DEFAULT_FRAME_MS,
};
