// In-memory Xero stand-in for tests and local dry runs. It is NOT Xero:
// it reproduces only the behaviour the posting queue relies on —
//   - create returns a new document id;
//   - Idempotency-Key replay (24h) returns the SAME document (Xero behaviour),
//     unless honourIdempotencyKey=false, which proves find-by-Reference alone
//     still prevents duplicates;
//   - find by Reference;
//   - injected failures, including "committed but the response was lost".
'use strict';

const { randomUUID } = require('node:crypto');
const { XeroError } = require('./errors');

const ID_FIELD = { Invoices: 'InvoiceID', CreditNotes: 'CreditNoteID', Payments: 'PaymentID', BankTransactions: 'BankTransactionID' };

function createMockXero({ honourIdempotencyKey = true } = {}) {
  const documents = []; // { endpoint, id, body, idempotencyKey }
  const byIdempotencyKey = new Map();
  const failures = [];  // queue of failure kinds consumed per create call
  const calls = [];
  let available = true;

  function maybeFail(stage) {
    if (!available) throw new XeroError('unavailable', 'mock Xero unavailable');
    const next = failures[0];
    if (!next || next.stage !== stage) return null;
    failures.shift();
    return next.kind;
  }

  return {
    documents,
    calls,
    setAvailable(v) { available = v; },
    failNext(kind, times = 1) { for (let i = 0; i < times; i += 1) failures.push({ kind, stage: 'create' }); },
    failNextLookup(kind) { failures.unshift({ kind, stage: 'lookup' }); },

    async createDocument({ endpoint, body, idempotencyKey }) {
      calls.push({ op: 'create', endpoint, reference: body.Reference, idempotencyKey });
      const kind = maybeFail('create');
      if (kind === 'network') throw new XeroError('unknown_outcome', 'socket hang up');
      if (kind === 'rate_limit') throw new XeroError('rate_limited', 'HTTP 429', { status: 429, retryAfterSeconds: 30 });
      if (kind === 'server_error') throw new XeroError('unknown_outcome', 'HTTP 503', { status: 503 });
      if (kind === 'validation') throw new XeroError('rejected', 'HTTP 400 A validation exception occurred', { status: 400 });
      if (honourIdempotencyKey && idempotencyKey && byIdempotencyKey.has(idempotencyKey)) {
        return { id: byIdempotencyKey.get(idempotencyKey).id, replayed: true };
      }
      const doc = { endpoint, id: randomUUID(), body: JSON.parse(JSON.stringify(body)), idempotencyKey };
      documents.push(doc);
      if (idempotencyKey) byIdempotencyKey.set(idempotencyKey, doc);
      if (kind === 'timeout_after_commit') throw new XeroError('unknown_outcome', 'timeout after Xero committed the document');
      return { id: doc.id, idField: ID_FIELD[endpoint] };
    },

    async findByReference({ endpoint, reference }) {
      calls.push({ op: 'find', endpoint, reference });
      const kind = maybeFail('lookup');
      if (kind === 'network') throw new XeroError('unknown_outcome', 'lookup failed');
      const doc = documents.find((d) => d.endpoint === endpoint && d.body.Reference === reference);
      return doc ? { id: doc.id } : null;
    },

    count(endpoint) { return documents.filter((d) => !endpoint || d.endpoint === endpoint).length; },
  };
}

module.exports = { createMockXero, ID_FIELD };
