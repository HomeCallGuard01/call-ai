// WS1 2026-10-10 — rollback compatibility: production eb43368 against the
// schema after migrations 047, 051–075 (scripts/production/rollback-compat-check.mjs).
// Read-only: git show eb43368:<path> + the migration files. No database.
//
// Part A: the real check — 0 BREAKING, every REVIEW item has a written verdict.
// Part B: the checker is not vacuous — synthetic migration edits that WOULD
//         break eb43368 are each detected.
//
// Run: node tests/ws1-rollback-compat.test.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, copyFileSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../scripts/production/rollback-compat-check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

let haveRev = true;
try { execFileSync('git', ['cat-file', '-e', 'eb43368^{commit}'], { cwd: ROOT, stdio: 'ignore' }); } catch { haveRev = false; }
if (!haveRev) {
  console.log('SKIP: commit eb43368 is not in this clone (shallow?) — rollback compatibility cannot be checked here');
  process.exit(0);
}

// ── Part A ──────────────────────────────────────────────────────────────
const r = runCheck({ oldRev: 'eb43368' });
const by = (lvl) => r.findings.filter((f) => f.level === lvl);
check(r.migrationsApplied.length === 26 && r.migrationsApplied[0].startsWith('047_') && r.migrationsApplied[25].startsWith('075_'), `replayed the 26 pending migrations (047, 051–075) on top of 000–046`);
check(r.files >= 60, `read ${r.files} eb43368 server-side files via git show`);
check(r.usage.tables.size >= 10 && new Set(r.usage.rpcs.map((x) => x.fn)).size >= 15, `extracted eb43368 usage: ${r.usage.tables.size} tables, ${new Set(r.usage.rpcs.map((x) => x.fn)).size} RPCs`);
check(by('BREAKING').length === 0, `0 BREAKING dependencies${by('BREAKING').length ? ': ' + by('BREAKING').map((f) => `${f.key} (${f.detail})`).join('; ') : ''}`);
const unreviewed = by('REVIEW').filter((f) => !f.verdict);
check(unreviewed.length === 0, `every REVIEW item has a written verdict${unreviewed.length ? ' — missing: ' + unreviewed.map((f) => f.key).join(', ') : ''}`);
check(by('UNRESOLVED').length === 0, `0 UNRESOLVED references${by('UNRESOLVED').length ? ': ' + by('UNRESOLVED').map((f) => f.key).join(', ') : ''}`);
for (const fn of ['process_stripe_webhook_event', 'mark_household_twilio_number_pending_release', 'release_household_twilio_number', 'set_household_carrier_compatibility', 'assign_household_twilio_number', 'record_terms_acceptance']) {
  check(r.findings.some((f) => f.key === `function:${fn}` && ['OK', 'REVIEW'].includes(f.level)), `eb43368 RPC ${fn} is still callable with its named arguments at 075`);
}
check(r.findings.some((f) => f.key === 'grant:households:userClient' && f.level === 'OK') && r.findings.some((f) => f.key === 'grant:user_roles:userClient' && f.level === 'OK'), 'eb43368 user-scoped sign-up path (ensureHouseholdAndRole) is covered by the 059 column grants');

// ── Part B: mutation tests on a temp copy of the migrations ─────────────
function withMutation(sql, label, expect) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hcg-rollback-compat-'));
  const src = path.join(ROOT, 'supabase', 'migrations');
  for (const f of readdirSync(src).filter((x) => /^\d{3}_.+\.sql$/.test(x))) copyFileSync(path.join(src, f), path.join(dir, f));
  const last = readdirSync(dir).filter((f) => f.startsWith('075_'))[0];
  appendFileSync(path.join(dir, last), `\n${sql}\n`);
  const res = runCheck({ oldRev: 'eb43368', migrationsDir: dir });
  check(expect(res.findings), `detects: ${label}`);
}
const has = (lvl, key) => (fs) => fs.some((f) => f.level === lvl && f.key === key);
withMutation('alter table public.households drop column email;', 'a dropped column eb43368 reads/writes', has('BREAKING', 'column:households.email'));
withMutation('alter table public.calls rename column result to outcome;', 'a renamed column', has('BREAKING', 'column:calls.result'));
withMutation('drop function if exists public.set_household_phone_number(uuid, text);', 'a dropped RPC', (fs) => fs.some((f) => f.key === 'function:set_household_phone_number' && f.level === 'BREAKING'));
withMutation('revoke all on function public.record_terms_acceptance from service_role;', 'service_role EXECUTE revoked on an RPC', (fs) => fs.some((f) => f.key === 'function:record_terms_acceptance' && f.level === 'BREAKING'));
withMutation('revoke all on table public.user_roles from authenticated;', 'the sign-up grant revoked', has('BREAKING', 'grant:user_roles:userClient'));
withMutation('create trigger calls_new_guard before insert on public.calls for each row execute function public.hcg_set_updated_at();', 'a new trigger on a table eb43368 writes (needs a verdict)', (fs) => fs.some((f) => f.key === 'trigger:calls' && f.level === 'REVIEW' && !f.verdict));
withMutation('alter table public.contacts add constraint contacts_name_len check (char_length(name) < 3);', 'a new CHECK on a column eb43368 writes', (fs) => fs.some((f) => f.key === 'constraint:contacts.contacts_name_len' && f.level === 'REVIEW' && !f.verdict));

console.log(failures === 0 ? '\nAll WS1 rollback compatibility checks passed.' : `\n${failures} WS1 rollback compatibility check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
