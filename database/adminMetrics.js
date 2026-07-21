const { supabaseAdmin } = require("../services/supabaseClients");
const { stripe } = require("../services/stripeClient");

// Cached in-process: the price of the one product this app sells changes
// rarely, and fetching it from Stripe on every dashboard load would add
// latency for no benefit. Cleared implicitly on process restart, which is
// the only time a price change would need picking up anyway (deploys
// already restart the process).
let cachedPrice = null;

async function getSubscriptionPrice() {
  if (cachedPrice) return cachedPrice;
  if (!stripe || !process.env.STRIPE_PRICE_ID) return null;

  try {
    const price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID);
    cachedPrice = { unitAmount: price.unit_amount, currency: price.currency };
    return cachedPrice;
  } catch (err) {
    console.error("ADMIN METRICS: STRIPE PRICE FETCH ERROR:", err.message);
    return null;
  }
}

// Merges two different real event sources (a household's own creation,
// and its subscriptions' status changes) into one timeline, since this
// project has no single dedicated activity/audit-log table. Pure so the
// merge/sort logic is unit-testable without a database.
function mergeCustomerActivity({ households, subscriptions }, limit) {
  const signupEvents = households.map(h => ({
    type: "signup",
    householdId: h.id,
    email: h.email,
    at: h.created_at,
  }));

  const subscriptionEvents = subscriptions.map(s => ({
    type: "subscription_" + s.status,
    householdId: s.household_id,
    email: s.households ? s.households.email : null,
    at: s.updated_at,
  }));

  return [...signupEvents, ...subscriptionEvents]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

async function getRecentCustomerActivity(limit = 15) {
  if (!supabaseAdmin) return [];

  const [{ data: households, error: hErr }, { data: subscriptions, error: sErr }] = await Promise.all([
    supabaseAdmin
      .from("households")
      .select("id, email, created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    supabaseAdmin
      .from("subscriptions")
      .select("household_id, status, updated_at, households(email)")
      .order("updated_at", { ascending: false })
      .limit(limit),
  ]);

  if (hErr) console.error("ADMIN METRICS: HOUSEHOLDS ACTIVITY READ ERROR:", hErr.message);
  if (sErr) console.error("ADMIN METRICS: SUBSCRIPTIONS ACTIVITY READ ERROR:", sErr.message);

  return mergeCustomerActivity({ households: households || [], subscriptions: subscriptions || [] }, limit);
}

async function getRecentCallsAcrossHouseholds(limit = 20) {
  if (!supabaseAdmin) return [];

  const { data: calls, error: callsError } = await supabaseAdmin
    .from("calls")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (callsError) {
    console.error("ADMIN METRICS: RECENT CALLS READ ERROR:", callsError.message);
    return [];
  }

  const householdIds = [...new Set((calls || []).map(c => c.household_id).filter(Boolean))];
  let emailByHouseholdId = {};

  if (householdIds.length > 0) {
    const { data: households, error: householdsError } = await supabaseAdmin
      .from("households")
      .select("id, email")
      .in("id", householdIds);

    if (householdsError) {
      console.error("ADMIN METRICS: RECENT CALLS HOUSEHOLD LOOKUP ERROR:", householdsError.message);
    } else {
      emailByHouseholdId = Object.fromEntries((households || []).map(h => [h.id, h.email]));
    }
  }

  return (calls || []).map(c => ({
    number: c.number,
    status: c.status,
    result: c.result,
    time: c.created_at,
    householdEmail: c.household_id ? emailByHouseholdId[c.household_id] || null : null,
  }));
}

// Pure — merges failed-provisioning households and failed webhook events
// into one alerts feed, sorted most-recent-first.
function mergeAlerts({ failedHouseholds, failedWebhookEvents }) {
  const provisioningAlerts = failedHouseholds.map(h => ({
    type: "provisioning_failed",
    severity: "high",
    householdId: h.id,
    email: h.email,
    message: h.twilio_provisioning_last_error || "Twilio number provisioning failed",
    at: h.twilio_provisioning_updated_at,
  }));

  const webhookAlerts = failedWebhookEvents.map(e => ({
    type: "webhook_failed",
    severity: "medium",
    householdId: e.household_id,
    email: null,
    message: `${e.event_type}: ${e.error || "processing failed"}`,
    at: e.received_at,
  }));

  return [...provisioningAlerts, ...webhookAlerts].sort((a, b) => new Date(b.at) - new Date(a.at));
}

async function getAlerts(limit = 20) {
  if (!supabaseAdmin) return [];

  const [{ data: failedHouseholds, error: hErr }, { data: failedWebhookEvents, error: wErr }] = await Promise.all([
    supabaseAdmin
      .from("households")
      .select("id, email, twilio_provisioning_last_error, twilio_provisioning_updated_at")
      .eq("twilio_provisioning_status", "failed"),
    supabaseAdmin
      .from("stripe_webhook_events")
      .select("household_id, event_type, error, received_at")
      .eq("status", "failed")
      .order("received_at", { ascending: false })
      .limit(limit),
  ]);

  if (hErr) console.error("ADMIN METRICS: ALERTS HOUSEHOLDS READ ERROR:", hErr.message);
  if (wErr) console.error("ADMIN METRICS: ALERTS WEBHOOK EVENTS READ ERROR:", wErr.message);

  return mergeAlerts({
    failedHouseholds: failedHouseholds || [],
    failedWebhookEvents: failedWebhookEvents || [],
  }).slice(0, limit);
}

// Pure — the Business overview section's derived numbers, split out from
// getBusinessOverview() so it's directly unit-testable without a database
// or Stripe call, same convention as computeKpiSummary above.
function computeBusinessOverview({
  totalCustomers,
  activeProtectedHouseholds,
  newCustomersThisWeek,
  activeEntitlements,
  failedPayments,
  price,
}) {
  const mrr =
    price && typeof price.unitAmount === "number"
      ? { amount: (activeEntitlements * price.unitAmount) / 100, currency: price.currency, available: true }
      : { amount: null, currency: null, available: false };

  return {
    totalCustomers,
    activeProtectedHouseholds,
    newCustomersThisWeek,
    mrr,
    failedPayments,
  };
}

// Monday 00:00 in server-local time — a fixed, deterministic definition of
// "this week" so the count doesn't silently shift with time-of-day.
function startOfThisWeek(now = new Date()) {
  const date = new Date(now);
  const day = date.getDay();
  const diffToMonday = (day + 6) % 7;
  date.setDate(date.getDate() - diffToMonday);
  date.setHours(0, 0, 0, 0);
  return date;
}

async function getBusinessOverview() {
  if (!supabaseAdmin) {
    return computeBusinessOverview({
      totalCustomers: 0,
      activeProtectedHouseholds: 0,
      newCustomersThisWeek: 0,
      activeEntitlements: 0,
      failedPayments: 0,
      price: null,
    });
  }

  const [
    { count: totalCustomers },
    { count: activeProtectedHouseholds },
    { count: newCustomersThisWeek },
    { count: activeEntitlements },
    { count: failedPayments },
    price,
  ] = await Promise.all([
    supabaseAdmin.from("households").select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("households")
      .select("id", { count: "exact", head: true })
      .eq("twilio_provisioning_status", "active")
      .not("twilio_number", "is", null),
    supabaseAdmin
      .from("households")
      .select("id", { count: "exact", head: true })
      .gte("created_at", startOfThisWeek().toISOString()),
    supabaseAdmin.from("entitlements").select("id", { count: "exact", head: true }).eq("status", "active"),
    // "Failed payments" — this app stores no separate payment/invoice
    // table, so the real available signal is a subscription Stripe itself
    // has marked past_due or unpaid (a payment attempt that failed and is
    // in dunning, or is exhausted). Not the same as a webhook processing
    // failure (see mergeAlerts) — that's this app failing to record an
    // event, not Stripe failing to charge a card.
    supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).in("status", ["past_due", "unpaid"]),
    getSubscriptionPrice(),
  ]);

  return computeBusinessOverview({
    totalCustomers: totalCustomers || 0,
    activeProtectedHouseholds: activeProtectedHouseholds || 0,
    newCustomersThisWeek: newCustomersThisWeek || 0,
    activeEntitlements: activeEntitlements || 0,
    failedPayments: failedPayments || 0,
    price,
  });
}

// Pure — protection rate as a percentage, rounded to one decimal. Returns
// null (not 0) when no calls were processed at all, so the UI can show
// "no calls yet" rather than a misleading 0%.
function computeProtectionRate(blocked, processed) {
  if (!processed) return null;
  return Math.round((blocked / processed) * 1000) / 10;
}

// Pure — takes the raw today's-call counts, computes the Protection
// activity section's shape.
function computeProtectionActivity({ callsProcessedToday, callsBlockedToday, callsAllowedToday, unknownChallengedToday }) {
  return {
    callsProcessedToday,
    callsBlockedToday,
    callsAllowedToday,
    unknownChallengedToday,
    protectionRate: computeProtectionRate(callsBlockedToday, callsProcessedToday),
  };
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

async function getProtectionActivityToday() {
  if (!supabaseAdmin) {
    return computeProtectionActivity({
      callsProcessedToday: 0,
      callsBlockedToday: 0,
      callsAllowedToday: 0,
      unknownChallengedToday: 0,
    });
  }

  const todayIso = startOfToday().toISOString();

  const [
    { count: callsProcessedToday },
    { count: callsBlockedToday },
    { count: callsAllowedToday },
    { count: unknownChallengedToday },
  ] = await Promise.all([
    supabaseAdmin.from("calls").select("id", { count: "exact", head: true }).gte("created_at", todayIso),
    supabaseAdmin.from("calls").select("id", { count: "exact", head: true }).gte("created_at", todayIso).eq("result", "SCAM"),
    supabaseAdmin.from("calls").select("id", { count: "exact", head: true }).gte("created_at", todayIso).eq("result", "SAFE"),
    supabaseAdmin.from("calls").select("id", { count: "exact", head: true }).gte("created_at", todayIso).eq("status", "Unknown"),
  ]);

  return computeProtectionActivity({
    callsProcessedToday: callsProcessedToday || 0,
    callsBlockedToday: callsBlockedToday || 0,
    callsAllowedToday: callsAllowedToday || 0,
    unknownChallengedToday: unknownChallengedToday || 0,
  });
}

// Pure — reduces a raw subscriptions read (possibly many historical rows
// per household) down to one status per household (its most recent row),
// then counts by status. Split out so the "one row per household" rule is
// independently testable.
function computeSubscriptionStatusBreakdown(subscriptions) {
  const latestByHousehold = new Map();

  for (const s of subscriptions) {
    const existing = latestByHousehold.get(s.household_id);
    if (!existing || new Date(s.updated_at) > new Date(existing.updated_at)) {
      latestByHousehold.set(s.household_id, s);
    }
  }

  const counts = {};
  for (const s of latestByHousehold.values()) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}

async function getSubscriptionStatusBreakdown() {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin.from("subscriptions").select("household_id, status, updated_at");

  if (error) {
    console.error("ADMIN METRICS: SUBSCRIPTION STATUS BREAKDOWN READ ERROR:", error.message);
    return [];
  }

  return computeSubscriptionStatusBreakdown(data || []);
}

// Pure — counts households by twilio_provisioning_status.
function computeProvisioningStatusBreakdown(households) {
  const counts = {};
  for (const h of households) {
    counts[h.twilio_provisioning_status] = (counts[h.twilio_provisioning_status] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}

async function getProvisioningStatusBreakdown() {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin.from("households").select("twilio_provisioning_status");

  if (error) {
    console.error("ADMIN METRICS: PROVISIONING STATUS BREAKDOWN READ ERROR:", error.message);
    return [];
  }

  return computeProvisioningStatusBreakdown(data || []);
}

// Pure — the Launch readiness section's overall status, derived from the
// same items list services/launchReadiness.js already provides. A single
// open 'blocker' makes the whole launch not-ready, regardless of how many
// lower-severity items also remain — matching how docs/launch/KNOWN_ISSUES.md
// itself is ordered (blockers first, everything else is "should fix").
function computeReadinessSummary(items) {
  const blockers = items.filter(i => i.severity === "blocker");
  const openCount = items.filter(i => i.status !== "done").length;

  const status = blockers.length > 0 ? "not_ready" : openCount > 0 ? "ready_with_open_items" : "ready";

  return {
    status,
    blockersCount: blockers.length,
    openCount,
    totalCount: items.length,
  };
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function searchCustomers(query) {
  if (!supabaseAdmin || !query || !query.trim()) return [];

  const trimmed = query.trim();
  let queryBuilder = supabaseAdmin.from("households").select("*").limit(25);

  if (looksLikeUuid(trimmed)) {
    queryBuilder = queryBuilder.eq("id", trimmed);
  } else {
    queryBuilder = queryBuilder.or(
      `email.ilike.%${trimmed}%,phone_number.ilike.%${trimmed}%,twilio_number.ilike.%${trimmed}%`
    );
  }

  const { data, error } = await queryBuilder;

  if (error) {
    console.error("ADMIN METRICS: CUSTOMER SEARCH ERROR:", error.message);
    return [];
  }

  return data || [];
}

module.exports = {
  mergeCustomerActivity,
  getRecentCustomerActivity,
  getRecentCallsAcrossHouseholds,
  mergeAlerts,
  getAlerts,
  searchCustomers,
  looksLikeUuid,
  computeBusinessOverview,
  getBusinessOverview,
  computeProtectionRate,
  computeProtectionActivity,
  getProtectionActivityToday,
  computeSubscriptionStatusBreakdown,
  getSubscriptionStatusBreakdown,
  computeProvisioningStatusBreakdown,
  getProvisioningStatusBreakdown,
  computeReadinessSummary,
};
