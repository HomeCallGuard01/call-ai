// fairUse.js — visibility only (2026-09 dashboard build, per explicit
// instruction: "Do not automatically block legitimate customers yet").
// Classifies households against the configurable call-count thresholds
// in services/businessMetrics/config.js. Nothing here writes to the
// database or affects call delivery in any way — it only reads the same
// Unknown-caller call counts services/businessMetrics/callStats.js
// already computes and labels each household normal/warning/hard.
'use strict';

const { resolveFairUseThresholds } = require('./config');

// Pure — classifies one household's Unknown-caller call count this month
// against the two configured tiers.
function classifyFairUseTier(unknownCallCount, thresholds) {
  if (unknownCallCount >= thresholds.hardCallsPerMonth) return 'over_hard_threshold';
  if (unknownCallCount >= thresholds.warningCallsPerMonth) return 'approaching_threshold';
  return 'normal';
}

// Pure — takes the already-ranked household list (callStats.js's
// rankHouseholdsByUnknownCallCount) and adds the fair-use tier to each.
function classifyHouseholds(rankedHouseholds, env = process.env) {
  const thresholds = resolveFairUseThresholds(env);
  const classified = rankedHouseholds.map((h) => ({ ...h, tier: classifyFairUseTier(h.unknownCallCount, thresholds) }));
  return {
    thresholds,
    households: classified,
    approachingCount: classified.filter((h) => h.tier === 'approaching_threshold').length,
    overHardThresholdCount: classified.filter((h) => h.tier === 'over_hard_threshold').length,
  };
}

module.exports = { classifyFairUseTier, classifyHouseholds };
