// Launch-gate financial contract FC-1…FC-8 bound to the REAL Financial
// Fortress (tests/launch-gate/adapters/fortress-pglite.mjs) — integration
// 2026-10-03. Pins the honest outcome, so a regression in either direction is
// visible, and turns the two non-PASS results into explained evidence:
//   FC-6 FAIL under FC_DEGRADED_MODE=bounded (decision D3: a small bounded
//        envelope is admitted while the database is down) — PASS under 'reject'.
//   FC-3 contract assertion FAIL: the contract measures allowance in seconds and
//        assumes cost never affects it; Fortress enforces £ and charges
//        max(estimate, actual) (invariant I7). Proven below: the duplicate
//        delivery is applied ONCE and charged ONCE.
import { runFinancialContract } from './launch-gate/financial-contract.mjs';
import { createSubject } from './launch-gate/adapters/fortress-pglite.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

for (const mode of ['bounded', 'reject']) {
  const res = await runFinancialContract(() => createSubject({ degradedMode: mode }));
  const st = Object.fromEntries(res.map((r) => [r.id, r.status]));
  for (const id of ['FC-1', 'FC-2', 'FC-4', 'FC-5', 'FC-7', 'FC-8']) check(st[id] === 'PASS', `[${mode}] ${id} PASS against the real Fortress (${res.find((r) => r.id === id).detail})`);
  check(st['FC-6'] === (mode === 'bounded' ? 'FAIL' : 'PASS'), `[${mode}] FC-6 store outage: ${st['FC-6']} — ${mode === 'bounded' ? 'D3 bounded envelope admits (≤ 2 concurrent / 20 per hour / 10 min, unmonitored, per instance)' : 'fail-closed refusal'}`);
  check(st['FC-3'] === 'FAIL', `[${mode}] FC-3 contract assertion FAIL is the seconds-vs-£ model mismatch (see evidence below), not a double charge`);
}

// FC-3 evidence: same event delivered 5× → one settlement, one actual, one charge.
{
  const s = await createSubject({ degradedMode: 'reject' });
  await s.setAllowance('h3', 600);
  const ev = { householdId: 'h3', callSid: 'CA-dup', eventId: 'evt-1', seconds: 60, costPence: 5 };
  const outs = [];
  for (let i = 0; i < 5; i++) outs.push(await s.recordUsage({ ...ev }).then((r) => r.applied, () => false));
  const id = await s._householdId('h3');
  const actuals = (await s._q("select count(*)::int n from public.fc_ledger where household_id = $1 and entry_type = 'actual'", [id]))[0].n;
  const acc = (await s._q('select consumed_gbp::float c, actual_gbp::float a from public.fc_budget_accounts where household_id = $1', [id]))[0];
  check(outs.filter(Boolean).length === 1 && actuals === 1, `FC-3 evidence: 5 deliveries → applied once, ${actuals} actual-cost ledger entry`);
  check(Math.abs(acc.c - 0.05) < 1e-6, `FC-3 evidence: the account was charged max(estimate, actual) = £0.05 exactly once (consumed £${acc.c})`);
}

console.log(failures === 0 ? '\nFinancial contract binding: outcome as pinned.' : `\n${failures} contract-binding check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
