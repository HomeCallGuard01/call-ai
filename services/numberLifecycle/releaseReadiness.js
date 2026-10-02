// Safe number-release review — PROTOTYPE (2026-09-29). NOT WIRED.
//
// Answers, for one provider number, "could a human safely confirm this
// number's release, and what must they see and confirm first?" It never
// releases anything and nothing calls a release path with its output:
// `wired` is always false. The real release stays where it is today —
// migration 047's SQL guard plus the quarantine confirm-deactivation flow,
// behind the environment guard (fix/nonprod-telephony-mutation-guard).
//
// Principle: a destructive action must be impossible from an ambiguous
// state. Every uncertainty is a BLOCKER, not a warning:
//   - the household blocks release (current/upcoming entitlement, 047), or
//     its lifecycle state is ambiguous;
//   - a quarantined number whose household is entitled again;
//   - the holder is unclassified (who is this?);
//   - the number is not in the release lifecycle (no release scheduled
//     and not quarantined), or its grace period has not ended;
//   - an inbound call in the last 14 days, or no way to know;
//   - staging/dev or orphan numbers (a separate, owner-approved cleanup —
//     never the customer lifecycle);
//   - the dashboard data is older than 10 minutes (reload first).
// Only with zero blockers are the confirmations offered: type the last
// four digits, confirm carrier forwarding is removed (quarantine), confirm
// inbound calls were checked, and give a reason.
'use strict';

const { GRACE } = require('./state');

const RECENT_CALL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DATA_AGE_MS = 10 * 60 * 1000;

function ms(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {object} row  number-inventory row (numberInventory.js), incl. lifecycle/quarantine
 * @param {{ now: Date, generatedAt?: string }} ctx
 */
function evaluateReleaseReadiness(row, { now, generatedAt } = {}) {
  const nowMs = now.getTime();
  const blockers = [];
  const add = (code, text) => blockers.push({ code, text });
  const owner = row.owner || null;
  const lc = row.lifecycle || null;

  const genMs = ms(generatedAt);
  if (genMs === null || nowMs - genMs > MAX_DATA_AGE_MS) add('STALE_VIEW', 'This view is more than 10 minutes old (or has no timestamp). Reload before reviewing a release.');

  if (row.state === 'missing_at_provider') add('NOT_AT_PROVIDER', 'The provider does not list this number: there is nothing to release.');
  if (row.category === 'staging') add('STAGING_NUMBER', 'Staging/development number: its household is in the staging database. Release through an owner-approved staging cleanup, never the customer lifecycle.');
  if (row.category === 'orphan') add('ORPHAN_NUMBER', 'No household in HCG. Investigate its inbound calls and history first; orphan numbers are never released from a review screen.');
  if (row.category === 'other') add('RECORD_MISMATCH', 'HCG\'s record and the provider disagree about this number. Resolve that first.');

  if (owner) {
    if (!owner.accountClass || owner.accountClass === 'unclassified') add('UNCLASSIFIED_HOLDER', 'The holder is not classified. Classify the account (Customers) before any decision about its number.');
    if (lc && lc.membership === 'ambiguous') add('AMBIGUOUS_STATE', 'The household\'s entitlement state cannot be determined. Never release from an ambiguous state.');
    if (lc && lc.blocksRelease) add('ENTITLED', 'The household has a current or upcoming membership (migration 047 would refuse this release).');
  }
  if (row.flags && row.flags.some((f) => f.code === 'quarantined_from_entitled')) add('QUARANTINED_WHILE_ENTITLED', 'Quarantined, but the household is entitled again. Do not confirm deactivation.');

  const inQuarantine = !!row.quarantine;
  const pendingMs = ms(row.pendingReleaseAt);
  if (owner && !inQuarantine) {
    if (pendingMs === null) add('NOT_IN_LIFECYCLE', 'No release is scheduled. The lifecycle must schedule it (after the membership ends) — not this screen.');
    else if (pendingMs > nowMs) add('GRACE_PERIOD', `Grace period runs until ${new Date(pendingMs).toISOString().slice(0, 10)}.`);
  }

  const call = row.lastInboundCall || {};
  const callMs = ms(call.at);
  if (callMs !== null && nowMs - callMs < RECENT_CALL_MS) add('RECENT_INBOUND_CALL', `An inbound call ${Math.round((nowMs - callMs) / 86400000)} day(s) ago: forwarding may still point here.`);
  if (callMs === null && !/no call recorded/.test(call.source || '')) add('CALLS_UNKNOWN', `Recent inbound calls cannot be ruled out (${call.source || 'no call data'}). Check the provider call log.`);

  const confirmations = blockers.length ? [] : [
    { id: 'typed_last4', text: `Type the last four digits of the number (${String(row.number || '').slice(-4)}).`, expect: String(row.number || '').slice(-4) },
    ...(inQuarantine && !row.quarantine.confirmed ? [{ id: 'forwarding_removed', text: 'The customer has confirmed carrier forwarding to this number is removed.' }] : []),
    { id: 'calls_checked', text: 'I checked the provider call log: no inbound calls in the last 14 days.' },
    { id: 'reason', text: 'Reason for release (recorded).' },
  ];

  return {
    wired: false,
    reviewable: blockers.length === 0,
    blockers,
    confirmations,
    evidence: {
      number: row.number || null,
      sid: row.sid || null,
      category: row.categoryLabel || row.category || null,
      environment: row.environment || null,
      household: owner ? (owner.email || owner.householdId) : null,
      classification: owner ? owner.accountClass || 'unclassified' : null,
      membership: owner ? owner.membership || null : null,
      access: owner ? owner.access || null : null,
      membershipEndedAt: owner ? owner.membershipEndedAt || null : null,
      pendingReleaseAt: row.pendingReleaseAt || null,
      graceEndsAt: row.pendingReleaseAt || null,
      quarantine: row.quarantine || null,
      lastInboundCall: call.at || null,
      lastInboundCallSource: call.source || null,
      lifecycleState: row.stateLabel || null,
      releaseJobOverdueAfterHours: GRACE.releaseOverdueMs / 3600000,
    },
  };
}

// Pure — what the (not wired) final button would require, client side.
function validateReleaseConfirmations(review, answers) {
  if (!review || !review.reviewable) return { ok: false, message: 'Blocked — resolve every blocker first.' };
  for (const c of review.confirmations) {
    if (c.id === 'typed_last4' && String(answers.typed_last4 || '').trim() !== c.expect) return { ok: false, message: 'The typed digits do not match this number.' };
    if (c.id === 'reason' && String(answers.reason || '').trim().length < 10) return { ok: false, message: 'Give a reason (at least 10 characters).' };
    if ((c.id === 'forwarding_removed' || c.id === 'calls_checked') && answers[c.id] !== true) return { ok: false, message: 'Every confirmation must be ticked.' };
  }
  return { ok: true, message: 'All checks complete. Release is NOT wired in this prototype — nothing will happen.' };
}

module.exports = { evaluateReleaseReadiness, validateReleaseConfirmations, RECENT_CALL_MS, MAX_DATA_AGE_MS };
