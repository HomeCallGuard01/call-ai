// WS1 2026-10-10 — scripts/production/preflight-readonly.mjs refusal logic and
// check evaluation, with a STUBBED Supabase CLI. The real `supabase` binary is
// never invoked: every run passes --cli <stub> (or an injected exec), and the
// stub records each argv it receives so the test can prove exactly which
// invocations happened.
//
// Run: node tests/ws1-production-preflight.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../scripts/production/preflight-readonly.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'production', 'preflight-readonly.mjs');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const throwsRefusal = (fn) => { try { fn(); return false; } catch (e) { return e instanceof P.RefusalError; } };

const PROD = 'psbzynxplxfbyrbdidmn';
const STAGING = 'tigwgmayeuisrxjjykqd';
const PENDING = P.expandVersions(P.DEFAULT_EXPECTED_PENDING);
check(PENDING.length === 26 && PENDING[0] === '047' && PENDING[1] === '051' && PENDING[25] === '075', 'default expected pending set = 047, 051–075 (26 files)');

// ── CLI allowlist ───────────────────────────────────────────────────────
const RO = (sql) => ['db', 'query', '--linked', '--output-format', 'json', `begin transaction read only; ${sql}; rollback;`];
check(P.assertAllowedInvocation(['migration', 'list', '--linked']) === 'migration-list', 'allowed: migration list --linked');
check(P.assertAllowedInvocation(['db', 'push', '--linked', '--dry-run']) === 'db-push-dry-run', 'allowed: db push --linked --dry-run');
check(P.assertAllowedInvocation(RO(P.P4_SQL)) === 'db-query' && P.assertAllowedInvocation(RO(P.P5_SQL)) === 'db-query', 'allowed: the P4 and P5 read-only queries');
for (const [args, label] of [
  [['db', 'push', '--linked'], 'db push without --dry-run'],
  [['db', 'push', '--linked', '--dry-run', '--include-all'], 'db push --dry-run --include-all'],
  [['db', 'push', '--linked', '--include-all'], 'db push --include-all'],
  [['db', 'push'], 'db push (local)'],
  [['migration', 'repair', '--status', 'applied', '047'], 'migration repair'],
  [['link', '--project-ref', PROD], 'link'],
  [['unlink'], 'unlink'],
  [['db', 'reset', '--linked'], 'db reset'],
  [['db', 'query', '--linked', '--output-format', 'json', 'select 1'], 'db query not wrapped read-only'],
  [RO('delete from public.households'), 'db query DELETE'],
  [RO('select 1; drop table public.households'), 'db query with a second statement'],
  [RO('with x as (update public.households set status = 1 returning 1) select * from x'), 'data-modifying CTE'],
  [RO("select set_config('default_transaction_read_only','off',false)"), 'set_config'],
  [RO('select * into public.copy from public.households'), 'SELECT INTO'],
  [RO('select 1 -- ; drop'), 'SQL comment'],
  [['db', 'push', '--linked', '--dry-run', 'extra'], 'extra argument'],
]) check(throwsRefusal(() => P.assertAllowedInvocation(args)), `refused: ${label}`);
check(P.assertReadOnlySql("select ';' as semicolon_in_literal") === true, 'a semicolon inside a string literal is not mistaken for a second statement');

// ── project / location guards ───────────────────────────────────────────
const readRef = (ref) => () => (ref === null ? (() => { throw new Error('ENOENT'); })() : `${ref}\n`);
check(throwsRefusal(() => P.checkLinkedProject({ cwd: '/tmp/x', expectProject: null, readFile: readRef(PROD) })), 'refused: --expect-project missing');
check(throwsRefusal(() => P.checkLinkedProject({ cwd: '/tmp/x', expectProject: 'prod', readFile: readRef(PROD) })), 'refused: malformed --expect-project');
check(throwsRefusal(() => P.checkLinkedProject({ cwd: '/tmp/x', expectProject: PROD, readFile: readRef(null) })), 'refused: nothing linked');
check(throwsRefusal(() => P.checkLinkedProject({ cwd: '/tmp/x', expectProject: PROD, readFile: readRef(STAGING) })), 'refused: linked to staging while expecting production');
check(throwsRefusal(() => P.checkLinkedProject({ cwd: '/tmp/x', expectProject: STAGING, readFile: readRef(PROD) })), 'refused: linked to production while expecting staging');
check(throwsRefusal(() => P.checkLinkedProject({ cwd: '/some/symlink', expectProject: PROD, readFile: readRef(PROD), realpath: () => P.PRIMARY_CHECKOUT })), 'refused: the primary checkout (even via a symlink)');
check(P.checkLinkedProject({ cwd: '/tmp/x', expectProject: PROD, readFile: readRef(PROD), realpath: (p) => p }) === PROD, 'accepted: linked ref equals --expect-project');
for (const a of [['--apply'], ['--include-all'], ['--force'], ['--yes']]) check(throwsRefusal(() => P.parseArgs(['--expect-project', PROD, ...a])), `refused: unknown option ${a[0]}`);

// ── redaction ───────────────────────────────────────────────────────────
const secretText = 'connecting to postgresql://cli_login_postgres.psbz:S3cr3tPa55@db.x.supabase.co:5432/postgres password=hunter2 sk_live_abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlMTIz SUPABASE_DB_PASSWORD=zzz9 sbp_0123456789abcdef0123';
const red = P.redact(secretText);
check(!/S3cr3tPa55|hunter2|abcdefghijklmnop|c2lnbmF0dXJlMTIz|zzz9|0123456789abcdef0123/.test(red), 'redact(): connection-string password, password=, Stripe key, JWT, DB password env and Supabase token are masked');

// ── evaluators ──────────────────────────────────────────────────────────
const localFiles = [...Array.from({ length: 47 }, (_, i) => `${String(i).padStart(3, '0')}_m${i}.sql`), ...PENDING.slice(1).map((v) => `${v}_m${Number(v)}.sql`)];
localFiles.splice(47, 0, '047_m47.sql');
const localVersions = localFiles.map((f) => f.slice(0, 3)).sort();
const goodList = localVersions.map((v) => ({ local: v, remote: v <= '046' ? v : '' }));
check(P.evaluateP3(goodList, { localVersions, expectedPending: PENDING, remoteThrough: '046' }).status === 'PASS', 'P3 PASS: remote 000…046, local-only = the 26');
check(P.evaluateP3([...goodList, { local: '', remote: '030' }], { localVersions, expectedPending: PENDING, remoteThrough: '046' }).status === 'STOP', 'P3 STOP: a remote-only row');
check(P.evaluateP3(goodList.map((m) => (m.local === '051' ? { ...m, remote: '051' } : m)), { localVersions, expectedPending: PENDING, remoteThrough: '046' }).status === 'STOP', 'P3 STOP: 051 already applied remotely');
const p4none = { fc_reservations: false, forwarding_proof_audit: false, households_account_number: false, households_forwarding_proven_at: false, entitlements_revenuecat_environment: false, entitlements_store_will_renew: false };
check(P.evaluateP4([p4none]).status === 'PASS', 'P4 PASS: none of the 6 objects exists');
check(P.evaluateP4([{ ...p4none, households_account_number: true }]).status === 'STOP', 'P4 STOP: households.account_number already exists');
check(P.evaluateP4([]).status === 'STOP', 'P4 STOP: no row');
const expectedFiles = PENDING.map((v) => localFiles.find((f) => f.startsWith(`${v}_`)));
const dry = `Would push these migrations:\n${expectedFiles.map((f) => ` • ${f}`).join('\n')}\n`;
check(P.evaluateP6(dry, { expectedFiles }).status === 'PASS', 'P6 PASS: exactly the 26 files in order');
check(P.evaluateP6(dry.replace(expectedFiles[3], expectedFiles[4]), { expectedFiles }).status === 'STOP', 'P6 STOP: order/content differs');
check(P.evaluateP6(`${dry}\nFound local migration files to be inserted before the last migration on remote database. Rerun the command with --include-all flag`, { expectedFiles }).status === 'STOP', 'P6 STOP: CLI asks for --include-all');
check(P.evaluateP6('Remote database is up to date.', { expectedFiles }).status === 'STOP', 'P6 STOP: nothing to push');

// ── end-to-end with a stub CLI (separate process, temp "worktree") ─────
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hcg-preflight-'));
const wt = path.join(tmp, 'deploy-worktree');
mkdirSync(path.join(wt, 'supabase', '.temp'), { recursive: true });
mkdirSync(path.join(wt, 'supabase', 'migrations'), { recursive: true });
for (const f of localFiles) writeFileSync(path.join(wt, 'supabase', 'migrations', f), '-- stub\n');
const stubLog = path.join(tmp, 'stub-calls.jsonl');
const stubCfg = path.join(tmp, 'stub-config.json');
const stub = path.join(tmp, 'supabase-stub.mjs');
writeFileSync(stub, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(stubLog)}, JSON.stringify(args) + '\\n');
const cfg = JSON.parse(readFileSync(${JSON.stringify(stubCfg)}, 'utf8'));
const key = args[0] === 'migration' ? 'list' : args[1] === 'push' ? 'push' : args[5].includes('union all') ? 'p5' : 'p4';
process.stdout.write(cfg[key]);
`);
chmodSync(stub, 0o755);
const p5rows = P.FINGERPRINT_TABLES.map(([t]) => ({ table_name: t, row_count: 7, newest: '2026-10-09T00:00:00Z' }));
const goodCfg = {
  list: `Connecting to remote database...\n${JSON.stringify({ migrations: goodList })}\n`,
  p4: `Initialising...\n${JSON.stringify({ rows: [p4none] })}`,
  p5: JSON.stringify({ rows: p5rows }),
  push: `Connecting to postgresql://cli_login_postgres.${PROD}:TOPSECRETPW@aws-0.pooler.supabase.com:5432/postgres\n${dry}`,
};
const calls = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const run = (args, cfg = goodCfg) => {
  writeFileSync(stubCfg, JSON.stringify(cfg));
  writeFileSync(stubLog, '');
  const r = spawnSync(process.execPath, [SCRIPT, '--cli', stub, '--cwd', wt, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: calls() };
};

writeFileSync(path.join(wt, 'supabase', '.temp', 'project-ref'), `${STAGING}\n`);
let r = run(['--expect-project', PROD]);
check(r.code === 1 && /REFUSED/.test(r.out) && r.calls.length === 0, 'e2e: linked to staging, expecting production → exit 1, CLI never invoked');
r = run([]);
check(r.code === 1 && r.calls.length === 0, 'e2e: no --expect-project → exit 1, CLI never invoked');
r = run(['--expect-project', PROD, '--apply']);
check(r.code === 1 && r.calls.length === 0, 'e2e: unknown option → exit 1, CLI never invoked');

writeFileSync(path.join(wt, 'supabase', '.temp', 'project-ref'), `${PROD}\n`);
const backup = path.join(tmp, 'backups', 'pre-047-075');
r = run(['--expect-project', PROD, '--backup-dir', backup]);
check(r.code === 0 && ['P3', 'P4', 'P5', 'P6'].every((id) => new RegExp(`PASS  ${id}`).test(r.out)), 'e2e: happy path → P3/P4/P5/P6 PASS, exit 0');
check(r.calls.length === 4 && r.calls.every((a) => { try { P.assertAllowedInvocation(a); return true; } catch { return false; } }), 'e2e: exactly 4 CLI calls, every one on the read-only allowlist');
check(!r.calls.some((a) => a[0] === 'db' && a[1] === 'push' && !a.includes('--dry-run')), 'e2e: db push was never invoked without --dry-run');
check(!r.out.includes('TOPSECRETPW'), 'e2e: a password in CLI output is never printed');
const saved = existsSync(backup) ? readdirSync(backup) : [];
check(saved.length === 1 && (statSync(path.join(backup, saved[0])).mode & 0o777) === 0o600 && (statSync(backup).mode & 0o777) === 0o700, 'e2e: P5 fingerprint saved once (file 600, dir 700)');

r = run(['--expect-project', PROD]);
check(r.code === 2 && /STOP  P5  fingerprint taken but NOT saved/.test(r.out), 'e2e: no --backup-dir → P5 STOP, exit 2');
r = run(['--expect-project', PROD, '--backup-dir', path.join(wt, 'inside-repo')]);
check(r.code === 2 && /STOP  P5  --backup-dir must be outside/.test(r.out), 'e2e: backup dir inside the repo → P5 STOP');
r = run(['--expect-project', PROD, '--only', 'P4'], { ...goodCfg, p4: JSON.stringify({ rows: [{ ...p4none, entitlements_store_will_renew: true }] }) });
check(r.code === 2 && /STOP  P4  already present: entitlements_store_will_renew/.test(r.out) && r.calls.length === 1, 'e2e: --only P4 with a pre-existing column → STOP, one CLI call');
r = run(['--expect-project', PROD, '--only', 'P6'], { ...goodCfg, push: `${dry} • 076_unexpected.sql\n` });
check(r.code === 2 && /STOP  P6/.test(r.out), 'e2e: dry-run lists an unexpected extra file → P6 STOP');

console.log(failures === 0 ? '\nAll WS1 production preflight checks passed.' : `\n${failures} WS1 production preflight check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
