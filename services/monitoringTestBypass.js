// TEST-ONLY DIAGNOSTIC — NOT A PRODUCTION FEATURE.
//
// Built for the launch-critical Media Streams A/B/C audio-quality
// experiment (2026-09-12 investigation): lets one explicitly-designated
// test household's screened calls skip live monitoring's
// <Start><Stream> only, so a physical test call can be compared against
// the same household's normal screened call and a trusted-contact call,
// isolating whether Media Streams itself contributes to the observed
// audio-quality degradation. See server.js's attachLiveMonitoring for
// the one call site that consults this.
//
// Deliberately a two-condition, fail-closed design — not just an env var
// someone might forget to unset:
//   1. DIAGNOSTIC_MONITORING_BYPASS_ENABLED must be exactly "true".
//   2. DISABLE_MONITORING_FOR_HOUSEHOLD_IDS must contain the exact,
//      valid-UUID household id being checked.
// Both absent/wrong/malformed → monitoring behaves exactly as today.
// Neither condition alone can bypass monitoring for anyone — a stale
// household id left in the allowlist does nothing unless the enable flag
// is ALSO deliberately set, and vice versa. This is the same fail-closed,
// resource-scoped philosophy already used for the staging environment
// guard (services/serverConfig.js) — a real, deliberate two-step action
// is required, never a single flag that could be left on by accident.
//
// Never disables screening, <Say>, <Dial><Client>, Voice SDK delivery,
// or contact classification — those are separate, unrelated call sites
// in server.js and this module has no way to reach them even if it
// wanted to. This module answers exactly one question: should THIS
// household's live-monitoring Stream be skipped, for this diagnostic
// experiment only.

'use strict';

// Case-insensitive, exact-length UUID match — deliberately no
// wildcard/prefix support. An entry that isn't a genuine UUID is simply
// dropped from the allowlist, never partially matched against anything.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses a comma-separated list of household ids, keeping only entries
// that are genuinely well-formed UUIDs (case-normalised to lowercase for
// comparison). Never throws; a missing/empty/malformed-only input yields
// an empty allowlist, which never matches any household.
function parseHouseholdAllowlist(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => UUID_RE.test(entry))
    .map(entry => entry.toLowerCase());
}

// The single decision point. Both conditions below are independently
// necessary; neither is sufficient alone — see this file's own header.
function shouldBypassMonitoringForTest(householdId, env = process.env) {
  if (!householdId) return false;
  if (!env || env.DIAGNOSTIC_MONITORING_BYPASS_ENABLED !== 'true') return false;

  const allowlist = parseHouseholdAllowlist(env.DISABLE_MONITORING_FOR_HOUSEHOLD_IDS);
  if (allowlist.length === 0) return false;

  return allowlist.includes(String(householdId).toLowerCase());
}

module.exports = { shouldBypassMonitoringForTest, parseHouseholdAllowlist };
