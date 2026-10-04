// Accounting automation — engine, posting queue, settlement and entitlement
// reconciliation against the in-memory REFERENCE store. The same scenarios run
// against the SQL store in tests/accounting-store-parity.pglite.test.mjs.
//
// Run with: node tests/accounting-engine.test.mjs
import { createRequire } from 'node:module';
import { runAccountingScenarios } from './helpers/accountingScenarios.mjs';

const require = createRequire(import.meta.url);
const { createMemoryAccountingStore } = require('../services/accounting/memoryStore.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const n = await runAccountingScenarios({ newStore: async () => createMemoryAccountingStore(), check, only: process.argv[2] || null });
console.log(failures === 0 ? `\nAll ${n} accounting scenarios passed.` : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
