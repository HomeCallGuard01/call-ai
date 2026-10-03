// Launch-gate status vocabulary and the rules that stop a control being
// called PROVEN without evidence.
//
// The rules encode the gate's critical principle: an alert, a red
// dashboard, a stopped monitoring stream or "the provider probably blocks
// it" is never by itself evidence that HCG's financial exposure is
// contained. Only an enforced control with a reproducible test (automated)
// or a recorded manual execution (manual) can make something PROVEN.

export const STATUSES = Object.freeze(['PROVEN', 'PARTIAL', 'UNPROVEN', 'FAIL']);

// Evidence kinds that can, on their own, support PROVEN.
export const STRONG_EVIDENCE = Object.freeze([
  'automated-test',      // a test in this repo that exercises the enforced control and passes
  'manual-execution',    // a dated, recorded execution of a manual spec (who/when/env/result)
  'provider-config-export', // an exported provider setting (e.g. Twilio geo-permissions JSON), dated
]);

// Evidence kinds that never support PROVEN on their own. They are useful,
// but they describe observation, not containment.
export const WEAK_EVIDENCE = Object.freeze([
  'alert',               // "an alert is generated"
  'dashboard',           // "the dashboard shows red"
  'monitoring-stop',     // "AI/monitoring stream stops" — the PSTN leg may still be billing
  'provider-assumption', // "the provider probably blocks it"
  'design-doc',          // a design or plan, however good
  'code-inspection',     // reading code; necessary, not sufficient
]);

export const EVIDENCE_KINDS = Object.freeze([...STRONG_EVIDENCE, ...WEAK_EVIDENCE]);

/**
 * Returns a list of rule violations for one claimed status. Empty list =
 * the claim is admissible. Used by both the registry self-test and the
 * runner, so a hand-edited registry cannot quietly claim PROVEN.
 */
export function validateClaim({ status, evidence = [] }) {
  const problems = [];
  if (!STATUSES.includes(status)) {
    problems.push(`unknown status "${status}"`);
    return problems;
  }
  for (const e of evidence) {
    if (!EVIDENCE_KINDS.includes(e.kind)) problems.push(`unknown evidence kind "${e.kind}"`);
  }
  if (status === 'PROVEN') {
    const strong = evidence.filter(e => STRONG_EVIDENCE.includes(e.kind));
    if (strong.length === 0) {
      problems.push('PROVEN requires at least one strong evidence item (automated-test, manual-execution or provider-config-export); alerts, dashboards, monitoring-stop, provider assumptions, design docs and code inspection do not count');
    }
    for (const e of strong) {
      if (!e.ref) problems.push(`strong evidence of kind "${e.kind}" has no ref`);
      if (e.kind === 'manual-execution' && !(e.date && e.by && e.env)) {
        problems.push('manual-execution evidence needs date, by and env');
      }
    }
  }
  return problems;
}

/**
 * Combines executable results with the registry's claimed status.
 *   - any FAIL result ⇒ FAIL, whatever the registry claims;
 *   - PASS / UNPROVEN results never upgrade a claim (promotion to PROVEN
 *     is a reviewed registry edit with strong evidence, never automatic);
 *   - if the claim is FAIL but every attached result PASSes, the claim is
 *     kept and flagged `stale` so a human re-assesses it.
 * results: [{ status: 'PASS'|'FAIL'|'UNPROVEN' }]
 */
export function combine(claimed, results = []) {
  if (results.some(r => r.status === 'FAIL')) return { status: 'FAIL', stale: false };
  const allPass = results.length > 0 && results.every(r => r.status === 'PASS');
  return { status: claimed, stale: claimed === 'FAIL' && allPass };
}
