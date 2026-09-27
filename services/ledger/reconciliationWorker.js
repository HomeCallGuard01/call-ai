// reconciliationWorker.js — provider-neutral reconciliation jobs. NOT yet
// scheduled or wired into server.js: nothing on the live call path calls
// this. A later, separately approved step will run it on an interval.
//
//   reconcilePendingLegs   re-fetches legs whose provider outcome was still
//                          pending and records what the provider now says
//                          (a price, an explicit zero, or — after the
//                          window — "not observed"); gives up as
//                          'unavailable' after maxAttempts.
//   dailyReconciliation    compares the ledger's per-category day totals
//                          with the provider's own daily usage totals and
//                          returns rows + alert flags (never auto-corrects).
'use strict';

const { recordCall } = require('./ledgerWriter');
const { reconcileDailyTotals } = require('./reconcile');

const DEFAULT_MIN_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 20;

async function reconcilePendingLegs({ adapter, source, repo, now = new Date(), minAgeMs = DEFAULT_MIN_AGE_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS, limit = 100 }) {
  const olderThan = new Date(now.getTime() - minAgeMs).toISOString();
  const pending = await repo.listLegsAwaitingReconciliation({ provider: adapter.PROVIDER, olderThan, limit });
  const outcome = { checked: pending.length, recorded: 0, flags: [], failures: 0, gaveUp: 0 };

  for (const legRow of pending) {
    try {
      const call = await source.fetchCall(legRow.provider_call_id);
      const normalised = adapter.normaliseCall(
        call,
        { callId: legRow.call_id, householdId: legRow.household_id, householdMatch: legRow.household_match },
        { now }
      );
      const result = await recordCall(normalised, repo);
      outcome.recorded += 1;
      for (const f of result.flags) outcome.flags.push({ providerCallId: legRow.provider_call_id, flag: f });
    } catch (err) {
      outcome.failures += 1;
      await repo.recordLegAttemptFailure(legRow.id, err.message);
      if ((legRow.attempts || 0) + 1 >= maxAttempts) {
        await repo.markLegUnavailable(legRow.id);
        outcome.gaveUp += 1;
        outcome.flags.push({ providerCallId: legRow.provider_call_id, flag: 'gave_up_unavailable' });
      }
    }
  }
  return outcome;
}

/**
 * @param {object} args
 * @param {object} args.adapter
 * @param {object} args.source - provider data source (listDailyUsage)
 * @param {Array} args.entries - ledger entries for the date range
 * @param {string} args.startDate / args.endDate - YYYY-MM-DD
 */
async function dailyReconciliation({ adapter, source, entries, startDate, endDate }) {
  const usage = await source.listDailyUsage({ startDate, endDate });
  const { totals, unmapped } = adapter.supplierDailyTotals(usage);
  const rows = reconcileDailyTotals({ entries, supplierTotals: totals });
  const alerts = [];
  for (const r of rows) {
    if (r.status === 'mismatch') alerts.push({ level: 'warning', date: r.date, category: r.category, message: `ledger ${r.ledgerTotal} vs supplier ${r.supplierTotal} ${r.currency}` });
    if (r.flags.includes('supplier_charging_category_ledger_saw_as_uncharged')) {
      alerts.push({ level: 'critical', date: r.date, category: r.category, message: 'supplier billed a category the ledger recorded as uncharged (e.g. app/Voice SDK legs)' });
    }
  }
  for (const u of unmapped) alerts.push({ level: 'warning', date: u.date, category: u.sourceCategory, message: 'supplier charged an unmapped usage category' });
  return { rows, alerts };
}

module.exports = { reconcilePendingLegs, dailyReconciliation, DEFAULT_MAX_ATTEMPTS };
