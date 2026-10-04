// Xero failure classes — what the posting queue does next depends only on this.
//   unavailable      Xero not configured / disabled / auth failed. Nothing was sent.
//                    Posting stays queued; no attempt is consumed.
//   rate_limited     HTTP 429. Nothing committed. Retry after Retry-After.
//   unknown_outcome  Network error, timeout or 5xx: Xero MAY have created the
//                    document. The retry first looks it up by Reference.
//   rejected         4xx validation error. Retrying the same payload cannot
//                    succeed → failed + failed_xero_posting exception.
'use strict';

class XeroError extends Error {
  constructor(errorClass, message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'XeroError';
    this.errorClass = errorClass;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const ERROR_CLASSES = Object.freeze(['unavailable', 'rate_limited', 'unknown_outcome', 'rejected']);

function classifyHttpStatus(status) {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'unavailable';
  if (status >= 500) return 'unknown_outcome';
  if (status >= 400) return 'rejected';
  return null;
}

module.exports = { XeroError, ERROR_CLASSES, classifyHttpStatus };
