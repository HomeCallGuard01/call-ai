// Integration 2026-10-10: WS2's profitability portfolio (contract §B,
// docs/launch/2026-10-10-WS2-REPORT.md) → the shape the Financial Control
// Centre page (WS4, admin-financial-control.html) renders, contract
// "ws2-profitability-v1" (docs/launch/2026-10-10-WS4-REPORT.md §7). Pure and
// read-only. Unknown values stay null (the page shows "—"), never zero: a
// cost breakdown the model doesn't have (telephony/AI/SMS split) is null, and
// provider reconciliation is reported unavailable because production has no
// provider-actuals feed (WS2 finding 2).
//
// WS4 update 2026-10-10 (docs/launch/2026-10-10-WS4-CONTROL-CENTRE-UPDATE.md):
// additive fields only (same contract version) — per customer ESTIMATED cost
// (Fortress committed + reserved) beside ACTUAL cost (provider actuals, null
// + "not_available" when none were recorded, never £0), the 076 continuity
// reserves, the allowance STATE, PROTECTION status (the canonical
// services/lifecycle/activationState.js deriveActivationState over the
// existing database/lifecycleSnapshot.js snapshots) and per-household ALERTS
// (flags + unseen ops events + delivery problems). Pure: the route does the
// one batched load and passes the rows in.
'use strict';

const { deriveActivationState } = require('../lifecycle/activationState');

const CONTRACT_VERSION = 'ws2-profitability-v1';
const PRICE_LABELS = { standard_599: '£5.99', grandfathered_499: '£4.99 (grandfathered)' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => (num(v) === null ? null : Math.round(v * 100) / 100);
const pctOf = (part, whole) => (num(part) !== null && num(whole) !== null && whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function toCustomer(row) {
  const r = row || {};
  const revenue = r.revenue || {};
  const cost = r.cost || {};
  const contribution = r.contribution || {};
  const projection = r.projection || {};
  const allowance = r.allowance || {};
  return {
    householdId: r.householdId || null,
    accountNumber: r.accountNumber || null,
    segment: r.profile || null,
    channel: r.channel || null,
    priceLabel: PRICE_LABELS[r.pricePoint] || null,
    grandfathered: r.pricePoint === 'grandfathered_499',
    joinedAt: null,
    revenue: {
      grossGbp: revenue.counted ? num(revenue.grossInclVatGbp) : null,
      netGbp: num(revenue.netRevenueGbp),
      basis: revenue.counted ? 'actual' : `not_counted:${revenue.reasonNotCounted || 'unknown'}`,
    },
    cost: {
      attributableGbp: num(cost.totalGbp),
      // ESTIMATED = what the Fortress has committed (settled estimates) plus
      // what it holds reserved for calls in flight.
      estimatedGbp: num(cost.fortressCommittedGbp) === null && num(cost.fortressReservedGbp) === null ? null : r2((num(cost.fortressCommittedGbp) || 0) + (num(cost.fortressReservedGbp) || 0)),
      committedGbp: num(cost.fortressCommittedGbp),
      reservedGbp: num(cost.fortressReservedGbp),
      // ACTUAL = provider-billed cost recorded against the ledger
      // (fc_budget_accounts.actual_gbp via fc_record_provider_actual). No feed
      // writes it in production yet, so 0 means "none recorded", not "£0":
      // shown as null + not_available.
      actualGbp: num(cost.providerActualGbp) !== null && cost.providerActualGbp > 0 ? num(cost.providerActualGbp) : null,
      actualBasis: num(cost.providerActualGbp) !== null && cost.providerActualGbp > 0 ? 'provider_actual' : 'not_available',
      telephonyGbp: null,
      aiGbp: null,
      smsGbp: null,
      numberRentalGbp: num(cost.numberRentalGbp),
      basis: 'fortress_committed_conservative',
    },
    margin: {
      actualGbp: num(contribution.gbp),
      actualPct: num(contribution.marginPct),
      projectedGbp: num(projection.projectedContributionGbp),
      projectedPct: pctOf(num(projection.projectedContributionGbp), num(revenue.netRevenueGbp)),
    },
    allowance: {
      // No budget account this period ⇒ the state is unknown (null), not
      // "normal" — except a hold, which is known without an account.
      state: allowance.state === 'held' || num(allowance.budgetGbp) !== null ? allowance.state || null : null,
      usedPercent: num(allowance.percentUsed),
      remainingGbp: num(allowance.budgetRemainingGbp),
      budgetGbp: num(allowance.budgetGbp),
      trustedReserveRemainingGbp: num(allowance.trustedReserveRemainingGbp),
      unknownReserveRemainingGbp: num(allowance.unknownReserveRemainingGbp),
      topUpsGbp: num(allowance.topUpCreditGbp),
      resetsAt: null,
    },
    protection: null,
    alerts: [],
    flags: Array.isArray(r.flags) ? r.flags.slice() : [],
  };
}

const SIGNAL_RULES = [
  ['loss_making', 'red', 'Loss-making this period'],
  ['hard_ceiling', 'red', 'Reached the hard ceiling'],
  ['held', 'red', 'Household on financial hold'],
  ['reconciliation_gap', 'amber', 'Provider actuals differ from the ledger'],
  ['actual_exceeds_estimate', 'amber', 'Provider actual exceeded the Fortress estimate'],
  ['projected_loss', 'amber', 'Projected to be loss-making by period end'],
  ['heavy_user', 'amber', 'Heavy user'],
];

// Plain-English titles for the canonical activation stages / blockers
// (services/lifecycle/activationState.js). Unknown values pass through.
const STAGE_LABELS = Object.freeze({
  protected: 'Protected', forwarding_unconfirmed: 'Forwarding not confirmed', on_hold: 'Held (financial hold)',
  reconnect_needed: 'App unreachable (was working)', awaiting_app: 'App not registered', awaiting_first_delivery: 'Awaiting first delivered call',
  awaiting_forwarding: 'Forwarding not set up', awaiting_number: 'Awaiting number', number_failed: 'Number provisioning failed',
  number_conflict: 'Number quarantined while entitled', ambiguous: 'State unreadable', membership_upcoming: 'Membership not started',
  membership_ended: 'Membership ended', signed_up: 'Signed up (no membership)', account_deleted: 'Account deleted',
});
const BLOCKER_LABELS = Object.freeze({
  accountActive: 'Account not active', stateKnown: 'State unreadable', entitledNow: 'No membership in effect', notOnHold: 'On financial hold',
  numberActive: 'No active HCG number', numberNotQuarantined: 'Number quarantined', forwardingVerifiedForCurrentNumber: 'Forwarding not proven',
  appReachable: 'App not reachable', deliveryVerifiedForCurrentNumber: 'No delivered call yet',
});
// Stage → delivery/protection alert for a customer who should be protected.
const STAGE_ALERTS = Object.freeze({
  on_hold: 'red', number_conflict: 'red', ambiguous: 'red', reconnect_needed: 'red', number_failed: 'red',
  forwarding_unconfirmed: 'amber', awaiting_app: 'amber', awaiting_first_delivery: 'amber', awaiting_forwarding: 'amber', awaiting_number: 'amber',
});
const OPS_SEVERITY = Object.freeze({ critical: 'red', action: 'amber', info: 'info' });
const OPS_REASON_LABELS = Object.freeze({
  protection_lost_app_unreachable: 'App unreachable (was working)', not_protected_within_onboarding_window: 'Not protected within 24 h',
  number_provisioning_failed: 'Number provisioning failed', forwarding_not_proven: 'Forwarding not proven yet', payment_failed: 'Payment failed',
  financial_hold: 'Financial hold', number_quarantined_while_entitled: 'Number quarantined while entitled', state_unreadable: 'State unreadable',
});
const SEVERITY_RANK = { red: 0, amber: 1, info: 2 };

function protectionOf(snapshot, now) {
  if (!snapshot) return null;
  try {
    const a = deriveActivationState(snapshot, now);
    return {
      stage: a.stage,
      label: STAGE_LABELS[a.stage] || a.stage,
      protected: a.protected === true,
      blockers: a.blockers.map((b) => BLOCKER_LABELS[b] || b),
      attention: a.attention.slice(),
      deliveryHealthChecked: a.evidence.deliveryHealthChecked,
    };
  } catch {
    // Fail closed: an inconsistent snapshot is "unknown", never "protected".
    return { stage: 'ambiguous', label: STAGE_LABELS.ambiguous, protected: false, blockers: [BLOCKER_LABELS.stateKnown], attention: [], deliveryHealthChecked: false };
  }
}

function alertsFor(customer, protection, opsEvents) {
  const out = [];
  for (const [flag, severity, title] of SIGNAL_RULES) if (customer.flags.includes(flag)) out.push({ severity, title, at: null, source: 'flag' });
  if (protection) {
    const sev = STAGE_ALERTS[protection.stage];
    if (sev && !(protection.stage === 'on_hold' && customer.flags.includes('held'))) out.push({ severity: sev, title: protection.label, at: null, source: 'protection' });
    if (protection.attention.includes('delivery_unreachable') && protection.stage !== 'reconnect_needed') out.push({ severity: 'red', title: 'Delivery: app unreachable', at: null, source: 'delivery' });
    if (protection.attention.includes('delivery_suspect')) out.push({ severity: 'amber', title: 'Delivery: recent failures (suspect)', at: null, source: 'delivery' });
    if (protection.attention.includes('payment_issue')) out.push({ severity: 'amber', title: 'Payment issue', at: null, source: 'billing' });
    if (protection.attention.includes('evidence_predates_current_number')) out.push({ severity: 'amber', title: 'Evidence predates current number', at: null, source: 'protection' });
  }
  for (const e of opsEvents || []) {
    const payload = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const title = e.event_type === 'customer_needs_attention' ? `Needs attention: ${(reason && OPS_REASON_LABELS[reason]) || reason || 'unspecified'}`
      : e.event_type === 'customer_protected' ? 'Became protected' : e.event_type === 'new_genuine_customer' ? 'New genuine customer' : String(e.event_type || 'ops event');
    out.push({ severity: OPS_SEVERITY[e.severity] || 'info', title: `${title} (unseen)`, at: e.occurred_at || e.created_at || null, source: 'ops_event' });
  }
  return out.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || String(b.at || '').localeCompare(String(a.at || '')));
}

const COST_CAVEAT = 'Estimated cost is what the Fortress has committed (settled per-call estimates) plus what it holds reserved for calls in flight; it is conservative. Actual cost is provider-billed cost recorded against the ledger — providers bill with a delay (hours to days), and no provider-actuals feed is connected in production yet, so actual cost shows "not yet available" rather than £0.';

/**
 * Pure: WS2 portfolio (+ optional lifecycle snapshots and unseen ops events)
 * → control-centre v1.
 * @param {object} portfolio  buildPortfolio() output
 * @param {object} [extra]
 * @param {object[]|null} [extra.snapshots]  loadLifecycleSnapshots().snapshots; null = not loaded
 * @param {object[]|null} [extra.opsEvents]  unseen ops_events rows; null = not loaded
 * @param {object} [extra.sources]           per-source load states, passed through
 * @param {boolean} [extra.topUpsEnabled]    ALLOWANCE_TOPUPS_ENABLED === 'true'
 * @param {Date} [extra.now]
 */
function toControlCentreV1(portfolio, extra = {}) {
  const p = portfolio || {};
  const t = p.totals || {};
  const period = p.period || {};
  const now = extra.now || (p.generatedAt ? new Date(p.generatedAt) : new Date());
  const snapshotsLoaded = Array.isArray(extra.snapshots);
  const opsLoaded = Array.isArray(extra.opsEvents);
  const snapBy = new Map((snapshotsLoaded ? extra.snapshots : []).filter((s) => s && s.household).map((s) => [s.household.id, s]));
  const opsBy = new Map();
  for (const e of opsLoaded ? extra.opsEvents : []) {
    if (!e || !e.household_id || e.seen_at) continue;
    if (!opsBy.has(e.household_id)) opsBy.set(e.household_id, []);
    opsBy.get(e.household_id).push(e);
  }
  const customers = (Array.isArray(p.households) ? p.households : []).map(toCustomer);
  const signals = [];
  for (const c of customers) {
    // Protection: null when the lifecycle load failed or this household has
    // no snapshot — the page shows "unknown", never "protected".
    c.protection = snapshotsLoaded ? protectionOf(snapBy.get(c.householdId), now) : null;
    c.alerts = alertsFor(c, c.protection, opsBy.get(c.householdId));
    for (const [flag, severity, title] of SIGNAL_RULES) {
      if (c.flags.includes(flag)) signals.push({ severity, title, detail: flag, accountNumber: c.accountNumber });
    }
  }
  for (const w of Array.isArray(p.warnings) ? p.warnings : []) signals.push({ severity: 'info', title: 'Data warning', detail: String(w), accountNumber: null });
  for (const c of customers) {
    if (!c.allowance.resetsAt && period.end) c.allowance.resetsAt = period.end;
  }
  const withActual = customers.filter((c) => c.cost.actualBasis === 'provider_actual');
  const estimates = customers.map((c) => c.cost.estimatedGbp).filter((v) => v !== null);
  const known = customers.filter((c) => c.protection);
  const countState = (s) => customers.filter((c) => c.allowance.state === s).length;
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: p.generatedAt || null,
    period: { label: typeof period.start === 'string' ? period.start.slice(0, 7) : null, start: period.start || null, end: period.end || null },
    currency: 'GBP',
    basis: (p.assumptions && p.assumptions.usageCostBasis) || null,
    costCaveat: COST_CAVEAT,
    totals: {
      customers: num(t.households),
      revenueNetGbp: num(t.netRevenueGbp),
      attributableCostGbp: num(t.attributableCostGbp),
      estimatedCostGbp: estimates.length ? r2(estimates.reduce((s, v) => s + v, 0)) : null,
      // Only a sum of RECORDED provider actuals; null when none exist.
      actualCostGbp: withActual.length ? r2(withActual.reduce((s, c) => s + c.cost.actualGbp, 0)) : null,
      actualCostCoverage: { customersWithActual: withActual.length, customers: customers.length },
      marginGbp: num(t.contributionGbp),
      marginPct: num(t.marginPct),
      projectedMarginPct: pctOf(num(t.projectedContributionGbp), num(t.netRevenueGbp)),
      protectedCustomers: snapshotsLoaded ? known.filter((c) => c.protection.protected).length : null,
      notProtectedCustomers: snapshotsLoaded ? known.filter((c) => !c.protection.protected).length : null,
      protectionUnknownCustomers: snapshotsLoaded ? customers.length - known.length : null,
      heldCustomers: countState('held'),
      hardCeilingCustomers: countState('hard_ceiling'),
      customersWithRedAlerts: customers.filter((c) => c.alerts.some((a) => a.severity === 'red')).length,
    },
    customers,
    topUps: { enabled: extra.topUpsEnabled === true, status: extra.topUpsEnabled === true ? 'enabled' : 'disabled' },
    sources: {
      lifecycle: snapshotsLoaded ? 'ok' : 'unavailable',
      opsEvents: opsLoaded ? 'ok' : 'unavailable',
      // Per-household delivery health is not loaded in bulk (one query per
      // household); delivery alerts come from the snapshot's own evidence and
      // from ops events.
      deliveryHealth: 'not_loaded_in_bulk',
      providerActuals: withActual.length ? 'partial' : 'none_recorded',
      ...(extra.sources && typeof extra.sources === 'object' ? { detail: extra.sources } : {}),
    },
    providerReconciliation: { available: false, reason: 'No provider-actuals feed in production yet; offline reconciliation only (WS2).', rows: [] },
    signals,
    // Advisory text only — hard limits are enforced by the Fortress, never here.
    recommendations: [],
  };
}

module.exports = { toControlCentreV1, CONTRACT_VERSION, COST_CAVEAT };
