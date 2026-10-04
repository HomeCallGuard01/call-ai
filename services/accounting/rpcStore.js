// Accounting store over the SQL functions of migration 071 (DRAFT), via a
// Supabase client's .rpc(). Same interface and semantics as memoryStore.js —
// tests/accounting-store-parity.pglite.test.mjs runs the shared scenario
// suite through this adapter against PGlite.
'use strict';

function createRpcAccountingStore(supabase) {
  async function call(name, params) {
    const { data, error } = await supabase.rpc(name, params);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  }
  return {
    kind: 'rpc',
    claimSourceEvent: (e) => call('acc_claim_source_event', {
      p_source: e.source, p_source_event_id: e.source_event_id, p_event_type: e.event_type, p_environment: e.environment, p_payload_digest: e.payload_digest || null,
    }),
    completeSourceEvent: (id, { outcome, outcome_detail = null, transaction_ids = [] }) => call('acc_complete_source_event', {
      p_id: id, p_outcome: outcome, p_outcome_detail: outcome_detail, p_transaction_ids: transaction_ids,
    }),
    listSourceEvents: () => call('acc_list_source_events', {}),
    insertTransaction: (tx) => call('acc_insert_transaction', { p_tx: tx }),
    updateTransaction: (id, patch) => call('acc_update_transaction', { p_id: id, p_patch: patch }),
    getTransaction: async (id) => (await call('acc_get_transaction', { p_id: id })) || null,
    findTransactionByKey: async (key) => (await call('acc_find_transaction_by_key', { p_key: key })) || null,
    findTransactionsByRef: async (ref, value) => (value ? call('acc_find_transactions_by_ref', { p_ref: ref, p_value: value }) : []),
    listTransactions: (filter = {}) => call('acc_list_transactions', { p_filter: filter }),
    raiseException: (ex) => call('acc_raise_exception', { p_ex: ex }),
    resolveException: async (key, { status, resolved_by, resolution_note = null }) => (await call('acc_resolve_exception', {
      p_key: key, p_status: status, p_resolved_by: resolved_by, p_note: resolution_note,
    })) || null,
    listExceptions: (filter = {}) => call('acc_list_exceptions', { p_filter: filter }),
    enqueuePosting: (p) => call('acc_enqueue_posting', { p_posting: p }),
    claimDuePostings: ({ now, limit = 10, leaseSeconds = 120 }) => call('acc_claim_due_postings', { p_now: now.toISOString(), p_limit: limit, p_lease_seconds: leaseSeconds }),
    updatePosting: (id, patch) => call('acc_update_posting', { p_id: id, p_patch: patch }),
    findPostingByKey: async (key) => (await call('acc_find_posting_by_key', { p_key: key })) || null,
    listPostings: (filter = {}) => call('acc_list_postings', { p_filter: filter }),
    upsertSettlement: (s) => call('acc_upsert_settlement', { p_s: s }),
    updateSettlement: (id, patch) => call('acc_update_settlement', { p_id: id, p_patch: patch }),
    listSettlements: () => call('acc_list_settlements', {}),
  };
}

module.exports = { createRpcAccountingStore };
