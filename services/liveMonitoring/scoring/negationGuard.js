// negationGuard.js
//
// Distinguishes a genuine, live request ("tell me your PIN") from a
// protective/informational statement about what a scammer might ask or
// what a legitimate organisation would never ask ("we will never ask
// for your PIN") — both contain the exact same trigger words, but only
// one is actually dangerous.
//
// Found 2026-08-29 during Apple remediation: the existing
// credential_or_otp_request pattern matched the bare word "PIN"
// regardless of context, meaning a bank's own standard anti-fraud
// disclaimer ("we will never ask you for your PIN") scored at the
// high-severity floor and would trigger immediate call termination —
// on a call actively protecting the customer, not attacking them.
//
// Deliberately narrow, not a bare "not"/"never" scan (which would be
// far too broad and would suppress genuine detection — a scammer
// legitimately says "don't worry, just tell me your PIN" too). Every
// lead-in phrase here is the specific, well-documented wording UK
// banks/NCSC/Take Five actually use in their own published anti-fraud
// guidance and phone scripts ("we will never ask...", "never give/
// share/tell...", "don't/won't give/share/tell/read out/hand over/
// disclose..."). A match is only suppressed when one of these specific
// constructions appears CLOSE before it (see MAX_NEGATION_GAP_CHARS) —
// or is a same-negation list item chained to one that was ("PIN or
// password") — an ordinary request sentence, or an unrelated later
// clause in the same sentence, is completely unaffected.

'use strict';

// Deliberately NOT end-anchored to the match position — natural English
// almost always has one or two possessive/filler words between the
// negation verb and the actual noun ("ask for YOUR PIN", "tell me YOUR
// security code"), and trying to enumerate every such filler exactly
// would be fragile. Anchoring only to "appears somewhere in the same
// sentence, before the match" is the more robust check; the sentence-
// boundary window in precedingWindow() below is what keeps this from
// being too loose (a negation in an earlier, separate sentence can never
// reach across a full stop into the next one).
const NEGATION_LEAD_INS = [
  // "we/your bank/the bank/HMRC/the police will never ask/tell/request/require"
  /\b(we|your bank|the bank|hmrc|the police)('ll| will) never (ask|tell|request|require)\b/i,
  // "never give/share/tell/provide/send"
  /\bnever (give|share|tell|provide|send)\b/i,
  // "don't/do not/won't/will not/shouldn't/never + give/share/tell/provide/send/read (out)/hand over/disclose"
  /\b(don'?t|do not|won'?t|will not|should(n'?t)?( ever)?|never)\s+(give|share|tell|provide|send|read( out)?|hand over|disclose)\b/i,
];

// The window is capped to the last sentence boundary before the match
// (or 80 chars, whichever is closer) so a negation in an earlier,
// separate sentence can never suppress a genuine request in the next
// one — "We will never ask for your PIN. Now, tell me your PIN." must
// still detect the second, real request.
function precedingWindow(text, index, maxChars = 80) {
  const from = Math.max(0, index - maxChars);
  const slice = text.slice(from, index);
  const lastBoundary = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('?'), slice.lastIndexOf('!'));
  return { text: lastBoundary === -1 ? slice : slice.slice(lastBoundary + 1), start: from + (lastBoundary === -1 ? 0 : lastBoundary + 1) };
}

function withGlobalFlag(regex) {
  return regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
}

// Found 2026-08-29 (full-suite regression run): a sentence-wide window
// with no distance limit let an EARLIER, unrelated negated clause
// suppress a LATER, unrelated genuine instruction in the same
// comma-joined sentence — "don't tell your bank, this is urgent,
// transfer your money to the safe account right now" was wrongly
// suppressed via the "don't tell" lead-in match, even though "transfer
// your money" is a completely separate clause with its own subject and
// verb, not the object of "don't tell". A negation lead-in only governs
// a request that's genuinely close to it (allowing for filler/possessive
// words — "ask for YOUR PIN", "tell me YOUR security code" — but not an
// entire separate clause). 20 chars comfortably covers every filler
// pattern in this module's own regression suite (max observed: 16, for
// "...ask you to install TeamViewer...") while rejecting the 28-char gap
// in the regression case above.
const MAX_NEGATION_GAP_CHARS = 20;

// A real bank disclaimer routinely lists several credential types under
// one negation ("we will never ask for your PIN or password", "...PIN,
// password, or security code") — the list items after the first are
// often further than MAX_NEGATION_GAP_CHARS from the negation lead-in
// itself. Rather than widen the gap globally (which would let unrelated
// clauses leak back in, see the regression above), a later match
// inherits the negation from the immediately preceding match when the
// text between them is nothing but a list joiner (",", "or", "and",
// optionally combined, e.g. ", or") — never a real clause boundary.
const LIST_JOINER = /^[\s,]*(?:(?:or|and)[\s,]*)?$/i;

function isPureListJoiner(text) {
  return LIST_JOINER.test(text);
}

function negationAppliesDirectly(text, matchIndex) {
  const { text: preceding, start } = precedingWindow(text, matchIndex);
  return NEGATION_LEAD_INS.some(neg => {
    const negGlobal = withGlobalFlag(neg);
    return [...preceding.matchAll(negGlobal)].some(negMatch => {
      const negEnd = start + negMatch.index + negMatch[0].length;
      return matchIndex - negEnd <= MAX_NEGATION_GAP_CHARS;
    });
  });
}

// Returns true only if at least one occurrence of `regex` in `text` is
// NOT a negated/protective statement — i.e. a genuine, unnegated request
// is present. False only when every occurrence is negated/protective (or
// there's no match at all).
function hasUnnegatedMatch(text, regex) {
  const globalRegex = withGlobalFlag(regex);
  const matches = [...text.matchAll(globalRegex)];
  if (matches.length === 0) return false;

  let previousEnd = null;
  let previousNegated = false;

  return matches.some(match => {
    const directlyNegated = negationAppliesDirectly(text, match.index);
    const inheritedNegated =
      !directlyNegated &&
      previousEnd !== null &&
      previousNegated &&
      isPureListJoiner(text.slice(previousEnd, match.index));
    const negated = directlyNegated || inheritedNegated;

    previousEnd = match.index + match[0].length;
    previousNegated = negated;

    return !negated;
  });
}

module.exports = { hasUnnegatedMatch, NEGATION_LEAD_INS };
