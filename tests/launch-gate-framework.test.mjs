// Self-test for the launch-gate framework (tests/launch-gate/). This test
// must PASS on any tree — it validates the gate's own integrity, not HCG's
// launch readiness. Launch readiness is `node tests/launch-gate/run.mjs
// --enforce`, which is expected to exit 1 until every blocker is PROVEN.
//
// Deliberately NOT added to package.json's single-line "test" script:
// that line conflicts across ~19 unmerged branches already. Add it at
// integration time (see docs/launch-gate/INTEGRATION_PLAN.md).
//
// Run with: node tests/launch-gate-framework.test.mjs

import { CONTROLS, SCENARIOS } from './launch-gate/registry.mjs';
import { validateClaim, combine, STATUSES } from './launch-gate/lib/status.mjs';
import { inventory, duplicatesInTree, migrationNumber } from './launch-gate/lib/migrations.mjs';
import { runFinancialContract } from './launch-gate/financial-contract.mjs';
import { createSubject as reference } from './launch-gate/adapters/reference-model.mjs';
import { createSubject as naive } from './launch-gate/adapters/naive-model.mjs';
import { runProbes } from './launch-gate/probes.mjs';

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// --- status rules: weak evidence can never make PROVEN -------------------
for (const kind of ['alert', 'dashboard', 'monitoring-stop', 'provider-assumption', 'design-doc', 'code-inspection']) {
  check(validateClaim({ status: 'PROVEN', evidence: [{ kind, ref: 'x' }] }).length > 0,
    `PROVEN backed only by "${kind}" is rejected`);
}
check(validateClaim({ status: 'PROVEN', evidence: [{ kind: 'automated-test', ref: 'tests/x.test.mjs' }] }).length === 0,
  'PROVEN backed by an automated test with a ref is admissible');
check(validateClaim({ status: 'PROVEN', evidence: [{ kind: 'manual-execution', ref: 'M-1' }] }).length > 0,
  'manual-execution evidence without date/by/env is rejected');
check(validateClaim({ status: 'SAFE', evidence: [] }).length > 0, 'unknown status rejected');

// --- combine: results can only lower, never raise ------------------------
check(combine('PARTIAL', [{ status: 'FAIL' }]).status === 'FAIL', 'a FAILing probe forces FAIL');
check(combine('PARTIAL', [{ status: 'PASS' }]).status === 'PARTIAL', 'a PASSing probe never upgrades a claim');
check(combine('UNPROVEN', [{ status: 'PASS' }]).status === 'UNPROVEN', 'PASS cannot turn UNPROVEN into anything better');
check(combine('PARTIAL', [{ status: 'UNPROVEN' }]).status === 'PARTIAL', 'a probe that could not run does not change the claim');
check(combine('FAIL', [{ status: 'PASS' }]).stale === true, 'claimed FAIL with all-PASS results is flagged stale for re-assessment');

// --- registry integrity --------------------------------------------------
const controlIds = new Set(CONTROLS.map(c => c.id));
check(controlIds.size === CONTROLS.length, 'control ids are unique');
for (const a of 'ABCDEFGHI') check(CONTROLS.some(c => c.area === a), `area ${a} has at least one control`);
for (const c of CONTROLS) {
  const p = validateClaim(c);
  check(p.length === 0, `control ${c.id} claim admissible${p.length ? ' — ' + p.join('; ') : ''}`);
}

check(SCENARIOS.length === 30, 'exactly the 30 required adversarial scenarios are registered');
check(SCENARIOS.every((s, i) => s.id === `S${i + 1}`), 'scenarios are S1..S30 in order');
const REQUIRED = ['title', 'precondition', 'action', 'expected', 'maxExposure', 'mode', 'evidence', 'owner', 'status'];
for (const s of SCENARIOS) {
  const missing = REQUIRED.filter(k => !s[k] || String(s[k]).trim() === '');
  check(missing.length === 0, `${s.id} fully specified${missing.length ? ' — missing ' + missing.join(', ') : ''}`);
  check(STATUSES.includes(s.status) && s.status !== 'PROVEN', `${s.id} status is valid and not PROVEN on the baseline (no scenario has strong evidence yet)`);
  check((s.controls || []).every(id => controlIds.has(id)), `${s.id} references only existing controls`);
  check(['automated', 'manual', 'automated+manual'].includes(s.mode), `${s.id} mode is automated/manual/automated+manual`);
}

const probeResults = await (async () => {
  const e = console.error, w = console.warn, l = console.log;
  console.error = console.warn = console.log = () => {};
  try { return await runProbes(); } finally { console.error = e; console.warn = w; console.log = l; }
})();
const probeIds = new Set(probeResults.map(p => p.id));
const contractIds = new Set(['FC-1', 'FC-2', 'FC-3', 'FC-4', 'FC-5', 'FC-6', 'FC-7', 'FC-8']);
for (const item of [...CONTROLS, ...SCENARIOS]) {
  for (const id of item.probes || []) check(probeIds.has(id), `${item.id} → probe ${id} exists`);
  for (const id of item.contract || []) check(contractIds.has(id), `${item.id} → contract ${id} exists`);
}
check(probeResults.every(p => ['PASS', 'FAIL', 'UNPROVEN'].includes(p.status)), 'every probe returns PASS/FAIL/UNPROVEN');
check(probeResults.every(p => p.kind === 'static' || p.kind === 'behavioural'), 'every probe declares static or behavioural');

// --- migration helpers ---------------------------------------------------
check(migrationNumber('055_call_delivery_evidence.sql') === '055', 'migrationNumber parses the prefix');
check(migrationNumber('_rollbacks/055_x.sql') === null && migrationNumber('README.md') === null, 'non-migration names ignored');
{
  const { collisions } = inventory([
    { ref: 'a', file: '055_call_delivery_evidence.sql' },
    { ref: 'b', file: '055_call_delivery_evidence.sql' },
    { ref: 'c', file: '055_account_classification_history.sql' },
    { ref: 'a', file: '056_financial_safety.sql' },
  ]);
  check(collisions.length === 1 && collisions[0].number === '055' && collisions[0].files.length === 2,
    'cross-branch inventory reports 055 as a collision and nothing else');
}
check(duplicatesInTree(['060_a.sql', '060_b.sql', '061_c.sql']).length === 1, 'single-tree duplicate detection');

// --- the financial contract is satisfiable AND discriminating ------------
{
  const ref = await runFinancialContract(reference);
  check(ref.every(r => r.status === 'PASS'), `reference model passes all ${ref.length} contract checks (${ref.filter(r => r.status !== 'PASS').map(r => r.id).join(',') || 'none failed'})`);
  const bad = await runFinancialContract(naive);
  const mustCatch = ['FC-2', 'FC-3', 'FC-4', 'FC-5', 'FC-6', 'FC-7', 'FC-8'];
  for (const id of mustCatch) {
    check(bad.find(r => r.id === id)?.status === 'FAIL', `contract ${id} catches the naive model (race / no dedupe / no validation / fail-open / no ceiling / no breaker)`);
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
