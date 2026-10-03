// Does `npm test` run this test file? Integration 2026-10-03: npm test is
// scripts/run-all-tests.mjs, which runs EVERY tests/*.test.mjs; an old-style
// `node a && node b` chain is still understood.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function npmTestRuns(relFile) {
  const script = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test || '';
  if (script.trim() === 'node scripts/run-all-tests.mjs') {
    return /^tests\/[^/]+\.test\.mjs$/.test(relFile) && existsSync(path.join(ROOT, relFile));
  }
  return script.split('&&').map((s) => s.trim()).includes(`node ${relFile}`);
}
