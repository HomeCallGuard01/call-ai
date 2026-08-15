// transcribeChunk.js — sends one buffered audio window to a transcription
// API and returns the resulting text.
//
// The real client is injected (never constructed here), matching this
// project's existing fail-open/testability convention (see
// services/twilioProvisioning.js's `deps` pattern) — tests always supply a
// fake, deterministic client. Flagged honestly: the exact real-API call
// shape (OpenAI's audio.transcriptions.create + toFile()) has not been
// exercised against a real audio file — this is the piece most needing a
// real test call before trusting it in production.

'use strict';

const { wrapMulawAsWav } = require('./mulawWav');
const { logEvent } = require('./structuredLog');

/**
 * @param {Buffer} mulawChunk
 * @param {object} deps
 * @param {{transcribe: (wavBuffer: Buffer, promptContext?: string) => Promise<string>}} deps.client
 * @param {string} [deps.callSid] - for logging only
 * @param {string} [deps.promptContext] - the immediately preceding window's
 *   transcribed text, passed through to the client as transcription
 *   context. Added 2026-08-16: a real call's dangerous phrase was split
 *   across a window boundary with no shared context between the two
 *   windows, and Whisper filled the second window with a grammatically
 *   plausible but semantically different sentence ("I can't speak to
 *   your bank" instead of continuing "don't speak to your bank"). Giving
 *   Whisper the prior window's text as context measurably improves
 *   continuity across a boundary like this — see OpenAI's own guidance
 *   on the `prompt` parameter. Deliberately just the immediately
 *   preceding chunk, not the whole call's accumulated transcript: bounded
 *   size (Whisper only uses the trailing ~224 tokens of prompt text
 *   anyway), and this is about anchoring the current window's audio, not
 *   feeding the whole conversation history back in.
 * @returns {Promise<string|null>} the transcribed text, or null on failure
 *   (never throws — a transcription failure must not crash the live call).
 */
async function transcribeChunk(mulawChunk, { client, callSid, promptContext } = {}) {
  try {
    const wavBuffer = wrapMulawAsWav(mulawChunk);
    const text = await client.transcribe(wavBuffer, promptContext);
    return typeof text === 'string' ? text : null;
  } catch (err) {
    logEvent('transcription_failed', { callSid, error: err.message });
    return null;
  }
}

// Real client factory — not used by any test, constructed only when this
// module is actually wired into the live app with a real OpenAI instance.
function createOpenAiTranscribeClient(openaiClient) {
  return {
    async transcribe(wavBuffer, promptContext) {
      const { toFile } = require('openai');
      const file = await toFile(wavBuffer, 'chunk.wav', { type: 'audio/wav' });
      const response = await openaiClient.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        // Constrains Whisper to English (ISO-639-1; Whisper has no
        // separate en-GB variant) instead of auto-detecting language
        // fresh on every ~4s window. Added 2026-08-15 after a real
        // staging call where one window of genuine English speech was
        // auto-detected and transcribed as Welsh, losing that content to
        // the risk engine entirely.
        language: 'en',
        // See the promptContext doc comment on transcribeChunk above.
        // Omitted (undefined) on the first window of a call, when there
        // is nothing preceding yet.
        ...(promptContext ? { prompt: promptContext } : {}),
      });
      return response.text;
    },
  };
}

module.exports = { transcribeChunk, createOpenAiTranscribeClient };
