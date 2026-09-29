// Business control centre — Twilio number inventory (number-centric).
//
// One row per number the PROVIDER says exists (the provider is
// authoritative for what HCG is paying for), answering:
//   which household holds it · why HCG believes it should exist ·
//   environment evidence · monthly rental · lifecycle state ·
//   anomaly · recommended investigation.
// Plus rows for household numbers the provider no longer lists.
//
// STRICTLY OBSERVATIONAL. Lifecycle enforcement (release, quarantine,
// scheduling) belongs to the P0 number-lifecycle workstream (047, the
// lifecycle sweep, #47/#49); this module only reports recorded state.
// Recorded release failures are read from the columns P0's lifecycle-sweep
// migration adds (households.twilio_release_last_error /
// _last_attempt_at / _attempt_count) when they exist; until then they are
// reported as "not recorded yet", never assumed absent.
//
// Environment evidence comes from each number's voice URL host: a
// production host, a development tunnel (ngrok), another host, or none.
// Finance's number-cost report (services/ledger/numberCostReport.js, ledger
// branch) classifies staging the same way from the staging database; see
// docs/admin/RECONCILIATION_CONSOLIDATION_PLAN.md.
'use strict';

const { classifyHouseholdForBusiness } = require('./definitions');
const { parseTimestampMs } = require('../adminOnboardingStatus');

const HOUR_MS = 3600 * 1000;
// Canonical grace periods (services/numberLifecycle/state.js).
const { GRACE } = require('../numberLifecycle/state');
const RELEASE_JOB_GRACE_MS = GRACE.releaseOverdueMs;

const SEVERITY_ORDER = { red: 0, amber: 1, info: 2 };

const STATES = {
  in_service: { label: 'In service', severity: 'info' },
  in_service_upcoming: { label: 'Held for an upcoming membership', severity: 'info' },
  retained_internal: { label: 'Held by an internal/test/reviewer account', severity: 'info' },
  grace_period: { label: 'Grace period — release scheduled', severity: 'info' },
  release_overdue: { label: 'Release overdue', severity: 'red' },
  outside_lifecycle: { label: 'No membership and no release scheduled', severity: 'red' },
  quarantined_awaiting_confirmation: { label: 'Quarantined — awaiting deactivation confirmation', severity: 'amber' },
  quarantined_releasing: { label: 'Quarantined — confirmed, release job pending', severity: 'info' },
  quarantine_release_overdue: { label: 'Quarantined — confirmed but not released', severity: 'red' },
  marked_released_still_at_provider: { label: 'Recorded as released but still on the provider account', severity: 'red' },
  staging_or_dev: { label: 'Development/staging number on the production account', severity: 'amber' },
  orphan: { label: 'Not linked to any household or quarantine', severity: 'red' },
  missing_at_provider: { label: 'Household number not found at the provider', severity: 'red' },
  quarantined_from_entitled: { label: 'Quarantined number belongs to a household that is currently entitled', severity: 'red' },
};

const RECOMMENDATIONS = {
  release_overdue: 'Check the release job logs for this household; the scheduled release did not happen.',
  outside_lifecycle: 'Confirm the membership really ended, then let the lifecycle schedule the release (P0). Do not release manually from here.',
  quarantined_awaiting_confirmation: 'Confirm with the customer that carrier forwarding is off, then record it with the existing confirm-deactivation action.',
  quarantine_release_overdue: 'The provider release has not happened 48h after confirmation — check release logs / recorded error.',
  marked_released_still_at_provider: 'HCG recorded this number as released but Twilio still bills it — check whether the SID lookup failed (see release-failure design).',
  staging_or_dev: 'Bought by a staging/local server: it has no Twilio credentials of its own, so it falls back to the production account (see docs/admin/STAGING_NUMBERS_ON_PRODUCTION_TWILIO.md). Its household is in the staging database, and staging test subscriptions never lapse, so nothing ever releases it. Decide: move to a staging sub-account or release deliberately — never from here.',
  orphan: 'Check recent inbound calls to this number before doing anything — forwarding may still point here. Never release without investigation.',
  missing_at_provider: 'The customer may be forwarding to a number HCG no longer holds — contact the customer and reprovision through the normal flow.',
  voice_url_mismatch: 'Calls to this customer\'s number are not sent to production — check the number\'s voice URL in Twilio.',
  release_failed_recorded: 'A release attempt failed with a recorded error — review the error and retry through the lifecycle.',
  quarantined_from_entitled: 'Do NOT confirm deactivation — this customer is entitled again and may still forward to this number. Resolve through the lifecycle (P0) before any release.',
};

// The eight categories every provider number falls into (2026-09-29).
// Precedence: provider/lifecycle evidence first (staging, orphan, pending
// release, other), then the holder's explicit classification, then — for
// genuine customers only — membership. An unclassified holder is UNKNOWN:
// evidence is insufficient to call it a customer or a test account.
const CATEGORIES = {
  customer_active: { label: 'Customer — active', avoidable: false, action: 'None — in service for a genuine customer.' },
  customer_cancelled_grace: { label: 'Customer — cancelled / grace period', avoidable: false, action: 'Normal while a release is scheduled; if none is scheduled, confirm the membership ended and let the lifecycle schedule it.' },
  pending_release: { label: 'Pending release', avoidable: true, action: 'In the release lifecycle (release due, or quarantined). Follow the quarantine confirmation process; never release from the dashboard.' },
  internal_test: { label: 'Internal test', avoidable: true, action: 'Check the test still needs a live number; give the test account an end date so the lifecycle releases it.' },
  staging: { label: 'Staging / development', avoidable: true, action: 'Billed on the production account by a staging/local server. Move to a staging sub-account or release deliberately after checking inbound calls.' },
  reviewer: { label: 'Reviewer', avoidable: false, action: 'Keep while App Review / external review needs it; set an end date on the reviewer entitlement.' },
  orphan: { label: 'Orphan / unknown', avoidable: true, action: 'No household in HCG. Check the provider call log for recent inbound calls before doing anything.' },
  unknown: { label: 'Unknown (unclassified holder)', avoidable: false, action: 'Classify the account (Customers) before deciding anything about its number.' },
  other: { label: 'Other', avoidable: true, action: 'Record and provider disagree — see the row\'s flag.' },
};
const CATEGORY_ORDER = Object.keys(CATEGORIES);
const TEST_CLASSES = new Set(['internal_test', 'admin', 'qa_automation']);
// other_non_customer (migration 055) holders fall to OTHER: not a customer,
// not a known test account.

// Pure.
function categoriseInventoryRow(row) {
  if (row.state === 'staging_or_dev') return 'staging';
  if (row.state === 'orphan') return 'orphan';
  if (['release_overdue', 'quarantined_awaiting_confirmation', 'quarantined_releasing', 'quarantine_release_overdue'].includes(row.state)) return 'pending_release';
  if (row.state === 'marked_released_still_at_provider' || row.state === 'missing_at_provider') return 'other';
  const owner = row.owner;
  if (!owner || !owner.accountClass) return 'unknown';
  if (owner.accountClass === 'reviewer') return 'reviewer';
  if (TEST_CLASSES.has(owner.accountClass)) return 'internal_test';
  if (owner.accountClass === 'unclassified') return 'unknown';
  if (owner.accountClass === 'genuine') return owner.membership === 'current' || owner.membership === 'upcoming' ? 'customer_active' : 'customer_cancelled_grace';
  return 'other';
}

// "+447700900123" → "+44 •••• ••0123". HCG's numbers are its own provider
// resources, but they are also what customers forward to; the dashboard
// never needs more than the last four digits (the SID finds it in Twilio).
function maskNumber(n) {
  const digits = typeof n === 'string' ? n.replace(/[^0-9+]/g, '') : '';
  if (digits.length < 6) return digits ? '••••' : null;
  const cc = digits.startsWith('+44') ? '+44' : digits.startsWith('+') ? digits.slice(0, 2) : '';
  return `${cc} •••• ••${digits.slice(-4)}`.trim();
}

function normaliseNumber(n) {
  return typeof n === 'string' ? n.replace(/[^0-9+]/g, '') : null;
}

function voiceHostEvidence(voiceUrl, productionHosts) {
  if (!voiceUrl) return { environment: 'no_voice_url', host: null };
  let host = null;
  try {
    host = new URL(voiceUrl).host.toLowerCase();
  } catch (err) {
    return { environment: 'other_host', host: String(voiceUrl).slice(0, 60) };
  }
  if (productionHosts.has(host)) return { environment: 'production', host };
  if (/(^|\.)ngrok(-free)?\.(app|dev|io)$|ngrok/.test(host)) return { environment: 'dev_tunnel', host };
  return { environment: 'other_host', host };
}

// Production hosts: APP_URL's host plus its www./apex twin, plus any
// extras in BUSINESS_PRODUCTION_VOICE_HOSTS (comma-separated).
function resolveProductionHosts(env = process.env) {
  const hosts = new Set();
  const add = (h) => {
    if (!h) return;
    const host = h.toLowerCase();
    hosts.add(host);
    hosts.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`);
  };
  try {
    if (env.APP_URL) add(new URL(env.APP_URL).host);
  } catch (err) {
    /* ignore malformed APP_URL */
  }
  for (const h of String(env.BUSINESS_PRODUCTION_VOICE_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) add(h);
  return hosts;
}

// Pure.
function buildNumberInventory({ providerNumbers, households, entitlementsByHousehold, subscriptionsByHousehold, classificationMap, quarantineRows, productionHosts, rental, releaseRecordingAvailable, lastCallByHousehold = null }, now) {
  const nowMs = now.getTime();
  const byNumber = new Map();
  for (const h of households || []) if (h.twilio_number) byNumber.set(normaliseNumber(h.twilio_number), h);
  const quarantineByNumber = new Map();
  for (const q of quarantineRows || []) {
    const key = normaliseNumber(q.twilio_number);
    if (!key) continue;
    if (!quarantineByNumber.has(key)) quarantineByNumber.set(key, []);
    quarantineByNumber.get(key).push(q);
  }
  const perNumber = rental && Number.isFinite(rental.perNumber) ? rental.perNumber : null;

  const rows = [];
  const onProvider = new Set();
  for (const p of providerNumbers || []) {
    const number = normaliseNumber(p.phoneNumber);
    if (!number) continue;
    onProvider.add(number);
    const evidence = voiceHostEvidence(p.voiceUrl, productionHosts);
    const holder = byNumber.get(number) || null;
    const quarantines = quarantineByNumber.get(number) || [];
    const open = quarantines.find((q) => !q.released_at) || null;
    const released = quarantines.find((q) => q.released_at) || null;
    const extraFlags = [];
    let state;
    let reason;
    let owner = null;

    if (holder) {
      const biz = classifyHouseholdForBusiness({
        household: holder,
        entitlements: entitlementsByHousehold.get(holder.id) || [],
        subscriptions: (subscriptionsByHousehold && subscriptionsByHousehold.get(holder.id)) || [],
        classification: classificationMap.get(holder.id),
      }, now);
      owner = { householdId: holder.id, email: holder.email || null, accountClass: biz.accountClass, membership: biz.membership, access: biz.access, protection: biz.protection };
      const pendingMs = parseTimestampMs(holder.twilio_number_pending_release_at);
      if (biz.membership === 'current') {
        state = biz.isGenuine || biz.accountClass === 'unclassified' ? 'in_service' : 'retained_internal';
        reason = `Current ${biz.access} access (${biz.accountClass.replace('_', ' ')})`;
      } else if (biz.membership === 'upcoming') {
        state = 'in_service_upcoming';
        reason = 'Membership starts in the future';
      } else if (pendingMs !== null && nowMs - pendingMs <= RELEASE_JOB_GRACE_MS) {
        state = 'grace_period';
        reason = `Membership ${biz.membership}${biz.membershipEndedAt ? ' ' + String(biz.membershipEndedAt).slice(0, 10) : ''}; release scheduled ${new Date(pendingMs).toISOString().slice(0, 10)}`;
      } else if (pendingMs !== null) {
        state = 'release_overdue';
        reason = `Release was due ${new Date(pendingMs).toISOString().slice(0, 10)}`;
      } else {
        state = 'outside_lifecycle';
        reason = `Membership ${biz.membership}; no release scheduled`;
      }
      if (evidence.environment !== 'production') extraFlags.push({ code: 'voice_url_mismatch', severity: 'red', label: `Assigned to a production household but the voice URL points to ${evidence.host || 'nothing'}` });
      if (holder.twilio_release_last_error) {
        extraFlags.push({ code: 'release_failed_recorded', severity: 'red', label: `Release failed ${holder.twilio_release_attempt_count || 1} time(s); last error: ${String(holder.twilio_release_last_error).slice(0, 160)}` });
      }
    } else if (open) {
      const confirmedMs = parseTimestampMs(open.deactivation_confirmed_at);
      const fromHousehold = open.household_id ? (households || []).find((h) => h.id === open.household_id) : null;
      if (fromHousehold) {
        const fromBiz = classifyHouseholdForBusiness({ household: fromHousehold, entitlements: entitlementsByHousehold.get(fromHousehold.id) || [], subscriptions: (subscriptionsByHousehold && subscriptionsByHousehold.get(fromHousehold.id)) || [], classification: classificationMap.get(fromHousehold.id) }, now);
        owner = { householdId: fromHousehold.id, email: fromHousehold.email || null, accountClass: fromBiz.accountClass, membership: fromBiz.membership, access: fromBiz.access, protection: fromBiz.protection };
        if (fromBiz.membership === 'current' || fromBiz.membership === 'upcoming') {
          extraFlags.push({ code: 'quarantined_from_entitled', severity: 'red', label: STATES.quarantined_from_entitled.label });
        }
      }
      if (!open.deactivation_confirmed) {
        state = 'quarantined_awaiting_confirmation';
        reason = `Quarantined ${String(open.quarantined_at || '').slice(0, 10)} (${open.release_reason || 'reason not recorded'})`;
      } else if ((confirmedMs ?? parseTimestampMs(open.quarantined_at)) !== null && nowMs - (confirmedMs ?? parseTimestampMs(open.quarantined_at)) > GRACE.quarantineReleaseStuckMs) {
        state = 'quarantine_release_overdue';
        reason = `Deactivation confirmed ${String(open.deactivation_confirmed_at).slice(0, 10)}; still not released`;
      } else {
        state = 'quarantined_releasing';
        reason = 'Deactivation confirmed; waiting for the daily release job';
      }
    } else if (released) {
      state = 'marked_released_still_at_provider';
      reason = `HCG recorded release on ${String(released.released_at).slice(0, 10)}`;
    } else if (evidence.environment === 'dev_tunnel') {
      state = 'staging_or_dev';
      reason = `Voice URL points to a development tunnel (${evidence.host})`;
    } else {
      state = 'orphan';
      reason = evidence.host ? `No household or quarantine; voice URL host ${evidence.host}` : 'No household, no quarantine and no voice URL';
    }

    const flags = [...extraFlags];
    if (STATES[state].severity !== 'info') flags.unshift({ code: state, severity: STATES[state].severity, label: STATES[state].label });
    const severity = flags.reduce((worst, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[worst] ? f.severity : worst), 'info');
    const householdForCalls = owner ? owner.householdId : null;
    rows.push({
      number,
      sid: p.sid || null,
      createdAt: p.dateCreated || null,
      pendingReleaseAt: holder ? holder.twilio_number_pending_release_at || null : null,
      quarantinedAt: open ? open.quarantined_at || null : null,
      lastInboundCall: describeLastCall(householdForCalls, lastCallByHousehold),
      environment: evidence.environment,
      voiceHost: evidence.host,
      owner,
      state,
      stateLabel: STATES[state].label,
      whyExpected: reason,
      monthlyRental: perNumber,
      flags,
      severity,
      recommendations: flags.map((f) => RECOMMENDATIONS[f.code]).filter(Boolean),
    });
  }

  for (const [number, h] of byNumber) {
    if (onProvider.has(number)) continue;
    rows.push({
      number,
      sid: null,
      createdAt: null,
      pendingReleaseAt: h.twilio_number_pending_release_at || null,
      quarantinedAt: null,
      lastInboundCall: describeLastCall(h.id, lastCallByHousehold),
      environment: null,
      voiceHost: null,
      owner: { householdId: h.id, email: h.email || null },
      state: 'missing_at_provider',
      stateLabel: STATES.missing_at_provider.label,
      whyExpected: 'Held by a household in HCG',
      monthlyRental: null,
      flags: [{ code: 'missing_at_provider', severity: 'red', label: STATES.missing_at_provider.label }],
      severity: 'red',
      recommendations: [RECOMMENDATIONS.missing_at_provider],
    });
  }

  rows.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || String(a.number).localeCompare(String(b.number)));

  // Categories + masking. The full number never leaves this function.
  for (const r of rows) {
    r.category = categoriseInventoryRow(r);
    r.categoryLabel = CATEGORIES[r.category].label;
    if (!r.recommendations.length) r.recommendations = [CATEGORIES[r.category].action];
    r.number = maskNumber(r.number);
  }

  const byState = {};
  for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
  const flagged = rows.filter((r) => r.severity !== 'info' && r.state !== 'missing_at_provider');
  const cost = (list) => (perNumber === null ? null : Math.round(list.length * perNumber * 100) / 100);

  // Per-category count and rental. "Needs review" = categories that are
  // plausibly unnecessary spend, plus any red-flagged number elsewhere.
  // Only numbers the provider bills are costed.
  const billed = rows.filter((r) => r.state !== 'missing_at_provider');
  const byCategory = CATEGORY_ORDER.map((key) => {
    const list = billed.filter((r) => r.category === key);
    return { category: key, label: CATEGORIES[key].label, count: list.length, monthlyCost: cost(list), action: CATEGORIES[key].action };
  });
  const review = billed.filter((r) => CATEGORIES[r.category].avoidable || r.severity === 'red');

  return {
    providerNumberCount: onProvider.size,
    byCategory,
    needsReview: { count: review.length, monthlyCost: cost(review), note: 'Numbers that may be unnecessary spend. Verify each (inbound calls, owner) before any release; nothing here releases anything.' },
    categoryDefinitions: CATEGORIES,
    byState,
    stateDefinitions: STATES,
    monthlyRental: {
      perNumber,
      currency: rental ? rental.currency : null,
      basis: rental ? rental.basis : 'Rental rate not available',
      provenance: perNumber === null ? 'NOT_CONNECTED' : rental.provenance,
      allNumbers: cost([...onProvider]),
      flaggedNumbers: cost(flagged),
    },
    releaseFailureRecording: releaseRecordingAvailable
      ? 'recorded (households.twilio_release_last_error)'
      : 'not recorded yet — P0 lifecycle-sweep migration not applied; failures are only inferred',
    rows,
  };
}

// Last inbound call to the HCG number's household, from HCG's own calls
// table (calls record the household, not the dialled number). Numbers
// with no production household have no HCG record: the provider call log
// is the only source, and the row says so rather than "never".
function describeLastCall(householdId, lastCallByHousehold) {
  if (!householdId) return { at: null, source: 'not in HCG records — check the provider call log' };
  if (!lastCallByHousehold) return { at: null, source: 'call history not loaded' };
  const at = lastCallByHousehold.get(householdId) || null;
  return { at, source: at ? 'HCG call record (household)' : 'no call recorded for this household' };
}

// Rental per number from Twilio's own last complete month: total
// phonenumbers* price ÷ numbers billed. Derived from ACTUAL supplier
// figures; labelled as such.
function deriveRentalPerNumber(usageRecords) {
  const recs = (usageRecords || []).filter((r) => typeof r.category === 'string' && r.category.startsWith('phonenumbers'));
  const parent = recs.find((r) => r.category === 'phonenumbers' && Math.abs(Number(r.price)) > 0);
  const chosen = parent ? [parent] : recs.filter((r) => r.category !== 'phonenumbers');
  const price = chosen.reduce((s, r) => s + Math.abs(Number(r.price) || 0), 0);
  const count = chosen.reduce((s, r) => s + (Number(r.usage) || 0), 0);
  if (!price || !count) return null;
  const first = chosen[0];
  return {
    perNumber: Math.round((price / count) * 10000) / 10000,
    currency: String(first.priceUnit || 'gbp').toUpperCase(),
    provenance: 'ACTUAL',
    basis: `Twilio's own last-month rental: ${price.toFixed(2)} ${String(first.priceUnit || '').toUpperCase()} for ${count} number-months`,
  };
}

module.exports = { STATES, RECOMMENDATIONS, CATEGORIES, categoriseInventoryRow, maskNumber, describeLastCall, voiceHostEvidence, resolveProductionHosts, buildNumberInventory, deriveRentalPerNumber, normaliseNumber };
