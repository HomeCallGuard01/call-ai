const { supabaseAdmin } = require("../services/supabaseClients");
const { stripe } = require("../services/stripeClient");
const { deriveAdminCustomerState, ONBOARDING_ATTENTION_THRESHOLD_MS } = require("../services/adminOnboardingStatus");
const { deriveCustomerHealth, summariseCustomerHealth } = require("../services/adminCustomerHealth");
const { getClassificationMap, classifyHousehold } = require("../services/businessMetrics/accountClassification");

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

// Pure — same "membership/payment status" vocabulary as the customer-
// facing dashboards (server.js's /dashboard-data, routes/mobileApi.js's
// GET /api/v1/me/dashboard) for consistency, adapted for an admin list
// that (unlike those two, which are only ever reached once
// requireEntitlement has already confirmed status === 'active') also
// needs to describe households whose latest entitlement is not active —
// hence the leading 'none'/'inactive' checks neither of those call sites
// needs.
function deriveMembershipStatus(entitlement, subscription) {
  if (!entitlement) return "none";
  if (entitlement.status !== "active") return "inactive";
  if (entitlement.entitlement_type === "free_trial") return "trial";
  if (subscription && subscription.status === "past_due") return "payment_issue";
  if (subscription && subscription.cancel_at_period_end) return "cancelled";
  return "active";
}

// Pure — reduces possibly-many historical rows per household_id down to
// each household's single latest row (by updated_at), same rule
// computeSubscriptionStatusBreakdown already applies, just returning a
// lookup map instead of a count.
function latestRowPerHousehold(rows) {
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.household_id);
    if (!existing || new Date(row.updated_at) > new Date(existing.updated_at)) {
      latest.set(row.household_id, row);
    }
  }
  return latest;
}

// One row per recently-signed-up household, for the admin "Recent
// customers" table — signup date/time, email, membership/payment status,
// protection/activation status, and Twilio provisioning status. Entitlements/
// subscriptions are fetched scoped to just this batch of household IDs
// (not the whole table, unlike the platform-wide breakdown functions
// above) since only these households' latest rows are needed here.
// Dashboard simplification (2026-09-24) — the operational customer view
// found missing while diagnosing a real production household (Paul):
// this is the SAME household list every admin household action already
// works from, now carrying the fields needed to answer "is this person a
// customer, are they paying, are they protected, is their phone
// connected, are calls working, is there a problem" without visiting
// three different tabs. protectionStatus reuses services/callRouting.js's
// computeProtectionStatus — the exact same definition the customer-facing
// app itself uses, never a separate/weaker admin-only one. recentDialOutcome
// is a bounded N+1 (one row per household, capped at `limit`) — an
// admin-triggered, low-frequency list, not a customer-facing hot path,
// same tradeoff already accepted for buildProtectionEvidence's own
// entitlement lookup.
async function getRecentCustomers(limit = 20) {
  if (!supabaseAdmin) return [];

  const { data: households, error: hErr } = await supabaseAdmin
    .from("households")
    .select(
      "id, email, created_at, twilio_provisioning_status, twilio_number, activation_verified_at, voice_client_registered_at, " +
        "delivery_verified_at, device_type, carrier_provider_key, app_version, app_build_version, app_platform"
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (hErr) {
    console.error("ADMIN METRICS: RECENT CUSTOMERS HOUSEHOLDS READ ERROR:", hErr.message);
    return [];
  }

  const householdIds = (households || []).map(h => h.id);
  if (householdIds.length === 0) return [];

  const { computeProtectionStatus, hasRecentDeliveryProblem } = require("../services/callRouting");
  const { getMostRecentDialOutcome } = require("./calls");
  const now = new Date();

  const [{ data: entitlements, error: eErr }, { data: subscriptions, error: sErr }, dialOutcomes] = await Promise.all([
    supabaseAdmin
      .from("entitlements")
      .select("household_id, entitlement_type, status, updated_at")
      .in("household_id", householdIds),
    supabaseAdmin
      .from("subscriptions")
      .select("household_id, status, cancel_at_period_end, updated_at")
      .in("household_id", householdIds),
    Promise.all(households.map(h => getMostRecentDialOutcome(h.id))),
  ]);

  if (eErr) console.error("ADMIN METRICS: RECENT CUSTOMERS ENTITLEMENTS READ ERROR:", eErr.message);
  if (sErr) console.error("ADMIN METRICS: RECENT CUSTOMERS SUBSCRIPTIONS READ ERROR:", sErr.message);

  const latestEntitlementByHousehold = latestRowPerHousehold(entitlements || []);
  const latestSubscriptionByHousehold = latestRowPerHousehold(subscriptions || []);

  return households.map((h, i) => {
    const protection = computeProtectionStatus(h, now);
    const dialOutcome = dialOutcomes[i];
    return {
      householdId: h.id,
      email: h.email,
      signedUpAt: h.created_at,
      membershipStatus: deriveMembershipStatus(
        latestEntitlementByHousehold.get(h.id),
        latestSubscriptionByHousehold.get(h.id)
      ),
      // Kept for backward compatibility with any existing caller reading
      // this field directly — activation_verified_at alone. Prefer
      // protectionStatus.fullyProtected for anything new; see this
      // function's own header for why.
      activationStatus: h.activation_verified_at ? "verified" : "not_verified",
      provisioningStatus: h.twilio_provisioning_status,
      twilioNumber: h.twilio_number || null,
      protectionStatus: protection,
      deviceType: h.device_type || null,
      carrierProviderKey: h.carrier_provider_key || null,
      hasDeviceOnRecord: !!h.device_type,
      lastConfirmedProtectedAt: [h.activation_verified_at, h.delivery_verified_at].filter(Boolean).sort().pop() || null,
      appVersion: h.app_version || null,
      appBuildVersion: h.app_build_version || null,
      appPlatform: h.app_platform || null,
      recentCallProblem: hasRecentDeliveryProblem(dialOutcome, h.delivery_verified_at),
      recentCallOutcome: dialOutcome ? dialOutcome.dial_call_status : null,
      recentCallAt: dialOutcome ? dialOutcome.created_at : null,
      // Release-quality audit (2026-09-24) — found missing: the diagnostic
      // instrumentation just added (migration 045) wrote these two fields
      // but nothing read them anywhere, including here. Distinguishes
      // "Twilio attempted the dial but the Android client never even
      // received the invite" (recentCallOutcome set, recentClientInviteReceivedAt
      // null) from "received but never resolved" (received, no outcome) from
      // a genuine customer action (outcome set) — exactly the ambiguity a
      // real production failure (2026-09-24) could not be diagnosed through.
      recentClientInviteReceivedAt: dialOutcome ? dialOutcome.client_invite_received_at || null : null,
      recentClientOutcome: dialOutcome ? dialOutcome.client_outcome || null : null,
    };
  });
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
  newCustomersToday,
  newCustomersThisWeek,
  activeEntitlements,
  failedPayments,
  canceled,
  price,
}) {
  const mrr =
    price && typeof price.unitAmount === "number"
      ? { amount: (activeEntitlements * price.unitAmount) / 100, currency: price.currency, available: true }
      : { amount: null, currency: null, available: false };

  return {
    totalCustomers,
    activeProtectedHouseholds,
    // Same count already used for the MRR calculation above, now also
    // surfaced directly — "active protected households" is a provisioning
    // proxy (has a live Twilio number), which can genuinely differ from
    // "currently entitled to the service" (e.g. paid but not yet
    // provisioned), so both are shown rather than conflated.
    activePaidCustomers: activeEntitlements,
    newCustomersToday,
    newCustomersThisWeek,
    mrr,
    failedPayments,
    canceled,
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
      newCustomersToday: 0,
      newCustomersThisWeek: 0,
      activeEntitlements: 0,
      failedPayments: 0,
      canceled: 0,
      price: null,
    });
  }

  const [
    { count: totalCustomers },
    { count: activeProtectedHouseholds },
    { count: newCustomersToday },
    { count: newCustomersThisWeek },
    { count: activeEntitlements },
    { count: failedPayments },
    { count: canceled },
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
      .gte("created_at", startOfToday().toISOString()),
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
    // "Canceled" — same source/shape as the failed-payments count above,
    // just the 'canceled' status bucket instead of past_due/unpaid.
    supabaseAdmin.from("subscriptions").select("id", { count: "exact", head: true }).eq("status", "canceled"),
    getSubscriptionPrice(),
  ]);

  return computeBusinessOverview({
    totalCustomers: totalCustomers || 0,
    activeProtectedHouseholds: activeProtectedHouseholds || 0,
    newCustomersToday: newCustomersToday || 0,
    newCustomersThisWeek: newCustomersThisWeek || 0,
    activeEntitlements: activeEntitlements || 0,
    failedPayments: failedPayments || 0,
    canceled: canceled || 0,
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
// OPEN 'blocker' makes the whole launch not-ready, regardless of how many
// lower-severity items also remain — matching how docs/launch/KNOWN_ISSUES.md
// itself is ordered (blockers first, everything else is "should fix").
//
// Bug fix (Dashboard Consolidation, 2026-09): this used to count any
// blocker-SEVERITY item regardless of its status, so a resolved blocker
// (status: 'done') still permanently pinned the dashboard at "not_ready" —
// discovered when services/launchReadiness.js's two blocker items were
// both corrected to status: 'done' and the banner still read "2 open
// blockers". A blocker only counts here while it is still open.
function computeReadinessSummary(items) {
  const blockers = items.filter(i => i.severity === "blocker" && i.status !== "done");
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

// Onboarding-verification UX change (2026-09-23) — Admin Dashboard
// requirement: an authorised admin must be able to see a household's
// real protection evidence (entitlement, Twilio provisioning, forwarding
// verified, Voice SDK registration, end-to-end delivery, derived
// protection status) without querying production directly. Reuses
// services/callRouting.js's computeProtectionStatus — the exact same
// derivation the customer-facing web/mobile dashboards already use — so
// this can never show the admin a different "protected" answer than the
// customer sees. No secret/credential is added to the response; every
// field here is either already returned by this function's existing
// `select("*")` or a derived boolean/status string.
//
// Pure shaping logic split out from the I/O (the entitlement lookup)
// deliberately, matching this file's established convention (see this
// file's own header comment) of testing pure functions directly without
// a real Supabase call — see tests/admin-metrics.test.mjs.
function buildProtectionEvidence(household, entitlement, protection) {
  return {
    entitlementStatus: entitlement ? entitlement.status : "none",
    entitlementType: entitlement ? entitlement.entitlement_type : null,
    entitlementSource: entitlement ? entitlement.source : null,
    twilioProvisioningStatus: household.twilio_provisioning_status,
    forwardingVerified: protection.forwardingVerified,
    activationVerifiedAt: household.activation_verified_at,
    voiceSdkRegistered: protection.deliveryReady,
    voiceClientRegisteredAt: household.voice_client_registered_at,
    endToEndDeliveryVerified: protection.endToEndDeliveryVerified,
    deliveryVerifiedAt: household.delivery_verified_at,
    fullyProtected: protection.fullyProtected,
  };
}

async function attachProtectionEvidence(households) {
  if (!households || households.length === 0) return households;
  const { computeProtectionStatus } = require("../services/callRouting");
  const { getActiveEntitlement } = require("./billing");
  const now = new Date();
  // One entitlement lookup per matched household — search results are
  // capped at 25 and this is an admin-triggered manual action, not a
  // customer-facing hot path, so the small N+1 here is a deliberate,
  // acceptable tradeoff rather than a new batched query.
  return Promise.all(
    households.map(async h => {
      const entitlement = await getActiveEntitlement(h.id);
      const protection = computeProtectionStatus(h, now);
      return { ...h, protectionEvidence: buildProtectionEvidence(h, entitlement, protection) };
    })
  );
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

  return attachProtectionEvidence(data || []);
}

// ------------------------------------------------------------------
// Admin onboarding monitoring (2026-09) — data for the Customers tab's
// attention queue and per-household setup timeline. All state
// derivation lives in services/adminOnboardingStatus.js (pure); these
// functions only fetch and shape. Only admin-useful, non-secret fields
// leave the server: no Twilio SIDs, Stripe IDs, auth user IDs or the
// customer's own phone number.
// ------------------------------------------------------------------

const ONBOARDING_HOUSEHOLD_COLUMNS =
  "id, email, created_at, twilio_number, twilio_provisioning_status, twilio_provisioning_updated_at, " +
  "activation_verified_at, voice_client_registered_at, delivery_verified_at, " +
  "device_type, carrier_provider_key, app_version, app_build_version, app_platform";

// Deleted accounts are anonymised in place (migration 029) rather than
// removed; they are not customers and are hidden from the Customers view.
const ANONYMISED_EMAIL_SUFFIX = "@deleted.homecallguard.internal";

const ONBOARDING_HOUSEHOLD_LIMIT = 500;

// One limit-1 query per household (bounded concurrency) rather than one
// big calls read: a single busy household could otherwise fill the row
// cap and hide everyone else's last call. Uses calls_household_id_idx.
async function getLastCallAtByHousehold(householdIds, concurrency = 20) {
  const result = new Map();
  if (!supabaseAdmin) return result;

  for (let i = 0; i < householdIds.length; i += concurrency) {
    const batch = householdIds.slice(i, i + concurrency);
    const responses = await Promise.all(
      batch.map(id =>
        supabaseAdmin
          .from("calls")
          .select("created_at")
          .eq("household_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
      )
    );
    responses.forEach(({ data, error }, idx) => {
      if (error) {
        console.error("ADMIN METRICS: LAST CALL READ ERROR:", error.message);
        return;
      }
      result.set(batch[idx], data && data[0] ? data[0].created_at : null);
    });
  }

  return result;
}

// Admin control centre (2026-09-25): the latest real call (any outcome)
// and the latest ATTEMPTED delivery (dial_call_status set, migration 044)
// per household — two limit-1 reads each, same bounded-concurrency
// pattern as getLastCallAtByHousehold above.
async function getLatestCallEvidenceByHousehold(householdIds, concurrency = 10) {
  const result = new Map();
  if (!supabaseAdmin) return result;

  for (let i = 0; i < householdIds.length; i += concurrency) {
    const batch = householdIds.slice(i, i + concurrency);
    const responses = await Promise.all(
      batch.map(id =>
        Promise.all([
          supabaseAdmin
            .from("calls")
            .select("created_at, status, result, terminated_by_system")
            .eq("household_id", id)
            .order("created_at", { ascending: false })
            .limit(1),
          supabaseAdmin
            .from("calls")
            .select("dial_call_status, created_at, client_invite_received_at, client_outcome")
            .eq("household_id", id)
            .not("dial_call_status", "is", null)
            .order("created_at", { ascending: false })
            .limit(1),
        ])
      )
    );
    responses.forEach(([lastCallRes, lastDialRes], idx) => {
      if (lastCallRes.error) console.error("ADMIN METRICS: LATEST CALL READ ERROR:", lastCallRes.error.message);
      if (lastDialRes.error) console.error("ADMIN METRICS: LATEST DIAL READ ERROR:", lastDialRes.error.message);
      result.set(batch[idx], {
        lastCall: (!lastCallRes.error && lastCallRes.data && lastCallRes.data[0]) || null,
        lastDial: (!lastDialRes.error && lastDialRes.data && lastDialRes.data[0]) || null,
      });
    });
  }

  return result;
}

// Callers' own numbers are shown to the admin only as their last four
// digits — enough to match a call the customer describes, no more.
function maskCallerNumber(number) {
  if (typeof number !== "string" || !number) return null;
  const digits = number.replace(/[^0-9]/g, "");
  if (digits.length <= 4) return "…" + digits;
  return "…" + digits.slice(-4);
}

function groupByHousehold(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.household_id)) map.set(row.household_id, []);
    map.get(row.household_id).push(row);
  }
  return map;
}

// Pure — one Customers-tab row from already-fetched pieces. `lastCall`
// and `lastDial` are optional (older callers pass only lastCallAt).
function buildOnboardingRow({ household, entitlements, subscription, lastCallAt, lastCall, lastDial, classification }, now) {
  const effectiveLastCallAt = lastCall ? lastCall.created_at : lastCallAt || null;
  const derived = deriveAdminCustomerState({ household, entitlements, lastCallAt: effectiveLastCallAt }, now);
  const membershipStatus = derived.currentEntitlement
    ? deriveMembershipStatus(derived.currentEntitlement, subscription)
    : derived.latestEntitlement ? "inactive" : "none";
  const health = deriveCustomerHealth(
    { household, entitlements, lastCallAt: effectiveLastCallAt, lastDial: lastDial || null, classification },
    now
  );

  return {
    householdId: household.id,
    email: household.email,
    signedUpAt: household.created_at,
    classification,
    membershipStatus,
    provisioningStatus: household.twilio_provisioning_status,
    state: derived.state,
    reason: derived.reason,
    forwardingProven: derived.forwardingProven,
    appRegistered: derived.protection.deliveryReady,
    deliveryVerified: derived.protection.endToEndDeliveryVerified,
    fullyProtected: derived.protection.fullyProtected,
    setupClock: derived.setupClock,
    lastCallAt: derived.lastCallAt,
    // Admin control centre (2026-09-25) — services/adminCustomerHealth.js.
    health: health.health,
    healthReason: health.reason,
    account: health.account,
    subscriptionIssue: membershipStatus === "payment_issue" || membershipStatus === "cancelled" ? membershipStatus : null,
    setupLabel: health.setup.label,
    network: health.network,
    device: health.device,
    app: health.app,
    lastConfirmed: health.lastConfirmed,
    latestCall: lastCall
      ? { at: lastCall.created_at, status: lastCall.status, result: lastCall.result, terminatedBySystem: !!lastCall.terminated_by_system }
      : null,
    lastDelivery: health.delivery.attempted
      ? {
          at: health.delivery.at,
          twilioLabel: health.delivery.twilioLabel,
          phoneLabel: health.delivery.phoneLabel,
          failure: health.delivery.failure,
        }
      : null,
    deletedAccount: typeof household.email === "string" && household.email.endsWith(ANONYMISED_EMAIL_SUFFIX),
  };
}

async function getOnboardingMonitor(now = new Date()) {
  if (!supabaseAdmin) return { available: false, reason: "SUPABASE_SERVICE_ROLE_KEY not configured" };

  const [{ data: households, error: hErr }, { data: entitlements, error: eErr }, { data: subscriptions, error: sErr }, classification] =
    await Promise.all([
      supabaseAdmin
        .from("households")
        .select(ONBOARDING_HOUSEHOLD_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(ONBOARDING_HOUSEHOLD_LIMIT),
      supabaseAdmin.from("entitlements").select("household_id, entitlement_type, status, source, starts_at, ends_at, updated_at"),
      supabaseAdmin.from("subscriptions").select("household_id, status, cancel_at_period_end, updated_at"),
      getClassificationMap(),
    ]);

  if (hErr) return { available: false, reason: hErr.message };
  if (eErr) return { available: false, reason: eErr.message };
  if (sErr) console.error("ADMIN METRICS: ONBOARDING SUBSCRIPTIONS READ ERROR:", sErr.message);

  const entitlementsByHousehold = groupByHousehold(entitlements);
  const latestSubscriptionByHousehold = latestRowPerHousehold(subscriptions || []);
  const evidenceByHousehold = await getLatestCallEvidenceByHousehold((households || []).map(h => h.id));

  const rows = (households || []).map(h => {
    const evidence = evidenceByHousehold.get(h.id) || { lastCall: null, lastDial: null };
    return buildOnboardingRow(
      {
        household: h,
        entitlements: entitlementsByHousehold.get(h.id) || [],
        subscription: latestSubscriptionByHousehold.get(h.id),
        lastCall: evidence.lastCall,
        lastDial: evidence.lastDial,
        classification: classifyHousehold(h.id, classification.map),
      },
      now
    );
  });

  return {
    available: true,
    generatedAt: now.toISOString(),
    thresholdHours: ONBOARDING_ATTENTION_THRESHOLD_MS / 3600000,
    classificationAvailable: classification.available,
    truncated: (households || []).length >= ONBOARDING_HOUSEHOLD_LIMIT,
    summary: summariseCustomerHealth(rows.filter(r => !r.deletedAccount)),
    deletedAccountsHidden: rows.filter(r => r.deletedAccount).length,
    rows,
  };
}

async function getHouseholdStatusDetail(householdId, now = new Date()) {
  if (!supabaseAdmin) return { available: false, reason: "SUPABASE_SERVICE_ROLE_KEY not configured" };

  const { data: household, error } = await supabaseAdmin
    .from("households")
    .select(
      // device_type, carrier_provider_key and app_version/app_build_version/
      // app_platform (diagnostic instrumentation, 2026-09-24) are part of
      // ONBOARDING_HOUSEHOLD_COLUMNS since the admin control centre
      // (2026-09-25) — not repeated here.
      ONBOARDING_HOUSEHOLD_COLUMNS +
        ", twilio_provisioning_attempts, twilio_provisioning_last_error, carrier_tariff_type, carrier_compatibility_captured_at"
    )
    .eq("id", householdId)
    .maybeSingle();

  if (error) return { available: false, reason: error.message };
  if (!household) return { available: true, found: false };

  const { getMostRecentDialOutcome } = require("./calls");
  const [{ data: entitlements, error: eErr }, { data: subscriptions }, lastCallByHousehold, classification, mostRecentDialOutcome, evidenceByHousehold, { data: recentCallRows, error: rcErr }] = await Promise.all([
    supabaseAdmin
      .from("entitlements")
      .select("household_id, entitlement_type, status, source, starts_at, ends_at, updated_at")
      .eq("household_id", householdId),
    supabaseAdmin
      .from("subscriptions")
      .select("household_id, status, cancel_at_period_end, updated_at")
      .eq("household_id", householdId),
    getLastCallAtByHousehold([householdId]),
    getClassificationMap(),
    getMostRecentDialOutcome(householdId),
    getLatestCallEvidenceByHousehold([householdId]),
    supabaseAdmin
      .from("calls")
      .select("created_at, number, status, result, terminated_by_system, dial_call_status, client_invite_received_at, client_outcome, duration_seconds")
      .eq("household_id", householdId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (eErr) return { available: false, reason: eErr.message };
  if (rcErr) console.error("ADMIN METRICS: RECENT CALLS DETAIL READ ERROR:", rcErr.message);

  const lastCallAt = lastCallByHousehold.get(householdId) || null;
  const evidence = evidenceByHousehold.get(householdId) || { lastCall: null, lastDial: null };
  const derived = deriveAdminCustomerState({ household, entitlements: entitlements || [], lastCallAt }, now);
  const row = buildOnboardingRow(
    {
      household,
      entitlements: entitlements || [],
      subscription: latestRowPerHousehold(subscriptions || []).get(householdId),
      lastCallAt,
      lastCall: evidence.lastCall,
      lastDial: evidence.lastDial,
      classification: classifyHousehold(householdId, classification.map),
    },
    now
  );

  const shownEntitlement = derived.currentEntitlement || derived.latestEntitlement;

  return {
    available: true,
    found: true,
    customer: row,
    timeline: derived.timeline,
    recentCalls: (recentCallRows || []).map(c => ({
      at: c.created_at,
      caller: maskCallerNumber(c.number),
      status: c.status,
      result: c.result,
      terminatedBySystem: !!c.terminated_by_system,
      dialCallStatus: c.dial_call_status || null,
      clientInviteReceivedAt: c.client_invite_received_at || null,
      clientOutcome: c.client_outcome || null,
      durationSeconds: typeof c.duration_seconds === "number" ? c.duration_seconds : null,
    })),
    technical: {
      householdId: household.id,
      hcgNumber: household.twilio_number || null,
      provisioningStatus: household.twilio_provisioning_status,
      provisioningAttempts: household.twilio_provisioning_attempts,
      provisioningLastError: household.twilio_provisioning_last_error || null,
      provisioningUpdatedAt: household.twilio_provisioning_updated_at || null,
      deviceType: household.device_type || null,
      carrierProviderKey: household.carrier_provider_key || null,
      carrierTariffType: household.carrier_tariff_type || null,
      carrierCapturedAt: household.carrier_compatibility_captured_at || null,
      activationVerifiedAt: household.activation_verified_at || null,
      voiceClientRegisteredAt: household.voice_client_registered_at || null,
      deliveryVerifiedAt: household.delivery_verified_at || null,
      // Diagnostic instrumentation (2026-09-24) — appVersion is reported
      // by the app itself (mobile/lib/voiceClient.ts, via the existing
      // POST /api/v1/voice/registered call), never validated server-side,
      // so this and every other field here goes through escapeHtml at
      // render time exactly like every other technical-details row.
      appVersion: household.app_version || null,
      appBuildVersion: household.app_build_version || null,
      appPlatform: household.app_platform || null,
      // The most recent real dial attempt's outcome, distinct from
      // deliveryVerifiedAt above (a historical, set-once "it has worked at
      // least once" fact) — see services/callRouting.js's
      // hasRecentDeliveryProblem for how the mobile app's own Home tab
      // uses the same underlying data.
      mostRecentDialOutcome: mostRecentDialOutcome
        ? {
            dialCallStatus: mostRecentDialOutcome.dial_call_status || null,
            at: mostRecentDialOutcome.created_at || null,
            clientInviteReceivedAt: mostRecentDialOutcome.client_invite_received_at || null,
            clientOutcome: mostRecentDialOutcome.client_outcome || null,
          }
        : null,
      entitlement: shownEntitlement
        ? {
            type: shownEntitlement.entitlement_type,
            source: shownEntitlement.source || null,
            status: shownEntitlement.status,
            startsAt: shownEntitlement.starts_at,
            endsAt: shownEntitlement.ends_at || null,
          }
        : null,
    },
  };
}

module.exports = {
  buildOnboardingRow,
  maskCallerNumber,
  getOnboardingMonitor,
  getHouseholdStatusDetail,
  getSubscriptionPrice,
  mergeCustomerActivity,
  getRecentCustomerActivity,
  deriveMembershipStatus,
  latestRowPerHousehold,
  getRecentCustomers,
  getRecentCallsAcrossHouseholds,
  mergeAlerts,
  getAlerts,
  searchCustomers,
  buildProtectionEvidence,
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
