#!/usr/bin/env node
// Runs EVERY tests/*.test.mjs, one process each, and reports all of them —
// integration 2026-10-03 (launch-gate INTEGRATION_PLAN step 0).
//
// Replaces package.json's single `node a && node b && …` line, which:
//   - stopped at the first failing file, hiding every later result;
//   - silently skipped any test file nobody remembered to append;
//   - conflicted on every branch that added a test.
//
// Usage: npm test            (all files)
//        npm test -- <substr> (only files whose name contains <substr>)
// Exit code 1 if any file fails. Opt-in suites (e.g. the real-PostgreSQL race
// test) skip themselves loudly when their prerequisites are absent.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';
const files = readdirSync(path.join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.mjs') && f.includes(filter))
  .sort();

const failed = [];
let passChecks = 0;
let failChecks = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join('tests', f)], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 600000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = (out.match(/✓/g) || []).length;
  const fail = (out.match(/✗/g) || []).length;
  passChecks += pass;
  failChecks += fail;
  const ok = r.status === 0;
  if (!ok) failed.push(f);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (✓${pass} ✗${fail})`);
  if (!ok) console.log(out.split('\n').filter((l) => /✗|Error|error:/.test(l)).slice(0, 8).map((l) => `      ${l}`).join('\n'));
}
console.log(`\n${files.length} files, ${files.length - failed.length} passed, ${failed.length} failed; checks ✓${passChecks} ✗${failChecks}`);
if (failed.length) console.log(`Failed files:\n  ${failed.join('\n  ')}`);
process.exitCode = failed.length ? 1 : 0;
