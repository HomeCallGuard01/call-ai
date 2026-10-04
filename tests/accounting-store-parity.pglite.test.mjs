// Accounting automation — the SQL store (migration 071, DRAFT) on PGlite.
//
// 1. Runs the SAME scenario suite as tests/accounting-engine.test.mjs, but
//    through services/accounting/rpcStore.js → the 071 SQL functions, so the
//    database (not only JS) enforces source-event dedupe, economic-key
//    uniqueness, exception/posting idempotency and leased claiming.
// 2. Checks the SQL guards directly: immutable money identity, frozen posted
//    amounts, sandbox never postable, service-role-only access, rollback.
//
// PGlite is one connection: concurrency here is interleaving, not true
// multi-connection racing (FOR UPDATE SKIP LOCKED must be re-proven on a real
// PostgreSQL / staging — see the handover).
//
// Run with: node tests/accounting-store-parity.pglite.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyAll, ROOT } from './financial-containment-harness.mjs';
import { runAccountingScenarios } from './helpers/accountingScenarios.mjs';
import { H1, H2, H3, HNOACCT } from './helpers/accountingFixtures.mjs';

const require = createRequire(import.meta.url);
const { createRpcAccountingStore } = require('../services/accounting/rpcStore.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// supabase.rpc stand-in: named-argument call; objects → JSON text (jsonb),
// arrays of scalars → PostgreSQL arrays (uuid[]).
function rpcClient(db) {
  return {
    async rpc(name, params) {
      const keys = Object.keys(params || {});
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const values = keys.map((k) => {
        const v = params[k];
        if (Array.isArray(v) && k === 'p_transaction_ids') return v;
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      try {
        await db.exec('reset role; set role service_role;');
        const rows = (await db.query(`select public.${name}(${args}) as r`, values)).rows;
        return { data: rows[0].r, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      } finally {
        await db.exec('reset role;');
      }
    },
  };
}

async function freshDb() {
  const db = new PGlite();
  await applyAll(db);
  for (const id of [H1, H2, H3, HNOACCT]) {
    await db.query('insert into public.households (id, email) values ($1, $2)', [id, `${id}@example.invalid`]);
  }
  return db;
}

// ── 1. Shared scenarios through SQL ─────────────────────────────────────────
const n = await runAccountingScenarios({
  newStore: async () => createRpcAccountingStore(rpcClient(await freshDb())),
  check,
  only: process.argv[2] || null,
});

// ── 2. Direct SQL guards ────────────────────────────────────────────────────
console.log('\n── SQL guards');
const db = await freshDb();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const rejects = async (fn, pattern, message) => {
  try { await fn(); check(false, `${message} (no error raised)`); } catch (err) { check(pattern.test(err.message), `${message}${pattern.test(err.message) ? '' : ` (wrong error: ${err.message})`}`); }
};
const store = createRpcAccountingStore(rpcClient(db));
const ev = await store.claimSourceEvent({ source: 'stripe_webhook', source_event_id: 'evt_sql', event_type: 'invoice.paid', environment: 'production' });
const base = {
  economic_key: 'stripe:sale:invoice:in_sql', channel: 'stripe', kind: 'sale', environment: 'production', source: 'stripe_webhook',
  household_id: H1, account_number: 'HCG-00010017', provider_transaction_id: 'in_sql', provider_refs: { invoice: 'in_sql', charge: 'ch_sql' },
  currency: 'GBP', gross_minor: 499, tax_minor: 83, net_minor: 416, amount_quality: 'provider_actual', tax_source: 'provider',
  occurred_at: '2026-10-01T10:00:00Z', status: 'ready', blocked_reasons: [], content_digest: 'd1', first_source_event_id: ev.event.id,
};
const ins = await store.insertTransaction(base);
const dup = await store.insertTransaction({ ...base, gross_minor: 999, net_minor: 916, content_digest: 'd2' });
check(ins.inserted && !dup.inserted && dup.transaction.gross_minor === 499, 'economic_key unique: second insert returns the original untouched');
check((await q("select count(*)::int c from public.accounting_transactions"))[0].c === 1, 'exactly one row');
await rejects(() => q("update public.accounting_transactions set gross_minor = 1 where economic_key = 'stripe:sale:invoice:in_sql'"), /immutable/, 'gross amount is immutable (trigger)');
await rejects(() => q("insert into public.accounting_transactions (economic_key, channel, kind, environment, source, provider_transaction_id, currency, gross_minor, amount_quality, tax_source, occurred_at, status, content_digest) values ('k_sb','stripe','sale','sandbox','stripe_webhook','x','GBP',1,'provider_actual','missing',now(),'ready','d')"),
  /sandbox_never_posted|check constraint/, 'a sandbox transaction can never be ready/posted (check constraint)');
await rejects(() => q("insert into public.accounting_transactions (economic_key, channel, kind, environment, source, provider_transaction_id, currency, gross_minor, amount_quality, tax_source, occurred_at, status, content_digest) values ('k_noacct','stripe','sale','production','stripe_webhook','x','GBP',1,'provider_actual','missing',now(),'ready','d')"),
  /postable_has_account|check constraint/, 'a postable transaction must carry an HCG account number');
await rejects(() => q("insert into public.accounting_transactions (economic_key, channel, kind, environment, source, provider_transaction_id, currency, gross_minor, amount_quality, tax_source, occurred_at, status, content_digest, account_number) values ('k_ref','stripe','refund','production','stripe_webhook','x','GBP',1,'provider_actual','missing',now(),'ready','d','HCG-00010017')"),
  /reversal_has_original|check constraint/, 'a postable refund must reference its original');
await rejects(() => q("update public.accounting_transactions set net_minor = 1 where economic_key = 'stripe:sale:invoice:in_sql'"), /net_consistent|check constraint/, 'net must equal gross − VAT');
await store.updateTransaction(ins.transaction.id, { status: 'posted' });
await rejects(() => store.updateTransaction(ins.transaction.id, { tax_minor: 0, net_minor: 499 }), /frozen/, 'posted VAT is frozen (trigger)');
await rejects(() => store.updateTransaction(ins.transaction.id, { gross_minor: 1 }), /not patchable/, 'patch whitelist refuses money identity fields');
const fee = await store.updateTransaction(ins.transaction.id, { fee_minor: 32 });
check(fee.fee_minor === 32, 'Stripe fee can still be attached after posting (learnt from the payout)');
const p = await store.enqueuePosting({ posting_key: 'xero:sql', subject_type: 'transaction', transaction_id: ins.transaction.id });
await store.updatePosting(p.posting.id, { status: 'posted', posted_at: new Date().toISOString() });
await rejects(() => store.updatePosting(p.posting.id, { status: 'retry' }), /posted/, 'a posted posting cannot be re-queued (trigger)');
const claimA = await store.claimDuePostings({ now: new Date(Date.now() + 3600e3), limit: 10 });
check(claimA.length === 0, 'a posted posting is never claimed again');
const e1 = await store.raiseException({ exception_key: 'duplicate:x', type: 'duplicate', severity: 'high', detail: { a: 1 } });
await store.resolveException('duplicate:x', { status: 'dismissed', resolved_by: 'admin:test' });
const e2 = await store.raiseException({ exception_key: 'duplicate:x', type: 'duplicate', severity: 'high', detail: { a: 2 } });
check(e1.inserted && !e2.inserted && e2.exception.status === 'dismissed' && e2.exception.occurrences === 2, 'a dismissed exception stays dismissed when re-observed (occurrences counted)');
await rejects(() => q("insert into public.accounting_exceptions (exception_key, type, severity) values ('bad', 'made_up', 'high')"), /check constraint/, 'unknown exception type refused');
const src2 = await store.claimSourceEvent({ source: 'stripe_webhook', source_event_id: 'evt_sql', event_type: 'invoice.paid', environment: 'production' });
check(!src2.inserted && src2.event.delivery_count === 2, 'source event dedupe counts redeliveries');

// Privileges.
await db.exec('set role anon;');
await rejects(() => q('select * from public.accounting_transactions'), /permission denied/, 'anon cannot read accounting tables');
await rejects(() => q("select public.acc_list_transactions('{}'::jsonb)"), /permission denied/, 'anon cannot execute accounting functions');
await db.exec('reset role; set role authenticated;');
await rejects(() => q("select public.acc_raise_exception('{}'::jsonb)"), /permission denied/, 'authenticated cannot execute accounting functions');
await rejects(() => q('select * from public.accounting_exceptions'), /permission denied/, 'authenticated cannot read accounting tables');
await db.exec('reset role;');

// Rollback refuses while anything is posted; succeeds on a clean database.
const rollback = await readFile(path.join(ROOT, 'supabase', 'migrations', '_rollbacks', '071_rollback_accounting_transactions.sql'), 'utf8');
await rejects(() => db.exec(rollback), /already in Xero/, 'rollback refuses while postings are in Xero');
await db.exec('rollback;').catch(() => {});
const clean = await freshDb();
await clean.exec(rollback);
check((await clean.query("select to_regclass('public.accounting_transactions') as t")).rows[0].t === null, 'rollback drops 071 on a database with nothing posted');
await clean.exec(await readFile(path.join(ROOT, 'supabase', 'migrations', '071_accounting_transactions.sql'), 'utf8'));
check((await clean.query("select to_regclass('public.accounting_transactions') as t")).rows[0].t !== null, '071 re-applies after rollback');

console.log(failures === 0 ? `\nAll ${n} scenarios + SQL guards passed on PGlite.` : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
