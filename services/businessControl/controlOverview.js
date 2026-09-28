// Business control centre — the Overview: "Are we paying for anything we
// shouldn't be, and is every customer in the state they should be?"
//
// Thirteen headline cards. Each card's colour is derived from an explicit,
// displayed factual rule:
//   red   — a loose end exists (something is wrong now)
//   amber — something needs a decision/action but is within the normal
//           lifecycle, or information is missing
//   green — checked, and there is nothing to report
//   grey  — cannot be checked (source not connected / test data)
//   info  — a count, not a condition (no colour judgement)
// Nothing is hidden behind a colour: every card lists the households or
// numbers behind it.
// STRICTLY OBSERVATIONAL — reads only.
'use strict';

const { classifyHouseholdForBusiness } = require('./definitions');
const { buildNumberInventory, deriveRentalPerNumber, resolveProductionHosts } = require('./numberInventory');
const { detectHouseholdAnomalies } = require('./numberReconciliation');
const { parseTimestampMs } = require('../adminOnboardingStatus');

const HOUR_MS = 3600 * 1000;

function card(id, label, value, status, rule, extra = {}) {
  return { id, label, value, status, rule, sub: null, items: [], ...extra };
}

function fmtMoneyMap(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return '£0.00';
  return entries.map(([c, v]) => (c === 'GBP' ? '£' + Number(v).toFixed(2) : `${c} ${Number(v).toFixed(2)}`)).join(' + ');
}

// Pure.
function computeControlOverview({ households, entitlementsByHousehold, subscriptionsByHousehold, classificationMap, quarantineRows, inventory, stripeRevenue, releaseRecordingAvailable }, now) {
  const nowMs = now.getTime();
  const biz = (households || []).map((h) => ({
    household: h,
    ...classifyHouseholdForBusiness({
      household: h,
      entitlements: entitlementsByHousehold.get(h.id) || [],
      subscriptions: subscriptionsByHousehold.get(h.id) || [],
      classification: classificationMap.get(h.id),
    }, now),
  }));
  const live = biz.filter((b) => b.accountClass !== 'deleted');
  const ref = (b, detail) => ({ householdId: b.household.id, email: b.household.email || null, detail: detail || null });
  const cards = [];

  // 1. Genuine paying customers
  const genuinePaying = live.filter((b) => b.isGenuinePayingCustomer);
  const genuineFormer = live.filter((b) => b.isGenuine && b.formerPaying);
  cards.push(card('genuine_paying', 'Genuine paying customers (now)', genuinePaying.length, 'info',
    'Count only. Genuine = classified genuine customer; paying = current paid subscription. A customer who paid and then cancelled is a former paying customer, not a paying one.',
    { sub: `${live.filter((b) => b.isGenuine).length} genuine account(s) · ${genuinePaying.length + genuineFormer.length} ever paid · ${genuineFormer.length} former paying`,
      items: [...genuinePaying.map((b) => ref(b, 'paying now')), ...genuineFormer.map((b) => ref(b, `former paying · ${b.membership}`))] }));

  // 2. Non-customer / non-paying access
  const withAccess = live.filter((b) => b.membership === 'current' && !b.isGenuinePayingCustomer);
  const breakdown = {};
  for (const b of withAccess) {
    const key = b.accountClass === 'genuine' ? `genuine ${b.access}` : b.accountClass.replace('_', ' ');
    breakdown[key] = (breakdown[key] || 0) + 1;
  }
  const unclassifiedWithAccess = withAccess.filter((b) => b.accountClass === 'unclassified');
  cards.push(card('non_paying_access', 'Complimentary / internal / test / reviewer access', withAccess.length,
    unclassifiedWithAccess.length ? 'amber' : 'info',
    'Amber when any account with access is unclassified (it cannot be counted either way until classified).',
    { sub: Object.entries(breakdown).map(([k, n]) => `${n} ${k}`).join(' · ') || 'none', items: withAccess.map((b) => ref(b, `${b.accountClass} · ${b.access}`)) }));

  // 2b. Payment history that no figure counts: a paid membership was
  // recorded but the account is unclassified, so it is neither a genuine
  // (or former) paying customer nor a known test account.
  const paidUnclassified = live.filter((b) => b.everPaid && b.accountClass === 'unclassified');
  cards.push(card('paid_unclassified', 'Paid at some point, not classified', paidUnclassified.length,
    paidUnclassified.length ? 'amber' : 'green',
    'Amber when an account has a recorded paid membership (any status) but no classification. Until it is classified it is counted nowhere — this is how a real payer can be missing from "genuine paying customers".',
    { sub: paidUnclassified.length ? 'Classify as genuine customer or test/reviewer/admin' : 'Every account with payment history is classified',
      items: paidUnclassified.map((b) => ref(b, `${b.access === 'paid' ? 'paying now' : 'former paying · ' + b.membership} · ${b.paidSources.join('/')}`)) }));

  // 3. MRR — genuine customers only, from Stripe
  let mrrCard;
  if (!stripeRevenue || !stripeRevenue.available) {
    mrrCard = card('mrr', 'MRR — genuine customers', 'Not connected', 'grey', 'Grey when Stripe cannot be read.', { sub: stripeRevenue ? stripeRevenue.reason : 'Stripe not configured' });
  } else if (stripeRevenue.mode !== 'live') {
    mrrCard = card('mrr', 'MRR — genuine customers', `Stripe ${stripeRevenue.mode.toUpperCase()} mode`, 'grey',
      'Grey when the configured Stripe account is not in live mode: test figures are never shown as revenue.',
      { sub: 'This environment is reading a Stripe test account — no real revenue figures available here.' });
  } else {
    const m = stripeRevenue.mrr;
    const appleGenuinePaid = live.filter((b) => b.isGenuinePayingCustomer && b.currentEntitlement && b.currentEntitlement.source === 'apple_revenuecat').length;
    const col = stripeRevenue.collectedThisMonth || {};
    const unattributedSubs = m.unattributedSubscriptions || 0;
    const unattributedCharges = col.unattributedCharges || 0;
    const unattributed = unattributedSubs + unattributedCharges > 0;
    mrrCard = card('mrr', 'MRR — genuine customers', fmtMoneyMap(m.genuine), appleGenuinePaid || unattributed ? 'amber' : 'info',
      'From Stripe subscriptions of genuine customers only (never entitlement count × price). Amber when App Store subscriptions exist (revenue not connected), or when live Stripe subscriptions/payments belong to an unclassified account or to no household (real money no figure counts).',
      { sub: `${fmtMoneyMap(m.genuineExVat)} ex VAT · ${m.genuineSubscriptions} subscription(s) · collected this month ${fmtMoneyMap(col.genuine)}` +
          (m.excludedSubscriptions ? ` · ${m.excludedSubscriptions} non-genuine subscription(s) excluded` : '') +
          (unattributed ? ` · UNATTRIBUTED: ${unattributedSubs} subscription(s) ${fmtMoneyMap(m.unattributed)}/month, ${unattributedCharges} payment(s) ${fmtMoneyMap(col.unattributed)} this month — classify the account` : '') +
          (appleGenuinePaid ? ` · ${appleGenuinePaid} App Store subscription(s) NOT CONNECTED` : '') });
  }
  cards.push(mrrCard);

  // 4. Protected
  const protectedRows = live.filter((b) => b.protection === 'protected');
  cards.push(card('protected', 'Active protected households', protectedRows.length, 'info',
    'Count only. Protected = current membership + delivery confirmed + app registered (customer-facing definition).',
    { sub: `${protectedRows.filter((b) => b.isGenuine).length} genuine · ${protectedRows.filter((b) => !b.isGenuine).length} internal/test/reviewer/unclassified`, items: protectedRows.map((b) => ref(b, b.accountClass)) }));

  // 5. Entitled but not protected
  const notProtected = live.filter((b) => b.protection === 'entitled_not_protected');
  cards.push(card('entitled_not_protected', 'Entitled but NOT protected', notProtected.length, notProtected.length ? 'amber' : 'green',
    'Amber when any household with a current membership is not Protected. Details are in Customers.',
    { items: notProtected.map((b) => ref(b, `${b.accountClass} · ${b.access}${b.holdsNumber ? '' : ' · no number'}`)) }));

  // 6. Households with a number
  const withNumber = live.filter((b) => b.holdsNumber);
  cards.push(card('households_with_number', 'Households holding an HCG number', withNumber.length, 'info',
    'Count only (production households).',
    { sub: `${withNumber.filter((b) => b.membership === 'current' || b.membership === 'upcoming').length} with current/upcoming membership · ${withNumber.filter((b) => b.membership !== 'current' && b.membership !== 'upcoming').length} without`, items: withNumber.map((b) => ref(b, b.membership)) }));

  // 7. Active Twilio numbers
  if (!inventory) {
    cards.push(card('provider_numbers', 'Active Twilio numbers', 'Not connected', 'grey', 'Grey when the provider number list cannot be read.'));
  } else {
    const r = inventory.monthlyRental;
    cards.push(card('provider_numbers', 'Active Twilio numbers', inventory.providerNumberCount, 'info',
      'Count only — the provider\'s own list is authoritative for what HCG pays for.',
      { sub: r.perNumber !== null ? `≈ ${r.currency} ${Number(r.allNumbers).toFixed(2)}/month rental (${r.basis})` : 'Rental rate not available' }));
  }

  // 8. Numbers not mapped to an expected household
  if (inventory) {
    const unmapped = inventory.rows.filter((x) => ['orphan', 'staging_or_dev', 'marked_released_still_at_provider'].includes(x.state));
    const hard = unmapped.filter((x) => x.state !== 'staging_or_dev');
    const r = inventory.monthlyRental;
    cards.push(card('unmapped_numbers', 'Twilio numbers not mapped to an expected household', unmapped.length,
      hard.length ? 'red' : unmapped.length ? 'amber' : 'green',
      'Red for orphans or numbers HCG recorded as released that are still billed; amber when the only unmapped numbers are development/staging numbers.',
      { sub: `${inventory.rows.filter((x) => x.state === 'staging_or_dev').length} dev/staging · ${inventory.rows.filter((x) => x.state === 'orphan').length} orphan · ${inventory.rows.filter((x) => x.state === 'marked_released_still_at_provider').length} marked released` + (r.perNumber !== null ? ` · ≈ ${r.currency} ${(unmapped.length * r.perNumber).toFixed(2)}/month` : ''),
        items: unmapped.map((x) => ({ number: x.number, detail: x.whyExpected })) }));
  } else {
    cards.push(card('unmapped_numbers', 'Twilio numbers not mapped to an expected household', 'Not connected', 'grey', 'Grey when the provider number list cannot be read.'));
  }

  // 9. Cancelled/expired households still retaining a number
  const lapsedHolding = live.filter((b) => b.holdsNumber && b.membership !== 'current' && b.membership !== 'upcoming');
  const lapsedDetail = lapsedHolding.map((b) => {
    const pendingMs = parseTimestampMs(b.household.twilio_number_pending_release_at);
    const kind = pendingMs === null ? 'outside_lifecycle' : nowMs - pendingMs > 48 * HOUR_MS ? 'release_overdue' : 'grace_period';
    return { b, kind, pendingMs };
  });
  const lapsedBad = lapsedDetail.filter((x) => x.kind !== 'grace_period');
  cards.push(card('lapsed_retaining_number', 'Cancelled / expired households still holding a number', lapsedHolding.length,
    lapsedBad.length ? 'red' : lapsedHolding.length ? 'amber' : 'green',
    'Red when a lapsed household holds a number with no release scheduled, or its release is overdue (>48h); amber when all are within their scheduled grace period.',
    { sub: `${lapsedDetail.filter((x) => x.kind === 'grace_period').length} in grace period · ${lapsedDetail.filter((x) => x.kind === 'outside_lifecycle').length} no release scheduled · ${lapsedDetail.filter((x) => x.kind === 'release_overdue').length} release overdue`,
      items: lapsedDetail.map((x) => ref(x.b, `${x.b.membership} · ${x.kind.replace(/_/g, ' ')}${x.pendingMs !== null ? ' ' + new Date(x.pendingMs).toISOString().slice(0, 10) : ''}`)) }));

  // 10. Entitled households missing a number
  const missing = live.filter((b) => (b.membership === 'current') && !b.holdsNumber);
  const inProgress = missing.filter((b) => {
    const s = parseTimestampMs(b.currentEntitlement && b.currentEntitlement.starts_at);
    return b.household.twilio_provisioning_status !== 'failed' && s !== null && nowMs - s < HOUR_MS;
  });
  cards.push(card('entitled_missing_number', 'Entitled households missing a number', missing.length,
    missing.length > inProgress.length ? 'red' : missing.length ? 'amber' : 'green',
    'Red when a household with a current membership has had no number for over an hour (or provisioning failed); amber while provisioning is in its first hour.',
    { items: missing.map((b) => ref(b, `${b.accountClass} · ${b.access} · provisioning ${b.household.twilio_provisioning_status || 'unknown'}`)) }));

  // 11. Pending release / quarantine
  const pendingRelease = live.filter((b) => b.holdsNumber && b.household.twilio_number_pending_release_at);
  const openQ = (quarantineRows || []).filter((q) => !q.released_at);
  const awaiting = openQ.filter((q) => !q.deactivation_confirmed);
  const confirmedOverdue = openQ.filter((q) => q.deactivation_confirmed && (parseTimestampMs(q.deactivation_confirmed_at) || nowMs) < nowMs - 48 * HOUR_MS);
  cards.push(card('pending_release_quarantine', 'Numbers pending release / in quarantine', pendingRelease.length + openQ.length,
    confirmedOverdue.length ? 'red' : awaiting.length ? 'amber' : pendingRelease.length ? 'info' : 'green',
    'Amber when a quarantined number is waiting for your deactivation confirmation; red when a confirmed quarantine has not been released after 48h.',
    { sub: `${pendingRelease.length} release scheduled · ${awaiting.length} awaiting your confirmation · ${openQ.length - awaiting.length} confirmed`,
      items: [...pendingRelease.map((b) => ref(b, `release ${String(b.household.twilio_number_pending_release_at).slice(0, 10)}`)), ...openQ.map((q) => ({ number: q.twilio_number, detail: q.deactivation_confirmed ? 'confirmed, awaiting release' : 'awaiting deactivation confirmation' }))] }));

  // 12. Failed releases / unresolved lifecycle anomalies
  const anomalyRows = live
    .map((b) => ({ b, found: detectHouseholdAnomalies({ household: b.household, entitlements: entitlementsByHousehold.get(b.household.id) || [], quarantineRows: (quarantineRows || []).filter((q) => q.household_id === b.household.id) }, now).anomalies.filter((a) => a.severity === 'action') }))
    .filter((x) => x.found.length);
  const recordedFailures = live.filter((b) => b.household.twilio_release_last_error);
  // Count distinct problems: a household already counted for a lifecycle
  // anomaly or recorded failure is not counted again for its number.
  const countedHouseholds = new Set([...anomalyRows.map((x) => x.b.household.id), ...recordedFailures.map((b) => b.household.id)]);
  const inventoryRed = inventory ? inventory.rows.filter((x) => x.severity === 'red' && !(x.owner && countedHouseholds.has(x.owner.householdId))).length : 0;
  const total = countedHouseholds.size + inventoryRed;
  cards.push(card('lifecycle_anomalies', 'Failed releases / unresolved lifecycle anomalies', total,
    total ? 'red' : releaseRecordingAvailable ? 'green' : 'grey',
    'Red when any household or number has an unresolved lifecycle anomaly or a recorded release failure. Grey (not green) when there are none but release failures are not yet recorded anywhere.',
    { sub: `${countedHouseholds.size} household(s) · ${inventoryRed} further number(s) · ${releaseRecordingAvailable ? recordedFailures.length + ' recorded release failure(s)' : 'release failures not recorded yet (P0 migration pending)'}`,
      items: [...anomalyRows.map((x) => ref(x.b, x.found.map((a) => a.label).join('; '))), ...recordedFailures.map((b) => ref(b, 'recorded release failure: ' + String(b.household.twilio_release_last_error).slice(0, 120)))] }));

  const statuses = cards.map((c) => c.status);
  const overall = statuses.includes('red') ? 'red' : statuses.includes('amber') ? 'amber' : 'green';
  return {
    overall,
    incomplete: statuses.includes('grey'),
    counts: { red: statuses.filter((s) => s === 'red').length, amber: statuses.filter((s) => s === 'amber').length, green: statuses.filter((s) => s === 'green').length, grey: statuses.filter((s) => s === 'grey').length },
    cards,
  };
}

function resolveSupabaseAdmin() {
  try { return require('../supabaseClients').supabaseAdmin; } catch (err) { return null; }
}
function resolveTwilio() {
  try { return require('../twilioClient').twilioRestClient; } catch (err) { return null; }
}
function resolveStripe() {
  try { return require('../stripeClient').stripe; } catch (err) { return null; }
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows || []) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
}

const BASE_HOUSEHOLD_COLUMNS = 'id, email, created_at, stripe_customer_id, twilio_number, twilio_provisioning_status, twilio_number_pending_release_at, activation_verified_at, voice_client_registered_at, delivery_verified_at';
const RELEASE_COLUMNS = 'twilio_release_last_error, twilio_release_last_attempt_at, twilio_release_attempt_count';

// Read-only gather for the Overview and the number inventory.
async function getControlOverview(now = new Date()) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  const { getClassificationMap } = require('../businessMetrics/accountClassification');
  const { resolveVatRate } = require('../businessMetrics/config');
  const { getGenuineStripeRevenue } = require('./stripeRevenue');

  const releaseProbe = await supabaseAdmin.from('households').select(RELEASE_COLUMNS).limit(0);
  const releaseRecordingAvailable = !releaseProbe.error;
  const cols = BASE_HOUSEHOLD_COLUMNS + (releaseRecordingAvailable ? ', ' + RELEASE_COLUMNS : '');

  const [hRes, eRes, sRes, qRes, classification] = await Promise.all([
    supabaseAdmin.from('households').select(cols),
    supabaseAdmin.from('entitlements').select('household_id, entitlement_type, status, source, starts_at, ends_at, updated_at'),
    supabaseAdmin.from('subscriptions').select('household_id, status, cancel_at_period_end, updated_at'),
    supabaseAdmin.from('twilio_number_quarantine').select('id, household_id, twilio_number, release_reason, deactivation_confirmed, deactivation_confirmed_at, quarantined_at, released_at'),
    getClassificationMap(),
  ]);
  for (const r of [hRes, eRes, sRes, qRes]) if (r.error) return { available: false, reason: r.error.message };
  if (!classification.available) return { available: false, reason: classification.reason };

  const households = hRes.data || [];
  const entitlementsByHousehold = groupBy(eRes.data, 'household_id');
  const subscriptionsByHousehold = groupBy(sRes.data, 'household_id');

  // Provider inventory (read-only list + last month's rental records).
  let inventory = null;
  let inventoryReason = null;
  const twilio = resolveTwilio();
  if (twilio) {
    try {
      const [numbers, lastMonth] = await Promise.all([
        twilio.incomingPhoneNumbers.list({ limit: 1000 }),
        twilio.usage.records.lastMonth.list({ limit: 1000 }),
      ]);
      inventory = buildNumberInventory({
        providerNumbers: numbers.map((n) => ({ phoneNumber: n.phoneNumber, voiceUrl: n.voiceUrl, dateCreated: n.dateCreated })),
        households,
        entitlementsByHousehold,
        subscriptionsByHousehold,
        classificationMap: classification.map,
        quarantineRows: qRes.data || [],
        productionHosts: resolveProductionHosts(),
        rental: deriveRentalPerNumber(lastMonth),
        releaseRecordingAvailable,
      }, now);
    } catch (err) {
      inventoryReason = err.message;
    }
  } else {
    inventoryReason = 'Twilio credentials not configured';
  }

  // Genuine revenue from Stripe.
  const genuineByCustomer = new Map();
  const classByCustomer = new Map();
  for (const h of households) {
    if (!h.stripe_customer_id) continue;
    const cls = classification.map.get(h.id);
    if (cls === 'genuine_customer') genuineByCustomer.set(h.stripe_customer_id, h.id);
    classByCustomer.set(h.stripe_customer_id, cls === 'genuine_customer' ? 'genuine' : cls || 'unclassified');
  }
  const stripeRevenue = await getGenuineStripeRevenue({ stripe: resolveStripe(), genuineByCustomer, classByCustomer, vatRate: resolveVatRate(), now });

  return {
    available: true,
    generatedAt: now.toISOString(),
    ...computeControlOverview({ households, entitlementsByHousehold, subscriptionsByHousehold, classificationMap: classification.map, quarantineRows: qRes.data || [], inventory, stripeRevenue, releaseRecordingAvailable }, now),
    inventory,
    inventoryReason,
    stripe: stripeRevenue.available ? { mode: stripeRevenue.mode, mrr: stripeRevenue.mrr, collectedThisMonth: stripeRevenue.collectedThisMonth, vatRate: stripeRevenue.vatRate } : { mode: 'unavailable', reason: stripeRevenue.reason },
  };
}

module.exports = { computeControlOverview, getControlOverview };
