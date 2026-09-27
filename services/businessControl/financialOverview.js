// Business control dashboard (2026-09-27) — gathers the inputs for the
// Finance tab and hands them to the pure read model
// (financialReadModel.js). Read-only: Stripe balance transactions and
// Twilio usage records are the same read-only calls the existing
// Business tab already makes (services/businessMetrics/revenue.js,
// twilioCosts.js).
//
// LIVE-SOURCE FALLBACK MODE ONLY. This deployable never reads the ledger
// (financial_entries, migration 048) or manual costs (draft migration
// 050): it passes ledgerEntries = null, so every line comes from a live
// source or is shown NOT CONNECTED. Switching to ledger mode is a
// separate, reviewed change once 048 is applied (see
// docs/admin/BUSINESS_CONTROL_DASHBOARD.md).
'use strict';

const { buildLiveFigures, buildProfitAndLoss, monthToDatePeriod } = require('./financialReadModel');

function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    return null;
  }
}

function resolveStripe() {
  try {
    return require('../stripeClient').stripe;
  } catch (err) {
    return null;
  }
}

// Delivered-call minutes for unknown (monitored) callers this period,
// from calls.duration_seconds (the approved call's connected leg). A
// proxy for monitored minutes: calls blocked before connecting have no
// duration recorded.
async function readMonitoredMinutes(supabaseAdmin, period) {
  const { data, error } = await supabaseAdmin
    .from('calls')
    .select('duration_seconds, status')
    .eq('status', 'Unknown')
    .gte('created_at', new Date(period.startMs).toISOString())
    .limit(50000);
  if (error) return null;
  const seconds = (data || []).reduce((acc, c) => acc + (typeof c.duration_seconds === 'number' ? c.duration_seconds : 0), 0);
  return Math.round((seconds / 60) * 10) / 10;
}

async function getFinancialOverview(now = new Date()) {
  const supabaseAdmin = resolveSupabaseAdmin();
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };

  const { getStripeRevenueSnapshot, estimateAppleRevenueGbp } = require('../businessMetrics/revenue');
  const { getTwilioAccountSnapshot } = require('../businessMetrics/twilioCosts');
  const { estimateOpenAiCostGbp } = require('../businessMetrics/openaiCosts');
  const { getCallStatsMtd } = require('../businessMetrics/callStats');
  const { resolveVatRate, resolveFixedMonthlyCostsStatus } = require('../businessMetrics/config');
  const { getSubscriptionPrice } = require('../../database/adminMetrics');
  const { getSubscriptionOverview } = require('./subscriptionOverview');

  const period = monthToDatePeriod(now);

  const [stripe, twilio, callStats, price, appleCount, subscriptions, monitoredMinutes] = await Promise.all([
    getStripeRevenueSnapshot({ stripe: resolveStripe() }),
    getTwilioAccountSnapshot({}),
    getCallStatsMtd(),
    getSubscriptionPrice(),
    supabaseAdmin
      .from('entitlements')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .eq('source', 'apple_revenuecat')
      .then((r) => (r.error ? 0 : r.count || 0)),
    getSubscriptionOverview(now),
    readMonitoredMinutes(supabaseAdmin, period),
  ]);

  const priceGbp = price && price.currency === 'gbp' ? price.unitAmount / 100 : null;
  const liveFigures = buildLiveFigures({
    stripe,
    twilio,
    openaiEstimate: estimateOpenAiCostGbp(callStats.available ? callStats.unknownMonitoredCalls : 0),
    appleEstimate: priceGbp !== null ? estimateAppleRevenueGbp(appleCount, priceGbp) : null,
    vatRate: resolveVatRate(),
    fixedCostsStatus: resolveFixedMonthlyCostsStatus(),
    manualCostsConnected: false,
  });

  const c = subscriptions.available ? subscriptions.counts : null;
  const pnl = buildProfitAndLoss({
    period,
    ledgerEntries: null,
    liveFigures,
    units: {
      activeCustomers: c ? c.activePaidSubscriptions.total + c.complimentary + c.trial : null,
      genuinePayingCustomers: c ? c.genuinePayingCustomers : null,
      monitoredMinutes,
    },
  });

  return {
    available: true,
    generatedAt: now.toISOString(),
    ...pnl,
    connections: {
      ledger: 'not used by this version (live-source fallback mode; ledger migration 048 pending)',
      manualCosts: 'not available yet (needs ledger 048 + manual-cost migration 050)',
      stripe: stripe.available ? 'connected (read-only)' : stripe.reason,
      twilio: twilio.available ? 'connected (read-only usage records)' : twilio.reason,
      openai: 'estimate only (organisation cost API needs an Admin key)',
      railway: 'no billing integration (manual figure or manual cost)',
      supabase: 'no billing integration (manual figure or manual cost)',
      resend: 'no billing integration (manual figure or manual cost)',
      appStore: 'App Store Connect reports not connected',
      advertising: 'no ad-platform import; enter invoices as manual costs',
    },
  };
}

module.exports = { getFinancialOverview };
