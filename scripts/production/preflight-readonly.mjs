#!/usr/bin/env node
// Production preflight — READ-ONLY BY CONSTRUCTION (WS1 2026-10-10).
//
// Prints the P3 / P4 / P5 / P6 checks of
// docs/launch/2026-10-09-PRODUCTION-DEPLOY-PROCEDURE.md §3 with PASS / STOP.
// It is a reporting tool. It never applies, repairs, links or unlinks.
//
// SAFETY DESIGN (each enforced in code and unit-tested with a stubbed CLI,
// tests/ws1-production-preflight.test.mjs):
//   1. --expect-project <ref> is MANDATORY. supabase/.temp/project-ref in the
//      working directory must equal it, or nothing runs (exit 1).
//   2. Refuses to run in the primary checkout (/Users/ad/call-ai), which the
//      procedure forbids (P2: use a dedicated deploy worktree).
//   3. Every Supabase CLI invocation passes through assertAllowedInvocation(),
//      an allowlist of EXACTLY three shapes:
//        migration list --linked
//        db query --linked --output-format json <read-only SQL>
//        db push --linked --dry-run
//      Anything else — db push without --dry-run, --include-all, migration
//      repair, link, db reset, … — throws before a process is spawned.
//   4. Every SQL statement passes assertReadOnlySql(): a single SELECT/WITH,
//      no semicolons, no write/DDL/privilege/session keyword, and it is then
//      wrapped in `begin transaction read only; …; rollback;`.
//   5. Every byte printed or saved passes redact(): connection strings,
//      passwords, JWTs and provider keys are masked. No env var is printed.
//   6. One CLI call at a time (execFileSync): each `supabase` call rotates
//      the CLI login role's password (procedure §4.2).
//
// Usage (in the dedicated deploy worktree, already linked by the operator):
//   node scripts/production/preflight-readonly.mjs \
//     --expect-project psbzynxplxfbyrbdidmn \
//     --backup-dir /Users/ad/hcg-prod-backups/<date>-pre-047-075 \
//     [--expected-pending 047,051-075] [--remote-through 046] [--only P3,P4]
//
// Exit: 0 all PASS · 2 at least one STOP · 1 refused / usage error.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIMARY_CHECKOUT = '/Users/ad/call-ai';
export const DEFAULT_EXPECTED_PENDING = '047,051-075';
export const DEFAULT_REMOTE_THROUGH = '046';

export class RefusalError extends Error {}

// ── argument parsing ────────────────────────────────────────────────────
export function parseArgs(argv) {
  const args = { cli: 'supabase', expectedPending: DEFAULT_EXPECTED_PENDING, remoteThrough: DEFAULT_REMOTE_THROUGH, only: null, backupDir: null, expectProject: null, cwd: process.cwd() };
  const takes = { '--expect-project': 'expectProject', '--backup-dir': 'backupDir', '--expected-pending': 'expectedPending', '--remote-through': 'remoteThrough', '--only': 'only', '--cli': 'cli', '--cwd': 'cwd' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') { args.help = true; continue; }
    if (!takes[k]) throw new RefusalError(`unknown argument "${k}" — this tool accepts no other options (in particular nothing that would apply changes)`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new RefusalError(`${k} needs a value`);
    args[takes[k]] = v;
    i++;
  }
  if (args.only) args.only = args.only.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return args;
}

export function expandVersions(spec) {
  const out = [];
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(part);
    if (!m) throw new RefusalError(`bad version spec "${part}"`);
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    if (b < a) throw new RefusalError(`bad version range "${part}"`);
    for (let n = a; n <= b; n++) out.push(String(n).padStart(3, '0'));
  }
  return out;
}

// ── guard 1/2: linked project + location ────────────────────────────────
export function checkLinkedProject({ cwd, expectProject, readFile = readFileSync, realpath = realpathSync }) {
  if (!expectProject || !/^[a-z0-9]{20}$/.test(expectProject)) {
    throw new RefusalError('--expect-project <20-char project ref> is mandatory; this tool refuses to guess which project you mean');
  }
  let real = cwd;
  try { real = realpath(cwd); } catch { /* keep as given */ }
  if (path.resolve(real) === PRIMARY_CHECKOUT) {
    throw new RefusalError(`refusing to run in the primary checkout ${PRIMARY_CHECKOUT} (procedure P2: use a dedicated deploy worktree)`);
  }
  let linked;
  try { linked = String(readFile(path.join(cwd, 'supabase', '.temp', 'project-ref'), 'utf8')).trim(); } catch { linked = null; }
  if (!linked) throw new RefusalError('no project is linked in this worktree (supabase/.temp/project-ref missing) — link deliberately first; this tool never links');
  if (linked !== expectProject) {
    throw new RefusalError(`linked project is "${linked}" but --expect-project is "${expectProject}" — refusing to run anything`);
  }
  return linked;
}

// ── guard 3: CLI allowlist ──────────────────────────────────────────────
export function assertAllowedInvocation(args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new RefusalError('CLI args must be strings');
  const j = args.join(' ');
  if (args.includes('--include-all')) throw new RefusalError('--include-all is never allowed');
  if (args.length === 3 && args[0] === 'migration' && args[1] === 'list' && args[2] === '--linked') return 'migration-list';
  if (args.length === 3 && args[0] === 'db' && args[1] === 'push' && args[2] === '--linked') throw new RefusalError('db push without --dry-run is never allowed');
  if (args.length === 4 && args[0] === 'db' && args[1] === 'push' && args[2] === '--linked' && args[3] === '--dry-run') return 'db-push-dry-run';
  if (args.length === 6 && args[0] === 'db' && args[1] === 'query' && args[2] === '--linked' && args[3] === '--output-format' && args[4] === 'json') {
    const m = /^begin transaction read only; ([\s\S]+); rollback;$/.exec(args[5]);
    if (!m) throw new RefusalError('db query must be wrapped in a read-only transaction');
    assertReadOnlySql(m[1]);
    return 'db-query';
  }
  throw new RefusalError(`CLI invocation not on the read-only allowlist: supabase ${j.slice(0, 120)}`);
}

// ── guard 4: read-only SQL ──────────────────────────────────────────────
const FORBIDDEN_SQL = /\b(insert|update|delete|merge|upsert|drop|alter|create|grant|revoke|truncate|copy|call|do|execute|prepare|deallocate|set|reset|vacuum|analyze|cluster|reindex|comment|security|lock|refresh|notify|listen|unlisten|discard|checkpoint|import|load|begin|commit|rollback|savepoint|release|start|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|set_config|into)\b/i;
export function assertReadOnlySql(sql) {
  const s = String(sql).replace(/'(?:[^']|'')*'/g, "''").trim();
  if (!/^(select|with)\b/i.test(s)) throw new RefusalError('SQL must be a single SELECT/WITH');
  if (s.includes(';')) throw new RefusalError('SQL must be a single statement (no semicolons)');
  if (/--|\/\*/.test(s)) throw new RefusalError('SQL comments are not allowed');
  const bad = FORBIDDEN_SQL.exec(s);
  if (bad) throw new RefusalError(`SQL contains a non-read-only keyword: ${bad[1]}`);
  return true;
}

// ── guard 5: redaction ──────────────────────────────────────────────────
export function redact(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1***@')
    .replace(/\b(password|passwd|pwd|PGPASSWORD|SUPABASE_DB_PASSWORD|access[_-]?token|service[_-]?role[_-]?key|api[_-]?key|secret)(\s*[=:]\s*)("?)[^\s"']+/gi, '$1$2$3***')
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '***JWT***')
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, '$1_$2_***')
    .replace(/\bsbp_[A-Za-z0-9]{16,}/g, 'sbp_***')
    .replace(/\bwhsec_[A-Za-z0-9]{8,}/g, 'whsec_***')
    .replace(/\bSK[0-9a-f]{32}\b/g, 'SK***');
}

// ── CLI runner (the only place a process is spawned) ────────────────────
export function makeCliRunner({ cli = 'supabase', cwd, exec = execFileSync } = {}) {
  return function runCli(args) {
    assertAllowedInvocation(args);
    return String(exec(cli, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));
  };
}

export function readOnlyQuery(runCli, sql) {
  assertReadOnlySql(sql);
  const raw = runCli(['db', 'query', '--linked', '--output-format', 'json', `begin transaction read only; ${sql}; rollback;`]);
  const at = raw.indexOf('{');
  if (at < 0) throw new Error('db query returned no JSON');
  const parsed = JSON.parse(raw.slice(at));
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function parseMigrationList(raw) {
  const lines = String(raw).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const p = JSON.parse(lines[i]); if (p && Array.isArray(p.migrations)) return p.migrations; } catch { /* keep looking */ }
  }
  throw new Error('could not parse `supabase migration list --linked` output');
}

// ── checks (pure evaluators + runners) ──────────────────────────────────
export function evaluateP3(migrations, { localVersions, expectedPending, remoteThrough }) {
  const remote = migrations.filter((m) => m.remote).map((m) => m.remote).sort();
  const localOnly = migrations.filter((m) => m.local && !m.remote).map((m) => m.local).sort();
  const remoteOnly = migrations.filter((m) => m.remote && !m.local).map((m) => m.remote).sort();
  const expectedRemote = localVersions.filter((v) => v <= remoteThrough).sort();
  const problems = [];
  if (remoteOnly.length) problems.push(`remote-only rows: ${remoteOnly.join(', ')}`);
  if (JSON.stringify(remote) !== JSON.stringify(expectedRemote)) problems.push(`remote is not exactly 000…${remoteThrough} (remote has ${remote.length}, expected ${expectedRemote.length}; first difference: ${firstDiff(remote, expectedRemote)})`);
  if (JSON.stringify(localOnly) !== JSON.stringify([...expectedPending].sort())) problems.push(`local-only is not exactly the expected ${expectedPending.length} (got ${localOnly.length}: ${localOnly.join(', ') || 'none'})`);
  return { id: 'P3', status: problems.length ? 'STOP' : 'PASS', detail: problems.length ? problems.join('; ') : `remote = 000…${remoteThrough} (${remote.length}); local-only = ${localOnly.length} (${localOnly[0]}…${localOnly[localOnly.length - 1]}); no remote-only rows` };
}
function firstDiff(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `${a[i] ?? '∅'} vs ${b[i] ?? '∅'}`; return 'none'; }

export const P4_SQL = [
  "select to_regclass('public.fc_reservations') is not null as fc_reservations",
  "to_regclass('public.forwarding_proof_audit') is not null as forwarding_proof_audit",
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'households' and column_name = 'account_number') as households_account_number",
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'households' and column_name = 'forwarding_proven_at') as households_forwarding_proven_at",
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'entitlements' and column_name = 'revenuecat_environment') as entitlements_revenuecat_environment",
  "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'entitlements' and column_name = 'store_will_renew') as entitlements_store_will_renew",
].join(', ');
export function evaluateP4(rows) {
  const row = rows && rows[0];
  if (!row) return { id: 'P4', status: 'STOP', detail: 'no result row' };
  const present = Object.entries(row).filter(([, v]) => v === true || v === 't' || v === 'true').map(([k]) => k);
  const keys = Object.keys(row);
  if (keys.length !== 6) return { id: 'P4', status: 'STOP', detail: `unexpected result shape (${keys.join(', ')})` };
  return { id: 'P4', status: present.length ? 'STOP' : 'PASS', detail: present.length ? `already present: ${present.join(', ')}` : 'none of the 6 objects exists yet' };
}

export const FINGERPRINT_TABLES = [
  ['public.households', 'created_at'],
  ['public.entitlements', 'created_at'],
  ['public.subscriptions', 'created_at'],
  ['public.calls', 'created_at'],
  ['public.contacts', 'created_at'],
  ['public.stripe_webhook_events', 'received_at'],
  ['auth.users', 'created_at'],
];
export const P5_SQL = FINGERPRINT_TABLES
  .map(([t, c]) => `select '${t}' as table_name, count(*)::bigint as row_count, max(${c}) as newest from ${t}`)
  .join(' union all ');

export function evaluateP5(rows, { backupDir, cwd, now = new Date(), write = writeFileSync, mkdir = mkdirSync }) {
  if (!Array.isArray(rows) || rows.length !== FINGERPRINT_TABLES.length) return { id: 'P5', status: 'STOP', detail: `expected ${FINGERPRINT_TABLES.length} fingerprint rows, got ${rows ? rows.length : 0}` };
  const summary = rows.map((r) => `${r.table_name}=${r.row_count}`).join(' ');
  if (!backupDir) return { id: 'P5', status: 'STOP', detail: `fingerprint taken but NOT saved (pass --backup-dir): ${summary}` };
  const abs = path.resolve(backupDir);
  if (abs === path.resolve(cwd) || abs.startsWith(path.resolve(cwd) + path.sep)) return { id: 'P5', status: 'STOP', detail: '--backup-dir must be outside the repository' };
  mkdir(abs, { recursive: true, mode: 0o700 });
  const file = path.join(abs, `fingerprint-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  write(file, redact(JSON.stringify({ takenAt: now.toISOString(), rows }, null, 2)) + '\n', { mode: 0o600, flag: 'wx' });
  return { id: 'P5', status: 'PASS', detail: `saved ${file}: ${summary}` };
}

export function evaluateP6(raw, { expectedFiles }) {
  const text = String(raw);
  if (/include-all/i.test(text)) return { id: 'P6', status: 'STOP', detail: 'the dry-run mentions --include-all (out-of-order history) — investigate' };
  const listed = [...text.matchAll(/\b(\d{3}_[A-Za-z0-9_-]+\.sql)\b/g)].map((m) => m[1]);
  const unique = listed.filter((f, i) => listed.indexOf(f) === i);
  if (JSON.stringify(unique) !== JSON.stringify(expectedFiles)) {
    return { id: 'P6', status: 'STOP', detail: `dry-run would push ${unique.length} file(s); expected exactly ${expectedFiles.length} in order. First difference: ${firstDiff(unique, expectedFiles)}` };
  }
  return { id: 'P6', status: 'PASS', detail: `exactly ${unique.length} files in order (${unique[0]} … ${unique[unique.length - 1]})` };
}

export function localMigrationFiles(cwd, readDir = readdirSync) {
  return readDir(path.join(cwd, 'supabase', 'migrations')).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}

// ── main ────────────────────────────────────────────────────────────────
export function runPreflight(argv, { exec = execFileSync, readFile = readFileSync, readDir = readdirSync, realpath = realpathSync, write = writeFileSync, mkdir = mkdirSync, out = console.log, err = console.error, now = () => new Date() } = {}) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) { out('Usage: node scripts/production/preflight-readonly.mjs --expect-project <ref> --backup-dir <dir outside repo> [--expected-pending 047,051-075] [--remote-through 046] [--only P3,P4,P5,P6]'); return 0; }
    checkLinkedProject({ cwd: args.cwd, expectProject: args.expectProject, readFile, realpath });
    if (args.only && args.only.some((c) => !['P3', 'P4', 'P5', 'P6'].includes(c))) throw new RefusalError('--only accepts P3,P4,P5,P6');
  } catch (e) {
    if (e instanceof RefusalError) { err(`✗ REFUSED: ${redact(e.message)}`); return 1; }
    throw e;
  }
  out(`Read-only preflight against linked project ${args.expectProject} (no change is possible through this tool)\n`);
  const runCli = makeCliRunner({ cli: args.cli, cwd: args.cwd, exec });
  const files = localMigrationFiles(args.cwd, readDir);
  const localVersions = files.map((f) => f.slice(0, 3));
  const expectedPending = expandVersions(args.expectedPending);
  const expectedFiles = expectedPending.map((v) => files.find((f) => f.startsWith(`${v}_`)) || `${v}_<missing locally>.sql`);
  const want = (id) => !args.only || args.only.includes(id);
  const results = [];
  const guarded = (id, fn) => {
    if (!want(id)) return;
    try { results.push(fn()); } catch (e) {
      if (e instanceof RefusalError) { results.push({ id, status: 'STOP', detail: `REFUSED: ${e.message}` }); return; }
      results.push({ id, status: 'STOP', detail: `error: ${String(e.message).split('\n')[0]}` });
    }
  };
  guarded('P3', () => evaluateP3(parseMigrationList(runCli(['migration', 'list', '--linked'])), { localVersions, expectedPending, remoteThrough: args.remoteThrough }));
  guarded('P4', () => evaluateP4(readOnlyQuery(runCli, P4_SQL)));
  guarded('P5', () => evaluateP5(readOnlyQuery(runCli, P5_SQL), { backupDir: args.backupDir, cwd: args.cwd, now: now(), write, mkdir }));
  guarded('P6', () => evaluateP6(runCli(['db', 'push', '--linked', '--dry-run']), { expectedFiles }));
  for (const r of results) out(`${r.status === 'PASS' ? 'PASS' : 'STOP'}  ${r.id}  ${redact(r.detail)}`);
  const stop = results.some((r) => r.status !== 'PASS');
  out(stop ? '\nSTOP — do not proceed. Anything other than PASS is a stop condition (procedure §3).' : '\nAll requested checks PASS.');
  return stop ? 2 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runPreflight(process.argv.slice(2));
