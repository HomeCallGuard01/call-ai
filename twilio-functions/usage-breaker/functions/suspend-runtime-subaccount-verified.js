// HCG usage breaker: SELF-VERIFYING variant (Agent 1, 2026-10-11).
// Deployed in the PARENT account's Functions service next to the Protected
// variant. NOT deployed anywhere yet.
//
// Why it exists: a "protected" Function only accepts requests signed with the
// PARENT's auth token. A Usage Trigger created IN the runtime subaccount
// almost certainly signs its callback with the SUBACCOUNT's token, so the
// Protected variant would reject it (401) and the breaker would never fire.
// Twilio's Usage Trigger docs do not say whether a parent-level trigger counts
// subaccount usage (the Usage Records API includes subaccounts by default,
// IncludeSubaccounts=true; triggers are undocumented) — NEEDS-TWILIO-CONFIRMATION.
//
// This file is PUBLIC (no ".protected" suffix) and so does its own check:
//   - X-Twilio-Signature must verify, in constant time, against one of an
//     ALLOWLIST of auth tokens: the parent's (context.AUTH_TOKEN) and the
//     runtime subaccount's (HCG_RUNTIME_SUBACCOUNT_AUTH_TOKEN);
//   - the AccountSid in the body must be the account whose token verified
//     (a subaccount-signed request cannot claim to be the parent);
//   - then exactly the same decision as the Protected variant (allowlisted
//     trigger SIDs, configured target, never the parent).
// Unsigned or wrongly-signed requests get 403 and touch nothing. A request
// forged with the subaccount token (i.e. by someone who already controls the
// subaccount) can only SUSPEND that subaccount and end its calls: fail-safe.
'use strict';

const crypto = require('crypto');

function loadCore() {
  // In Twilio Functions, sibling functions are reached via Runtime.getFunctions().
  if (typeof Runtime !== 'undefined' && Runtime && typeof Runtime.getFunctions === 'function') {
    const f = Runtime.getFunctions()['suspend-runtime-subaccount'];
    if (f && f.path) return require(f.path);
  }
  return require('./suspend-runtime-subaccount.protected.js');
}

// Twilio's documented algorithm: HMAC-SHA1(token, url + Σ sorted(key + value)), base64.
function expectedSignature(token, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + (params[k] === undefined || params[k] === null ? '' : String(params[k])), url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf-8');
  const y = Buffer.from(String(b || ''), 'utf-8');
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

// Returns { ok, accountSid } — which allowlisted account signed the request.
function verifySignature(context, event) {
  const headers = (event && event.request && event.request.headers) || {};
  const signature = headers['x-twilio-signature'] || headers['X-Twilio-Signature'];
  if (!signature) return { ok: false, reason: 'missing_signature' };
  const url = `https://${context.DOMAIN_NAME}${context.PATH}`;
  const params = {};
  for (const [k, v] of Object.entries(event || {})) if (k !== 'request') params[k] = v;
  const candidates = [
    { accountSid: context.ACCOUNT_SID, token: context.AUTH_TOKEN },
    { accountSid: context.HCG_RUNTIME_SUBACCOUNT_SID, token: context.HCG_RUNTIME_SUBACCOUNT_AUTH_TOKEN },
  ].filter((c) => typeof c.token === 'string' && c.token.length >= 16 && typeof c.accountSid === 'string');
  let match = null;
  // Check every candidate (no early exit) so timing does not reveal which token matched.
  for (const c of candidates) if (safeEqual(expectedSignature(c.token, url, params), signature) && !match) match = c;
  if (!match) return { ok: false, reason: 'bad_signature' };
  if (String(params.AccountSid || '') !== match.accountSid) return { ok: false, reason: 'account_mismatch' };
  return { ok: true, accountSid: match.accountSid };
}

exports.expectedSignature = expectedSignature;
exports.verifySignature = verifySignature;

exports.handler = async function handler(context, event, callback) {
  const v = verifySignature(context, event);
  if (!v.ok) {
    console.log(`usage-breaker(verified): refused (${v.reason})`);
    const response = new Twilio.Response();
    response.setStatusCode(403);
    response.appendHeader('Content-Type', 'application/json');
    response.setBody({ suspended: false, reason: v.reason });
    return callback(null, response);
  }
  const params = {};
  for (const [k, val] of Object.entries(event || {})) if (k !== 'request') params[k] = val;
  return loadCore().handler(context, params, callback);
};
