// ledgerWriter.js — the only path by which ledger rows are written. Applies
// the contract (services/ledger/contract.js) and the write rules
// (services/ledger/reconcile.js decideEntryWrite) before touching the
// repository, so an invalid or weaker record can never overwrite a
// stronger one, regardless of which job or provider produced it.
//
// `repo` is database/financialLedger.js in production and a fake in tests.
'use strict';

const { assertValidEntry, assertValidLeg } = require('./contract');
const { decideEntryWrite } = require('./reconcile');

// A final leg is never re-opened by a later, less complete fetch.
function decideLegWrite(existing, incoming) {
  if (!existing) return true;
  if (existing.reconciliation_status === 'final' && incoming.reconciliation_status !== 'final') return false;
  return true;
}

async function recordEntry(entry, repo) {
  assertValidEntry(entry);
  const existing = await repo.getEntry(entry.source_system, entry.entry_key);
  const decision = decideEntryWrite(existing, entry);
  if (!decision.write) return { written: false, flags: decision.flags };
  assertValidEntry(decision.entry);
  await repo.upsertEntry(decision.entry);
  return { written: true, flags: decision.flags };
}

/**
 * Records one normalised provider call: the leg first (so its id exists),
 * then its provider_actual charge entry pointing at it.
 */
async function recordCall({ leg, entry }, repo) {
  assertValidLeg(leg);
  const existingLeg = await repo.getLeg(leg.provider, leg.provider_call_id);
  let legId = existingLeg && existingLeg.id;
  if (decideLegWrite(existingLeg, leg)) {
    const saved = await repo.upsertLeg(leg);
    legId = saved.id;
  }
  const result = await recordEntry({ ...entry, telephony_leg_id: legId }, repo);
  return { legId, ...result };
}

module.exports = { recordEntry, recordCall, decideLegWrite };
