// Accounting → 051 management ledger projection, against the REAL 051
// constraints on PGlite: every projected row must be accepted by
// public.financial_entries, be idempotent on (source_system, entry_key), and
// land in finance_monthly_contribution with the right signs.
//
// Run with: node tests/accounting-ledger-projection.pglite.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { applyAll } from './financial-containment-harness.mjs';
import { H1 } from './helpers/accountingFixtures.mjs';

const require = createRequire(import.meta.url);
const { projectToFinancialEntries } = require('../services/accounting/financialEntriesProjection.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const db = new PGlite();
await applyAll(db);
await db.query('insert into public.households (id, email) values ($1, $2)', [H1, 'h1@example.invalid']);
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const insert = async (row) => q(`insert into public.financial_entries
  select * from jsonb_populate_record(null::public.financial_entries, $1::jsonb || jsonb_build_object('id', gen_random_uuid(), 'created_at', now(), 'updated_at', now()))
  on conflict (source_system, entry_key) do nothing returning entry_key`, [JSON.stringify(row)]);

const base = { environment: 'production', household_id: H1, account_number: 'HCG-00010017', currency: 'GBP', status: 'posted', provider_refs: { subscription: 'sub_1' }, occurred_at: '2026-10-01T10:00:00Z', service_period_start: '2026-10-01T10:00:00Z', service_period_end: '2026-11-01T10:00:00Z' };
const txs = [
  { ...base, channel: 'stripe', kind: 'sale', economic_key: 'stripe:sale:invoice:in_1', provider_transaction_id: 'in_1', gross_minor: 499, tax_minor: 83, fee_minor: 32, amount_quality: 'provider_actual' },
  { ...base, channel: 'stripe', kind: 'sale', economic_key: 'stripe:sale:invoice:in_2', provider_transaction_id: 'in_2', gross_minor: 499, tax_minor: 83, fee_minor: null, amount_quality: 'provider_actual' },
  { ...base, channel: 'stripe', kind: 'refund', economic_key: 'stripe:refund:re_1', provider_transaction_id: 're_1', gross_minor: 499, tax_minor: 83, fee_minor: null, amount_quality: 'provider_actual' },
  { ...base, channel: 'app_store', kind: 'sale', economic_key: 'app_store:sale:a1', provider_transaction_id: 'a1', gross_minor: 499, tax_minor: 83, fee_minor: 62, proceeds_minor: 354, amount_quality: 'estimated', provider_refs: { original_transaction: 'o1' } },
];
let inserted = 0;
for (const tx of txs) {
  for (const row of projectToFinancialEntries(tx)) {
    try { inserted += (await insert(row)).length; } catch (err) { check(false, `${row.entry_key} rejected by 051: ${err.message}`); }
  }
}
check(inserted === 10, `all ${inserted} projected rows accepted by the 051 constraints`);
let again = 0;
for (const tx of txs) for (const row of projectToFinancialEntries(tx)) again += (await insert(row)).length;
check(again === 0, 'projection is idempotent on (source_system, entry_key)');
const pending = await q("select count(*)::int c from public.financial_entries where amount is null");
check(pending[0].c === 2, 'two unknown Stripe fees are pending (amount NULL), not zero');
const c = await q("select revenue::numeric r, tax::numeric t, payment_fees::numeric f from public.finance_monthly_contribution where native_currency = 'GBP'");
// revenue: 4.99 + 4.99 − 4.16 (refund, ex VAT) + 4.16 (Apple ex store VAT) = 9.98; tax: Stripe VAT 0.83 × 2 = 1.66;
// fees: 0.32 + 0.62 = 0.94. Contribution 9.98 − 1.66 − 0.94 = 7.38 = economic truth: one kept Stripe sale
// (4.16 net − 0.32 fee = 3.84) + one refunded Stripe sale (0) + Apple (4.16 − 0.62 commission = 3.54).
check(c.length === 1 && Number(c[0].r) === 9.98, `contribution view revenue £9.98 (refund recorded ex VAT; got ${c[0] && c[0].r})`);
check(Number(c[0].t) === -1.66 || Number(c[0].t) === 1.66, `VAT £1.66 from the two Stripe sales only (got ${c[0].t})`);
check(Math.abs(Number(c[0].f)) === 0.94, `fees £0.94: Stripe 0.32 + Apple commission (estimated) 0.62 (got ${c[0].f})`);
const contribution = await q("select contribution::numeric x from public.finance_monthly_contribution where native_currency = 'GBP'");
check(Number(contribution[0].x) === 7.38, `contribution £7.38 equals the economic truth (got ${contribution[0].x})`);
const quality = await q("select amount_quality, count(*)::int n from public.finance_entries_reporting where source_system = 'hcg_accounting' group by 1 order by 1");
check(quality.some((r) => r.amount_quality === 'ESTIMATED') && quality.some((r) => r.amount_quality === 'ACTUAL'), 'Apple rows are ESTIMATED, Stripe rows ACTUAL in the reporting view');

console.log(failures === 0 ? '\nProjection accepted by the 051 ledger.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
