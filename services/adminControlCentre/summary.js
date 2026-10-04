// Admin Control Centre summary (admin redesign, 2026-10-04). READ-ONLY, pure.
//
// The founder-facing answers on the redesigned Overview and Customers tabs:
// how many genuine customers, how many are protected, who needs attention,
// what happened recently. This module INVENTS NO DEFINITION. It composes the
// canonical integrated ones and only adds admin wording:
//
//   genuine paying     services/commercial/commercialStatus.js
//                      classifyCommercialStatus (the ONE genuine-paying rule)
//   protected          services/lifecycle/activationState.js via
//                      exceptionQueue.householdExceptions (every gate in
//                      PROTECTION_GATES; fail closed)
//   needs attention    services/lifecycle/exceptionQueue.js items, plus the
//                      canonical ops-event detector's needs-attention reasons
//                      (services/opsEvents/detector.js)
//
// One admin-only rule is added on top of the canonical stage, and is labelled
// as such: CALLS_ARRIVING_APP_NOT_REGISTERED — a GENUINE paying customer whose
// forwarded calls already reach HCG (activation_verified_at is stamped by
// /voice) while the canonical stage is awaiting_app. Calls are being missed
// NOW, so it is raised immediately rather than after the 24h SETUP_STALLED
// window (the September 2026 incident: forwarding worked, the app never
// registered, nine real calls went unanswered).
//
// Identity: the permanent HCG account number (households.account_number,
// migration 062) is the support reference. Twilio/routing numbers are never
// used as identity and are masked to the last three digits in every string
// this module returns.
'use strict';

const { STAGES } = require('../lifecycle/activationState');
const { householdExceptions, buildExceptionQueue, currentEntitlementOf, EXCEPTIONS } = require('../lifecycle/exceptionQueue');
const { classifyCommercialStatus, STATUS, TEST_CLASSIFICATIONS } = require('../commercial/commercialStatus');
const { detectOpsEvents } = require('../opsEvents/detector');
const { parseTimestampMs } = require('../numberLifecycle/state');

const DAY_MS = 24 * 3600 * 1000;
const RECENT_WINDOW_MS = 7 * DAY_MS;

// Admin display segments. Each is a direct mapping of the canonical
// commercial status (plus the account's own classification for the
// reviewer/test split, and payment history for "former customer").
const SEGMENTS = Object.freeze({
  genuine_paying: { label: 'Genuine paying', revenue: true },
  complimentary: { label: 'Complimentary', revenue: false },
  trial: { label: 'Trial', revenue: false },
  internal_test: { label: 'Internal / test', revenue: false },
  reviewer: { label: 'Reviewer', revenue: false },
  sandbox: { label: 'Sandbox', revenue: false },
  payment_unverified: { label: 'Payment environment unverified', revenue: false },
  former_customer: { label: 'Former customer', revenue: false },
  no_membership: { label: 'Signed up, never a member', revenue: false },
  deleted: { label: 'Deleted account', revenue: false },
});

// Admin wording for the canonical activation stages. Tone drives colour only.
const STAGE_DISPLAY = Object.freeze({
  [STAGES.PROTECTED]: { label: 'Protected', tone: 'good' },
  [STAGES.AWAITING_NUMBER]: { label: 'Waiting for HCG number', tone: 'setup' },
  [STAGES.AWAITING_FORWARDING]: { label: 'Waiting for call forwarding', tone: 'setup' },
  [STAGES.AWAITING_APP]: { label: 'App not registered', tone: 'setup' },
  [STAGES.AWAITING_FIRST_DELIVERY]: { label: 'Waiting for first protected call', tone: 'setup' },
  [STAGES.MEMBERSHIP_UPCOMING]: { label: 'Membership starts soon', tone: 'setup' },
  [STAGES.RECONNECT_NEEDED]: { label: 'App offline — reconnect needed', tone: 'bad' },
  [STAGES.NUMBER_FAILED]: { label: 'HCG number could not be set up', tone: 'bad' },
  [STAGES.NUMBER_CONFLICT]: { label: 'HCG number quarantined while paid', tone: 'bad' },
  [STAGES.ON_HOLD]: { label: 'On financial hold', tone: 'bad' },
  [STAGES.AMBIGUOUS]: { label: 'State unclear — check', tone: 'bad' },
  [STAGES.MEMBERSHIP_ENDED]: { label: 'Membership ended', tone: 'muted' },
  [STAGES.SIGNED_UP]: { label: 'Signed up — not a member', tone: 'muted' },
  [STAGES.ACCOUNT_DELETED]: { label: 'Account deleted', tone: 'muted' },
});

// Plain English for the canonical protection gates (first blocker first).
const BLOCKER_TEXT = Object.freeze({
  accountActive: 'Account deleted',
  stateKnown: 'Billing or number state could not be read',
  entitledNow: 'No current membership',
  notOnHold: 'On a financial hold',
  numberActive: 'No active HCG number',
  numberNotQuarantined: 'HCG number is in quarantine',
  forwardingVerifiedForCurrentNumber: 'Call forwarding to the current HCG number not confirmed',
  appReachable: 'App not registered for calls',
  deliveryVerifiedForCurrentNumber: 'No protected call delivered yet',
});

// Plain-English titles for the canonical exception codes. The canonical
// recommendedAction text is kept alongside as the "next step".
const ATTENTION_TITLES = Object.freeze({
  CALLS_ARRIVING_APP_NOT_REGISTERED: 'Paying customer is missing calls — app not registered',
  SETUP_STALLED: 'Paying customer not protected after 24 hours',
  PROTECTION_LOST: 'Customer lost protection — app offline',
  NUMBER_PROVISIONING_FAILED: 'Customer has no HCG number',
  NUMBER_CONFLICT: 'Customer’s HCG number is quarantined while they are paying',
  HOUSEHOLD_ON_HOLD: 'Customer on a financial hold',
  LIFECYCLE_STATE_AMBIGUOUS: 'Customer state could not be read',
  PAYMENT_ISSUE: 'Payment problem',
  PAYMENT_ENVIRONMENT_UNVERIFIED: 'Store purchase not verified as real money',
  STORE_SANDBOX_HOLDS_NUMBER: 'Sandbox/TestFlight account holds a billed number',
  FIRST_DELIVERY_UNCONFIRMED_LONG: 'No protected call confirmed for a week',
  EVIDENCE_PREDATES_CURRENT_NUMBER: 'Customer must re-dial forwarding for their new number',
  RETURNING_CUSTOMER_OLD_NUMBER_QUARANTINED: 'Old number still quarantined (and billed)',
  QUARANTINE_WITHOUT_HOUSEHOLD: 'Quarantined number with no customer',
  STRIPE_EVENT_FAILED: 'A Stripe event failed to process',
  STRIPE_EVENT_FOR_DELETED_HOUSEHOLD: 'Old Stripe failure for a deleted account',
  DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE: 'Deleted account may still be paying',
  ACCOUNT_DELETED_NUMBER_RETAINED: 'Deleted account still holds a number',
  PROVISIONING_FAILED: 'Number provisioning failed',
  ENTITLED_WITHOUT_NUMBER: 'Member without an HCG number',
  ENTITLED_PENDING_RELEASE: 'Member’s number is scheduled for release',
  NUMBER_RETAINED_NO_ENTITLEMENT: 'Number kept with no membership',
  RELEASE_OVERDUE: 'Number release overdue',
  QUARANTINE_AWAITING_CONFIRMATION: 'Number awaiting release confirmation',
  QUARANTINE_AWAITING_CONFIRMATION_LONG: 'Number awaiting release confirmation for 45+ days',
  QUARANTINE_RELEASE_STUCK: 'Confirmed number release has not happened',
  QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD: 'Member’s number is quarantined',
  RECORDED_RELEASE_FAILURE: 'Number release failed at the provider',
});

// Where an attention item belongs, for the founder-facing status rows.
const AREA_OF = Object.freeze({
  CALLS_ARRIVING_APP_NOT_REGISTERED: 'protection', SETUP_STALLED: 'protection', PROTECTION_LOST: 'protection',
  NUMBER_PROVISIONING_FAILED: 'telephony', NUMBER_CONFLICT: 'telephony', LIFECYCLE_STATE_AMBIGUOUS: 'protection',
  FIRST_DELIVERY_UNCONFIRMED_LONG: 'protection', EVIDENCE_PREDATES_CURRENT_NUMBER: 'protection',
  HOUSEHOLD_ON_HOLD: 'financial', PAYMENT_ISSUE: 'payments', PAYMENT_ENVIRONMENT_UNVERIFIED: 'payments',
  STRIPE_EVENT_FAILED: 'payments', STRIPE_EVENT_FOR_DELETED_HOUSEHOLD: 'payments', DELETED_HOUSEHOLD_SUBSCRIPTION_LIVE: 'payments',
});
const areaOf = (code) => AREA_OF[code] || 'numbers';

const SEVERITY_RANK = { critical: 0, action: 1, watch: 2 };

// Never return a full telephone number: E.164 / long digit runs → last 3.
function maskNumbers(text) {
  if (text === null || text === undefined) return null;
  return String(text).replace(/\+?\d[\d\s]{8,}\d/g, (m) => '•••' + m.replace(/\D/g, '').slice(-3));
}

function isoOrNull(value) {
  const ms = parseTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function segmentOf({ commercial, activation, snapshot }) {
  if (activation.stage === STAGES.ACCOUNT_DELETED) return 'deleted';
  const s = commercial.status;
  if (s === STATUS.GENUINE_PAYING) return 'genuine_paying';
  if (s === STATUS.INTERNAL_OR_TEST) return commercial.testClassification === 'reviewer' ? 'reviewer' : 'internal_test';
  if (s === STATUS.STORE_SANDBOX || s === STATUS.STRIPE_TEST) return 'sandbox';
  if (s === STATUS.STORE_ENVIRONMENT_UNVERIFIED) return 'payment_unverified';
  if (s === STATUS.COMPLIMENTARY) return 'complimentary';
  if (s === STATUS.TRIAL) return 'trial';
  // No current membership. A test-classified account stays a test account;
  // a former customer is one whose PAST paid entitlement the canonical
  // classifier would have counted as genuine paying.
  const classification = snapshot.classification || null;
  if (TEST_CLASSIFICATIONS.has(classification)) return classification === 'reviewer' ? 'reviewer' : 'internal_test';
  const everGenuine = (snapshot.entitlements || []).some((e) => e && e.entitlement_type === 'paid_subscription'
    && classifyCommercialStatus({ currentEntitlement: e, classification }).genuinePaying);
  return everGenuine ? 'former_customer' : 'no_membership';
}

function firstPaidOrGrantedAt(entitlements) {
  const starts = (entitlements || []).map((e) => parseTimestampMs(e && e.starts_at)).filter((ms) => ms !== null).sort((a, b) => a - b);
  return starts.length ? new Date(starts[0]).toISOString() : null;
}

// The customer journey, in the canonical order. "Protected now" is the
// current-state step: it is true only when EVERY canonical gate holds.
function buildJourney({ household: h, entitlements, currentNumberAssignedAt }, activation, segment) {
  const g = activation.gates;
  const isPaid = segment === 'genuine_paying' || segment === 'former_customer';
  const steps = [
    { key: 'joined', label: 'Joined', done: true, at: isoOrNull(h.created_at) },
    { key: 'paid', label: isPaid ? 'Paid' : 'Membership granted', done: (entitlements || []).length > 0, at: firstPaidOrGrantedAt(entitlements) },
    { key: 'number_ready', label: 'HCG number ready', done: g.numberActive === true, at: g.numberActive ? isoOrNull(currentNumberAssignedAt || h.twilio_provisioning_updated_at) : null },
    { key: 'app_registered', label: 'App registered', done: g.appReachable === true, at: isoOrNull(h.voice_client_registered_at) },
    { key: 'forwarding_confirmed', label: 'Call forwarding confirmed', done: g.forwardingVerifiedForCurrentNumber === true, at: isoOrNull(h.activation_verified_at) },
    { key: 'first_protected_call', label: 'First protected call', done: g.deliveryVerifiedForCurrentNumber === true, at: isoOrNull(h.delivery_verified_at) },
    { key: 'protected_now', label: 'Protected now', done: activation.protected === true, at: null },
  ];
  const first = steps.findIndex((s) => !s.done);
  if (first !== -1) steps[first].firstIncomplete = true;
  return steps;
}

// Raw detail codes from the canonical queue, said in words.
const DETAIL_WORDS = Object.freeze({ apple: 'Apple App Store', google: 'Google Play', web_stripe: 'Web (Stripe)', past_due: 'Stripe: payment past due', unpaid: 'Stripe: payment unpaid' });

function attentionItem(code, severity, { householdId = null, accountNumber = null, segment = null, detail = null, since = null, nextStep = null } = {}) {
  if (detail !== null && detail !== undefined && DETAIL_WORDS[detail]) detail = DETAIL_WORDS[detail];
  return {
    code,
    severity,
    area: areaOf(code),
    title: ATTENTION_TITLES[code] || code.replace(/_/g, ' ').toLowerCase(),
    nextStep: maskNumbers(nextStep || (EXCEPTIONS[code] && EXCEPTIONS[code].action) || null),
    detail: maskNumbers(detail),
    householdId,
    accountNumber,
    segment,
    genuine: segment === 'genuine_paying',
    since: isoOrNull(since),
  };
}

function recentEventsFor({ household: h, entitlements, quarantineRows }, activation, segment, accountNumber, nowMs) {
  const genuine = segment === 'genuine_paying';
  const within = (iso) => {
    const ms = parseTimestampMs(iso);
    return ms !== null && ms <= nowMs && nowMs - ms <= RECENT_WINDOW_MS ? new Date(ms).toISOString() : null;
  };
  const base = { householdId: h.id, accountNumber, segment, genuine };
  const out = [];
  // A genuine customer is announced once, when they paid (below); other
  // sign-ups are listed plainly and never celebrated.
  const joined = within(h.created_at);
  if (joined && !genuine) out.push({ ...base, at: joined, type: 'signed_up', title: `Sign-up — ${SEGMENTS[segment].label}` });
  const paid = (entitlements || []).filter((e) => e && e.entitlement_type === 'paid_subscription').map((e) => within(e.starts_at)).filter(Boolean).sort()[0];
  if (paid && genuine) out.push({ ...base, at: paid, type: 'new_genuine_customer', title: 'NEW GENUINE CUSTOMER', celebrate: true });
  const number = activation.gates.numberActive ? within(h.twilio_provisioning_updated_at) : null;
  if (number) out.push({ ...base, at: number, type: 'number_ready', title: 'HCG number provisioned' });
  const fwd = within(h.activation_verified_at);
  if (fwd) out.push({ ...base, at: fwd, type: 'forwarding_confirmed', title: 'Call forwarding confirmed' });
  const delivered = within(h.delivery_verified_at);
  if (delivered) {
    out.push({ ...base, at: delivered, type: 'first_protected_call', title: 'First protected call delivered' });
    if (activation.protected) out.push({ ...base, at: delivered, type: 'customer_protected', title: genuine ? 'CUSTOMER PROTECTED' : 'Account protected', celebrate: genuine });
  }
  if (activation.stage === STAGES.MEMBERSHIP_ENDED) {
    const ended = (entitlements || []).map((e) => within(e && e.ends_at)).filter(Boolean).sort().pop();
    if (ended) out.push({ ...base, at: ended, type: 'membership_ended', title: genuine || segment === 'former_customer' ? 'Customer cancelled / membership ended' : 'Membership ended' });
  }
  for (const q of quarantineRows || []) {
    const at = within(q.quarantined_at);
    if (at) out.push({ ...base, at, type: 'number_quarantined', title: 'Number moved to quarantine (awaiting release)' });
  }
  return out;
}

/**
 * @param {object} input
 * @param {object[]} input.snapshots              database/lifecycleSnapshot.js snapshots
 * @param {object[]} [input.orphanQuarantineRows]
 * @param {Date|number} now
 */
function buildControlCentreSummary({ snapshots = [], orphanQuarantineRows = [] } = {}, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const customers = [];
  const attention = [];
  const activity = [];

  for (const snapshot of snapshots) {
    const h = snapshot.household;
    if (!h) continue;
    const { activation, items } = householdExceptions(snapshot, now);
    const commercial = classifyCommercialStatus({ currentEntitlement: currentEntitlementOf(snapshot.entitlements, nowMs), classification: snapshot.classification || null });
    const segment = segmentOf({ commercial, activation, snapshot });
    const accountNumber = h.account_number || null;
    const ctx = { householdId: h.id, accountNumber, segment };

    const hAttention = items
      // "Watch" items about a non-genuine account's own setup are noise for
      // the founder; number/money watch items (e.g. a number awaiting release
      // confirmation) are kept whoever holds the number.
      .filter((i) => i.severity !== 'watch' || segment === 'genuine_paying' || areaOf(i.code) !== 'protection')
      .map((i) => attentionItem(i.code, i.severity, { ...ctx, detail: i.detail, since: i.since, nextStep: i.recommendedAction }));
    // Supersedes the generic SETUP_STALLED for the same household: the
    // specific cause (calls arriving, app not registered) is what to fix.
    if (segment === 'genuine_paying' && activation.stage === STAGES.AWAITING_APP && h.activation_verified_at) {
      const stalled = hAttention.findIndex((a) => a.code === 'SETUP_STALLED');
      if (stalled !== -1) hAttention.splice(stalled, 1);
      hAttention.unshift(attentionItem('CALLS_ARRIVING_APP_NOT_REGISTERED', 'critical', {
        ...ctx, since: h.activation_verified_at,
        detail: 'Forwarded calls reach HCG but cannot ring the customer’s phone',
        nextStep: 'Contact the customer today: open the Home Call Guard app and allow notifications so it registers. Check the app version in diagnostics.',
      }));
    }
    // A genuine customer the canonical ops-event detector flags but the
    // exception queue does not (e.g. a loss reason) is never dropped.
    const { events: opsSignals } = detectOpsEvents(snapshot, now);
    const needsAttentionSignal = opsSignals.find((e) => e.event_type === 'customer_needs_attention');
    if (segment === 'genuine_paying' && needsAttentionSignal && hAttention.length === 0) {
      hAttention.push(attentionItem('SETUP_STALLED', 'action', { ...ctx, detail: `reason: ${needsAttentionSignal.payload.reason || 'unknown'}` }));
    }
    attention.push(...hAttention);

    const stage = STAGE_DISPLAY[activation.stage] || { label: activation.stage, tone: 'muted' };
    customers.push({
      householdId: h.id,
      accountNumber,
      segment,
      segmentLabel: SEGMENTS[segment].label,
      commercial: { status: commercial.status, label: commercial.label, genuinePaying: commercial.genuinePaying, channel: commercial.channel },
      protection: {
        stage: activation.stage,
        label: stage.label,
        tone: stage.tone,
        protected: activation.protected,
        blockers: activation.blockers.map((b) => ({ gate: b, text: BLOCKER_TEXT[b] || b })),
        billingStanding: activation.billingStanding,
      },
      journey: buildJourney(snapshot, activation, segment),
      setupDone: null,
      attention: hAttention.map((a) => ({ code: a.code, severity: a.severity, title: a.title })),
    });
    const last = customers[customers.length - 1];
    last.setupDone = last.journey.filter((s) => s.done && s.key !== 'joined' && s.key !== 'protected_now').length;

    activity.push(...recentEventsFor(snapshot, activation, segment, accountNumber, nowMs));
  }

  // Orphan quarantine rows come from the queue (no household to attach to).
  const queue = buildExceptionQueue({ snapshots: [], orphanQuarantineRows }, now);
  attention.push(...queue.items.map((i) => attentionItem(i.code, i.severity, { detail: i.detail, since: i.since, nextStep: i.recommendedAction })));

  attention.sort((a, b) => (Number(b.genuine) - Number(a.genuine))
    || (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    || String(a.since || '').localeCompare(String(b.since || '')));
  activity.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const bySegment = Object.fromEntries(Object.keys(SEGMENTS).map((k) => [k, 0]));
  for (const c of customers) bySegment[c.segment] += 1;
  const genuine = customers.filter((c) => c.segment === 'genuine_paying');
  const genuineNeedingAttention = new Set(attention.filter((a) => a.genuine && a.severity !== 'watch').map((a) => a.householdId));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    label: 'read-only — canonical definitions: commercialStatus (genuine), activationState (protected), exceptionQueue (attention)',
    headline: {
      genuineCustomers: genuine.length,
      genuineProtected: genuine.filter((c) => c.protection.protected).length,
      genuineSettingUp: genuine.filter((c) => !c.protection.protected && !genuineNeedingAttention.has(c.householdId)).length,
      genuineNeedingAttention: genuineNeedingAttention.size,
      attentionItems: attention.filter((a) => a.severity !== 'watch').length,
      bySegment,
    },
    customers,
    attention,
    activity: activity.slice(0, 50),
    segments: SEGMENTS,
    identity: { accountNumbersAssigned: customers.filter((c) => c.accountNumber).length, households: customers.length },
  };
}

module.exports = { buildControlCentreSummary, maskNumbers, SEGMENTS, STAGE_DISPLAY, BLOCKER_TEXT, ATTENTION_TITLES, RECENT_WINDOW_MS };
