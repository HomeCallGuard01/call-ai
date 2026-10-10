// WS2 (2026-10-10) — the Fortress scale simulation (scripts/sim/fortress-scale-sim.mjs)
// is deterministic and its safety properties hold on a small run (the full
// N=100 / N=1,000 results are in docs/launch/2026-10-10-WS2-REPORT.md §4).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const run = (...a) => {
  const r = spawnSync(process.execPath, ['scripts/sim/fortress-scale-sim.mjs', ...a, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error(r.stderr || 'sim failed');
  const o = JSON.parse(r.stdout); delete o.wallSeconds; return o;
};

const a = run('--n', '40', '--hours', '6', '--policy', 'scaled');
const b = run('--n', '40', '--hours', '6', '--policy', 'scaled');
check(JSON.stringify(a) === JSON.stringify(b), 'same inputs ⇒ identical output (deterministic, no network)');
check(a.invariantsOk === true, 'Fortress invariants hold after the run');
const e = a.perKind.extreme;
check(e && e.fortressGbp.max <= 2.25 + 1e-9, `every extremely heavy household stays inside the £2.00 hold + in-flight leases (max £${e.fortressGbp.max})`);
check(e.billedWithSdkGbp.max <= e.fortressGbp.max + 1e-9, 'modelled billed cost (even with the SDK leg at list) ≤ the Fortress estimate');
check(a.genuine.refusedShare === 0, 'scaled policy: no genuine call refused by a global control');
check(a.totals.unattributed.allowed * 0.04 <= 0.25 + 0.05, `unattributed calls capped (${JSON.stringify(a.totals.unattributed)})`);
const r = run('--n', '40', '--hours', '6', '--policy', 'recommended', '--extreme-share', '0.5');
check(r.invariantsOk === true && r.breakerTrips.length >= 1, `recommended policy under a 50% compromise: the breaker trips (${JSON.stringify(r.breakerTrips)})`);
check(r.totals.fortressGbp <= r.caps.daily + 2.5, `global spend stays within the daily cap + in-flight leases (£${r.totals.fortressGbp} vs cap £${r.caps.daily})`);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll scale-simulation checks passed.');
