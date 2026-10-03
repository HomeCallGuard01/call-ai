// Prints the maximum £ exposure per failure scenario from the configured
// financial-safety limits. Run with: node scripts/failure-scenarios.js [--households=N]
'use strict';
const { computeFailureScenarios } = require('../services/finance/failureScenarios');
const arg = process.argv.find((a) => a.startsWith('--households='));
const { scenarios } = computeFailureScenarios({ env: process.env, entitledHouseholds: arg ? Number(arg.slice(13)) : 10 });
for (const s of scenarios) {
  const money = Object.entries(s).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} £${v.toFixed(2)}`).join(' · ');
  console.log(`\n${s.scenario}\n  stopped by: ${s.stoppedBy}\n  max exposure: ${money}${s.provider ? `\n  provider-side: ${s.provider}` : ''}${s.note ? `\n  note: ${s.note}` : ''}`);
}
