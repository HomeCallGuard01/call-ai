// Accounting automation (migration 071, DRAFT) — TRUE concurrency on a real
// PostgreSQL server with many simultaneous connections (soft-launch
// integration 2026-10-04, brief §6 C15). PGlite is one connection, so the
// accounting-store-parity suite could only interleave; this proves the
// multi-connection guarantees the Xero posting worker relies on:
//   1. the same provider event captured by 12 instances at once → ONE source
//      event (idempotency at the webhook-event layer);
//   2. the same economic transaction inserted by 12 at once → ONE row
//      (idempotency at the payment-transaction layer);
//   3. the same posting key enqueued by 12 at once → ONE posting
//      (idempotency at the Xero-document layer: one document per key);
//   4. 12 workers draining 240 due postings concurrently → every posting
//      claimed EXACTLY once (FOR UPDATE SKIP LOCKED);
//   5. a crashed worker's lease expiry → re-claimed exactly once, never by two;
//   6. a posted posting can never be moved back (guard trigger) by any worker.
// Needs embedded-postgres + pg (see financial-containment-realpg.test.mjs).
// Local only: an embedded throw-away server in a temp dir; no external DB.
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { applyAll } from './financial-containment-harness.mjs';

const modules = process.env.FC_REALPG_MODULES;
if (!modules) {
  console.log('⚠ SKIPPED: FC_REALPG_MODULES not set — real multi-connection accounting race test not run.');
  process.exit(0);
}
const req = createRequire(path.join(modules, 'package.json'));
const EmbeddedPostgres = req('embedded-postgres').default || req('embedded-postgres');
const pg = req('pg');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const PORT = 55000 + Math.floor(Math.random() * 900);
const N = 12;

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'acc-realpg-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const cfg = { host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' };
  const admin = new pg.Client(cfg);
  await admin.connect();
  const conns = [];
  try {
    await applyAll({ exec: (sql) => admin.query(sql), query: (sql, p) => admin.query(sql, p) });
    check(true, `migrations incl. 071 apply on real ${(await admin.query('select version()')).rows[0].version.split(' on ')[0]}`);
    for (let i = 0; i < N; i++) {
      const c = new pg.Client(cfg);
      await c.connect();
      await c.query('set role service_role');
      conns.push(c);
    }
    const call = (c, fn, args) => c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args).then((r) => r.rows[0].r);

    // 1. Same provider event from 12 instances at once.
    const ev = await Promise.all(conns.map((c) => call(c, 'acc_claim_source_event', ['stripe_webhook', 'evt_race_1', 'invoice.paid', 'production', 'digest-1'])));
    const evRow = (await admin.query("select count(*)::int n, max(delivery_count) d from public.accounting_source_events where source_event_id = 'evt_race_1'")).rows[0];
    check(ev.filter((r) => r.inserted).length === 1 && evRow.n === 1 && evRow.d === N, `webhook-event layer: ${N} simultaneous captures → 1 event, 1 inserter, delivery_count ${evRow.d}`);

    // 2. Same economic transaction from 12 at once.
    const tx = { economic_key: 'stripe:sale:in_race_1', channel: 'stripe', kind: 'sale', environment: 'production', source: 'stripe', provider_transaction_id: 'in_race_1', amount_quality: 'provider_actual', tax_source: 'provider', occurred_at: '2026-10-04T10:00:00Z', status: 'subledger_only', content_digest: 'cd-1', currency: 'GBP', gross_minor: 599, tax_minor: 100, net_minor: 499 };
    const txr = await Promise.all(conns.map((c) => call(c, 'acc_insert_transaction', [JSON.stringify(tx)])));
    const txIds = new Set(txr.map((r) => r.transaction.id));
    const txCount = (await admin.query("select count(*)::int n from public.accounting_transactions where economic_key = 'stripe:sale:in_race_1'")).rows[0].n;
    check(txr.filter((r) => r.inserted).length === 1 && txCount === 1 && txIds.size === 1, `payment-transaction layer: ${N} simultaneous inserts → 1 row; every caller sees the same id`);

    // 3. Same posting key from 12 at once (one Xero document per key).
    const txId = [...txIds][0];
    const posting = { posting_key: 'xero:tx:in_race_1', subject_type: 'transaction', transaction_id: txId, document_plan: { kind: 'invoice' } };
    const pr = await Promise.all(conns.map((c) => call(c, 'acc_enqueue_posting', [JSON.stringify(posting)])));
    const pCount = (await admin.query("select count(*)::int n from public.accounting_postings where posting_key = 'xero:tx:in_race_1'")).rows[0].n;
    check(pr.filter((r) => r.inserted).length === 1 && pCount === 1, `Xero-document layer: ${N} simultaneous enqueues of one key → 1 posting`);

    // 4. 12 workers drain 240 due postings concurrently.
    const TOTAL = 240;
    for (let i = 0; i < TOTAL; i++) {
      await admin.query("insert into public.accounting_postings (posting_key, subject_type, settlement_id, next_attempt_at) values ($1, 'settlement', gen_random_uuid(), '2026-10-04T09:00:00Z')", [`xero:settlement:${i}`]);
    }
    const now = '2026-10-04T10:00:00Z';
    const claimedBy = new Map();
    let duplicateClaims = 0;
    await Promise.all(conns.map(async (c, w) => {
      for (;;) {
        const rows = await call(c, 'acc_claim_due_postings', [now, 7, 120]);
        const batch = rows.filter((r) => r.subject_type === 'settlement');
        if (!rows.length) break;
        for (const r of batch) { if (claimedBy.has(r.id)) duplicateClaims++; claimedBy.set(r.id, w); }
      }
    }));
    const workersUsed = new Set(claimedBy.values()).size;
    const cc = (await admin.query("select min(claim_count)::int mn, max(claim_count)::int mx, count(*) filter (where status = 'in_flight')::int f from public.accounting_postings where subject_type = 'settlement'")).rows[0];
    check(claimedBy.size === TOTAL && duplicateClaims === 0 && cc.mn === 1 && cc.mx === 1 && cc.f === TOTAL, `${N} concurrent workers: all ${TOTAL} postings claimed exactly once (duplicates ${duplicateClaims}, claim_count ${cc.mn}..${cc.mx}, workers used ${workersUsed})`);
    check(workersUsed > 1, `the work really was spread across connections (${workersUsed} workers)`);

    // 5. Crash recovery: leases expire; 12 workers race to re-claim.
    const later = '2026-10-04T10:05:00Z';
    const reclaimed = new Map(); let dup2 = 0;
    await Promise.all(conns.map(async (c, w) => {
      for (;;) {
        const rows = await call(c, 'acc_claim_due_postings', [later, 9, 120]);
        if (!rows.length) break;
        for (const r of rows) { if (reclaimed.has(r.id)) dup2++; reclaimed.set(r.id, w); }
      }
    }));
    const cc2 = (await admin.query("select min(claim_count)::int mn, max(claim_count)::int mx from public.accounting_postings where subject_type = 'settlement'")).rows[0];
    check(dup2 === 0 && cc2.mn === 2 && cc2.mx === 2 && reclaimed.size >= TOTAL, `expired leases re-claimed exactly once each under contention (duplicates ${dup2}, claim_count ${cc2.mn}..${cc2.mx})`);
    const early = await call(conns[0], 'acc_claim_due_postings', ['2026-10-04T10:05:30Z', 100, 120]);
    check(early.length === 0, 'a live lease is never stolen before it expires');

    // 6. Posted is terminal for every worker.
    const one = (await admin.query("select id from public.accounting_postings where posting_key = 'xero:settlement:0'")).rows[0].id;
    await call(conns[1], 'acc_update_posting', [one, JSON.stringify({ status: 'posted', posted_at: '2026-10-04T10:06:00Z' })]);
    const back = await Promise.allSettled(conns.slice(2, 8).map((c) => call(c, 'acc_update_posting', [one, JSON.stringify({ status: 'retry' })])));
    const st = (await admin.query('select status from public.accounting_postings where id = $1', [one])).rows[0].status;
    check(back.every((b) => b.status === 'rejected') && st === 'posted', 'concurrent attempts to move a posted posting back are all refused (no double Xero document)');
  } finally {
    for (const c of conns) await c.end().catch(() => {});
    await admin.end().catch(() => {});
    await server.stop().catch(() => {});
  }
}

main().then(() => {
  console.log(failures === 0 ? '\nAccounting real-PostgreSQL concurrency: all checks hold.' : `\n${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}).catch((err) => { console.error('✗ accounting real-PG harness error:', err.message); process.exitCode = 1; });
