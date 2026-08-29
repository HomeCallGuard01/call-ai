// criticalSignals.js — Layer 1 of the two-layer architecture (2026-08-15,
// revised 2026-08-16 against an evidence-based UK scam-behaviour review —
// NCSC, gov.uk/HMRC, Take Five to Stop Fraud, UK Finance, Action Fraud,
// Met Police, FCA, HSBC/Which?/Cifas): red-line behaviours dangerous
// enough to intervene on immediately, independent of the accumulated
// 0-100 score in scorer.js (Layer 2).
//
// Deliberately a separate module/array from scoring/signals.js's
// RISK_PATTERNS: matching here means "act now", not "add weight". Some
// IDs (credential_or_otp_request, remote_access_request,
// gift_card_payment_request, cryptocurrency_payment_request) are the
// same behaviour also scored progressively — promoted here, not removed
// there, so a call that somehow bypasses termination still carries full
// progressive weight too. Regexes are intentionally duplicated (not
// imported) between the two files, matching the existing precedent, so
// each layer stays independently reasoned-about; keep them in sync by
// hand when editing either.
//
// Identity claims alone ("I'm calling from your bank/HMRC/police/BT")
// are deliberately absent from this list — see fabricated_authority_claim
// in scoring/signals.js, which stays progressive-only, by design. Every
// authoritative source reviewed agrees identity alone is not evidence.
//
// Two patterns are `standalone: false` — a red line only in combination
// with at least one standalone signal already present in the same
// accumulated transcript, never alone:
//
//   - prevents_independent_verification ("don't hang up" / generic "stay
//     on the line/phone/call"): real benign uses exist (a legitimate
//     helpdesk asking you to hold).
//   - authority_threat (arrest/warrant/bailiffs/prosecution): gov.uk is
//     explicit that a genuine authority never threatens arrest by phone,
//     which makes this materially stronger evidence than ordinary
//     urgency — but on its own it's still just a threat, not yet an
//     attempt to extract money/credentials/secrecy. Per the review,
//     combined with a financial/credential/isolation/collection ask, it
//     becomes definitive.
//
// verification_call_interception is standalone despite also being a
// "stay on the line" construction: UK bank guidance (RBS/NatWest
// "vishing tackled") names this specific tactic — the caller staying
// connected and playing a dial tone so a victim's own callback reaches
// the fraudster, not the bank — as a distinct, highly diagnostic pattern
// from generic "please hold".

'use strict';

const { hasUnnegatedMatch } = require('./negationGuard');

// negationAware: true (added 2026-08-29) — see signals.js's own comment
// on this flag for the full rationale (found via a real false-positive:
// "we will never ask for your PIN" was scoring as a live request and,
// because this is the standalone/immediate-termination layer, would
// have ended a call that was actively protecting the customer).
// Every STANDALONE pattern here with a realistic "we will never ask you
// to..." bank-disclaimer analogue is marked. isolation_from_family/
// isolation_from_bank, verification_call_interception, and
// stay_connected_during_money_transfer were inspected and deliberately
// left unmarked — none has a common real disclaimer phrasing of that
// specific shape. authority_threat and prevents_independent_verification
// are already compound-only (standalone: false), so a negated false
// match there can never alone terminate a call regardless — inspected,
// left as-is rather than adding an unnecessary extra guard.
const CRITICAL_PATTERNS = [
  {
    id: 'isolation_from_family',
    standalone: true,
    // The "your \w+ or your family" alternative covers the natural
    // compound construction ("don't speak to your bank or your family")
    // where "family" isn't directly adjacent to "speak/talk to" — found
    // missing against a real staging call's actual wording.
    regex: /\b(don'?t tell (anyone|your family|your (husband|wife|son|daughter))|don'?t (speak|talk) to your family|don'?t (speak|talk) to your \w+ or your family)\b/i,
    description: 'instructs the person not to tell or speak to their family — prevents independent verification',
  },
  {
    id: 'isolation_from_bank',
    standalone: true,
    regex: /\b(don'?t (speak|talk) to your bank|don'?t contact your bank|don'?t tell your bank)\b/i,
    description: 'instructs the person not to contact or speak to their bank — prevents independent verification',
  },
  {
    id: 'financial_redirection',
    standalone: true,
    negationAware: true,
    // Broadened 2026-08-16: the object noun (money/savings/funds/it) and
    // the "another account" case (no descriptor needed — "another"
    // already implies "a different one") were both missing, found
    // against Take Five/RBS wording ("move substantial amounts of money
    // into foreign accounts for safe-keeping") and natural paraphrase
    // ("transfer your savings somewhere secure"). Gerund verb forms
    // (moving/transferring/putting/sending) added same day for
    // consistency with the progressive layer's money-transfer widening —
    // the redirection-target requirement (to a safe/secure/different/
    // another account, or "somewhere safe/secure") is unchanged: generic
    // "transferring money" alone still stays progressive-only, never a
    // red line, see payment_or_transfer_request in scoring/signals.js.
    regex: /\b(move|moving|transfer|transferring|put|putting|send|sending) (your |the )?(money|savings|funds|it) (in)?to ((a |the )?(safe|secure|different|new) account|another account)\b|\b(move|moving|transfer|transferring|send|sending) (your |the )?(money|savings|funds|it) somewhere (safe|secure)\b/i,
    description: 'instructs the person to move or transfer money into a safe, secure, different, or another account',
  },
  {
    id: 'credential_or_otp_request',
    standalone: true,
    negationAware: true,
    regex: /\b(one[\s-]?time (passcode|code|password)|otp|pin\s*(number)?|cvv|security code|verification code|\w+[\s-]?digit code|passwords?|passcode|card number|sort code)\b/i,
    description: 'requests a password, PIN, OTP, CVV or full card/sort code — promoted from the progressive layer',
  },
  {
    id: 'remote_access_request',
    standalone: true,
    negationAware: true,
    regex: /\b(teamviewer|anydesk|remote access|remote desktop|install (this|the) app|download (this|the) (app|software)|give (me|us) access to your (computer|laptop|phone))\b/i,
    description: 'asks the caller to install remote-access software or grant device access — promoted from the progressive layer',
  },
  {
    id: 'directed_verification_callback',
    standalone: true,
    negationAware: true,
    // Deliberately narrow: requires a caller-supplied-number reference
    // ("this number" / "the number I've given you"), never "the number"
    // alone — "call the number on the back of your card" (legitimate
    // safety advice, independently sourced) must never match.
    regex: /\b(call (us |me )?back on this number|call this number to verify|call this number i'?m giving you|ring this number to (verify|confirm)|verify by calling this number|call the number (i'?ve|we'?ve) (just )?(given|sent) you)\b/i,
    description: 'directs the person to call a caller-supplied number as purported identity verification, rather than an independently-sourced official number',
  },
  {
    id: 'physical_collection_request',
    standalone: true,
    negationAware: true,
    // New 2026-08-16: courier fraud / card-collection scam — Action
    // Fraud and Met Police's most specific UK-only pattern, previously
    // entirely unrepresented in this codebase. Every alternative
    // requires the card/cash collection object explicitly — a bare
    // "someone will come round" or "the courier will drop it off" must
    // never match on its own (see the false-positive regression test).
    regex: /\b((someone|a courier) will (collect|come (round )?(and collect|to collect)) (your card|the card|your cash|the cash|it)|have (your |the )?card ready( for (collection|the courier))?|hand (over )?(your card|the card) to (the courier|whoever comes)|post (your card|the card) to (this|that|the) address|(wait for|expect) (someone|a courier) to (come (round )?(and )?)?collect (your card|the card|the cash|your cash))\b/i,
    description: 'arranges physical collection of a card or cash by a courier or person — courier fraud, the single most UK-specific pattern in the reviewed evidence',
  },
  {
    id: 'gift_card_payment_request',
    standalone: true,
    negationAware: true,
    // New 2026-08-16: near-zero legitimate use as a payment method to a
    // caller — named explicitly by gov.uk (HMRC), FCA, and courier-fraud
    // guidance. Requires a payment-action verb plus a specific gift-card
    // object, never a bare "gift card" mention (e.g. "I got you a gift
    // card for your birthday" must not match).
    regex: /\b(pay (using|with|via)|buy (some|a)|purchase (some|a)|get (some|a)) (gift cards?|(itunes|google play|amazon|steam) (gift )?(cards?|vouchers?)|(gift )?vouchers?)\b|\bread (me|out) the (gift card |voucher )?codes?\b/i,
    description: 'requests payment via gift cards — a payment method with essentially no legitimate use for a real bank, government body, or business',
  },
  {
    id: 'cryptocurrency_payment_request',
    standalone: true,
    negationAware: true,
    // New 2026-08-16: same reasoning as gift cards — gov.uk/FCA/courier-
    // fraud guidance all name crypto as a payment method scammers use
    // and legitimate organisations don't. Requires a payment-action verb
    // plus the currency, not a bare mention (e.g. discussing crypto as a
    // topic must not match).
    regex: /\b(pay (using|with|via)|send (it|the money|the payment)|transfer (it|the money)) (as |in |via )?(bitcoin|crypto(currency)?|ethereum)\b|\b(buy|purchase) (some |a )?(bitcoin|crypto(currency)?|ethereum)\b/i,
    description: 'requests payment or transfer via cryptocurrency — near-zero legitimate use for a real bank, government body, or business demanding payment this way',
  },
  {
    id: 'verification_call_interception',
    standalone: true,
    // New 2026-08-16, from RBS/NatWest's "vishing tackled" guidance: the
    // caller offers to stay connected while the victim "independently"
    // calls their bank/the police/159 — the callback then reaches the
    // fraudster, not the real organisation. Deliberately requires the
    // "while you call ..." construction, distinguishing it from generic
    // "stay on the line" (see prevents_independent_verification below,
    // and the false-positive regression tests: "stay on the line while I
    // check your appointment" / "...while I transfer you to another
    // department" must never match this).
    regex: /\b(stay|keep me|i'?ll stay)( on the (line|phone|call)| connected)?\s*while you (call|ring|dial) (your bank|the bank|the police|159)\b/i,
    description: 'offers to stay on the line while the person "independently" calls their bank/police/159 — intercepts the verification call itself, a specific tactic named in UK bank vishing guidance',
  },
  {
    id: 'stay_connected_during_money_transfer',
    standalone: true,
    // New 2026-08-16: "don't hang up while you transfer the money" is
    // dangerous as one combined construction, but bare "transfer the
    // money" (no account qualifier) is too generic to be a standalone
    // trigger on its own — an ordinary instruction like "transfer the
    // money to Dave for the bill" has nothing to do with fraud. This
    // pattern requires BOTH the isolation clause and the financial
    // action in the same utterance, distinguishing "...while YOU
    // transfer THE MONEY" from "...while I transfer you to another
    // department" (a different subject, a different kind of transfer).
    regex: /\b(don'?t hang up|stay on the (phone|line|call)|stay connected)\b.{0,30}\bwhile you (transfer|move|send) (the|your) money\b/i,
    description: 'instructs the person to keep the caller connected specifically while a money transfer takes place — isolation from hanging up combined with an active financial instruction in one utterance',
  },
  {
    id: 'authority_threat',
    standalone: false,
    // New 2026-08-16, split out of urgency_or_threat: gov.uk states a
    // genuine authority never threatens arrest by phone, which makes
    // this materially stronger evidence than ordinary urgency phrasing —
    // but alone it's still just a threat, not yet an attempt to extract
    // money/credentials/secrecy. Per the review: combined with any other
    // standalone critical signal (payment, money movement, credentials,
    // isolation, collection, remote access, caller-supplied callback),
    // treat as a red line.
    regex: /\b(arrest warrant|warrant (out )?for your arrest|you('ll| will) be arrested|bailiffs|court proceedings|prosecut(ed|ion))\b/i,
    description: 'threatens arrest, a warrant, bailiffs, or prosecution — a genuine authority never does this by phone; only a red line in combination with another critical signal',
  },
  {
    id: 'prevents_independent_verification',
    standalone: false,
    regex: /\b(don'?t hang up|stay on the (phone|line|call))\b/i,
    description: 'instructs the person not to hang up or to stay on the call — only a red line in combination with another critical signal, since alone it has legitimate uses',
  },
  {
    id: 'cash_withdrawal_instruction',
    standalone: false,
    negationAware: true,
    // Added 2026-08-29 (Apple remediation, UK scam-pattern review):
    // compound-only, same reasoning as prevents_independent_verification
    // — a withdrawal instruction alone (e.g. a genuine family member
    // asking someone to get cash out for them) is not itself dangerous,
    // but combined with any other standalone critical signal (a
    // fabricated-authority financial instruction, isolation, a
    // caller-supplied callback number, remote access, etc.) it becomes a
    // red line. Same regex as the progressive layer's copy in
    // scoring/signals.js — kept duplicated, not imported, matching this
    // file's own stated precedent for every other shared pattern here.
    regex: /\b(withdraw (a large (amount|sum) of |some |£\s?\d[\d,]* ?(pounds|worth)? ?(of |in )?)?(cash|money)|go to the bank and (withdraw|take out)|take out (a large (amount|sum) of |some )?(cash|money) from your (account|bank))\b/i,
    description: 'instructs the person to withdraw cash from the bank — only a red line in combination with another critical signal, since alone it has legitimate uses',
  },
];

/**
 * @param {string} transcript - the accumulated call transcript so far
 * @returns {{criticalSignals: {id: string, description: string}[], hasCriticalSignal: boolean}}
 */
function extractCriticalSignals(transcript) {
  const text = transcript || '';

  const standaloneMatches = [];
  const compoundMatches = [];

  for (const pattern of CRITICAL_PATTERNS) {
    const matched = pattern.negationAware
      ? hasUnnegatedMatch(text, pattern.regex)
      : pattern.regex.test(text);
    if (!matched) continue;
    const hit = { id: pattern.id, description: pattern.description };
    if (pattern.standalone) {
      standaloneMatches.push(hit);
    } else {
      compoundMatches.push(hit);
    }
  }

  // Any compound-only pattern only counts once at least one standalone
  // signal is also present in the same accumulated transcript — matches
  // however many compound patterns exist, not hardcoded to one.
  const criticalSignals = standaloneMatches.slice();
  if (standaloneMatches.length > 0) {
    criticalSignals.push(...compoundMatches);
  }

  return {
    criticalSignals,
    hasCriticalSignal: criticalSignals.length > 0,
  };
}

module.exports = { CRITICAL_PATTERNS, extractCriticalSignals };
