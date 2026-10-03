#!/usr/bin/env node
// Cross-branch migration inventory. READ-ONLY: uses `git for-each-ref` and
// `git ls-tree` only — never checks out, fetches, writes refs or touches a
// database. Run `git fetch` yourself first if you want fresh remote refs.
//
//   node tests/launch-gate/migration-inventory.mjs            # markdown report
//   node tests/launch-gate/migration-inventory.mjs --json     # machine-readable
//   node tests/launch-gate/migration-inventory.mjs --min 046  # only numbers >= 046
//
// Exit code is 1 when any migration number maps to more than one filename
// across the inspected refs — the condition that must be resolved before
// integration (see docs/launch-gate/MIGRATION_INVENTORY.md).

import { execFileSync } from 'node:child_process';
import { inventory } from './lib/migrations.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minIdx = args.indexOf('--min');
const min = minIdx >= 0 ? args[minIdx + 1] : '000';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const refs = git('for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes')
  .split('\n')
  .filter(r => r && !r.endsWith('/HEAD') && r !== 'origin');

const entries = [];
for (const ref of refs) {
  let out;
  try {
    out = git('ls-tree', '--name-only', ref, 'supabase/migrations/');
  } catch {
    continue;
  }
  for (const path of out.split('\n')) {
    const file = path.replace(/^supabase\/migrations\//, '');
    if (file && !file.includes('/')) entries.push({ ref, file });
  }
}

const { byNumber, collisions } = inventory(entries.filter(e => e.file.slice(0, 3) >= min));

if (asJson) {
  const all = [...byNumber].sort(([a], [b]) => a.localeCompare(b)).map(([number, files]) => ({
    number,
    files: [...files].map(([file, rs]) => ({ file, refCount: rs.size, refs: [...rs].sort() })),
  }));
  console.log(JSON.stringify({ refsInspected: refs.length, migrations: all, collisions }, null, 2));
} else {
  console.log(`# Migration inventory (${refs.length} refs inspected, numbers >= ${min})\n`);
  console.log('| # | filename | refs (count) | example refs |');
  console.log('|---|---|---|---|');
  for (const [number, files] of [...byNumber].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [file, rs] of files) {
      const list = [...rs].sort();
      const flag = files.size > 1 ? ' **COLLISION**' : '';
      console.log(`| ${number}${flag} | ${file} | ${list.length} | ${list.slice(0, 4).join(', ')}${list.length > 4 ? ', …' : ''} |`);
    }
  }
  console.log(`\nCollisions: ${collisions.length ? collisions.map(c => c.number).join(', ') : 'none'}`);
}

process.exit(collisions.length ? 1 : 0);
