// Prints the worst-case exposure table for the ≤10-customer cohort
// (services/containment/worstCaseExposure.js). Pure model: no network.
// Run: node scripts/agent1-worst-case-exposure.js
'use strict';
const m = require('../services/containment/worstCaseExposure');

function rows() {
  const out = [m.scenarioNormal(), m.scenarioBackendDown(), m.scenarioBackendDown({ fallbackConfigured: false })];
  for (const n of [10, 100, 1000]) out.push(m.scenarioCompromised({ attackerConcurrency: n }));
  for (const ch of [2, 4, 10]) for (const rs of Object.keys(m.P8_RATE_SETS)) out.push(m.scenarioMagrathea({ channelsPerNumber: ch, rateSet: rs }));
  out.push(m.scenarioMagrathea({ channelsPerNumber: 10, accountWideCap: 4, rateSet: 'stacked' }));
  out.push(m.scenarioOpenAi());
  return out;
}

function table(list = rows()) {
  const f = (n) => (n === undefined ? '—' : `£${n.toFixed(2)}`);
  const lines = ['| Scenario | £/hour | £/day | One-off / per 4 h wave | Provider-bounded? | Enforced by |', '|---|---|---|---|---|---|'];
  for (const r of list) lines.push(`| ${r.label} | ${f(r.perHourGbp)} | ${f(r.perDayGbp)} | ${f(r.oneOffTailGbp ?? r.perFourHourWaveGbp)} | ${r.bounded ? (r.boundedScope ? `yes (${r.boundedScope})` : 'yes') : '**NO**'} | ${r.enforcedBy} |`);
  return lines.join('\n');
}

module.exports = { rows, table };
if (require.main === module) {
  console.log(table());
  console.log('\nNon-Magrathea paths under Level 2:');
  for (const p of m.NON_CAPPED_PATHS) console.log(`- ${p.path}: capped=${p.capped}${p.blocker ? ' [RELEASE BLOCKER]' : ''} — ${p.control}`);
  const v = m.releaseVerdict();
  console.log(`\n${v.verdict}\nCloses:\n- ${v.closes.join('\n- ')}`);
}
