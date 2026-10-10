// WS2 (2026-10-10) — the commercial allowance calculator
// (scripts/finance/commercial-allowance.js) behind
// docs/launch/2026-10-10-COMMERCIAL-ALLOWANCE-PROPOSAL.md.
// Checks: Fortress cost formula matches 067 and the real staging ledger (DT-2),
// worst-case conversion ratios, per-household spend never passes its pools by
// more than the stated overrun, determinism, the proposal's headline claims, and
// that the generated tables file is current.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = require(path.join(ROOT, 'scripts/finance/commercial-allowance.js'));

let failures = 0;
const check = (c, msg) => { if (c) console.log(`✓ ${msg}`); else { console.error(`✗ ${msg}`); failures++; } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// 1. Fortress formula = migration 067 fc_call_cost; matches the DT-2 staging ledger.
check(near(m.fcCallCost(42, false, 1800), 0.01239, 1e-5), 'a ≤ 60 s trusted call commits £0.01239 (DT-2 staging ledger)');
check(near(m.telLeaseGbp(), 0.071339, 1e-6), 'first lease (300 s + 60 s grace) reserves £0.071339 (DT-2 staging ledger)');
check(near(m.screeningAdmissionGbp(1800), 0.337616, 1e-6), 'screening admission = lease + full 30-min window = £0.3376 (WS2 report §2.1)');
check(m.fcCallCost(0, true, 1800) === 0, 'a zero-second call costs nothing');

// 2. Worst-case conversion of a Fortress £ pool to billed £.
check(m.worstBilledRatio(false) < 0.76 && m.worstBilledRatio(false) > 0.75, 'billed ≤ 0.76 × Fortress today (SDK leg £0)');
check(near(m.worstBilledRatio(true), 1 / 1.1, 2e-3), 'billed ≤ Fortress ÷ 1.1 if the SDK leg is billed at list');

// 3. Per-household Fortress spend never passes its pools by more than the overrun bound.
for (const [key, profile] of Object.entries(m.PROFILES)) {
  const mode = key === 'bypass' ? 'B' : 'A';
  let worst = -Infinity;
  for (const seg of m.SEGMENTS) {
    const rnd = m.mulberry32(99);
    for (let i = 0; i < 800; i++) {
      const o = m.simulateMonth(seg, profile, { mode, rnd, reserveFirst: key === 'opt1s' });
      worst = Math.max(worst, o.fortress - (profile.budget + profile.trustedReserve + profile.unscreenedReserve + profile.essential));
    }
  }
  check(worst <= m.overrunFor(profile) + 1e-9, `${key}: spend ≤ pools + overrun (max excess £${worst.toFixed(4)} ≤ £${m.overrunFor(profile).toFixed(4)})`);
}

// 4. Bypass: trusted calls never reach HCG.
{
  const rnd = m.mulberry32(5);
  const o = m.simulateMonth(m.SEGMENTS[1], m.PROFILES.opt1, { mode: 'B', rnd });
  check(o.trustedFortress === 0 && o.refusedTrusted === 0, 'mode B: trusted calls cost HCG nothing and are never refused');
}

// 5. Determinism + headline claims (full default run, ~30 s, no network).
const a = m.computeAll();
const b = m.computeAll({ households: 400 });
const c = m.computeAll({ households: 400 });
check(JSON.stringify(b) === JSON.stringify(c), 'same inputs ⇒ identical output (seeded, no network)');

const seg = (opt, k) => a.options[opt].segments.find((s) => s.segment === k);
check(1 - seg('current', 'typical').pausedShare < 0.5, 'current £3.00 profile: most typical households see screening paused (the finding being fixed)');
check(1 - seg('opt1', 'typical').pausedShare >= 0.9, 'Option 1: ≥ 90% of typical households never pause (exponential durations)');
check(a.options.opt1.worstCase.contributionToday >= 0, 'Option 1: worst case per customer ≥ break-even on today\'s billing');
check(a.options.opt1.worstCase.contributionSdk < 0 && a.options.opt1.worstCase.contributionSdk > -0.7, 'Option 1: if the SDK leg is billed, worst case is a bounded loss < £0.70');
check(a.options.opt1.blended.marginBilled < 0.4, 'Option 1 at £5.99 under A does NOT reach a 40% blended margin (stated plainly in the proposal)');
check(a.options.opt2.worstCase.contributionSdk >= 0, 'Option 2: break-even even with the SDK leg billed');
check(a.options.opt3.blended.marginBilled >= 0.4 && a.options.opt3.worstCase.contributionToday >= 0, 'Option 3 (£6.99): ≥ 40% blended and worst case ≥ break-even today');
check(a.options.bypass.blended.marginBilled >= 0.4 && a.options.bypass.worstCase.contributionSdk >= 0, 'bypass profile: ≥ 40% blended, break-even worst case even with the SDK leg billed');
check(1 - seg('bypass', 'typical').pausedShare >= 0.9, 'bypass profile: ≥ 90% of typical households never pause');
for (const k of ['opt1', 'opt1m', 'opt1s', 'opt2']) {
  const e = a.options[k];
  check(e.worstCase.billedToday <= e.economics.usageRoom + 1e-9, `${k}: worst-case billed today ≤ £5.99 Stripe usage room (£${e.economics.usageRoom.toFixed(2)})`);
}

// 6. The generated tables file is current.
const onDisk = readFileSync(path.join(ROOT, 'docs/launch/2026-10-10-COMMERCIAL-ALLOWANCE-TABLES.md'), 'utf8');
check(onDisk.trim() === m.toMarkdown(a).trim(), 'docs/launch/2026-10-10-COMMERCIAL-ALLOWANCE-TABLES.md is current (regenerate with --md)');

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
