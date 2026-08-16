// thresholds.js
//
// All the magic numbers for the risk-scoring engine live here, named and
// documented, so tuning is a one-place change and every threshold has a
// stated rationale. Nothing in scoring/ should hardcode a number that
// means something — it should reference this file.

'use strict';

const THRESHOLDS = Object.freeze({
  // --- classification bands (risk_score 0-100) -------------------------
  // score <= SAFE_MAX                      -> 'safe'
  // SAFE_MAX < score <= SUSPICIOUS_MAX      -> 'suspicious'
  // score > SUSPICIOUS_MAX                  -> 'high_risk'
  SAFE_MAX: 25,
  SUSPICIOUS_MAX: 60,

  // --- confidence ---------------------------------------------------
  // Below this, we don't trust the classification enough to act on it
  // decisively; classification is forced to 'unknown' instead, even if
  // the raw score would otherwise land in a normal band.
  MIN_CONFIDENCE_TO_TRUST: 35,

  // Minimum confidence required before a 'safe' classification is allowed
  // to produce a 'connect' next_action. A low-confidence "safe" score
  // (e.g. because almost no signal was found either way) is routed to
  // ask_question instead of being connected outright.
  MIN_CONFIDENCE_FOR_CONNECT: 50,

  // --- high-severity override ------------------------------------------
  // Any single indicator tagged severity:'high' (OTP/password/remote-access
  // requests, explicit fabricated-authority + payment demand, etc.) forces
  // the blended score up to at least this floor and the classification to
  // 'high_risk', regardless of what the rest of the average looks like.
  // Rationale: these are the signals real fraud-prevention guidance (UK
  // Finance / Action Fraud) treats as near-unconditional red flags — no
  // legitimate bank, HMRC officer, or courier ever needs your PIN, OTP, or
  // remote-desktop access read aloud over the phone.
  HIGH_SEVERITY_SCORE_FLOOR: 90,

  // --- model-vs-rules blend --------------------------------------------
  // When a valid, schema-passing model score is available, the final rule
  // score is a weighted blend of the deterministic rule-based score and
  // the model's self-reported score. Rules get the majority weight
  // deliberately: the model is an assistive signal, not the source of
  // truth.
  RULE_WEIGHT: 0.65,
  MODEL_WEIGHT: 0.35,

  // If prompt-injection patterns are detected in the transcript, the
  // model's self-reported score is distrusted entirely (weight zero) and
  // the engine falls back to pure rule-based scoring for that turn, on
  // the theory that injected text may have been crafted to manipulate the
  // model's own output. The injection attempt itself is also logged as a
  // risk indicator.
  MODEL_WEIGHT_UNDER_SUSPECTED_INJECTION: 0,

  // --- live monitoring (post-connect, continuous) -----------------------
  // The risk_score at or above which a post-connect live-monitored call
  // triggers exactly one SMS warning to the household. Deliberately
  // reuses SUSPICIOUS_MAX's value (not a new, unevidenced number) — it's
  // the same boundary this scoring engine already uses to mark a
  // transcript as crossing from "suspicious" into "high_risk" territory;
  // kept as its own named constant so live-monitoring's trigger point can
  // be tuned independently later without redefining what SUSPICIOUS_MAX
  // means elsewhere.
  LIVE_MONITORING_WARN_MIN: 60,
});

// --- feature flags -------------------------------------------------------
// Every non-trivial piece of scoring behaviour beyond a bare rule-based
// keyword scorer is gated behind a flag here, OFF-able independently.
const FEATURE_FLAGS = Object.freeze({
  ENABLE_MODEL_BLEND: true, // blend injected model risk_score into the rule score (false = pure rule-based)
  ENABLE_HIGH_SEVERITY_OVERRIDE: true, // force score floor + high_risk when a high-severity indicator fires
  ENABLE_PROTECTIVE_DAMPENING: true, // let protective indicators reduce the rule score
  ENABLE_INJECTION_DISTRUST: true, // zero the model's weight when prompt-injection patterns are detected
});

function withFlags(overrides = {}) {
  return Object.freeze({ ...FEATURE_FLAGS, ...overrides });
}

function withThresholds(overrides = {}) {
  return Object.freeze({ ...THRESHOLDS, ...overrides });
}

module.exports = { THRESHOLDS, FEATURE_FLAGS, withFlags, withThresholds };
