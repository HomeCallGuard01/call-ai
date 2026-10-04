// In-memory accounting store — the REFERENCE semantics of the store
// interface. supabase/migrations/071_accounting_transactions.sql (DRAFT)
// implements the same interface as SQL functions (services/accounting/rpcStore.js);
// tests/accounting-store-parity.pglite.test.mjs runs one scenario suite
// against both so the two cannot drift.
//
// Every method is async and returns plain snake_case rows (copies — callers
// can never mutate stored state by accident). Uniqueness mirrors the SQL
// constraints exactly:
//   source events   unique (source, source_event_id)
//   transactions    unique (economic_key)
//   exceptions      unique (exception_key)
//   postings        unique (posting_key)
//   settlements     unique (channel, settlement_ref)

'use strict';

const { randomUUID } = require('node:crypto');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const TX_PATCHABLE = new Set([
  'household_id', 'account_number', 'original_transaction_id', 'status', 'blocked_reasons',
  'tax_minor', 'net_minor', 'fee_minor', 'tax_source', 'settlement_id', 'xero_status', 'xero_reference', 'xero_document_ids',
]);
const POSTING_PATCHABLE = new Set([
  'status', 'attempts', 'next_attempt_at', 'lease_until', 'last_error', 'last_error_class',
  'completed_steps', 'posted_at', 'payload_digest',
]);
// Once posted, the money on a transaction is frozen. Any later correction is
// a new transaction (refund/credit), never an edit — the same rule the SQL
// trigger enforces. (fee_minor is NOT frozen: Stripe fees are learnt from the
// payout and posted in the settlement summary, after the sale itself.)
const FROZEN_WHEN_POSTED = new Set(['tax_minor', 'net_minor', 'household_id', 'account_number']);

function createMemoryAccountingStore({ now = () => new Date() } = {}) {
  const sourceEvents = new Map(); // `${source}|${id}` -> row
  const transactions = new Map(); // id -> row
  const txByKey = new Map();      // economic_key -> id
  const exceptions = new Map();   // exception_key -> row
  const postings = new Map();     // id -> row
  const postingByKey = new Map();
  const settlements = new Map();  // `${channel}|${ref}` -> row
  const ts = () => now().toISOString();

  return {
    kind: 'memory',

    async claimSourceEvent({ source, source_event_id, event_type, environment, payload_digest }) {
      const k = `${source}|${source_event_id}`;
      const existing = sourceEvents.get(k);
      if (existing) {
        existing.delivery_count += 1;
        existing.last_received_at = ts();
        return { inserted: false, event: clone(existing) };
      }
      const row = {
        id: randomUUID(), source, source_event_id, event_type, environment, payload_digest: payload_digest || null,
        outcome: null, outcome_detail: null, transaction_ids: [], delivery_count: 1,
        received_at: ts(), last_received_at: ts(), completed_at: null,
      };
      sourceEvents.set(k, row);
      return { inserted: true, event: clone(row) };
    },

    async completeSourceEvent(id, { outcome, outcome_detail = null, transaction_ids = [] }) {
      for (const row of sourceEvents.values()) {
        if (row.id === id) {
          Object.assign(row, { outcome, outcome_detail, transaction_ids: [...transaction_ids], completed_at: ts() });
          return clone(row);
        }
      }
      throw new Error('source event not found');
    },

    async listSourceEvents() { return [...sourceEvents.values()].map(clone); },

    async insertTransaction(tx) {
      const existingId = txByKey.get(tx.economic_key);
      if (existingId) return { inserted: false, transaction: clone(transactions.get(existingId)) };
      const row = { ...clone(tx), id: randomUUID(), created_at: ts(), updated_at: ts() };
      transactions.set(row.id, row);
      txByKey.set(row.economic_key, row.id);
      return { inserted: true, transaction: clone(row) };
    },

    async updateTransaction(id, patch) {
      const row = transactions.get(id);
      if (!row) throw new Error('transaction not found');
      for (const key of Object.keys(patch)) {
        if (!TX_PATCHABLE.has(key)) throw new Error(`transaction field ${key} is not patchable`);
        if (row.status === 'posted' && FROZEN_WHEN_POSTED.has(key) && JSON.stringify(row[key]) !== JSON.stringify(patch[key])) {
          throw new Error(`transaction ${row.economic_key} is posted; ${key} is frozen`);
        }
      }
      Object.assign(row, clone(patch), { updated_at: ts() });
      return clone(row);
    },

    async getTransaction(id) { return clone(transactions.get(id)) || null; },
    async findTransactionByKey(key) { const id = txByKey.get(key); return id ? clone(transactions.get(id)) : null; },

    // Any transaction whose provider_refs[refName] === value (refund/dispute → original matching).
    async findTransactionsByRef(refName, value) {
      if (!value) return [];
      return [...transactions.values()].filter((t) => t.provider_refs && t.provider_refs[refName] === value).map(clone);
    },

    async listTransactions(filter = {}) {
      return [...transactions.values()].filter((t) => (
        (!filter.status || (Array.isArray(filter.status) ? filter.status.includes(t.status) : t.status === filter.status))
        && (!filter.channel || t.channel === filter.channel)
        && (!filter.household_id || t.household_id === filter.household_id)
        && (!filter.original_transaction_id || t.original_transaction_id === filter.original_transaction_id)
      )).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || a.created_at.localeCompare(b.created_at)).map(clone);
    },

    // Raise (or re-observe) an exception. Deterministic key = one row per
    // condition, however often reconciliation runs. A condition that comes
    // back after auto-resolution is reopened; one a person DISMISSED stays
    // dismissed (occurrences still counted) so humans are not re-nagged.
    async raiseException(ex) {
      const existing = exceptions.get(ex.exception_key);
      if (existing) {
        existing.occurrences += 1;
        existing.last_seen_at = ts();
        existing.detail = clone(ex.detail || existing.detail);
        if (existing.status === 'auto_resolved' || existing.status === 'resolved') {
          existing.status = 'open';
          existing.resolved_at = null;
          existing.resolved_by = null;
          existing.resolution_note = null;
        }
        return { inserted: false, exception: clone(existing) };
      }
      const row = {
        id: randomUUID(), exception_key: ex.exception_key, type: ex.type, severity: ex.severity,
        status: 'open', transaction_id: ex.transaction_id || null, household_id: ex.household_id || null,
        account_number: ex.account_number || null, detail: clone(ex.detail || {}),
        occurrences: 1, first_seen_at: ts(), last_seen_at: ts(), resolved_at: null, resolved_by: null, resolution_note: null,
      };
      exceptions.set(row.exception_key, row);
      return { inserted: true, exception: clone(row) };
    },

    async resolveException(exceptionKey, { status, resolved_by, resolution_note = null }) {
      const row = exceptions.get(exceptionKey);
      if (!row) return null;
      if (!['resolved', 'auto_resolved', 'dismissed'].includes(status)) throw new Error('invalid resolution status');
      if (row.status !== 'open') return clone(row);
      Object.assign(row, { status, resolved_by, resolution_note, resolved_at: ts() });
      return clone(row);
    },

    async listExceptions(filter = {}) {
      return [...exceptions.values()].filter((e) => (
        (!filter.status || e.status === filter.status)
        && (!filter.type || e.type === filter.type)
        && (!filter.transaction_id || e.transaction_id === filter.transaction_id)
      )).sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at) || a.exception_key.localeCompare(b.exception_key)).map(clone);
    },

    async enqueuePosting(p) {
      const existingId = postingByKey.get(p.posting_key);
      if (existingId) return { inserted: false, posting: clone(postings.get(existingId)) };
      const row = {
        id: randomUUID(), posting_key: p.posting_key, target: p.target || 'xero', subject_type: p.subject_type,
        transaction_id: p.transaction_id || null, settlement_id: p.settlement_id || null,
        document_plan: clone(p.document_plan || null), status: 'pending', attempts: 0, next_attempt_at: p.next_attempt_at || ts(),
        lease_until: null, last_error: null, last_error_class: null, completed_steps: {}, payload_digest: null, claim_count: 0,
        created_at: ts(), posted_at: null,
      };
      postings.set(row.id, row);
      postingByKey.set(row.posting_key, row.id);
      return { inserted: true, posting: clone(row) };
    },

    // Claim due postings: pending/retry whose next_attempt_at has passed, or
    // in_flight whose lease expired (a worker died mid-post). Claiming sets a
    // lease so two workers never post the same document concurrently.
    async claimDuePostings({ now: at, limit = 10, leaseSeconds = 120 }) {
      const nowIso = at.toISOString();
      const due = [...postings.values()].filter((p) => (
        ((p.status === 'pending' || p.status === 'retry') && p.next_attempt_at <= nowIso)
        || (p.status === 'in_flight' && p.lease_until && p.lease_until <= nowIso)
      )).sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at) || a.created_at.localeCompare(b.created_at)).slice(0, limit);
      for (const p of due) {
        p.status = 'in_flight';
        p.claim_count += 1;
        p.lease_until = new Date(at.getTime() + leaseSeconds * 1000).toISOString();
      }
      return due.map(clone);
    },

    async updatePosting(id, patch) {
      const row = postings.get(id);
      if (!row) throw new Error('posting not found');
      for (const key of Object.keys(patch)) if (!POSTING_PATCHABLE.has(key)) throw new Error(`posting field ${key} is not patchable`);
      if (row.status === 'posted' && patch.status && patch.status !== 'posted') throw new Error('a posted posting cannot change status');
      Object.assign(row, clone(patch));
      return clone(row);
    },

    async findPostingByKey(key) { const id = postingByKey.get(key); return id ? clone(postings.get(id)) : null; },
    async listPostings(filter = {}) {
      return [...postings.values()].filter((p) => !filter.status || p.status === filter.status)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)).map(clone);
    },

    async upsertSettlement(s) {
      const k = `${s.channel}|${s.settlement_ref}`;
      const existing = settlements.get(k);
      if (existing) return { inserted: false, settlement: clone(existing) };
      const row = { ...clone(s), id: randomUUID(), status: s.status || 'imported', created_at: ts() };
      settlements.set(k, row);
      return { inserted: true, settlement: clone(row) };
    },
    async updateSettlement(id, patch) {
      for (const row of settlements.values()) {
        if (row.id === id) { Object.assign(row, clone(patch)); return clone(row); }
      }
      throw new Error('settlement not found');
    },
    async listSettlements() { return [...settlements.values()].map(clone); },
  };
}

module.exports = { createMemoryAccountingStore, TX_PATCHABLE, POSTING_PATCHABLE, FROZEN_WHEN_POSTED };
