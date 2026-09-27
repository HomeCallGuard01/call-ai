// reconcile.js — provider-neutral rules for updating ledger entries and for
// checking the ledger against a supplier's own aggregate totals. Pure.
'use strict';

const { PROVENANCE_RANK, money } = require('./contract');

const PENDINGISH = new Set(['pending', 'unavailable']);

function sameMoney(a, b) {
  return a == null ? b == null : b != null && Math.abs(Number(a) - Number(b)) < 5e-7;
}

/**
 * Decides whether an incoming entry may replace the stored one with the
 * same (source_system, entry_key), and what — if anything — is noteworthy.
 *
 * Rules:
 *   - a weaker provenance never replaces a stronger one
 *     (provider_actual > provider_allocated/manual > estimated);
 *   - a stronger provenance always upgrades a weaker one, keeping the old
 *     figure in evidence.superseded;
 *   - pending/unavailable never replaces an observed outcome;
 *   - a charge appearing where "not_observed" was recorded is written and
 *     flagged — this is how a supplier starting to bill a previously
 *     uncharged leg (e.g. the Twilio Voice SDK leg) gets noticed;
 *   - a different supplier amount for an already-final entry is written as
 *     a correction but marked 'mismatch' for review, keeping the previous
 *     value in evidence.previous.
 *
 * @returns {{ write: boolean, entry?: object, flags: string[] }}
 */
function decideEntryWrite(existing, incoming) {
  if (!existing) return { write: true, entry: incoming, flags: [] };

  const oldRank = PROVENANCE_RANK[existing.provenance] || 0;
  const newRank = PROVENANCE_RANK[incoming.provenance] || 0;
  if (newRank < oldRank) return { write: false, flags: ['kept_stronger_provenance'] };

  if (newRank > oldRank) {
    return {
      write: true,
      entry: {
        ...incoming,
        evidence: {
          ...(incoming.evidence || {}),
          superseded: { provenance: existing.provenance, amount: existing.amount, allocation_basis: existing.allocation_basis },
        },
      },
      flags: ['provenance_upgraded'],
    };
  }

  // Same provenance from here on.
  if (incoming.provenance !== 'provider_actual') {
    const unchanged = sameMoney(existing.amount, incoming.amount) && existing.source_reference === incoming.source_reference;
    return unchanged ? { write: false, flags: [] } : { write: true, entry: incoming, flags: ['derived_amount_updated'] };
  }

  const was = existing.charge_observation;
  const now = incoming.charge_observation;

  if (PENDINGISH.has(now) && !PENDINGISH.has(was)) return { write: false, flags: ['kept_observed_outcome'] };
  if (was === now && sameMoney(existing.amount, incoming.amount) && existing.reconciliation_status === incoming.reconciliation_status) {
    return { write: false, flags: [] };
  }

  if (was === 'not_observed' && (now === 'reported_amount' || now === 'reported_zero')) {
    return {
      write: true,
      entry: { ...incoming, evidence: { ...(incoming.evidence || {}), previously: 'not_observed' } },
      flags: now === 'reported_amount' ? ['charge_appeared_after_not_observed'] : ['explicit_zero_after_not_observed'],
    };
  }

  const wasFinalAmount = existing.reconciliation_status === 'final' && (was === 'reported_amount' || was === 'reported_zero');
  if (wasFinalAmount && (now === 'reported_amount' || now === 'reported_zero') && !sameMoney(existing.amount, incoming.amount)) {
    return {
      write: true,
      entry: {
        ...incoming,
        reconciliation_status: 'mismatch',
        evidence: {
          ...(incoming.evidence || {}),
          previous: { amount: existing.amount, native_amount: existing.native_amount, finalised_at: existing.finalised_at },
        },
      },
      flags: ['provider_amount_changed_after_final'],
    };
  }

  return { write: true, entry: incoming, flags: [] };
}

function utcDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

/**
 * Compares the ledger with a supplier's own daily totals.
 *
 * @param {object} args
 * @param {Array<object>} args.entries - financial_entries-shaped rows
 * @param {Array<{ date: string, category: string, amount: number, currency: string, sourceCategory: string }>} args.supplierTotals
 *        - supplier aggregates already mapped to ledger categories by the adapter
 * @param {number} [args.absoluteTolerance] - currency units (default 0.01)
 * @param {number} [args.relativeTolerance] - fraction of the supplier total (default 0.01)
 * @returns {Array<object>} one row per (date, category, currency)
 */
function reconcileDailyTotals({ entries, supplierTotals, absoluteTolerance = 0.01, relativeTolerance = 0.01 }) {
  const rows = new Map();
  const keyOf = (date, category, currency) => `${date}|${category}|${currency}`;
  const row = (date, category, currency) => {
    const k = keyOf(date, category, currency);
    if (!rows.has(k)) {
      rows.set(k, { date, category, currency, supplierTotal: null, sourceCategories: [], ledgerTotal: 0, ledgerEntries: 0, notObserved: 0, pending: 0 });
    }
    return rows.get(k);
  };

  for (const t of supplierTotals) {
    const r = row(t.date, t.category, t.currency);
    r.supplierTotal = money((r.supplierTotal || 0) + t.amount);
    if (t.sourceCategory) r.sourceCategories.push(t.sourceCategory);
  }

  for (const e of entries) {
    const date = utcDate(e.occurred_at || e.period_start);
    const amountless = ['not_observed', 'pending', 'unavailable'].includes(e.charge_observation);
    if (!date || (!e.native_currency && !amountless)) continue;
    const currency = e.native_currency || (supplierTotals.find((t) => t.category === e.category) || {}).currency || 'UNKNOWN';
    const r = row(date, e.category, currency);
    r.ledgerEntries += 1;
    if (e.charge_observation === 'not_observed') r.notObserved += 1;
    if (e.charge_observation === 'pending' || e.charge_observation === 'unavailable') r.pending += 1;
    if (e.amount != null) r.ledgerTotal = money(r.ledgerTotal + Number(e.amount));
  }

  return [...rows.values()]
    .map((r) => {
      let status;
      let difference = null;
      if (r.supplierTotal == null) {
        status = r.ledgerTotal > 0 ? 'no_supplier_total' : 'nothing_to_compare';
      } else {
        difference = money(r.ledgerTotal - r.supplierTotal);
        const tolerance = Math.max(absoluteTolerance, Math.abs(r.supplierTotal) * relativeTolerance);
        status = Math.abs(difference) <= tolerance ? 'match' : 'mismatch';
      }
      const flags = [];
      // Supplier billed something for a category the ledger recorded as
      // not observed on that day: e.g. Twilio starting to charge app legs.
      if (r.supplierTotal > 0 && r.notObserved > 0 && r.ledgerTotal === 0) flags.push('supplier_charging_category_ledger_saw_as_uncharged');
      if (r.pending > 0) flags.push('ledger_has_pending_items');
      return { ...r, difference, status, flags };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.category < b.category ? -1 : 1));
}

module.exports = { decideEntryWrite, reconcileDailyTotals, utcDate };
