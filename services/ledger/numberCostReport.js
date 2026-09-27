// numberCostReport.js — financial reconciliation of the provider numbers HCG
// pays for against HCG's own records. Pure and provider-neutral. It REPORTS
// only: it never releases, reassigns or changes a lifecycle state (that is
// owned by the number-lifecycle work); every anomaly is for a person or the
// lifecycle process to act on.
//
// Output, for the admin dashboard and daily alerts:
//   rows      one per provider-billed number: masked number, provider SID,
//             monthly cost, environment, household, classification,
//             entitlement state, lifecycle state, last inbound activity,
//             cost assessment
//   kpis      total numbers, monthly cost, cost by assessment, orphans,
//             entitled households without a number, potential saving
//   anomalies CRITICAL / WARNING items with the evidence behind them
//
// Cost assessment (what the money is buying):
//   customer_required      genuine household, current or upcoming entitlement
//   retained_internal      internal/test/reviewer household with a current or
//                          upcoming entitlement (intentional overhead)
//   lifecycle_in_progress  pending release or quarantined (cost should stop
//                          once the lifecycle completes)
//   apparently_unnecessary a household number with no current or upcoming
//                          entitlement that is NOT in the release lifecycle,
//                          or a staging/development number on this account
//   orphan_investigate     no household in any environment
// No phone numbers or emails appear in the output (last 3 digits only).
'use strict';

const { money } = require('./contract');

const DAY = 24 * 60 * 60 * 1000;

function norm(n) {
  return String(n || '').replace(/[^\d+]/g, '');
}

function entitlementState(entitlements, householdId, now) {
  const rows = entitlements.filter((e) => e.household_id === householdId);
  const current = rows.some((e) => e.status === 'active' && new Date(e.starts_at) <= now && (!e.ends_at || new Date(e.ends_at) > now));
  if (current) return 'current';
  const upcoming = rows.some((e) => (e.status === 'scheduled' || (e.status === 'active' && new Date(e.starts_at) > now)) && (!e.ends_at || new Date(e.ends_at) > now));
  if (upcoming) return 'upcoming';
  return rows.length ? 'ended' : 'never';
}

const INTERNAL = new Set(['internal_test', 'reviewer', 'admin', 'qa_automation']);

/**
 * @param {object} args
 * @param {Array<{sid, phoneNumber, dateCreated, voiceUrlHost?}>} args.ownedNumbers - provider inventory (authoritative for cost)
 * @param {number} args.monthlyRate - provider price per number per month (native currency)
 * @param {string} args.currency
 * @param {Array<{id, twilio_number, twilio_number_pending_release_at?, environment}>} args.households - all environments on this provider account
 * @param {Array} args.entitlements - rows with household_id, status, starts_at, ends_at
 * @param {Array<{household_id, classification}>} args.classifications
 * @param {Array<{twilio_number, household_id, quarantined_at, released_at, deactivation_confirmed}>} args.quarantine
 * @param {Object<string,string>} args.lastInboundByNumber - normalised number → ISO timestamp of last inbound call
 * @param {Date} args.now
 * @param {number} [args.recentDays]
 * @param {{ warningDays: number, criticalDays: number }} [args.quarantinePolicy]
 */
function buildNumberCostReport({ ownedNumbers, monthlyRate, currency, households, entitlements, classifications, quarantine, lastInboundByNumber, now, recentDays = 30, quarantinePolicy = { warningDays: 45, criticalDays: 90 } }) {
  const classOf = new Map(classifications.map((c) => [c.household_id, c.classification]));
  const holdersByNumber = new Map();
  for (const h of households) {
    const n = norm(h.twilio_number);
    if (n) holdersByNumber.set(n, [...(holdersByNumber.get(n) || []), h]);
  }
  const quarantineByNumber = new Map(quarantine.filter((q) => !q.released_at).map((q) => [norm(q.twilio_number), q]));
  const anomalies = [];

  const rows = ownedNumbers.map((num) => {
    const n = norm(num.phoneNumber);
    const holders = holdersByNumber.get(n) || [];
    const production = holders.filter((h) => h.environment === 'production');
    const staging = holders.filter((h) => h.environment !== 'production');
    const primary = production[0] || staging[0] || null;
    const environment = production.length ? 'production' : staging.length ? 'staging' : 'none';
    const classification = primary ? (classOf.get(primary.id) || (environment === 'staging' ? 'staging' : 'unclassified')) : null;
    const ent = primary && environment === 'production' ? entitlementState(entitlements, primary.id, now) : null;
    const q = quarantineByNumber.get(n);
    const pendingAt = primary && primary.twilio_number_pending_release_at ? primary.twilio_number_pending_release_at : null;
    const lifecycle = q ? 'quarantined' : pendingAt ? 'pending_release' : primary ? 'assigned' : 'unassigned';
    const lastInbound = lastInboundByNumber[n] || null;
    const recentInbound = lastInbound ? now.getTime() - new Date(lastInbound).getTime() <= recentDays * DAY : false;

    let assessment;
    if (lifecycle === 'quarantined' || lifecycle === 'pending_release') assessment = 'lifecycle_in_progress';
    else if (!primary) assessment = 'orphan_investigate';
    else if (environment !== 'production') assessment = 'apparently_unnecessary';
    else if (ent === 'current' || ent === 'upcoming') assessment = INTERNAL.has(classification) ? 'retained_internal' : 'customer_required';
    else assessment = 'apparently_unnecessary';

    const ref = { sid: num.sid, number: `…${n.slice(-3)}` };
    if (!primary && !q) {
      anomalies.push({ level: 'WARNING', type: 'ORPHAN_NUMBER', ...ref, detail: `billed number with no household in any environment${recentInbound ? '; RECENT INBOUND CALLS — forwarding may still point here, do not release without investigation' : ''}` });
    }
    if (production.length > 1) anomalies.push({ level: 'WARNING', type: 'DUPLICATE_ASSIGNMENT', ...ref, detail: `${production.length} production households hold this number` });
    if (environment === 'staging') anomalies.push({ level: 'WARNING', type: 'STAGING_NUMBER_ON_BILLED_ACCOUNT', ...ref, detail: 'staging/development number billed on this provider account' });
    if (environment === 'production' && assessment === 'apparently_unnecessary') {
      anomalies.push({ level: 'WARNING', type: 'NUMBER_WITHOUT_ENTITLEMENT_OUTSIDE_LIFECYCLE', ...ref, detail: `household has ${ent} entitlement and the number is not pending release or quarantined` });
    }
    if (q) {
      const ageDays = Math.floor((now.getTime() - new Date(q.quarantined_at).getTime()) / DAY);
      if (ageDays >= quarantinePolicy.criticalDays) anomalies.push({ level: 'CRITICAL', type: 'QUARANTINE_OVERDUE', ...ref, detail: `quarantined ${ageDays} days` });
      else if (ageDays >= quarantinePolicy.warningDays) anomalies.push({ level: 'WARNING', type: 'QUARANTINE_OVERDUE', ...ref, detail: `quarantined ${ageDays} days` });
      if (q.household_id && entitlementState(entitlements, q.household_id, now) === 'current') {
        anomalies.push({ level: 'CRITICAL', type: 'QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD', ...ref, detail: 'the household this number was quarantined from is currently entitled' });
      }
    }

    return {
      ...ref,
      acquiredAt: num.dateCreated ? new Date(num.dateCreated).toISOString().slice(0, 10) : null,
      monthlyCost: monthlyRate,
      currency,
      environment,
      household: primary ? String(primary.id).slice(0, 8) : null,
      classification,
      entitlement: ent,
      lifecycle,
      pendingReleaseAt: pendingAt,
      lastInboundAt: lastInbound,
      recentInbound,
      assessment,
    };
  });

  // Entitled production households with no billed number (the other side
  // of the reconciliation).
  const billed = new Set(ownedNumbers.map((o) => norm(o.phoneNumber)));
  for (const h of households.filter((x) => x.environment === 'production')) {
    const ent = entitlementState(entitlements, h.id, now);
    if (ent !== 'current') continue;
    if (!h.twilio_number || !billed.has(norm(h.twilio_number))) {
      anomalies.push({ level: 'CRITICAL', type: 'ENTITLED_HOUSEHOLD_WITHOUT_NUMBER', household: String(h.id).slice(0, 8), classification: classOf.get(h.id) || 'unclassified',
        detail: h.twilio_number ? 'assigned number is not on the provider account' : 'no number assigned' });
    }
  }

  const costOf = (list) => money(list.length * monthlyRate);
  const by = (a) => rows.filter((r) => r.assessment === a);
  const blocked = rows.filter((r) => (r.assessment === 'orphan_investigate' || r.assessment === 'apparently_unnecessary') && r.recentInbound);
  const kpis = {
    totalNumbers: rows.length,
    monthlyCost: costOf(rows),
    currency,
    byAssessment: Object.fromEntries(['customer_required', 'retained_internal', 'lifecycle_in_progress', 'apparently_unnecessary', 'orphan_investigate']
      .map((a) => [a, { numbers: by(a).length, monthlyCost: costOf(by(a)) }])),
    orphanNumbers: by('orphan_investigate').length,
    stagingNumbersOnAccount: rows.filter((r) => r.environment === 'staging').length,
    entitledHouseholdsWithoutNumber: anomalies.filter((a) => a.type === 'ENTITLED_HOUSEHOLD_WITHOUT_NUMBER').length,
    expectedMonthlyCost: costOf([...by('customer_required'), ...by('retained_internal')]),
    potentialMonthlySaving: {
      whenLifecycleCompletes: costOf(by('lifecycle_in_progress')),
      ifApparentlyUnnecessaryResolved: costOf(by('apparently_unnecessary').filter((r) => !r.recentInbound)),
      orphansAfterInvestigation: costOf(by('orphan_investigate')),
      blockedByRecentInboundActivity: costOf(blocked),
    },
    anomalies: { critical: anomalies.filter((a) => a.level === 'CRITICAL').length, warning: anomalies.filter((a) => a.level === 'WARNING').length },
  };

  return { rows, kpis, anomalies };
}

module.exports = { buildNumberCostReport, entitlementState };
