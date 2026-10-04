// New paid sign-up control for the controlled launch (launch sprint
// 2026-10-05). Gates ONLY the start of a NEW Stripe checkout (web and the
// Android app). Never touches existing customers, renewals, entitlements,
// call delivery or provisioning.
//
//   NEW_SUBSCRIPTIONS_PAUSED=true        stop-acquisition switch: no new paid
//                                        sign-ups (incident procedure, step 1)
//   NEW_SUBSCRIPTIONS_ALLOWLIST=a@x,b@y  invite-only cohort: only these account
//                                        emails may start a checkout
//   both unset                           open, exactly as before
//
// iOS purchases go through Apple and never reach these routes: if iOS is
// offered, the cohort cannot be invite-gated there (documented in the
// controlled-launch runbook).
'use strict';

function parseAllowlist(raw) {
  return new Set(String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * @param {{ household: { email?: string } , env?: object }} input
 * @returns {{ allowed: boolean, reason: null | 'new_memberships_paused' | 'not_invited' }}
 */
function decideNewSubscription({ household, env = process.env }) {
  if (env.NEW_SUBSCRIPTIONS_PAUSED === 'true') return { allowed: false, reason: 'new_memberships_paused' };
  const allow = parseAllowlist(env.NEW_SUBSCRIPTIONS_ALLOWLIST);
  if (allow.size > 0) {
    const email = String((household && household.email) || '').trim().toLowerCase();
    if (!email || !allow.has(email)) return { allowed: false, reason: 'not_invited' };
  }
  return { allowed: true, reason: null };
}

module.exports = { decideNewSubscription, parseAllowlist };
