'use strict';

// Twilio accounts whose webhooks HCG accepts (WS6 Magrathea → Twilio BYOC,
// 2026-10-11).
//
// Default and RECOMMENDED: ONE account. Put the BYOC trunk in the same
// (runtime sub)account as the hosted numbers (TWILIO_ACCOUNT_SID): webhooks
// are signed with TWILIO_AUTH_TOKEN, the REST client can fetch/end BYOC calls
// (Fortress lease sweeper, countLiveCalls), and the Twilio-hosted usage
// breaker suspends BYOC traffic too. Nothing below is needed then.
//
// Optional: ONE additional account (e.g. an isolated BYOC staging subaccount)
// via TWILIO_BYOC_ACCOUNT_SID + TWILIO_BYOC_AUTH_TOKEN. Its token is used ONLY
// for a request whose (signed) AccountSid equals TWILIO_BYOC_ACCOUNT_SID, so
// it can never validate a request claiming the primary account. An
// incomplete or invalid pair is IGNORED (fail closed: such requests are then
// refused 403) and reported by services/config/launchConfig.js.
//
// LIMITATION of the two-account mode (documented in the BYOC report): the
// backend REST client is bound to the primary account, so call-control on a
// BYOC-subaccount call (lease-sweeper termination, live-call counts) does not
// reach it; the per-call <Dial timeLimit> and Magrathea's channel limit stay
// the bounds. Use it for attended staging tests only.

const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/i;

/** @returns {{ accounts: Array<{accountSid: string, authToken: string}>, problem: string|null }} */
function resolveAdditionalTwilioAccounts(env = process.env) {
  const sid = typeof env.TWILIO_BYOC_ACCOUNT_SID === 'string' ? env.TWILIO_BYOC_ACCOUNT_SID.trim() : '';
  const token = typeof env.TWILIO_BYOC_AUTH_TOKEN === 'string' ? env.TWILIO_BYOC_AUTH_TOKEN.trim() : '';
  if (!sid && !token) return { accounts: [], problem: null };
  if (!sid || !token) return { accounts: [], problem: 'incomplete_pair' };
  if (!ACCOUNT_SID_RE.test(sid)) return { accounts: [], problem: 'invalid_account_sid' };
  const primarySid = typeof env.TWILIO_ACCOUNT_SID === 'string' ? env.TWILIO_ACCOUNT_SID.trim() : '';
  if (primarySid && primarySid.toLowerCase() === sid.toLowerCase()) return { accounts: [], problem: 'same_as_primary_account' };
  const primaryToken = typeof env.TWILIO_AUTH_TOKEN === 'string' ? env.TWILIO_AUTH_TOKEN.trim() : '';
  if (primaryToken && primaryToken === token) return { accounts: [], problem: 'same_token_as_primary' };
  return { accounts: [{ accountSid: sid, authToken: token }], problem: null };
}

/** AccountSids a webhook may carry: the primary one plus any valid additional account. */
function acceptedAccountSids(primarySid, env = process.env) {
  const out = [];
  if (typeof primarySid === 'string' && primarySid) out.push(primarySid);
  for (const a of resolveAdditionalTwilioAccounts(env).accounts) out.push(a.accountSid);
  return out;
}

/**
 * Signing tokens to try for one request: the primary token always (back-
 * compatible: requests without AccountSid), plus the additional account's
 * token ONLY when the request's AccountSid is exactly that account.
 */
function signingTokensFor({ primaryToken, accountSid, additionalAccounts = [] }) {
  const tokens = [];
  if (primaryToken) tokens.push(primaryToken);
  if (typeof accountSid === 'string' && accountSid) {
    for (const a of additionalAccounts) {
      if (a && a.accountSid === accountSid && a.authToken && !tokens.includes(a.authToken)) tokens.push(a.authToken);
    }
  }
  return tokens;
}

module.exports = { ACCOUNT_SID_RE, resolveAdditionalTwilioAccounts, acceptedAccountSids, signingTokensFor };
