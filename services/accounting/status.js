// Read-only accounting status for the admin dashboard. Never returns
// customer PII: households appear only as HCG account numbers / ids.
'use strict';

const { ACCOUNTANT_DECISIONS, TX_STATUS } = require('./constants');

async function buildAccountingStatus({ store, policy, xeroStatus, now = new Date() }) {
  const [transactions, exceptions, postings, events, settlements] = await Promise.all([
    store.listTransactions({}), store.listExceptions({}), store.listPostings({}), store.listSourceEvents(), store.listSettlements(),
  ]);
  const count = (list, key) => list.reduce((m, x) => ({ ...m, [x[key]]: (m[x[key]] || 0) + 1 }), {});

  // Money totals: production only, per channel × currency × kind. Store
  // amounts are RevenueCat ESTIMATES until a settlement reconciles them, so
  // they are reported separately and labelled.
  const totals = {};
  for (const tx of transactions) {
    if (tx.environment !== 'production') continue;
    const k = `${tx.channel}|${tx.currency}`;
    totals[k] = totals[k] || { channel: tx.channel, currency: tx.currency, amount_quality: tx.amount_quality, by_kind: {} };
    const b = totals[k].by_kind[tx.kind] || { count: 0, gross_minor: 0, tax_minor: 0, tax_unknown: 0, fee_minor: 0, fee_unknown: 0 };
    b.count += 1;
    b.gross_minor += tx.gross_minor || 0;
    if (Number.isSafeInteger(tx.tax_minor)) b.tax_minor += tx.tax_minor; else b.tax_unknown += 1;
    if (Number.isSafeInteger(tx.fee_minor)) b.fee_minor += tx.fee_minor; else b.fee_unknown += 1;
    totals[k].by_kind[tx.kind] = b;
  }
  const open = exceptions.filter((e) => e.status === 'open');
  return {
    generated_at: now.toISOString(),
    label: 'Accounting automation — visibility only. Nothing here posts to Xero or changes billing.',
    xero: xeroStatus,
    accountant_decisions: ACCOUNTANT_DECISIONS.map((d) => ({ ...d, confirmed: policy.confirmed.has(d.id) })),
    account_codes_configured: Object.keys(policy.accountCodes || {}).sort(),
    source_events: { total: events.length, by_outcome: count(events, 'outcome'), by_source: count(events, 'source') },
    transactions: {
      total: transactions.length,
      by_status: count(transactions, 'status'),
      by_channel: count(transactions, 'channel'),
      blocked_reasons: transactions.filter((t) => t.status === TX_STATUS.BLOCKED)
        .flatMap((t) => t.blocked_reasons || []).reduce((m, r) => ({ ...m, [r]: (m[r] || 0) + 1 }), {}),
      totals: Object.values(totals),
    },
    exceptions: {
      open: open.length,
      by_type: count(open, 'type'),
      by_severity: count(open, 'severity'),
      oldest_open: open.slice(0, 50).map((e) => ({
        exception_key: e.exception_key, type: e.type, severity: e.severity, account_number: e.account_number,
        first_seen_at: e.first_seen_at, occurrences: e.occurrences, detail: e.detail,
      })),
    },
    postings: { total: postings.length, by_status: count(postings, 'status') },
    settlements: settlements.map((s) => ({ channel: s.channel, settlement_ref: s.settlement_ref, status: s.status, currency: s.currency, totals: s.totals })),
  };
}

module.exports = { buildAccountingStatus };
