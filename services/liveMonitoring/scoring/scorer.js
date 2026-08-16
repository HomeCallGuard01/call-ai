// scorer.js
//
// Turns extracted signals (+ an optional validated model output) into a
// numeric risk_score (0-100) and confidence (0-100). This module never
// decides next_action or terminates anything — it only scores.

'use strict';

const { extractSignals } = require('./signals');
const { THRESHOLDS, FEATURE_FLAGS } = require('./thresholds');

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * @param {string} transcript
 * @param {object} [validatedModelOutput] - already schema-validated
 *   {risk_score, confidence, indicators?} or null/undefined if no usable
 *   model output this turn (timeout, error, malformed, or model disabled).
 * @param {object} [flags] - feature flag overrides for ablation testing.
 * @returns {{
 *   riskScore: number, confidence: number,
 *   riskIndicators: object[], protectiveIndicators: object[],
 *   ruleScore: number, modelScoreUsed: number|null,
 *   injectionDetected: boolean, selfAssertionDetected: boolean,
 *   highSeverityOverrideApplied: boolean, modelDistrustedDueToInjection: boolean,
 * }}
 */
function scoreTranscript(transcript, validatedModelOutput, flags = FEATURE_FLAGS, thresholds = THRESHOLDS) {
  const signals = extractSignals(transcript);
  const riskIndicators = signals.riskIndicators.slice();

  // A prompt-injection ATTEMPT is itself treated as a risk indicator, not
  // just a reason to distrust the model's score. Gated behind the same
  // flag as the model-distrust behaviour, so they're measured as one unit.
  if (flags.ENABLE_INJECTION_DISTRUST && signals.injectionDetected) {
    riskIndicators.push({
      id: 'prompt_injection_attempt',
      severity: 'medium',
      weight: 25,
      description: 'transcript contains a prompt-injection pattern aimed at a downstream classifier',
    });
  }

  let ruleScore = 0;
  for (const r of riskIndicators) ruleScore += r.weight;

  if (flags.ENABLE_PROTECTIVE_DAMPENING) {
    for (const p of signals.protectiveIndicators) ruleScore -= p.weight;
  }
  ruleScore = clamp(ruleScore, 0, 100);

  const modelDistrustedDueToInjection = Boolean(
    flags.ENABLE_INJECTION_DISTRUST && signals.injectionDetected
  );

  let modelWeight = flags.ENABLE_MODEL_BLEND ? thresholds.MODEL_WEIGHT : 0;
  if (modelDistrustedDueToInjection) {
    modelWeight = thresholds.MODEL_WEIGHT_UNDER_SUSPECTED_INJECTION;
  }
  const haveModel = flags.ENABLE_MODEL_BLEND && validatedModelOutput != null && modelWeight > 0;

  let riskScore;
  let confidence;
  let modelScoreUsed = null;

  if (haveModel) {
    modelScoreUsed = validatedModelOutput.risk_score;
    const ruleWeight = 1 - modelWeight;
    riskScore = clamp(Math.round(ruleWeight * ruleScore + modelWeight * modelScoreUsed), 0, 100);
    // Confidence: blend rule-derived confidence (more signals => more
    // confident either way) with the model's own reported confidence.
    const ruleConfidence = ruleBasedConfidence(signals);
    confidence = clamp(Math.round(0.5 * ruleConfidence + 0.5 * validatedModelOutput.confidence), 0, 100);
  } else {
    riskScore = ruleScore;
    confidence = ruleBasedConfidence(signals);
    // No usable model this turn: if the model was supposed to be in the
    // loop but wasn't (timeout/malformed/error), confidence is capped —
    // we have less evidence than we would with a model, so we should not
    // present false certainty.
    if (flags.ENABLE_MODEL_BLEND && !modelDistrustedDueToInjection) {
      confidence = Math.min(confidence, 55);
    }
  }

  let highSeverityOverrideApplied = false;
  if (flags.ENABLE_HIGH_SEVERITY_OVERRIDE && signals.hasHighSeverity) {
    if (riskScore < thresholds.HIGH_SEVERITY_SCORE_FLOOR) {
      riskScore = thresholds.HIGH_SEVERITY_SCORE_FLOOR;
      highSeverityOverrideApplied = true;
    }
    confidence = Math.max(confidence, 75); // an explicit high-severity ask is unambiguous
  }

  return {
    riskScore,
    confidence,
    riskIndicators,
    protectiveIndicators: signals.protectiveIndicators,
    ruleScore,
    modelScoreUsed,
    injectionDetected: signals.injectionDetected,
    selfAssertionDetected: signals.selfAssertionDetected,
    highSeverityOverrideApplied,
    modelDistrustedDueToInjection,
  };
}

function ruleBasedConfidence(signals) {
  const totalIndicators = signals.riskIndicators.length + signals.protectiveIndicators.length;
  if (totalIndicators === 0) return 20; // no evidence either way — low confidence
  if (signals.hasHighSeverity) return 85;
  // More corroborating indicators => more confidence, capped.
  return clamp(30 + totalIndicators * 15, 30, 80);
}

module.exports = { scoreTranscript, clamp };
