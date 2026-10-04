// Accounting engine: source event → idempotent accounting transaction →
// posting decision, plus the exceptions that explain anything it cannot
// post. Pure orchestration over an injected store (memoryStore / rpcStore),
// resolver (household + HCG account number) and policy.
//
// Idempotency, in three layers:
//   1. Source event   unique (source, source_event_id). A webhook retry or a
//                     replay of the same event is a no-op (duplicate_event).
//   2. Economic key   unique (economic_key) — the provider's id for the MONEY
//                     (Stripe invoice/PaymentIntent/refund/dispute id, the
//                     store transaction id). A different event describing the
//                     same money is a no-op (duplicate_economic); if it
//                     describes it DIFFERENTLY a `duplicate` exception is raised
//                     and the first record is kept.
//   3. Posting key    unique (posting_key) + Xero Idempotency-Key + find-by-
//                     Reference before re-creating (services/accounting/postingQueue.js).
//
// The engine never changes entitlement. Entitlement stays with the existing
// canonical webhook path (migration 070 / services/revenuecatWebhook.js);
// reconciliation (services/accounting/reconciliation.js) only REPORTS when
// money and entitlement disagree.

'use strict';

const { createHash } = require('node:crypto');
const {
  CHANNELS, KINDS, TX_STATUS, EXCEPTION_TYPES, EXCEPTION_SEVERITY, EVENT_OUTCOMES, SUPPORTED_CURRENCIES,
} = require('./constants');
const { postingBlockers, checkStripeVat } = require('./accountingPolicy');
const { normalizeStripeEvent } = require('./normalizeStripe');
const { normalizeRevenueCatEvent } = require('./normalizeRevenueCat');
const { planForTransaction } = require('./xero/mapping');

const STORE_CHANNELS = new Set([CHANNELS.APP_STORE, CHANNELS.PLAY_STORE]);
const REVERSAL_KINDS = new Set([KINDS.REFUND, KINDS.CHARGEBACK]);
// Exceptions a person may ACCEPT (resolve/dismiss) to let posting continue:
// the facts are the provider's and correct, they just need human eyes.
const ACCEPTABLE = new Set([EXCEPTION_TYPES.AMOUNT_DISCREPANCY, EXCEPTION_TYPES.DUPLICATE]);

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function contentDigest(fact) {
  return digest({ channel: fact.channel, kind: fact.kind, gross: fact.grossMinor, currency: fact.currency, ptx: fact.providerTransactionId });
}

function createAccountingEngine({ store, resolver, policy, now = () => new Date(), log = () => {} }) {
  if (!store || !resolver || !policy) throw new Error('store, resolver and policy are required');

  async function raise(type, key, fields = {}) {
    return store.raiseException({ exception_key: `${type}:${key}`, type, severity: EXCEPTION_SEVERITY[type], ...fields });
  }
  async function autoResolve(exceptionKey, note) {
    return store.resolveException(exceptionKey, { status: 'auto_resolved', resolved_by: 'system:accounting', resolution_note: note });
  }
  async function exceptionStatus(exceptionKey) {
    const [type] = exceptionKey.split(':');
    const list = await store.listExceptions({ type });
    const ex = list.find((e) => e.exception_key === exceptionKey);
    return ex ? ex.status : null;
  }

  // ── Original-transaction matching for refunds / disputes ────────────────
  async function findOriginal(tx) {
    if (tx.kind === KINDS.CHARGEBACK_REVERSAL) {
      const list = await store.findTransactionsByRef('dispute', tx.provider_refs.dispute);
      return list.find((t) => t.kind === KINDS.CHARGEBACK) || null;
    }
    if (STORE_CHANNELS.has(tx.channel)) {
      return store.findTransactionByKey(`${tx.channel}:sale:${tx.provider_refs.transaction}`);
    }
    for (const ref of ['invoice', 'payment_intent', 'charge']) {
      const value = tx.original_refs && tx.original_refs[ref];
      if (!value) continue;
      const list = await store.findTransactionsByRef(ref, value);
      const sale = list.find((t) => t.kind === KINDS.SALE && t.channel === tx.channel);
      if (sale) return sale;
    }
    return null;
  }

  // ── Status evaluation: which blockers apply right now ───────────────────
  // Returns { status, blockers: [{ reason, type, key, detail }] }. Pure apart
  // from reading the original and human resolutions.
  async function evaluate(tx) {
    if (tx.environment !== 'production') return { status: TX_STATUS.EXCLUDED_SANDBOX, blockers: [] };
    const blockers = [];
    const add = (reason, type, key, detail = {}) => blockers.push({ reason, type, key: `${type}:${key}`, detail });

    if (!SUPPORTED_CURRENCIES.includes(tx.currency)) {
      add('unsupported_currency', EXCEPTION_TYPES.UNSUPPORTED_CURRENCY, tx.economic_key, { currency: tx.currency });
    }
    let original = null;
    if (tx.kind !== KINDS.SALE) {
      original = tx.original_transaction_id ? await store.getTransaction(tx.original_transaction_id) : await findOriginal(tx);
      if (!original) {
        add('original_not_found', EXCEPTION_TYPES.REFUND_MISMATCH, tx.economic_key, { reason: 'original_not_found', kind: tx.kind, refs: tx.original_refs || null });
      } else if (REVERSAL_KINDS.has(tx.kind)) {
        const siblings = await store.listTransactions({ original_transaction_id: original.id });
        const reversed = siblings.filter((s) => REVERSAL_KINDS.has(s.kind) && s.id !== tx.id).reduce((s, t) => s + (t.gross_minor || 0), 0) + (tx.gross_minor || 0);
        const reinstated = siblings.filter((s) => s.kind === KINDS.CHARGEBACK_REVERSAL).reduce((s, t) => s + (t.gross_minor || 0), 0);
        if (reversed - reinstated > original.gross_minor) {
          add('over_refund', EXCEPTION_TYPES.REFUND_MISMATCH, tx.economic_key, { reason: 'refunds_exceed_original', original: original.economic_key, original_gross_minor: original.gross_minor, reversed_minor: reversed - reinstated });
        }
      }
    }
    const householdId = tx.household_id || (original && original.household_id) || null;
    const accountNumber = tx.account_number || (original && original.account_number) || null;
    if (!householdId) {
      add('unmatched_payment', EXCEPTION_TYPES.UNMATCHED_PAYMENT, tx.economic_key, { refs: tx.provider_refs });
    } else if (!accountNumber && !STORE_CHANNELS.has(tx.channel)) {
      add('missing_account', EXCEPTION_TYPES.MISSING_ACCOUNT, householdId, { household_id: householdId });
    }

    if (tx.channel === CHANNELS.STRIPE && tx.kind === KINDS.SALE) {
      const vat = checkStripeVat({ grossMinor: tx.gross_minor, taxMinor: tx.tax_minor, customerCountry: tx.customer_country });
      if (vat.issues.length) {
        const key = `vat:${tx.economic_key}`;
        const status = await exceptionStatus(`${EXCEPTION_TYPES.AMOUNT_DISCREPANCY}:${key}`);
        if (status !== 'resolved' && status !== 'dismissed') add('vat_check', EXCEPTION_TYPES.AMOUNT_DISCREPANCY, key, { issues: vat.issues });
      }
    }
    const dupKey = `${EXCEPTION_TYPES.DUPLICATE}:${tx.economic_key}`;
    const dupStatus = await exceptionStatus(dupKey);
    if (dupStatus === 'open') blockers.push({ reason: 'duplicate_unreviewed', type: EXCEPTION_TYPES.DUPLICATE, key: dupKey, detail: null, existing: true });

    if (STORE_CHANNELS.has(tx.channel)) {
      // Store money posts only through reconciled settlement summaries; the
      // blockers above are still reported so the sub-ledger stays honest.
      return { status: TX_STATUS.SUBLEDGER_ONLY, blockers, householdId, accountNumber, original };
    }
    for (const decision of postingBlockers(tx, policy)) {
      blockers.push({ reason: `accountant_decision:${decision}`, type: EXCEPTION_TYPES.TAX_TREATMENT_UNCONFIRMED, key: `${EXCEPTION_TYPES.TAX_TREATMENT_UNCONFIRMED}:${decision}`, detail: { decision }, aggregate: true });
    }
    if (!blockers.length) {
      const plan = planForTransaction({ ...tx, household_id: householdId, account_number: accountNumber }, policy.accountCodes, { postingKey: `xero:${tx.economic_key}` });
      if (plan.error) {
        blockers.push({ reason: `xero_mapping:${plan.error}`, type: EXCEPTION_TYPES.TAX_TREATMENT_UNCONFIRMED, key: `${EXCEPTION_TYPES.TAX_TREATMENT_UNCONFIRMED}:account_codes`, detail: { error: plan.error, missing: plan.missing || [] }, aggregate: true });
      } else {
        return { status: TX_STATUS.READY, blockers, householdId, accountNumber, original, plan };
      }
    }
    return { status: TX_STATUS.BLOCKED, blockers, householdId, accountNumber, original };
  }

  // Apply an evaluation: persist status, raise current exceptions, auto-resolve
  // exceptions for this transaction whose condition has cleared, enqueue posting.
  async function apply(tx, previousKeys = null) {
    if ([TX_STATUS.POSTED, TX_STATUS.POSTING, TX_STATUS.FAILED].includes(tx.status)) return tx;
    // Re-resolve a household / account number that was missing (account
    // numbers backfilled by 062, a Stripe customer linked later).
    if (!tx.household_id || (!tx.account_number && tx.channel === CHANNELS.STRIPE)) {
      const refs = tx.provider_refs || {};
      const r = await resolver.resolve({ householdHint: tx.household_id || refs.household_hint || null, stripeCustomerId: refs.customer || null, authUserId: refs.revenuecat_app_user_id || null });
      if (r && r.householdId && (!tx.household_id || r.householdId === tx.household_id)) {
        tx = { ...tx, household_id: r.householdId, account_number: tx.account_number || r.accountNumber || null };
      }
    }
    const ev = await evaluate(tx);
    const patch = { status: ev.status, blocked_reasons: ev.blockers.map((b) => b.reason) };
    const stored = await store.getTransaction(tx.id);
    if (ev.householdId && !stored.household_id) patch.household_id = ev.householdId;
    if (ev.accountNumber && !stored.account_number) patch.account_number = ev.accountNumber;
    if (ev.original && !tx.original_transaction_id) patch.original_transaction_id = ev.original.id;
    // Refund/chargeback VAT: pro rata from the original's provider-reported VAT
    // (Stripe does not split refunds). Never invented when the original has none.
    if (ev.original && tx.kind !== KINDS.SALE && tx.tax_minor === null && Number.isSafeInteger(ev.original.tax_minor) && ev.original.gross_minor > 0) {
      patch.tax_minor = Math.round((ev.original.tax_minor * tx.gross_minor) / ev.original.gross_minor);
      patch.net_minor = tx.gross_minor - patch.tax_minor;
      patch.tax_source = 'pro_rata_from_original';
    }
    const updated = await store.updateTransaction(tx.id, patch);

    const current = new Set();
    for (const b of ev.blockers) {
      current.add(b.key);
      if (b.existing) continue;
      if (b.aggregate) {
        await store.raiseException({ exception_key: b.key, type: b.type, severity: EXCEPTION_SEVERITY[b.type], detail: b.detail });
      } else {
        await store.raiseException({
          exception_key: b.key, type: b.type, severity: EXCEPTION_SEVERITY[b.type],
          transaction_id: tx.id, household_id: updated.household_id, account_number: updated.account_number, detail: b.detail,
        });
      }
    }
    const linked = previousKeys || (await store.listExceptions({ transaction_id: tx.id, status: 'open' })).map((e) => e.exception_key);
    for (const key of linked) {
      const [type] = key.split(':');
      if (!current.has(key) && !ACCEPTABLE.has(type)) await autoResolve(key, 'condition cleared on re-evaluation');
    }
    if (updated.household_id) {
      const missingKey = `${EXCEPTION_TYPES.MISSING_ACCOUNT}:${updated.household_id}`;
      if (updated.account_number && !current.has(missingKey)) await autoResolve(missingKey, 'account number now present');
    }
    // The Xero document plan is rebuilt at posting time from the CURRENT
    // transaction and policy (services/accounting/postingQueue.js); the queue
    // also re-checks status, so a transaction blocked after enqueueing (e.g. a
    // conflicting duplicate) is held, never posted.
    if (ev.status === TX_STATUS.READY) {
      const q = await store.enqueuePosting({ posting_key: `xero:${updated.economic_key}`, subject_type: 'transaction', transaction_id: updated.id, next_attempt_at: now().toISOString() });
      if (!q.inserted && q.posting.status === 'held') await store.updatePosting(q.posting.id, { status: 'pending', next_attempt_at: now().toISOString() });
    }
    return updated;
  }

  // ── Ingest ───────────────────────────────────────────────────────────────
  async function ingest(normalized) {
    const claim = await store.claimSourceEvent({
      source: normalized.source, source_event_id: normalized.sourceEventId, event_type: normalized.eventType,
      environment: normalized.environment, payload_digest: normalized.payloadDigest || null,
    });
    // A completed event is a replay. An uncompleted one (a worker died after
    // claiming) is processed again — safe because layer 2 is idempotent.
    if (!claim.inserted && claim.event.outcome) {
      return { outcome: EVENT_OUTCOMES.DUPLICATE_EVENT, sourceEventId: claim.event.id, transactions: [] };
    }
    const eventId = claim.event.id;
    const finish = async (outcome, detail = null, txIds = []) => {
      await store.completeSourceEvent(eventId, { outcome, outcome_detail: detail, transaction_ids: txIds });
      return { outcome, detail, sourceEventId: eventId, transactions: txIds };
    };

    if (normalized.supersededBy) return finish(EVENT_OUTCOMES.SUPERSEDED_BY_PRIMARY, normalized.supersededBy);
    if (normalized.complimentary) return finish(EVENT_OUTCOMES.COMPLIMENTARY, 'store_promotional_grant');
    if (normalized.environment !== 'production') return finish(EVENT_OUTCOMES.SANDBOX, normalized.eventType);
    if (normalized.nonEconomicReason === 'test_event') return finish(EVENT_OUTCOMES.IGNORED, 'test_event');
    if (!normalized.facts.length) return finish(EVENT_OUTCOMES.NON_ECONOMIC, normalized.nonEconomicReason);

    const txIds = [];
    let duplicateEconomic = 0;
    for (const fact of normalized.facts) {
      const resolved = (await resolver.resolve(fact)) || {};
      const gross = fact.grossMinor;
      const row = {
        economic_key: fact.economicKey,
        channel: fact.channel,
        kind: fact.kind,
        environment: normalized.environment,
        source: normalized.source,
        household_id: resolved.householdId || null,
        account_number: resolved.accountNumber || null,
        provider_transaction_id: fact.providerTransactionId,
        provider_refs: { ...(fact.providerRefs || {}), ...(fact.householdHint ? { household_hint: fact.householdHint } : {}) },
        original_refs: fact.originalRefs || null,
        original_transaction_id: null,
        product: fact.product || null,
        product_code: fact.productCode || null,
        currency: fact.currency,
        gross_minor: gross,
        tax_minor: Number.isSafeInteger(fact.taxMinor) ? fact.taxMinor : null,
        net_minor: Number.isSafeInteger(fact.taxMinor) && Number.isSafeInteger(gross) ? gross - fact.taxMinor : null,
        fee_minor: Number.isSafeInteger(fact.feeMinor) ? fact.feeMinor : null,
        proceeds_minor: Number.isSafeInteger(fact.proceedsMinor) ? fact.proceedsMinor : null,
        amount_quality: fact.amountQuality || 'provider_actual',
        tax_source: Number.isSafeInteger(fact.taxMinor) ? (fact.amountQuality === 'estimated' ? 'provider_estimate' : 'provider') : 'missing',
        customer_country: fact.customerCountry || null,
        occurred_at: fact.occurredAt || normalized.occurredAt || now().toISOString(),
        service_period_start: fact.servicePeriodStart || null,
        service_period_end: fact.servicePeriodEnd || null,
        status: TX_STATUS.BLOCKED,
        blocked_reasons: ['pending_evaluation'],
        content_digest: contentDigest(fact),
        first_source_event_id: eventId,
        settlement_id: null,
        xero_status: null,
        xero_reference: null,
        xero_document_ids: {},
      };
      if (!Number.isSafeInteger(gross) || gross <= 0) {
        await raise(EXCEPTION_TYPES.AMOUNT_DISCREPANCY, `missing_amount:${fact.economicKey}`, { detail: { reason: 'provider reported no positive amount', event: normalized.sourceEventId } });
      }
      const ins = await store.insertTransaction(row);
      if (!ins.inserted) {
        duplicateEconomic += 1;
        if (ins.transaction.content_digest !== row.content_digest) {
          await raise(EXCEPTION_TYPES.DUPLICATE, fact.economicKey, {
            transaction_id: ins.transaction.id, household_id: ins.transaction.household_id, account_number: ins.transaction.account_number,
            detail: { reason: 'same economic transaction reported with different content', kept_gross_minor: ins.transaction.gross_minor, other_gross_minor: gross, other_source_event: normalized.sourceEventId },
          });
          await apply(ins.transaction);
        }
        txIds.push(ins.transaction.id);
        continue;
      }
      const applied = await apply(ins.transaction, []);
      txIds.push(applied.id);
      if (applied.kind === KINDS.SALE || applied.kind === KINDS.CHARGEBACK) await relinkOrphans(applied);
    }
    if (duplicateEconomic === normalized.facts.length) return finish(EVENT_OUTCOMES.DUPLICATE_ECONOMIC, null, txIds);
    return finish(EVENT_OUTCOMES.RECORDED, null, txIds);
  }

  // Out-of-order delivery: a refund/dispute that arrived before its sale is
  // re-evaluated as soon as the sale (or chargeback) is recorded.
  async function relinkOrphans(original) {
    const candidates = new Map();
    for (const ref of ['invoice', 'payment_intent', 'charge', 'transaction', 'dispute']) {
      const value = original.provider_refs && original.provider_refs[ref];
      if (!value) continue;
      for (const t of await store.findTransactionsByRef(ref, value)) {
        if (t.id !== original.id && t.kind !== KINDS.SALE && !t.original_transaction_id) candidates.set(t.id, t);
      }
    }
    for (const t of candidates.values()) await apply(t);
  }

  // Re-evaluate everything not yet posted (account numbers backfilled,
  // decisions confirmed, originals arrived) and tidy aggregate exceptions.
  async function reevaluate() {
    // Settled, clean store rows are final — skip them so the sweep stays bounded.
    const open = (await store.listTransactions({ status: [TX_STATUS.BLOCKED, TX_STATUS.READY, TX_STATUS.SUBLEDGER_ONLY] }))
      .filter((t) => !(t.status === TX_STATUS.SUBLEDGER_ONLY && t.settlement_id && !(t.blocked_reasons || []).length));
    for (const tx of open) await apply(tx);
    const stillNeeded = new Set();
    for (const tx of await store.listTransactions({ status: TX_STATUS.BLOCKED })) {
      for (const r of tx.blocked_reasons || []) {
        if (r.startsWith('accountant_decision:')) stillNeeded.add(`${EXCEPTION_TYPES.TAX_TREATMENT_UNCONFIRMED}:${r.split(':')[1]}`);
        if (r.startsWith('xero_mapping:')) stillNeeded.add(`${EXCEPTION_TYPES.TAX_TREATMENT_UNCONFIRMED}:account_codes`);
      }
    }
    for (const ex of await store.listExceptions({ type: EXCEPTION_TYPES.TAX_TREATMENT_UNCONFIRMED, status: 'open' })) {
      if (!stillNeeded.has(ex.exception_key)) await autoResolve(ex.exception_key, 'no transaction is blocked by this any more');
    }
    return { reevaluated: open.length };
  }

  return {
    ingest,
    ingestStripeEvent: (event) => ingest({ ...normalizeStripeEvent(event), payloadDigest: digest(event) }),
    ingestRevenueCatEvent: (body) => ingest({ ...normalizeRevenueCatEvent(body), payloadDigest: digest(body) }),
    reevaluate,
    evaluate,
    apply,
  };
}

module.exports = { createAccountingEngine, contentDigest };
