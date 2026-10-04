// Xero posting queue (outbox worker). Exactly-once *effect* on Xero from an
// at-least-once queue:
//
//   - one posting row per economic transaction / settlement (unique posting_key);
//   - claiming takes a lease, so two workers never post the same row at once;
//   - each plan step carries a deterministic Idempotency-Key AND a
//     deterministic Reference; completed step ids are persisted after every
//     step, so a crash resumes at the next step;
//   - whenever the previous outcome is unknown (timeout, 5xx, a worker died
//     mid-call — i.e. the posting was claimed before), the step is first
//     looked up by Reference and ADOPTED if Xero already has it;
//   - Xero unavailable/not configured consumes no attempt; work stays queued;
//   - validation rejections and exhausted retries raise failed_xero_posting.
//
// The plan is rebuilt from the CURRENT transaction + policy each time, and a
// transaction that is no longer READY is held, never posted.

'use strict';

const { TX_STATUS, EXCEPTION_TYPES, EXCEPTION_SEVERITY } = require('./constants');
const { planForTransaction, planForSettlement } = require('./xero/mapping');
const { settlementBlockers } = require('./accountingPolicy');

const DEFAULT_MAX_ATTEMPTS = 8;
const UNAVAILABLE_RECHECK_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 6 * 3600;

function backoffSeconds(attempts, retryAfterSeconds) {
  const exp = Math.min(60 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS);
  return Math.max(exp, retryAfterSeconds || 0);
}

function createPostingQueue({ store, xero, policy, now = () => new Date(), maxAttempts = DEFAULT_MAX_ATTEMPTS, storeRevenueBasis = null }) {
  const later = (seconds) => new Date(now().getTime() + seconds * 1000).toISOString();

  async function raiseFailure(posting, subject, error, attempts) {
    await store.raiseException({
      exception_key: `${EXCEPTION_TYPES.FAILED_XERO_POSTING}:${posting.posting_key}`,
      type: EXCEPTION_TYPES.FAILED_XERO_POSTING,
      severity: EXCEPTION_SEVERITY[EXCEPTION_TYPES.FAILED_XERO_POSTING],
      transaction_id: posting.transaction_id || null,
      household_id: subject && subject.household_id ? subject.household_id : null,
      account_number: subject && subject.account_number ? subject.account_number : null,
      detail: { posting_key: posting.posting_key, error_class: error.errorClass || 'unknown_outcome', message: String(error.message).slice(0, 300), attempts },
    });
  }

  async function loadPlan(posting) {
    if (posting.subject_type === 'transaction') {
      const tx = await store.getTransaction(posting.transaction_id);
      if (!tx || ![TX_STATUS.READY, TX_STATUS.POSTING].includes(tx.status)) return { hold: true, subject: tx };
      const plan = planForTransaction(tx, policy.accountCodes, { postingKey: posting.posting_key });
      if (plan.error) return { hold: true, subject: tx };
      return { plan, subject: tx };
    }
    const settlement = (await store.listSettlements()).find((s) => s.id === posting.settlement_id);
    if (!settlement || settlement.status !== 'reconciled' || settlementBlockers(settlement.channel, policy).length) return { hold: true, subject: settlement };
    const plan = planForSettlement(settlement, policy.accountCodes, { postingKey: posting.posting_key, storeRevenueBasis });
    if (plan.error) return { hold: true, subject: settlement };
    return { plan, subject: settlement };
  }

  async function markSubject(posting, subject, patch) {
    if (posting.subject_type === 'transaction' && subject) await store.updateTransaction(subject.id, patch);
    if (posting.subject_type === 'settlement' && subject) {
      await store.updateSettlement(subject.id, { status: patch.status === TX_STATUS.POSTED ? 'posted' : subject.status, xero_document_ids: patch.xero_document_ids || subject.xero_document_ids || {} });
    }
  }

  async function processOne(posting) {
    const { plan, subject, hold } = await loadPlan(posting);
    if (hold) {
      await store.updatePosting(posting.id, { status: 'held', lease_until: null });
      return { posting_key: posting.posting_key, result: 'held' };
    }
    if (posting.subject_type === 'transaction') await store.updateTransaction(subject.id, { status: TX_STATUS.POSTING });
    const completed = { ...(posting.completed_steps || {}) };
    const uncertain = posting.claim_count > 1 || posting.attempts > 0 || !!posting.last_error_class;

    for (const step of plan.steps) {
      if (completed[step.name]) continue;
      const body = { ...step.body };
      if (step.bind) {
        const boundId = completed[step.bind.from];
        body[step.bind.as] = { [step.bind.idField]: boundId };
      }
      try {
        let id = null;
        if (uncertain) {
          const found = await xero.findByReference({ endpoint: step.endpoint, reference: step.reference });
          if (found) id = found.id;
        }
        if (!id) id = (await xero.createDocument({ endpoint: step.endpoint, body, idempotencyKey: step.idempotency_key })).id;
        completed[step.name] = id;
        await store.updatePosting(posting.id, { completed_steps: completed });
      } catch (err) {
        const errorClass = err.errorClass || 'unknown_outcome';
        if (errorClass === 'unavailable') {
          await store.updatePosting(posting.id, { status: 'pending', lease_until: null, next_attempt_at: later(UNAVAILABLE_RECHECK_SECONDS), last_error: String(err.message).slice(0, 300), last_error_class: errorClass });
          if (posting.subject_type === 'transaction') await store.updateTransaction(subject.id, { status: TX_STATUS.READY });
          return { posting_key: posting.posting_key, result: 'xero_unavailable' };
        }
        const attempts = posting.attempts + 1;
        if (errorClass === 'rejected' || attempts >= maxAttempts) {
          await store.updatePosting(posting.id, { status: 'failed', attempts, lease_until: null, last_error: String(err.message).slice(0, 300), last_error_class: errorClass });
          await markSubject(posting, subject, { status: TX_STATUS.FAILED, xero_status: 'failed' });
          await raiseFailure(posting, subject, err, attempts);
          return { posting_key: posting.posting_key, result: 'failed', errorClass };
        }
        await store.updatePosting(posting.id, {
          status: 'retry', attempts, lease_until: null, next_attempt_at: later(backoffSeconds(attempts, err.retryAfterSeconds)),
          last_error: String(err.message).slice(0, 300), last_error_class: errorClass,
        });
        if (posting.subject_type === 'transaction') await store.updateTransaction(subject.id, { status: TX_STATUS.READY });
        return { posting_key: posting.posting_key, result: 'retry', errorClass, attempts };
      }
    }
    await store.updatePosting(posting.id, { status: 'posted', lease_until: null, posted_at: now().toISOString(), completed_steps: completed, last_error: null, last_error_class: null });
    await markSubject(posting, subject, { status: TX_STATUS.POSTED, xero_status: 'posted', xero_reference: plan.steps[0] ? plan.steps[0].reference : null, xero_document_ids: completed });
    await store.resolveException(`${EXCEPTION_TYPES.FAILED_XERO_POSTING}:${posting.posting_key}`, { status: 'auto_resolved', resolved_by: 'system:accounting', resolution_note: 'posted on retry' });
    return { posting_key: posting.posting_key, result: 'posted', documents: completed };
  }

  return {
    async processDue({ limit = 10 } = {}) {
      const claimed = await store.claimDuePostings({ now: now(), limit });
      const results = [];
      for (const p of claimed) results.push(await processOne(p));
      return results;
    },
    // Operator action (after fixing the cause of a failed posting): queue it
    // again. Attempts restart; completed steps are kept and the lookup-first
    // path guarantees nothing already in Xero is created twice.
    async retryFailed(postingKey, { actor }) {
      if (!actor) throw new Error('actor required');
      const p = await store.findPostingByKey(postingKey);
      if (!p || p.status !== 'failed') return null;
      if (p.transaction_id) {
        const tx = await store.getTransaction(p.transaction_id);
        if (tx && tx.status === TX_STATUS.FAILED) await store.updateTransaction(tx.id, { status: TX_STATUS.READY, xero_status: null });
      }
      return store.updatePosting(p.id, { status: 'retry', attempts: 0, next_attempt_at: now().toISOString(), last_error: `manual retry by ${actor}; previous: ${p.last_error}` });
    },
  };
}

module.exports = { createPostingQueue, backoffSeconds, DEFAULT_MAX_ATTEMPTS };
