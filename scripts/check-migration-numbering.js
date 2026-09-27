// check-migration-numbering.js — static, no-database check for the
// simplest class of bug that caused tonight's drift investigation:
// two migration files (on the same branch, or about to be merged from
// different branches) claiming the same version number. This is exactly
// what happened historically with the "030" entry found tonight
// (a file later renumbered to 035, leaving a stale duplicate tracking
// row) — this script exists to catch a NEW instance of that class of
// mistake before it's ever applied anywhere, not just to explain the
// old one.
//
// Read-only, local-files-only — no Supabase connection, no network, safe
// to run any time, including in CI once one exists (repository currently
// has none — see docs/due_diligence/DUE_DILIGENCE/04 Security.md).
//
// Checks:
//   1. No two files in supabase/migrations/ share the same leading
//      version number.
//   2. Every _rollbacks/ file's version number has a matching forward
//      migration (a rollback for a migration that doesn't exist is
//      itself a sign of drift).
//   3. Reports (does not fail on) numbering gaps, since this project's
//      own convention already has deliberate gaps (005 never applied
//      anywhere, 026/030 historical) — a gap is not itself an error,
//      only a duplicate is.
//
// Exit code 0 = clean, 1 = duplicate(s) found (a real, blocking problem).
//
// Run with: node scripts/check-migration-numbering.js

'use strict';

const { readdirSync } = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const ROLLBACKS_DIR = path.join(MIGRATIONS_DIR, '_rollbacks');

function extractVersion(filename) {
  const match = filename.match(/^(\d+)_/);
  return match ? match[1] : null;
}

function main() {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
  const byVersion = new Map();
  const unnumbered = [];

  for (const file of files) {
    const version = extractVersion(file);
    if (!version) {
      unnumbered.push(file);
      continue;
    }
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(file);
  }

  let failures = 0;

  const duplicates = [...byVersion.entries()].filter(([, files]) => files.length > 1);
  if (duplicates.length > 0) {
    console.error('✗ DUPLICATE MIGRATION VERSION NUMBER(S) FOUND:');
    for (const [version, dupFiles] of duplicates) {
      console.error(`   version ${version}: ${dupFiles.join(', ')}`);
      failures++;
    }
    console.error('   Two migrations claiming the same version number cannot both be tracked correctly — rename one before merging.');
  } else {
    console.log(`✓ No duplicate migration version numbers across ${files.length} migration file(s).`);
  }

  if (unnumbered.length > 0) {
    console.log(`(${unnumbered.length} file(s) with no leading version number, ignored: ${unnumbered.join(', ')})`);
  }

  // Rollback/forward pairing check.
  let rollbackFiles = [];
  try {
    rollbackFiles = readdirSync(ROLLBACKS_DIR).filter(f => f.endsWith('.sql'));
  } catch {
    // No _rollbacks directory at all is not an error this script checks.
  }
  const orphanRollbacks = [];
  for (const rb of rollbackFiles) {
    const m = rb.match(/^(\d+)_rollback_/);
    const version = m ? m[1] : null;
    if (!version || !byVersion.has(version)) {
      orphanRollbacks.push(rb);
    }
  }
  if (orphanRollbacks.length > 0) {
    console.error(`✗ ORPHAN ROLLBACK FILE(S) with no matching forward migration: ${orphanRollbacks.join(', ')}`);
    failures++;
  } else {
    console.log(`✓ Every rollback file (${rollbackFiles.length}) has a matching forward migration.`);
  }

  // Report the highest version number present, for convenience — the
  // next migration should generally be this + 1 (this project's own
  // documented convention: "unmerged branches renumber/rebase before
  // integration", per migration 047's own header).
  const numericVersions = [...byVersion.keys()].map(Number).sort((a, b) => a - b);
  const highest = numericVersions[numericVersions.length - 1];
  console.log(`\nHighest migration version present locally: ${highest}. A new migration being prepared should generally take ${highest + 1} (or higher, if others are already claimed on unmerged branches — check open PRs too, this script only sees local files).`);

  process.exitCode = failures === 0 ? 0 : 1;
}

main();
