// verify-migration-history.js — the tool tonight's session should have
// had from the start. Every migration action tonight (both on staging
// and production) required careful, repeated manual confirmation of
// "am I linked to the right project?" and manual parsing of
// `supabase migration list --linked`'s JSON to spot drift — this script
// makes both of those checks a single, explicit, hard-to-get-wrong
// command instead of relying on an operator's (human or AI) discipline
// each time.
//
// SAFETY DESIGN:
//   - Requires --expect-project <ref> as a MANDATORY argument. If the
//     currently-linked project doesn't match, this refuses to run any
//     further check and exits non-zero — this is the single highest-
//     value guard tonight's session didn't have: it makes "I meant to
//     check staging but was actually linked to production" a loud,
//     immediate, unmissable failure instead of something that depends on
//     remembering to `cat supabase/.temp/project-ref` first.
//   - Everything this script does is READ-ONLY. It never runs
//     `db push` (with or without --dry-run) — dry-run still requires a
//     database connection and, per tonight's own discovery, can itself
//     error out in ways that need separate human judgement (the
//     "LegacyDbPushMissingLocalError"/"...MissingRemoteError" cases).
//     Actually applying anything remains a separate, explicit, human-
//     approved step — this tool only ever reports state.
//
// What it reports:
//   1. The linked project ref (and refuses to continue if it doesn't
//      match --expect-project).
//   2. Every local/remote mismatch from `supabase migration list --linked`,
//      classified as LOCAL-ONLY (pending), REMOTE-ONLY (no local file —
//      tonight's "030" case), or MATCH.
//   3. A plain-English summary: how many are pending, how many are
//      remote-only (needing investigation, never blind repair), and
//      whether the history is fully aligned.
//
// This is a diagnostic tool, not a repair tool — it makes no changes and
// proposes none. The lesson from tonight (docs/engineering/
// MIGRATION_047_DEPLOYMENT_SEQUENCE.md) still applies: a remote-only
// entry must be individually investigated and PROVEN (not assumed) to be
// a historical duplicate/renumbering before anyone runs
// `migration repair --status reverted`, and a local-only entry must be
// physically verified against the live database before anyone runs
// `migration repair --status applied` — this script surfaces the drift,
// it does not resolve it.
//
// Usage:
//   node scripts/verify-migration-history.js --expect-project <ref>
//
// Requires the Supabase CLI to already be linked (`supabase link
// --project-ref <ref>`) before running this — it does not link for you,
// on purpose: linking is itself a deliberate, logged step per this
// project's own established discipline.

'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expect-project') {
      args.expectProject = argv[i + 1];
      i++;
    }
  }
  return args;
}

function linkedProjectRef() {
  try {
    return readFileSync(path.join(process.cwd(), 'supabase', '.temp', 'project-ref'), 'utf8').trim();
  } catch {
    return null;
  }
}

function main() {
  const { expectProject } = parseArgs(process.argv.slice(2));

  if (!expectProject) {
    console.error('✗ Usage: node scripts/verify-migration-history.js --expect-project <ref>');
    console.error('  --expect-project is mandatory — this script refuses to guess which project you mean to check.');
    process.exitCode = 1;
    return;
  }

  const linked = linkedProjectRef();
  if (!linked) {
    console.error('✗ No project is currently linked (supabase/.temp/project-ref not found).');
    console.error(`  Run: supabase link --project-ref ${expectProject}`);
    process.exitCode = 1;
    return;
  }

  if (linked !== expectProject) {
    console.error(`✗ REFUSING TO CONTINUE: linked project is "${linked}", but you asked to verify "${expectProject}".`);
    console.error('  This mismatch is exactly the class of mistake this script exists to catch loudly.');
    console.error(`  Run: supabase link --project-ref ${expectProject}`);
    console.error('  Then re-run this script.');
    process.exitCode = 1;
    return;
  }

  console.log(`✓ Linked project confirmed: ${linked}\n`);

  let raw;
  try {
    raw = execFileSync('supabase', ['migration', 'list', '--linked'], { encoding: 'utf8' });
  } catch (err) {
    console.error('✗ `supabase migration list --linked` failed:', err.message);
    process.exitCode = 1;
    return;
  }

  // The CLI prints informational lines before the JSON line — find and
  // parse the last line that looks like a JSON object (matches the
  // parsing approach used throughout tonight's session).
  const lines = raw.trim().split('\n');
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      parsed = JSON.parse(lines[i]);
      break;
    } catch {
      // not the JSON line, keep looking backwards
    }
  }
  if (!parsed || !Array.isArray(parsed.migrations)) {
    console.error('✗ Could not parse `supabase migration list --linked` output as expected. Raw output:');
    console.error(raw);
    process.exitCode = 1;
    return;
  }

  const localOnly = [];
  const remoteOnly = [];
  const matched = [];

  for (const m of parsed.migrations) {
    if (m.local && m.remote && m.local === m.remote) {
      matched.push(m);
    } else if (m.local && !m.remote) {
      localOnly.push(m);
    } else if (!m.local && m.remote) {
      remoteOnly.push(m);
    }
  }

  console.log(`Matched (local === remote): ${matched.length}`);

  if (remoteOnly.length > 0) {
    console.log(`\n⚠ REMOTE-ONLY (no local file) — ${remoteOnly.length}:`);
    for (const m of remoteOnly) {
      console.log(`   ${m.remote}`);
    }
    console.log('   Each of these needs individual investigation before any repair — see tonight\'s "030" precedent (docs/engineering/MIGRATION_047_DEPLOYMENT_SEQUENCE.md and the session record): query supabase_migrations.schema_migrations directly for the `name` column, and compare it against local migration names before assuming it\'s a historical duplicate/renumbering. Never run `migration repair --status reverted` on one of these without that proof.');
  }

  if (localOnly.length > 0) {
    console.log(`\n⚠ LOCAL-ONLY (pending) — ${localOnly.length}:`);
    for (const m of localOnly) {
      console.log(`   ${m.local}`);
    }
    console.log('   Each of these is either genuinely unapplied (the normal, expected case for a migration not yet deployed) or already physically applied with only the tracking row missing (tonight\'s "046" precedent) — these look identical in this list alone. Physically verify each one\'s target objects against the live database before deciding which.');
  }

  if (remoteOnly.length === 0 && localOnly.length === 0) {
    console.log('\n✓ Migration history is fully aligned — no drift detected.');
  } else {
    console.log(`\nSummary: ${matched.length} matched, ${localOnly.length} pending, ${remoteOnly.length} remote-only needing investigation.`);
  }

  // Never a "failure" exit code for drift alone — pending migrations are
  // often the normal, expected state (e.g. the night before an
  // intentional deploy). Only a hard usage/connection error exits non-zero.
  process.exitCode = 0;
}

main();
