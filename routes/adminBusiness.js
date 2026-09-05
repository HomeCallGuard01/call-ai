// Business/profitability dashboard API — 2026-09 build. Deliberately a
// separate router file from routes/admin.js (not merged into it) so the
// existing, working admin route file is never touched by this change.
// Every route here uses the exact same, unmodified requireAuth +
// requireAdmin middleware every other admin route already depends on —
// no new authorization mechanism, no new session/role concept. See
// middleware/requireAdmin.js: role is read from user_roles at login
// time (requireAuth), checked server-side on every request, independent
// of anything the browser sends or hides in its UI.
//
// No provider secret is ever placed in a JSON response here — every
// value returned is either a derived number, a count, or a non-secret
// status string (e.g. "configured": true/false, never the key itself).
const express = require("express");
const path = require("path");
const { requireAuth } = require("../middleware/requireAuth");
const { requireAdmin } = require("../middleware/requireAdmin");
const { supabaseAdmin } = require("../services/supabaseClients");
const { stripe } = require("../services/stripeClient");
const {
  getBusinessOverview,
  getSubscriptionStatusBreakdown,
  getSubscriptionPrice,
} = require("../database/adminMetrics");
const { getStripeRevenueSnapshot, estimateAppleRevenueGbp, netOfVat } = require("../services/businessMetrics/revenue");
const { getTwilioAccountSnapshot } = require("../services/businessMetrics/twilioCosts");
const { estimateOpenAiCostGbp, isOpenAiKeyConfigured } = require("../services/businessMetrics/openaiCosts");
const { getCallStatsToday, getCallStatsMtd, getTopUnknownCallHouseholdsMtd } = require("../services/businessMetrics/callStats");
const { getSystemHealthSnapshot } = require("../services/businessMetrics/systemHealth");
const {
  computeProfitabilitySnapshot,
  computeConfirmedContribution,
  computeBreakEvenMonitoredMinutes,
  estimateCostPerMonitoredMinuteGbp,
} = require("../services/businessMetrics/profitability");
const { classifyHouseholds } = require("../services/businessMetrics/fairUse");
const { getBackendReleaseInfo, getMobileReleaseInfo } = require("../services/businessMetrics/releaseInfo");
const { resolveVatRate, resolveFixedMonthlyCostsGbp, resolveFixedMonthlyCostsStatus, resolveUsdToGbpRate } = require("../services/businessMetrics/config");
const { getGenuineCustomerOverview, getClassifiedCustomerList } = require("../services/businessMetrics/customerClassificationOverview");
const { getAcquisitionOverview } = require("../services/businessMetrics/acquisitionOverview");

const router = express.Router();

router.get("/admin/business", requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "admin-business.html"));
});

// A 30-day-old recency window for "recent" Stripe webhook failures —
// matches the existing getAlerts() convention of surfacing the alert
// list without an arbitrary separate time filter (that function has no
// window either); used only for the System Health rollup's own count.
async function getRecentFailedStripeWebhookCount() {
  if (!supabaseAdmin) return 0;
  const since = new Date();
  since.setDate(since.getDate() - 1);
  const { count, error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .select("stripe_event_id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("received_at", since.toISOString());
  if (error) return 0;
  return count || 0;
}

async function getActiveAppleEntitlementCount() {
  if (!supabaseAdmin) return 0;
  const { count, error } = await supabaseAdmin
    .from("entitlements")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("source", "apple_revenuecat");
  if (error) return 0;
  return count || 0;
}

// Enriches the count-based household ranking (services/businessMetrics/
// callStats.js) with an email for display — a separate, small query
// rather than baking identity lookup into the pure ranking function.
async function enrichHouseholdsWithEmail(households) {
  if (!supabaseAdmin || households.length === 0) return households;
  const ids = households.map((h) => h.householdId);
  const { data } = await supabaseAdmin.from("households").select("id, email").in("id", ids);
  const emailById = new Map((data || []).map((h) => [h.id, h.email]));
  return households.map((h) => ({ ...h, email: emailById.get(h.householdId) || null }));
}

router.get("/admin/api/business/overview", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [
      businessOverview,
      subscriptionStatusBreakdown,
      price,
      stripeRevenue,
      twilio,
      callStatsToday,
      callStatsMtd,
      activeAppleEntitlements,
      recentFailedStripeWebhookCount,
      topHouseholdsRaw,
      genuineOverview,
      acquisitionOverview,
      classifiedCustomerList,
    ] = await Promise.all([
      getBusinessOverview(),
      getSubscriptionStatusBreakdown(),
      getSubscriptionPrice(),
      getStripeRevenueSnapshot({ stripe }),
      getTwilioAccountSnapshot({}),
      getCallStatsToday(),
      getCallStatsMtd(),
      getActiveAppleEntitlementCount(),
      getRecentFailedStripeWebhookCount(),
      getTopUnknownCallHouseholdsMtd(10),
      getGenuineCustomerOverview(),
      getAcquisitionOverview(),
      getClassifiedCustomerList(20),
    ]);

    const systemHealth = await getSystemHealthSnapshot({ recentFailedStripeWebhookCount });

    const priceGbp = price && price.currency === "gbp" ? price.unitAmount / 100 : 4.99;
    const appleRevenue = estimateAppleRevenueGbp(activeAppleEntitlements, priceGbp);

    const openaiEstimateToday = estimateOpenAiCostGbp(callStatsToday.available ? callStatsToday.unknownMonitoredCalls : 0);
    const openaiEstimateMtd = estimateOpenAiCostGbp(callStatsMtd.available ? callStatsMtd.unknownMonitoredCalls : 0);

    const fixedMonthlyCosts = resolveFixedMonthlyCostsGbp();
    const fixedCostsTotalGbp = fixedMonthlyCosts.railway + fixedMonthlyCosts.supabase + fixedMonthlyCosts.resend;
    const fixedCostsStatus = resolveFixedMonthlyCostsStatus();
    const vatRate = resolveVatRate();

    // Business Dashboard V2 (2026-09): real, confirmed MRR — Stripe-only
    // active entitlements belonging to genuine_customer-classified
    // households only. Deliberately separate from businessOverview.mrr
    // below (kept as-is, unchanged, for the existing operational view),
    // which counts every active entitlement regardless of source or
    // account classification.
    const confirmedMrr = genuineOverview.available
      ? { amount: Number((genuineOverview.genuineStripePayingCustomers * priceGbp).toFixed(2)), currency: "gbp", available: true }
      : { amount: null, currency: null, available: false };

    const confirmedContributionMtd = stripeRevenue.available
      ? computeConfirmedContribution({
          stripeGrossRevenueGbp: stripeRevenue.grossRevenueMtdGbp,
          stripeFeesGbp: stripeRevenue.stripeFeesMtdGbp,
          twilioCostGbp: twilio.available ? twilio.spendMtdGbp : 0,
          vatRateAppliedToGross: vatRate,
          fixedCostsStatus,
          genuinePayingCustomerCount: genuineOverview.available ? genuineOverview.genuinePayingCustomers : 0,
        })
      : null;
    // Bug fix (2026-09): database/adminMetrics.js's computeBusinessOverview
    // returns activePaidCustomers, not activeEntitlements — confirmed by
    // running this exact code against real production data, which
    // surfaced this immediately (activeEntitlements was always undefined,
    // silently falling back to 0 in every `|| 0` below). One local
    // variable, used everywhere below, so this can't drift out of sync
    // across the five places this count is needed again.
    const activePaidCustomerCount = businessOverview.activePaidCustomers || 0;

    const profitabilityMtd = stripeRevenue.available
      ? computeProfitabilitySnapshot({
          stripeGrossRevenueGbp: stripeRevenue.grossRevenueMtdGbp,
          stripeFeesGbp: stripeRevenue.stripeFeesMtdGbp,
          appleRevenueEstimateGbp: appleRevenue.grossRevenueEstimateGbp,
          twilioCostGbp: twilio.available ? twilio.spendMtdGbp : 0,
          openaiCostEstimateGbp: openaiEstimateMtd.estimatedCostGbp,
          fixedMonthlyCostsGbp: fixedCostsTotalGbp,
          vatRateAppliedToGross: vatRate,
          activeCustomerCount: activePaidCustomerCount,
        })
      : null;

    const profitabilityToday = stripeRevenue.available
      ? computeProfitabilitySnapshot({
          stripeGrossRevenueGbp: stripeRevenue.grossRevenueTodayGbp,
          stripeFeesGbp: stripeRevenue.stripeFeesTodayGbp,
          appleRevenueEstimateGbp: 0, // no daily Apple revenue signal available at all — MTD only, see appleRevenue's own note
          twilioCostGbp: twilio.available ? twilio.spendTodayGbp : 0,
          openaiCostEstimateGbp: openaiEstimateToday.estimatedCostGbp,
          fixedMonthlyCostsGbp: 0, // fixed costs are not meaningfully allocable to "today" — MTD figure only
          vatRateAppliedToGross: vatRate,
          activeCustomerCount: activePaidCustomerCount,
        })
      : null;

    const costPerMonitoredMinuteGbp = twilio.available
      ? estimateCostPerMonitoredMinuteGbp({
          twilioInboundPerMinuteGbp: 0.007558, // confirmed live against this Twilio account, 2026-09 — see docs/session record; not re-fetched per-request to avoid an extra Pricing API call on every dashboard load
        })
      : null;

    const breakEvenMonitoredMinutes =
      profitabilityMtd && costPerMonitoredMinuteGbp
        ? computeBreakEvenMonitoredMinutes({
            netRevenuePerCustomerGbp: netOfVat(priceGbp, process.env).netAmount,
            fixedCostPerCustomerGbp: activePaidCustomerCount > 0 ? fixedCostsTotalGbp / activePaidCustomerCount : fixedCostsTotalGbp,
            costPerMonitoredMinuteGbp,
          })
        : null;

    const fairUse = classifyHouseholds(await enrichHouseholdsWithEmail(topHouseholdsRaw.households || []));

    res.json({
      generatedAt: new Date().toISOString(),
      systemHealth,
      customers: {
        // Genuine-customer headline figures (Business Dashboard V2,
        // 2026-09) — an UNCLASSIFIED household is never counted as a
        // genuine customer; see services/businessMetrics/
        // customerClassificationOverview.js. Shown first/above the raw
        // operational counts below, per the explicit brief.
        genuine: genuineOverview.available
          ? {
              genuineCustomers: genuineOverview.genuineCustomers,
              genuinePayingCustomers: genuineOverview.genuinePayingCustomers,
              genuineStripePayingCustomers: genuineOverview.genuineStripePayingCustomers,
              activeProtectedGenuineCustomers: genuineOverview.activeProtectedGenuineCustomers,
              internalTest: genuineOverview.internalTest,
              admin: genuineOverview.admin,
              reviewer: genuineOverview.reviewer,
              qaAutomation: genuineOverview.qaAutomation,
              unclassified: genuineOverview.unclassified,
              unclassifiedAccounts: genuineOverview.unclassifiedAccounts,
            }
          : { available: false, reason: genuineOverview.reason },
        // Customers tab (Dashboard Cleanup, 2026-09): the same
        // recent-customer rows database/adminMetrics.js's
        // getRecentCustomers() has always returned, now annotated with
        // each household's classification. `genuine` is the default,
        // customer-facing view — currently empty, honestly, since HCG
        // has 0 genuine external customers; `all` is the secondary
        // diagnostics view (admin-only, same auth as everything else on
        // this route) covering every historical/internal/test/anonymised
        // account without deleting or reclassifying any of them.
        recentList: classifiedCustomerList,
        // Existing raw/operational counts — unchanged, kept available
        // below the genuine-customer headline above, per the explicit
        // brief ("Keep the existing operational/raw account counts
        // available below the genuine-customer headline figures").
        // These count every households row regardless of classification.
        totalCustomers: businessOverview.totalCustomers,
        activeProtectedHouseholds: businessOverview.activeProtectedHouseholds,
        activeEntitlements: activePaidCustomerCount,
        newCustomersToday: businessOverview.newCustomersToday,
        newCustomersThisWeek: businessOverview.newCustomersThisWeek,
        paymentIssueCustomers: businessOverview.failedPayments,
        cancelledCustomers: businessOverview.canceled,
        subscriptionStatusBreakdown,
        activeAppleEntitlements,
      },
      revenue: {
        vatRate,
        stripe: stripeRevenue,
        apple: appleRevenue,
        // CONFIRMED: Stripe-only, genuine-customer-only. This is the
        // trustworthy headline MRR figure.
        confirmedMrr,
        // ESTIMATED: unchanged from V1 — every active entitlement
        // (any source, any account classification) x list price. Kept
        // for the existing operational view, never the headline number.
        mrr: businessOverview.mrr,
      },
      costs: {
        twilio,
        openai: { today: openaiEstimateToday, monthToDate: openaiEstimateMtd, configured: isOpenAiKeyConfigured() },
        // ESTIMATED/operational view — unset fixed costs still read as
        // £0 here, unchanged, matching V1 behaviour for this field.
        fixedMonthlyCostsGbp: fixedMonthlyCosts,
        fixedMonthlyCostsTotalGbp: fixedCostsTotalGbp,
        // CONFIRMED view — an unset fixed cost is NOT_CONFIGURED here,
        // never silently £0. See services/businessMetrics/config.js's
        // resolveFixedMonthlyCostsStatus.
        fixedMonthlyCostsStatus: fixedCostsStatus,
      },
      profitability: {
        // ESTIMATED — unchanged from V1: blends the Apple revenue
        // estimate and the OpenAI cost estimate into one figure.
        today: profitabilityToday,
        monthToDate: profitabilityMtd,
        // CONFIRMED — Stripe-only revenue, real Twilio cost only; no
        // Apple estimate, no OpenAI estimate. operatingProfitGbp is
        // null with profit.operatingProfitStatus === "INCOMPLETE" and
        // profit.missingCostInputs populated whenever a fixed cost
        // isn't configured — never presented as a false £0-cost profit.
        confirmedMonthToDate: confirmedContributionMtd,
        costPerMonitoredMinuteGbp,
        breakEvenMonitoredMinutesPerCustomer: breakEvenMonitoredMinutes,
        fxRateUsdToGbp: resolveUsdToGbpRate(),
      },
      callStats: { today: callStatsToday, monthToDate: callStatsMtd },
      fairUse,
      acquisition: acquisitionOverview,
      release: {
        backend: getBackendReleaseInfo(),
        mobile: getMobileReleaseInfo(),
      },
      knownGaps: [
        "calls.duration_seconds does not exist in production — monitored minutes and true per-household £ cost cannot be computed; call COUNT is used as a labeled proxy throughout.",
        "OpenAI cost is an estimate only — the configured API key cannot query organisation cost APIs (needs a separate Admin-scoped key); no persisted transcription-success record exists to confirm recent operation.",
        "Apple/RevenueCat revenue is an estimate (active-entitlement count x list price) — no per-transaction Apple amount or commission tier is available from this integration.",
        "No RevenueCat webhook failure log exists in this schema — RevenueCat health cannot be confirmed from recent operational evidence.",
        "Acquisition/landing-visit counts are raw server-side page-request counts, not unique/deduplicated visitors — no cookie or session exists to distinguish a repeat visitor from a new one, and bots/prefetchers/link-scanners are not filtered out. Registration-submitted/completed counts likewise cannot be linked to a specific later checkout/conversion (no persistent identifier exists before a household is created), so only stage-level aggregate counts are available, never a true per-visitor funnel. Referrer is hostname-only and reflects only the browser's own Referer header, which many browsers/privacy settings omit or strip. The 'classified genuine-customer' funnel only ever counts households explicitly marked genuine_customer in account_classifications — an unclassified account is never counted as genuine.",
        "Account classification (genuine/internal/admin/reviewer/qa) is explicit and manually maintained (public.account_classifications) — any household with no row is UNCLASSIFIED and excluded from genuine-customer figures; see customers.genuine.unclassifiedAccounts for the current list needing review.",
        "calls.duration_seconds still does not exist — Twilio number-rental vs. call-usage cost is now split (costs.twilio.spendMtdSplit), but no per-household or per-genuine-customer £ cost can be computed without duration data.",
      ],
    });
  } catch (err) {
    console.error("ADMIN BUSINESS DASHBOARD ERROR:", err.message);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;
