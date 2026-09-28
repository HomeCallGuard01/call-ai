// companySpendProtection.js — HCG's company-level emergency spend state.
// Combines spendGuard + spendAnomaly alerts and the day/month totals into
// one protection level with recommended actions. Pure: it decides and
// explains; it never executes anything, never blocks call delivery and
// never changes a customer-facing limit. Twilio (and most carriers) have no
// hard account spend cap, so this is HCG's own backstop.
//
// Levels
//   0 NORMAL     nothing abnormal
//   1 WATCH      any WARNING — dashboard only
//   2 ALERT      any CRITICAL, or cost data missing/stale — page the operator
//   3 EMERGENCY  company spend far beyond any plausible legitimate use — page,
//                and put the prepared emergency actions in front of a human
//
// Invariants (tested):
//   - no action ever blocks, rejects or shortens a customer's call on its own
//     authority; call-path actions are recommendations that need approval
//     (config.approvedActions) and are still executed by the call path's owner
//   - missing/stale data raises the level to at least ALERT but can never, by
//     itself, reach EMERGENCY, and the level cannot step down while data is stale
//   - escalation is immediate; de-escalation is one level at a time after
//     `clearRunsToStepDown` consecutive lower evaluations (no flapping)
'use strict';

const LEVELS = ['NORMAL', 'WATCH', 'ALERT', 'EMERGENCY'];

const DEFAULT_PROTECTION_CONFIG = {
  // DECISION REQUIRED: proposed from 2026-09 unit economics. Normal run-rate
  // is ≈ £0.07–0.10 per entitled household per day.
  emergencyDailyFloorGbp: 25,
  emergencyDailyPerEntitledGbp: 0.75,   // ≈ 10× normal
  emergencyMonthFloorGbp: 250,
  emergencyMonthPerEntitledGbp: 6,      // ≈ the whole after-fees revenue of every household
  clearRunsToStepDown: 2,
  approvedActions: [],                  // e.g. ['reject_burst_source'] once Andrew approves one
};

// Every action HCG could take, what it costs the customer, and who owns it.
// None is executed here.
const ACTIONS = {
  page_operator: { kind: 'notify', affectsCustomers: false, description: 'Send a CRITICAL alert to the operator (existing sendCriticalAlert)' },
  review_dashboard: { kind: 'notify', affectsCustomers: false, description: 'Review WARNING items on the admin dashboard' },
  check_provider_console: { kind: 'manual', affectsCustomers: false, description: 'Compare with the provider console usage (Twilio Usage → Today) to confirm the spend is real' },
  investigate_households: { kind: 'manual', affectsCustomers: false, description: 'Open the flagged households: call legs, callers, durations' },
  fix_ingestion: { kind: 'manual', affectsCustomers: false, description: 'Cost data is missing/stale: restore ledger ingestion before trusting any total' },
  reject_burst_source: {
    kind: 'call_path', affectsCustomers: true, owner: 'P0/product',
    description: 'Reject further calls from the specific caller ID(s) driving a detected burst/flood to a household (first-verb <Reject> is unbilled). Targets abuse, not the household\'s genuine callers.',
  },
  pause_new_monitoring_flagged: {
    kind: 'call_path', affectsCustomers: true, owner: 'P0/product',
    description: 'Stop starting NEW monitoring sessions for flagged households only. Calls still connect; the customer loses scam monitoring and MUST be told. Saves streams + transcription, not the inbound leg.',
  },
  provider_number_suspension: {
    kind: 'manual', affectsCustomers: true, owner: 'Andrew',
    description: 'Last resort, human only: point a single abused number at a reject-only handler in the provider console. The household\'s protection stops until restored.',
  },
};

function thresholdsFor(entitled, c) {
  return {
    emergencyDailyGbp: Math.max(c.emergencyDailyFloorGbp, entitled * c.emergencyDailyPerEntitledGbp),
    emergencyMonthGbp: Math.max(c.emergencyMonthFloorGbp, entitled * c.emergencyMonthPerEntitledGbp),
  };
}

/**
 * @param {object} input
 * @param {object[]} input.alerts           spendGuard + spendAnomaly alerts
 * @param {number}   input.entitledHouseholds
 * @param {number|null} [input.todaySpendGbp]
 * @param {number|null} [input.monthToDateGbp]
 * @param {{ level: number, lowerRuns: number }|null} [input.previous]  last evaluation's state
 * @param {object} [config]
 */
function assessProtection(input, config = {}) {
  const c = { ...DEFAULT_PROTECTION_CONFIG, ...config };
  const alerts = input.alerts || [];
  const entitled = Math.max(0, Number(input.entitledHouseholds) || 0);
  const th = thresholdsFor(entitled, c);
  const reasons = [];

  const dataUnobserved = alerts.some((a) => a.code === 'COST_DATA_MISSING' || a.code === 'COST_DATA_STALE' || a.code === 'MONITOR_LOAD_FAILED');
  let computed = 0;
  if (alerts.some((a) => a.severity === 'WARNING')) computed = 1;
  if (alerts.some((a) => a.severity === 'CRITICAL')) computed = 2;
  if (dataUnobserved) { computed = Math.max(computed, 2); reasons.push('cost data unobserved (missing/stale): treated as ALERT, never as zero spend'); }

  const today = Number(input.todaySpendGbp);
  const mtd = Number(input.monthToDateGbp);
  if (Number.isFinite(today) && today >= th.emergencyDailyGbp) {
    computed = 3; reasons.push(`today's spend £${round(today)} ≥ emergency £${round(th.emergencyDailyGbp)}`);
  }
  if (Number.isFinite(mtd) && mtd >= th.emergencyMonthGbp) {
    computed = 3; reasons.push(`month-to-date £${round(mtd)} ≥ emergency £${round(th.emergencyMonthGbp)}`);
  }
  for (const a of alerts.filter((x) => x.severity === 'CRITICAL')) reasons.push(`${a.code}${a.subject ? ` (${a.subject})` : ''}: ${a.detail}`);

  // Hysteresis.
  const prev = input.previous || { level: 0, lowerRuns: 0 };
  let level = computed;
  let lowerRuns = 0;
  if (computed < prev.level) {
    lowerRuns = (prev.lowerRuns || 0) + 1;
    if (dataUnobserved || lowerRuns < c.clearRunsToStepDown) {
      level = prev.level;
      reasons.push(dataUnobserved ? `holding ${LEVELS[prev.level]}: cannot step down while cost data is unobserved`
        : `holding ${LEVELS[prev.level]}: ${lowerRuns}/${c.clearRunsToStepDown} clear evaluations before stepping down`);
    } else {
      level = prev.level - 1;
      lowerRuns = 0;
    }
  }

  const burstHouseholds = alerts.filter((a) => a.code === 'CALL_BURST' || (a.code === 'CONCURRENT_CALLS' && a.severity === 'CRITICAL')).map((a) => a.subject);
  const flaggedHouseholds = [...new Set(alerts.filter((a) => a.subject && a.severity === 'CRITICAL' && !['NEW_COST_CATEGORY'].includes(a.code)).map((a) => a.subject))];

  const actions = [];
  const add = (id, extra = {}) => {
    const def = ACTIONS[id];
    const approved = def.kind !== 'call_path' || (c.approvedActions || []).includes(id);
    actions.push({ id, ...def, status: def.kind === 'call_path' ? (approved ? 'approved_for_owner_to_execute' : 'recommendation_requires_approval') : 'do_now', ...extra });
  };
  if (level >= 1) add('review_dashboard');
  if (level >= 2) { add('page_operator'); add('check_provider_console'); if (flaggedHouseholds.length) add('investigate_households', { households: flaggedHouseholds }); }
  if (dataUnobserved) add('fix_ingestion');
  if (level >= 2 && burstHouseholds.length) add('reject_burst_source', { households: [...new Set(burstHouseholds)] });
  if (level >= 3) {
    if (flaggedHouseholds.length) add('pause_new_monitoring_flagged', { households: flaggedHouseholds });
    add('provider_number_suspension');
  }

  return {
    level,
    name: LEVELS[level],
    computedLevel: computed,
    state: { level, lowerRuns },
    thresholds: { emergencyDailyGbp: round(th.emergencyDailyGbp), emergencyMonthGbp: round(th.emergencyMonthGbp) },
    reasons,
    actions,
    blocksCallDelivery: false,
  };
}

function round(n) { return Math.round(Number(n) * 100) / 100; }

module.exports = { assessProtection, LEVELS, ACTIONS, DEFAULT_PROTECTION_CONFIG };
