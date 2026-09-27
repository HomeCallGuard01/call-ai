// Business control dashboard — read contract for customer attribution
// (public.customer_acquisition, migration 049: designed in
// docs/architecture/FINANCIAL_DATA_ARCHITECTURE.md §8.2 / §9, NOT yet
// written). Everything the Marketing tab needs from 049 goes through the
// single adapter below, so if 049's final column names differ, only
// ACQUISITION_COLUMNS / toAcquisitionRecord change.
//
// DECISION REQUIRED (049 author): confirm these column names, or tell the
// dashboard owner the real ones.
//
// Rules carried over from the design, enforced here:
//   - first touch is the attribution of record (write-once in 049);
//   - no campaign → the household is "direct / unknown", never guessed;
//   - self-reported source is shown SEPARATELY and never fills in or
//     overrides automatic attribution;
//   - only genuine_customer households count as paying customers;
//   - CAC needs both spend and attributed paying customers.
'use strict';

const { normaliseCampaignRef } = require('./campaignPerformance');

// Proposed 049 columns (architecture doc §8.2).
const ACQUISITION_COLUMNS = [
  'household_id',
  'first_source',
  'first_medium',
  'first_campaign',
  'first_content',
  'first_touch_at',
  'channel',
  'attribution_method',
  'confidence',
  'signup_source',
  'self_reported_source',
];

const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'none'];

// The one adapter from a 049 row to what the dashboard uses.
function toAcquisitionRecord(row) {
  const campaignRef = normaliseCampaignRef(row.first_source, row.first_medium, row.first_campaign);
  return {
    householdId: row.household_id,
    campaignRef,
    channel: row.channel || (campaignRef ? 'other_tagged' : 'direct_or_unknown'),
    method: row.attribution_method || 'none',
    confidence: CONFIDENCE_LEVELS.includes(row.confidence) ? row.confidence : 'none',
    signupSource: row.signup_source || 'unknown',
    selfReported: row.self_reported_source || null,
  };
}

// Pure — per campaign_ref: attributed signups, genuine signups, genuine
// paying customers, and the confidence / method mix behind them.
// `payingGenuineHouseholdIds`: households that are genuine_customer AND
// have an active paid entitlement. `genuineHouseholdIds`: all
// genuine_customer households.
function aggregateAttribution(rows, { payingGenuineHouseholdIds = new Set(), genuineHouseholdIds = new Set() } = {}) {
  const byCampaign = {};
  const selfReported = {};
  let unattributed = { signups: 0, payingGenuine: 0 };

  for (const raw of rows || []) {
    const r = toAcquisitionRecord(raw);
    const paying = payingGenuineHouseholdIds.has(r.householdId);
    if (r.selfReported) selfReported[r.selfReported] = (selfReported[r.selfReported] || 0) + 1;
    if (!r.campaignRef) {
      unattributed.signups += 1;
      if (paying) unattributed.payingGenuine += 1;
      continue;
    }
    const c = (byCampaign[r.campaignRef] = byCampaign[r.campaignRef] || {
      signups: 0,
      genuineSignups: 0,
      payingGenuine: 0,
      confidence: { high: 0, medium: 0, low: 0, none: 0 },
      methods: {},
    });
    c.signups += 1;
    if (genuineHouseholdIds.has(r.householdId)) c.genuineSignups += 1;
    if (paying) c.payingGenuine += 1;
    c.confidence[r.confidence] += 1;
    c.methods[r.method] = (c.methods[r.method] || 0) + 1;
  }
  return { byCampaign, unattributed, selfReported };
}

module.exports = { ACQUISITION_COLUMNS, CONFIDENCE_LEVELS, toAcquisitionRecord, aggregateAttribution };
