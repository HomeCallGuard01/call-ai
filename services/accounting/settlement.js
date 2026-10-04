// Settlement import + reconciliation (Stripe payouts, App Store / Play
// proceeds). Input is a NORMALISED settlement (shape below), not a raw
// provider file: the parsers for real Stripe payout reconciliation reports
// and Apple/Google financial reports are deliberately not written until they
// can be validated against real files (docs/finance/ACCOUNTING_AUTOMATION.md §6).
//
//   { channel, settlement_ref, environment, currency, period_start, period_end, paid_at,
//     totals: { gross_minor, refunds_minor, fee_minor, proceeds_minor, payout_minor, units },
//     lines?: [{ line_ref, type: 'charge'|'refund'|'dispute', source_ref, gross_minor, fee_minor }] }
//
// Stripe payouts list each balance transaction → matched one-by-one.
// Apple/Google reports are aggregated (per product/country, fiscal month) →
// matched in aggregate against the RevenueCat-fed sub-ledger for the period.

'use strict';

const { CHANNELS, KINDS, TX_STATUS, EXCEPTION_TYPES, EXCEPTION_SEVERITY } = require('./constants');

const STORE_CHANNELS = new Set([CHANNELS.APP_STORE, CHANNELS.PLAY_STORE]);

function createSettlementReconciler({ store, now = () => new Date(), storeProceedsToleranceBps = 200 }) {
  async function raise(type, key, fields) {
    return store.raiseException({ exception_key: `${type}:${key}`, type, severity: EXCEPTION_SEVERITY[type], ...fields });
  }
  async function acceptedOrNone(key) {
    const [type] = key.split(':');
    const ex = (await store.listExceptions({ type })).find((e) => e.exception_key === key);
    return !ex || ex.status === 'resolved' || ex.status === 'dismissed';
  }

  async function matchStripeLine(line) {
    if (line.type === 'refund') return store.findTransactionByKey(`stripe:refund:${line.source_ref}`);
    if (line.type === 'dispute') {
      return (await store.findTransactionByKey(`stripe:${line.gross_minor < 0 ? 'chargeback_reversal' : 'chargeback'}:${line.source_ref}`))
        || store.findTransactionByKey(`stripe:chargeback:${line.source_ref}`);
    }
    for (const ref of ['charge', 'payment_intent', 'invoice']) {
      const list = await store.findTransactionsByRef(ref, line.source_ref);
      const sale = list.find((t) => t.kind === KINDS.SALE && t.channel === CHANNELS.STRIPE);
      if (sale) return sale;
    }
    return null;
  }

  async function reconcileStripe(settlement) {
    const issues = [];
    let lineGross = 0;
    let lineFees = 0;
    for (const line of settlement.lines || []) {
      const sign = line.type === 'charge' ? 1 : -1;
      lineGross += sign * line.gross_minor;
      lineFees += line.fee_minor || 0;
      const tx = await matchStripeLine(line);
      const key = `settlement:${settlement.channel}:${settlement.settlement_ref}:${line.line_ref}`;
      if (!tx) {
        issues.push(key);
        await raise(EXCEPTION_TYPES.UNMATCHED_PAYMENT, key, { detail: { reason: 'payout line has no accounting transaction', line } });
        continue;
      }
      await store.updateTransaction(tx.id, { settlement_id: settlement.id, ...(Number.isSafeInteger(line.fee_minor) ? { fee_minor: line.fee_minor } : {}) });
      if (tx.gross_minor !== line.gross_minor) {
        const dk = `amount:${key}`;
        await raise(EXCEPTION_TYPES.AMOUNT_DISCREPANCY, dk, { transaction_id: tx.id, household_id: tx.household_id, account_number: tx.account_number, detail: { reason: 'payout line amount differs from transaction', line_gross_minor: line.gross_minor, transaction_gross_minor: tx.gross_minor } });
        if (!(await acceptedOrNone(`${EXCEPTION_TYPES.AMOUNT_DISCREPANCY}:${dk}`))) issues.push(dk);
      }
    }
    const t = settlement.totals || {};
    if (settlement.lines && settlement.lines.length) {
      const expectedPayout = lineGross - lineFees;
      if (t.payout_minor !== expectedPayout || (Number.isSafeInteger(t.fee_minor) && t.fee_minor !== lineFees)) {
        const dk = `totals:${settlement.channel}:${settlement.settlement_ref}`;
        await raise(EXCEPTION_TYPES.AMOUNT_DISCREPANCY, dk, { detail: { reason: 'payout total does not equal its lines', payout_minor: t.payout_minor, lines_net_minor: expectedPayout, fee_minor: t.fee_minor, lines_fee_minor: lineFees } });
        if (!(await acceptedOrNone(`${EXCEPTION_TYPES.AMOUNT_DISCREPANCY}:${dk}`))) issues.push(dk);
      }
    }
    return issues;
  }

  async function reconcileStore(settlement) {
    const start = settlement.period_start;
    const end = settlement.period_end;
    const txs = (await store.listTransactions({ channel: settlement.channel }))
      .filter((tx) => tx.environment === 'production' && tx.currency === settlement.currency
        && Date.parse(tx.occurred_at) >= Date.parse(start) && Date.parse(tx.occurred_at) < Date.parse(end));
    let units = 0;
    let proceeds = 0;
    let unknownProceeds = 0;
    for (const tx of txs) {
      const sign = tx.kind === KINDS.SALE ? 1 : -1;
      units += sign;
      if (Number.isSafeInteger(tx.proceeds_minor)) proceeds += sign * tx.proceeds_minor; else unknownProceeds += 1;
    }
    const t = settlement.totals || {};
    const tolerance = Math.ceil(Math.abs(t.proceeds_minor || 0) * storeProceedsToleranceBps / 10000);
    const issues = [];
    const key = `settlement:${settlement.channel}:${settlement.settlement_ref}`;
    if (units !== t.units || unknownProceeds > 0 || Math.abs(proceeds - t.proceeds_minor) > tolerance) {
      await raise(EXCEPTION_TYPES.AMOUNT_DISCREPANCY, key, { detail: {
        reason: 'store report differs from RevenueCat sub-ledger', report_units: t.units, subledger_units: units,
        report_proceeds_minor: t.proceeds_minor, subledger_estimated_proceeds_minor: proceeds, tolerance_minor: tolerance, transactions_without_estimate: unknownProceeds,
      } });
      if (!(await acceptedOrNone(`${EXCEPTION_TYPES.AMOUNT_DISCREPANCY}:${key}`))) issues.push(key);
    } else {
      await store.resolveException(`${EXCEPTION_TYPES.AMOUNT_DISCREPANCY}:${key}`, { status: 'auto_resolved', resolved_by: 'system:accounting', resolution_note: 'report now agrees with sub-ledger' });
    }
    for (const tx of txs) if (tx.status === TX_STATUS.SUBLEDGER_ONLY && !tx.settlement_id) await store.updateTransaction(tx.id, { settlement_id: settlement.id });
    return issues;
  }

  return {
    // Idempotent: the same settlement imported twice is the same row.
    async importSettlement(report) {
      if (!report || !report.channel || !report.settlement_ref) throw new Error('settlement needs channel and settlement_ref');
      const { settlement } = await store.upsertSettlement({
        channel: report.channel, settlement_ref: report.settlement_ref, environment: report.environment || 'production',
        currency: report.currency, period_start: report.period_start || null, period_end: report.period_end || null, paid_at: report.paid_at || null,
        totals: report.totals || {}, lines: report.lines || [], status: 'imported', xero_document_ids: {},
      });
      return settlement;
    },

    async reconcile(settlementId) {
      const settlement = (await store.listSettlements()).find((s) => s.id === settlementId);
      if (!settlement) throw new Error('settlement not found');
      if (settlement.status === 'posted') return { status: 'posted', issues: [] };
      if (settlement.environment !== 'production') {
        await store.updateSettlement(settlement.id, { status: 'excluded_sandbox' });
        return { status: 'excluded_sandbox', issues: [] };
      }
      const issues = STORE_CHANNELS.has(settlement.channel) ? await reconcileStore(settlement) : await reconcileStripe(settlement);
      const status = issues.length ? 'discrepancy' : 'reconciled';
      await store.updateSettlement(settlement.id, { status, reconciled_at: status === 'reconciled' ? now().toISOString() : null });
      if (status === 'reconciled') {
        const q = await store.enqueuePosting({ posting_key: `xero:settlement:${settlement.channel}:${settlement.settlement_ref}`, subject_type: 'settlement', settlement_id: settlement.id, next_attempt_at: now().toISOString() });
        if (!q.inserted && q.posting.status === 'held') await store.updatePosting(q.posting.id, { status: 'pending', next_attempt_at: now().toISOString() });
      }
      return { status, issues };
    },
  };
}

module.exports = { createSettlementReconciler };
