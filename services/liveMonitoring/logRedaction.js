// logRedaction.js — keeps conversation content and full customer phone
// numbers out of structured logs (2026-09-27 privacy fix).
//
// Background: the privacy policy states that HCG does not store the call
// audio or a transcript of what was said. Transcript text was nevertheless
// being written to application logs (riskMonitor.js's transcript_chunk
// event), and SMS-warning log lines carried the customer's full mobile
// number. These helpers produce non-content diagnostics instead. They are
// used only for logging and never affect transcription, scoring,
// interventions or call handling.

'use strict';

// Non-content facts about a transcript chunk: how much text there was,
// never what it said. null/undefined (a failed transcription) and
// whitespace-only text both count as an empty transcript.
function describeTranscriptChunk(chunkText) {
  const text = typeof chunkText === 'string' ? chunkText : '';
  const trimmed = text.trim();
  return {
    chunkChars: text.length,
    chunkWords: trimmed ? trimmed.split(/\s+/).length : 0,
    emptyTranscript: trimmed.length === 0,
  };
}

// Masks a phone number to its last 3 digits, e.g. "+447700900123" ->
// "***123". Enough to tell two numbers apart in an incident, not enough
// to identify the customer. Non-strings and numbers with fewer than 4
// digits are fully masked.
function maskPhoneNumber(number) {
  if (typeof number !== 'string') return number == null ? null : '***';
  const digits = number.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-3)}`;
}

// Masks anything in free text that looks like a phone number (7+ digits,
// optionally with a leading + and common separators). Used on provider
// error messages, which can quote the destination number back
// (e.g. "The 'To' number +447700900123 is not a valid phone number").
const PHONE_LIKE = /\+?\d(?:[\s().-]?\d){6,}/g;

function redactPhoneNumbers(text) {
  if (typeof text !== 'string') return text;
  return text.replace(PHONE_LIKE, match => maskPhoneNumber(match));
}

module.exports = { describeTranscriptChunk, maskPhoneNumber, redactPhoneNumbers };
