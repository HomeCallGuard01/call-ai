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

// Pure — takes the raw counts/price already fetched, computes the
// derived KPI shape. Split out from getKpiSummary() so it's directly
// unit-testable without a database or Stripe call.
function computeKpiSummary({ customerCount, totalCalls, blockedCalls, activeEntitlements, failedProvisioning, price }) {
  const revenue =
    price && typeof price.unitAmount === "number"
      ? { amount: (activeEntitlements * price.unitAmount) / 100, currency: price.currency, available: true }
      : { amount: null, currency: null, available: false };

  return {
    customers: customerCount,
    protectedCalls: totalCalls,
    blockedCalls,
    activeSubscriptions: activeEntitlements,
    failedProvisioning,
    revenue,
  };
}

async function getKpiSummary() {
  if (!supabaseAdmin) {
    return computeKpiSummary({
      customerCount: 0,
      totalCalls: 0,
      blockedCalls: 0,
      activeEntitlements: 0,
      failedProvisioning: 0,
      price: null,
    });
  }

  const [
    { count: customerCount },
    { count: totalCalls },
    { count: blockedCalls },
    { count: activeEntitlements },
    { count: failedProvisioning },
    price,
  ] = await Promise.all([
    supabaseAdmin.from("households").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("calls").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("calls").select("id", { count: "exact", head: true }).eq("result", "SCAM"),
    supabaseAdmin.from("entitlements").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabaseAdmin.from("households").select("id", { count: "exact", head: true }).eq("twilio_provisioning_status", "failed"),
    getSubscriptionPrice(),
  ]);

  return computeKpiSummary({
    customerCount: customerCount || 0,
    totalCalls: totalCalls || 0,
    blockedCalls: blockedCalls || 0,
    activeEntitlements: activeEntitlements || 0,
    failedProvisioning: failedProvisioning || 0,
    price,
  });
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
  computeKpiSummary,
  getKpiSummary,
  mergeCustomerActivity,
  getRecentCustomerActivity,
  getRecentCallsAcrossHouseholds,
  mergeAlerts,
  getAlerts,
  searchCustomers,
  looksLikeUuid,
};
