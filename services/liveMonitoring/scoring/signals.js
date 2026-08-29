// signals.js
//
// Rule-based signal extraction: scans a transcript for risk indicators,
// protective indicators, prompt-injection attempts, and "self-assertion"
// claims that must never be treated as evidence of safety.
//
// Behaviour-based by design (Decision 014): identity claims alone
// ("I'm calling from the bank/HMRC/police") are a real but low-weight
// signal — real risk comes from what the caller asks the person to DO,
// not who they claim to be.

'use strict';

// --- risk indicator patterns -------------------------------------------
// severity: 'high' patterns can trigger the high-severity override
// (thresholds.js's HIGH_SEVERITY_SCORE_FLOOR) when that flag is on.
const RISK_PATTERNS = [
  {
    id: 'credential_or_otp_request',
    severity: 'high',
    weight: 55,
    regex: /\b(one[\s-]?time (passcode|code|password)|otp|pin\s*(number)?|cvv|security code|verification code|\w+[\s-]?digit code|passwords?|passcode|card number|sort code)\b/i,
    description: 'asks for a password, PIN, OTP, CVV or full card/sort code',
  },
  {
    id: 'remote_access_request',
    severity: 'high',
    weight: 55,
    regex: /\b(teamviewer|anydesk|remote access|remote desktop|install (this|the) app|download (this|the) (app|software)|give (me|us) access to your (computer|laptop|phone))\b/i,
    description: 'asks the caller to install remote-access software or grant device access',
  },
  {
    id: 'fabricated_authority_claim',
    severity: 'medium',
    weight: 25,
    regex: /\b(this is (hmrc|the police|action fraud|your bank|amazon (security|fraud) team)|dwp compliance|hm revenue|national crime agency|from the fraud (team|department))\b/i,
    description: 'claims to be calling from a bank/government/law-enforcement authority',
  },
  {
    id: 'urgency_or_threat',
    severity: 'medium',
    weight: 20,
    // Widened 2026-08-15 after a real staging call: a scripted urgency line
    // ("we need to sort it out fairly quickly" / "you need to deal with
    // this today... don't delay") was spoken, transcribed in part, but
    // never matched — the old list only covered fairly formal/explicit
    // wording (urgent, immediately, suspended account, bailiffs...), not
    // natural pressure phrasing. Every added alternative is still a
    // multi-word action+timeframe/negation construction, never a bare
    // "today"/"quickly"/"delay" — those words alone must never move the
    // score (see the regression tests asserting exactly that).
    //
    // 2026-08-16: arrest/warrant/bailiffs/court-proceedings wording moved
    // OUT to its own authority_threat pattern below — the evidence review
    // (gov.uk: a genuine authority never threatens arrest by phone) found
    // these were materially stronger than ordinary urgency and deserved
    // more weight, not the same 20 as "need to sort this out today".
    regex: /\b(urgent|immediately|right away|within the hour|suspend(ed)? your account|account (will be|has been|may be) (suspended|frozen|closed|blocked)|final notice|needs? to (deal with (this|it)|sort (this|it) out|resolve (this|it)|act) (now|today|immediately|quickly|straight away|right away)|needs? to do (this|it) (quickly|now|today|immediately)|needs? dealing with (now|today|immediately)|must do (this|it) (now|today)|(can'?t|cannot|don'?t|do not) delay( this| it)?|time is running out|consequences if you (don'?t|do not) (act|do (this|so)))\b/i,
    description: 'uses urgency/pressure language — either explicit (urgent, suspended account) or a natural action+timeframe/negation construction (e.g. "need to sort this out today", "can\'t delay this") — never a bare timeframe word alone. Arrest/legal threats are scored separately, see authority_threat',
  },
  {
    id: 'authority_threat',
    severity: 'medium',
    weight: 35,
    // New 2026-08-16, split out of urgency_or_threat (see above): gov.uk
    // is explicit that a genuine authority never threatens arrest by
    // phone — evidence supports weighting this well above ordinary
    // urgency. Also promoted to criticalSignals.js as a compound-only red
    // line (combined with a financial/credential/isolation/collection
    // ask), but stays here too so it still contributes real progressive
    // weight on its own or if termination is ever skipped/fails.
    regex: /\b(arrest warrant|warrant (out )?for your arrest|you('ll| will) be arrested|bailiffs|court proceedings|prosecut(ed|ion))\b/i,
    description: 'threatens arrest, a warrant, bailiffs, or prosecution — a genuine authority never does this by phone',
  },
  {
    id: 'payment_or_transfer_request',
    severity: 'medium',
    weight: 20,
    // Gift-card and cryptocurrency wording moved OUT 2026-08-16 to their
    // own dedicated patterns below — the evidence review found these
    // payment methods have essentially no legitimate use (gov.uk/FCA/
    // courier-fraud guidance all name them explicitly), warranting more
    // weight than a generic "processing fee" mention.
    //
    // (transfer|transferring|move|moving|send|sending) (money|funds|savings)
    // added 2026-08-16 after a real call: "I need you to start looking at
    // transferring money" didn't match anything (gerund form, no
    // possessive, no account qualifier). This is deliberately generic
    // transfer-intent language only — it stays in the progressive bucket,
    // not promoted to criticalSignals.js's financial_redirection, which
    // still requires the actual redirection target ("to a safe/secure/
    // different/another account") to be a red line. Combined with
    // whatever else has already accumulated in a real scam call, this
    // alone is usually enough to cross the warning threshold without
    // needing extra weight — see the regression tests.
    regex: /\b(bank transfer|wire the money|payment (now|today)|processing fee|release fee|unlock fee|transfer your money|safe account|move (your |the )?money|(transfer|transferring|move|moving|send|sending) (your |the )?(money|funds|savings))\b/i,
    description: 'asks for a bank transfer, wire payment, fee, "safe account" instruction, or generic money-movement intent (transfer/move/send money, funds, or savings, including gerund forms)',
  },
  {
    id: 'gift_card_payment_request',
    severity: 'high',
    weight: 45,
    // New 2026-08-16, promoted to criticalSignals.js as a standalone red
    // line — see that file's comment for the evidence and false-positive
    // reasoning (requires a payment-action verb, never a bare mention).
    regex: /\b(pay (using|with|via)|buy (some|a)|purchase (some|a)|get (some|a)) (gift cards?|(itunes|google play|amazon|steam) (gift )?cards?|(gift )?vouchers?)\b|\bread (me|out) the (gift card |voucher )?codes?\b/i,
    description: 'requests payment via gift cards — a payment method with essentially no legitimate use for a real bank, government body, or business',
  },
  {
    id: 'cryptocurrency_payment_request',
    severity: 'high',
    weight: 45,
    // New 2026-08-16, promoted to criticalSignals.js as a standalone red
    // line — see that file's comment for the evidence and false-positive
    // reasoning (requires a payment-action verb, never a bare mention).
    regex: /\b(pay (using|with|via)|send (it|the money|the payment)|transfer (it|the money)) (as |in |via )?(bitcoin|crypto(currency)?|ethereum)\b|\b(buy|purchase) (some |a )?(bitcoin|crypto(currency)?|ethereum)\b/i,
    description: 'requests payment or transfer via cryptocurrency — near-zero legitimate use for a real bank, government body, or business demanding payment this way',
  },
  {
    id: 'secrecy_or_coaching',
    severity: 'medium',
    weight: 25,
    // "stay on the call" and "don't contact your bank" added 2026-08-15 —
    // a real staging call used "stay on the call" (not "phone"/"line") and
    // "don't contact your bank" (not "speak"/"talk to"), neither of which
    // the original wording list covered.
    regex: /\b(don'?t tell (anyone|your (bank|family|husband|wife|son|daughter))|keep this (between us|private|confidential)|don'?t (speak|talk) to (your bank|anyone)|don'?t contact (your bank|anyone)|don'?t hang up|stay on the (phone|line|call)|this is confidential)\b/i,
    description: 'instructs secrecy or discourages the person from checking with anyone else — a real audit found this missing from the original ruleset',
  },
  {
    id: 'refund_or_overpayment_pretext',
    severity: 'low',
    weight: 12,
    regex: /\b(refund|overpaid|owe you money|compensation (is )?due|entitled to a (refund|rebate))\b/i,
    description: 'uses a refund/overpayment pretext, a common social-engineering opener',
  },
  {
    id: 'cash_withdrawal_instruction',
    severity: 'medium',
    weight: 25,
    // Added 2026-08-29 (Apple remediation, UK scam-pattern review — Action
    // Fraud / Met Police courier-fraud guidance): being instructed to
    // withdraw a specific sum of cash from the bank is the standard
    // precursor to a card/cash-collection scam, distinct from
    // physical_collection_request (criticalSignals.js) which covers the
    // handover itself. Requires an actual instruction verb plus
    // cash/money in a bank/withdrawal context — never a bare "cash"
    // mention (e.g. "I paid cash for the shopping" must not match; see
    // the false-positive regression test).
    regex: /\b(withdraw (a large (amount|sum) of |some |£\s?\d[\d,]* ?(pounds|worth)? ?(of |in )?)?(cash|money)|go to the bank and (withdraw|take out)|take out (a large (amount|sum) of |some )?(cash|money) from your (account|bank))\b/i,
    description: 'instructs the person to withdraw cash from the bank — the standard precursor to courier/card-collection fraud',
  },
  {
    id: 'investigation_pretext',
    severity: 'medium',
    weight: 20,
    // Added 2026-08-29: Action Fraud/police guidance names "help us with
    // an investigation" / "you've been selected to assist" as a common
    // pretext used to recruit a victim into courier fraud or a fake-
    // police scam — distinct from a bare identity claim
    // (fabricated_authority_claim above), which stays low-weight on its
    // own by design.
    regex: /\b((help|assist)( (us|the (bank|police)))? with (an |our )?investigation|assist (us|the (bank|police)) in (an |our )?investigation|you'?ve been (selected|chosen) to (help|assist)|part of an? (ongoing )?(police )?investigation|(acting|act) as an? (undercover )?agent for (the bank|the police))\b/i,
    description: 'frames the call as needing the person\'s help with an "investigation" — a known pretext used to recruit a victim into courier fraud',
  },
  {
    id: 'unexpected_prize_or_investment_pretext',
    severity: 'low',
    weight: 12,
    // Added 2026-08-29: deliberately requires unambiguous scam-adjacent
    // qualifying language (guaranteed/risk-free/selected/won), never a
    // bare "investment" or "prize" mention — a genuine financial adviser
    // discussing investments, or a legitimate competition win, must not
    // match this on its own (see the false-positive regression test).
    regex: /\b(guaranteed (return|profit)|risk[- ]?free investment|you'?ve (won|been selected to receive)|selected to receive (a|this) (prize|refund|reward)|limited[- ]?time investment opportunity|double your money)\b/i,
    description: 'uses unexpected-prize or too-good-to-be-true investment framing — a common social-engineering opener when paired with a request for money or details',
  },
];

// --- prompt-injection patterns -------------------------------------------
// Text in the transcript attempting to steer a downstream model's output.
// Detected regardless of whether a model is even in the loop, because the
// attempt itself is a red flag about the caller's intent.
const INJECTION_PATTERNS = [
  /ignore (all|any|the)?\s*(previous|prior|above)?\s*instructions?/i,
  /you are now/i,
  /system\s*:/i,
  /disregard (the|your|all)?\s*(rules|instructions|prompt)/i,
  /act as (a|an)?\s*\w+/i,
  /forget (your|the|all)?\s*(instructions|rules|prompt)/i,
  /classify this (call |transcript )?as safe/i,
  /respond (only )?with safe/i,
];

// --- self-assertion patterns (never evidence of safety) ------------------
const SELF_ASSERTION_PATTERNS = [
  /this is not a scam/i,
  /i('m| am) not (a scammer|trying to scam you|a fraudster)/i,
  /i promise (this is|it'?s) (legitimate|real|genuine)/i,
  /trust me/i,
  /you can trust me/i,
  /i('m| am) (calling )?genuinely/i,
];

// --- protective indicator patterns ---------------------------------------
const PROTECTIVE_PATTERNS = [
  {
    id: 'known_relationship_reference',
    weight: 15,
    regex: /\b(mum|mom|dad|son|daughter|grandad|grandma|nan|auntie|uncle|neighbour|neighbor)\b/i,
    description: 'refers to a family/neighbour relationship',
  },
  {
    id: 'routine_appointment_context',
    weight: 12,
    regex: /\b(appointment|prescription|surgery|dentist|check[- ]?up|reschedul(e|ing)|reminder (about|for) your)\b/i,
    description: 'routine appointment/healthcare context, no financial ask',
  },
  {
    id: 'tradesperson_or_local_business_context',
    // Deliberately does NOT include delivery/parcel/courier wording —
    // scam parcel/courier-fee pretexts also mention those words, so
    // treating them as inherently protective would actively suppress
    // real scam scores. Narrowed to unambiguous tradesperson/estate-agent
    // wording only.
    weight: 10,
    regex: /\b(plumber|electrician|boiler service|quote for the|estate agent|viewing (on|at))\b/i,
    description: 'tradesperson/estate-agent context',
  },
];

function extractSignals(transcript) {
  const text = transcript || '';

  const riskIndicators = [];
  for (const pattern of RISK_PATTERNS) {
    if (pattern.regex.test(text)) {
      riskIndicators.push({
        id: pattern.id,
        severity: pattern.severity,
        weight: pattern.weight,
        description: pattern.description,
      });
    }
  }

  const injectionAttempts = INJECTION_PATTERNS.filter((re) => re.test(text));
  const selfAssertions = SELF_ASSERTION_PATTERNS.filter((re) => re.test(text));

  const protectiveIndicators = [];
  for (const pattern of PROTECTIVE_PATTERNS) {
    if (pattern.regex.test(text)) {
      protectiveIndicators.push({ id: pattern.id, weight: pattern.weight, description: pattern.description });
    }
  }

  return {
    riskIndicators,
    protectiveIndicators,
    injectionDetected: injectionAttempts.length > 0,
    injectionMatchCount: injectionAttempts.length,
    selfAssertionDetected: selfAssertions.length > 0,
    selfAssertionMatchCount: selfAssertions.length,
    hasHighSeverity: riskIndicators.some((r) => r.severity === 'high'),
  };
}

module.exports = {
  RISK_PATTERNS,
  INJECTION_PATTERNS,
  SELF_ASSERTION_PATTERNS,
  PROTECTIVE_PATTERNS,
  extractSignals,
};
