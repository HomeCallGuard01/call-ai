// Money tab ← Pricing Safety contract (2026-09-29).
//
// tests/fixtures/spend-monitor-results.sample.json was produced by the
// REAL runSpendMonitor() on feature/provider-neutral-billing-ledger
// (7ad12c9) — fresh, stale-ingestion and load-failure runs — so these
// checks exercise the actual contract, not a guess at it. Once that branch
// merges, section 6 re-runs the live module too.
//
// Run with: node tests/money-tab-contract.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { adaptSpendMonitorResult, loadFinancialSafety } = require('../services/businessControl/financialSafetyAdapter.js');
const sample = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'spend-monitor-results.sample.json'), 'utf8'));
const NOW = new Date(sample.generatedAt);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
const amounts = (a) => [
  ...Object.values(a.company || {}).filter((v) => typeof v === 'number' || v === null),
  ...(a.components || []).map((c) => c.amountGbp),
  ...Object.values(a.split || {}).filter((v) => typeof v !== 'string'),
];

// ---------- 1. not connected / failed: never £0 ----------
{
  const nc = adaptSpendMonitorResult(null, { now: NOW });
  check(nc.state === 'not_connected' && nc.company === null && nc.components === null && nc.level === null, 'no result → NOT CONNECTED: no amounts at all (not £0), no level');
  const missing = await loadFinancialSafety({ now: NOW, requireProvider: () => { throw new Error("Cannot find module '../finance/latestSpendMonitorResult'"); } });
  check(missing.state === 'not_connected' && /not merged or deployed/.test(missing.reason), 'provider module absent (today) → NOT CONNECTED with the reason');
  const throws = await loadFinancialSafety({ now: NOW, requireProvider: () => ({ getLatestSpendMonitorResult: async () => { throw new Error('db down'); } }) });
  check(throws.state === 'load_failed' && throws.company === null, 'provider throws → load_failed, no amounts');
  const failed = adaptSpendMonitorResult(sample.failed, { now: NOW });
  check(failed.state === 'load_failed' && failed.company === null && failed.level === 'ALERT' && /connection refused/.test(failed.reason), 'real MONITOR_LOAD_FAILED run → load_failed, level ALERT kept, no amounts');
}

// ---------- 2. fresh run ----------
{
  const a = adaptSpendMonitorResult(sample.fresh, { now: NOW });
  const m = sample.fresh.metrics;
  check(a.state === 'ok' && a.level === sample.fresh.protection.name && a.blocksCallDelivery === false, `fresh run → ok, level ${a.level} passed through, never blocks calls`);
  check(a.company.monthToDateGbp === m.company.monthToDateGbp && a.company.todaySpendGbp === m.company.todaySpendGbp && a.company.unallocatedGbp === m.company.unallocatedGbp, 'company figures passed through unchanged');
  const t = a.split.trustedCallCostGbp, mo = a.split.monitoredCallCostGbp, r = a.split.numberRentalGbp;
  check(Math.abs(t + mo + r - m.company.householdAttributedGbp) < 0.011, `trusted (${t}) + monitored (${mo}) + rental (${r}) = household-attributed £${m.company.householdAttributedGbp} (nothing lost or double-counted)`);
  check(a.components.find((c) => c.key === 'unallocated').amountGbp === m.company.unallocatedGbp, 'unallocated cost is its own line, never spread across households');
  check(a.company.unknownItems === 1 && a.warnings.some((w) => /not yet priced/.test(w.text)), 'unpriced items are counted and warned about, never summed as £0');
  check(a.company.projectedMonthEndGbp !== null && /ESTIMATED/.test(a.company.projectionBasis) && a.company.projectedMonthEndGbp >= a.company.monthToDateGbp, 'projected month-end is labelled ESTIMATED and never below month-to-date');
  check(a.outliers.length === 2 && a.outliers[0].projectedMonthGbp >= a.outliers[1].projectedMonthGbp && a.outliers.some((o) => o.lossMaking), 'household outliers sorted by projected cost; loss-making flagged');
  check(a.outliers.every((o) => o.householdRef.length === 8), 'outliers carry a short household reference');
}

// ---------- 3. stale ingestion / stale run ----------
{
  const s = adaptSpendMonitorResult(sample.stale, { now: NOW });
  check(s.state === 'stale' && s.company.projectedMonthEndGbp === null && /stale/.test(s.company.projectionBasis), 'COST_DATA_STALE in a real run → stale: figures kept with their age, NO projection');
  check(s.warnings.some((w) => w.severity === 'critical' && /unobserved/.test(w.text)), 'stale warning says spend since then is unobserved, not zero');
  const oldRun = adaptSpendMonitorResult(sample.fresh, { now: new Date(NOW.getTime() + 40 * 3600000) });
  check(oldRun.state === 'stale' && oldRun.ageHours === 40 && oldRun.warnings.some((w) => /40h ago/.test(w.text)), 'a fresh result read 40h later is stale (the monitor stopped running)');
  const noTime = adaptSpendMonitorResult({ ...sample.fresh, asOf: undefined, metrics: { ...sample.fresh.metrics, asOf: undefined } }, { now: NOW });
  check(noTime.state === 'stale', 'a result without a timestamp is never treated as fresh');
}

// ---------- 4. edge cases ----------
{
  const empty = adaptSpendMonitorResult({ ...sample.fresh, metrics: { ...sample.fresh.metrics, households: [] } }, { now: NOW });
  check(empty.components.filter((c) => c.key !== 'unallocated').every((c) => c.amountGbp === null) && empty.split.trustedCallCostGbp === null, 'no household rows → components NOT CONNECTED (null), never £0');
  const usd = adaptSpendMonitorResult({ ...sample.fresh, metrics: { ...sample.fresh.metrics, currency: 'USD' } }, { now: NOW });
  check(usd.warnings.some((w) => /GBP only/.test(w.text)), 'non-GBP metrics are flagged, never shown as £');
  const conv = adaptSpendMonitorResult({ ...sample.fresh, metrics: { ...sample.fresh.metrics, company: { ...sample.fresh.metrics.company, unconverted: { USD: 1.23 } } } }, { now: NOW });
  check(conv.warnings.some((w) => /USD 1.23/.test(w.text)), 'unconverted currency amounts are reported, not added');
  check(adaptSpendMonitorResult({ ...sample.fresh, protection: { ...sample.fresh.protection, name: 'PANIC' } }, { now: NOW }).level === null, 'an unknown level is not passed through');
}

// ---------- 5. UI: never £0 for missing, escapes ----------
{
  const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
  const x = (name) => { const a = html.indexOf(`// TEST-EXTRACT-START: ${name}`); const b = html.indexOf(`// TEST-EXTRACT-END: ${name}`); return html.slice(a, b); };
  const doc = { getElementById: () => ({ innerHTML: '' }) };
  const ui = new Function('document', 'fetch', 'window', 'fmtNum', `${x('customerMonitorHelpers')}\n${x('fmtDateTime')}\n${x('businessControlTabs')}\nreturn { renderSafetyHtml };`)(doc, async () => ({}), {}, (n) => String(n));
  const nc = ui.renderSafetyHtml(adaptSpendMonitorResult(null, { now: NOW }));
  check(nc.includes('Not connected') && !/£0\.00/.test(nc), 'Money: not connected → says so, no £0.00');
  const lf = ui.renderSafetyHtml(adaptSpendMonitorResult(sample.failed, { now: NOW }));
  check(/unobserved, not zero/.test(lf) && !/£0\.00/.test(lf), 'Money: load failure → "unobserved, not zero"');
  const st = ui.renderSafetyHtml(adaptSpendMonitorResult(sample.stale, { now: NOW }));
  check(st.includes('STALE DATA') && st.includes('Not connected') /* projection */, 'Money: stale → STALE DATA banner and no projection figure');
  const ok = ui.renderSafetyHtml(adaptSpendMonitorResult(sample.fresh, { now: NOW }));
  check(ok.includes('Level: WATCH') && ok.includes('Trusted-call cost') && ok.includes('Monitored-call cost') && ok.includes('Recommended actions (not executed)') === (sample.fresh.protection.actions.length > 0), 'Money: fresh → level, trusted/monitored split, recommended actions labelled not executed');
  const evil = '"><img src=x onerror=alert(1)>';
  const hostile = ui.renderSafetyHtml({ ...adaptSpendMonitorResult(sample.fresh, { now: NOW }), warnings: [{ severity: 'critical', text: evil }], levelReasons: [evil], actions: [{ id: 'x', label: evil, status: evil }] });
  check(!hostile.includes('<img') && hostile.includes('&lt;img'), 'Money: every data-derived string is escaped');
}

// ---------- 6. live module, once merged ----------
if (existsSync(path.join(__dirname, '..', 'services', 'finance', 'spendMonitor.js'))) {
  const { runSpendMonitor } = require('../services/finance/spendMonitor.js');
  const live = await runSpendMonitor({ load: async () => ({ entries: [], legs: [], calls: [], entitledHouseholds: 0, lastIngestedAt: null }), now: NOW });
  const a = adaptSpendMonitorResult(live, { now: NOW });
  check(a.state === 'stale' && a.warnings.some((w) => /unobserved/.test(w.text)), 'live runSpendMonitor with no data → stale/unobserved through the adapter');
} else {
  console.log('- live spend monitor: not on this branch yet (feature/provider-neutral-billing-ledger) — the committed sample from its real output is used');
}

console.log(failures === 0 ? '\nAll Money tab contract checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
