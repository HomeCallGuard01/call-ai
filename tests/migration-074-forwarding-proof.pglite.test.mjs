// Migration 074 (LF-2 forwarding proof on households): applies after 000→073,
// idempotent, CHECK on proof method, existing rows not proven, and the rollback
// refuses while proof is recorded. 2026-10-06.
//
// Run with: node tests/migration-074-forwarding-proof.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

const BOOTSTRAP_SQL = `
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb; $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to service_role;
grant select, insert, update, delete on auth.users to service_role;
`;

function asServiceRole(db) {
  return db.exec(`reset role; set role service_role;`);
}

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

async function main() {
  const db = new PGlite();
  await db.exec(BOOTSTRAP_SQL);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  assert(files.includes('074_households_forwarding_proof.sql'), 'migration 074 file is present');
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try { await db.exec(sql); } catch (err) { console.error(`✗ ${file} failed to apply: ${err.message}`); process.exitCode = 1; return; }
  }
  assert(true, `all ${files.length} migrations applied in order (000 → 074)`);
  const cols = await db.query(`select column_name, is_nullable from information_schema.columns where table_schema='public' and table_name='households' and column_name in ('forwarding_proven_at','forwarding_proof_method') order by column_name`);
  assert(cols.rows.length === 2 && cols.rows.every((r) => r.is_nullable === 'YES'), '074 adds forwarding_proven_at + forwarding_proof_method, both nullable');
  const sql074 = await readFile(path.join(migrationsDir, '074_households_forwarding_proof.sql'), 'utf8');
  let again = true; try { await db.exec(sql074); } catch { again = false; }
  assert(again, '074 can be re-applied safely (idempotent)');

  const hh = (await db.query(`insert into public.households (auth_user_id, email, phone_number, activation_verified_at) values (null, 'lf2@example.com', '+441234560074', now()) returning id, forwarding_proven_at`)).rows[0];
  assert(hh.forwarding_proven_at === null, 'a household with an inbound-call stamp is NOT proven by default (LF-2)');
  let bad = false; try { await db.query(`update public.households set forwarding_proof_method = 'direct_call' where id = $1`, [hh.id]); } catch { bad = true; }
  assert(bad, 'proof method is constrained (an arbitrary "direct_call" is rejected)');
  await db.query(`update public.households set forwarding_proven_at = now(), forwarding_proof_method = 'verification_call' where id = $1`, [hh.id]);

  const rollback = await readFile(path.join(migrationsDir, '_rollbacks', '074_rollback_households_forwarding_proof.sql'), 'utf8');
  let refused = false; try { await db.exec(rollback); } catch (err) { refused = /rollback 074/.test(err.message); }
  await db.exec('rollback;').catch(() => {});
  assert(refused, 'rollback refuses while forwarding proof is recorded');
  await db.query(`update public.households set forwarding_proven_at = null, forwarding_proof_method = null where id = $1`, [hh.id]);
  await db.exec(rollback);
  const gone = (await db.query(`select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='households' and column_name in ('forwarding_proven_at','forwarding_proof_method')`)).rows[0].n;
  assert(gone === 0, 'with no proof recorded the rollback removes both columns');

  console.log(failures === 0 ? '\nMigration 074: all checks hold.' : `\n${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
