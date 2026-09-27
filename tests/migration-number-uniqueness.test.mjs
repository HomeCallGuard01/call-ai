// Fails if two top-level supabase/migrations/*.sql files share a numeric
// prefix. Two branches independently numbering a migration 046 (2026-09-27:
// main's 046_voice_client_registration_history.sql and the allowance
// branch's 046_monitoring_usage_and_financial_safety.sql) would otherwise
// only be noticed after a merge, when "apply in order" becomes ambiguous.
// _superseded/ and _rollbacks/ are subdirectories and are never applied in
// sequence, so they are out of scope, matching tests/migrations.pglite.test.mjs.
//
// Run with: node tests/migration-number-uniqueness.test.mjs

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function findMigrationNumberProblems(fileNames) {
  const byNumber = new Map();
  const unnumbered = [];
  for (const name of fileNames.filter((f) => f.endsWith('.sql'))) {
    const match = /^(\d{3,})_/.exec(name);
    if (!match) {
      unnumbered.push(name);
      continue;
    }
    const list = byNumber.get(match[1]) || [];
    list.push(name);
    byNumber.set(match[1], list);
  }
  const duplicates = [...byNumber.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([number, names]) => ({ number, names }));
  return { duplicates, unnumbered };
}

// The checker itself must catch the real 2026-09-27 collision.
const simulated = findMigrationNumberProblems([
  '045_diagnostic_instrumentation.sql',
  '046_voice_client_registration_history.sql',
  '046_monitoring_usage_and_financial_safety.sql',
  '048_financial_ledger_and_telephony_usage.sql',
  'README.md',
]);
check(
  simulated.duplicates.length === 1 && simulated.duplicates[0].number === '046' && simulated.duplicates[0].names.length === 2,
  'the checker reports a duplicate 046 when two branches both add one'
);
check(simulated.unnumbered.length === 0, 'non-SQL files are ignored by the checker');
check(
  findMigrationNumberProblems(['no_number.sql']).unnumbered.length === 1,
  'an .sql migration without a numeric prefix is reported'
);

const entries = await readdir(migrationsDir, { withFileTypes: true });
const topLevelSql = entries.filter((e) => e.isFile()).map((e) => e.name);
const { duplicates, unnumbered } = findMigrationNumberProblems(topLevelSql);

check(topLevelSql.some((f) => f.endsWith('.sql')), `found migrations to check (${topLevelSql.filter((f) => f.endsWith('.sql')).length})`);
check(
  duplicates.length === 0,
  duplicates.length === 0
    ? 'every migration number in supabase/migrations/ is unique'
    : `duplicate migration numbers: ${duplicates.map((d) => `${d.number} (${d.names.join(', ')})`).join('; ')}`
);
check(
  unnumbered.length === 0,
  unnumbered.length === 0 ? 'every migration file has a numeric prefix' : `migrations without a numeric prefix: ${unnumbered.join(', ')}`
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
