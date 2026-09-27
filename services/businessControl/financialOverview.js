// Business control dashboard (2026-09-27) — gathers the inputs for the
// Finance tab and hands them to the pure read model
// (financialReadModel.js). Read-only: Stripe balance transactions and
// Twilio usage records are the same read-only calls the existing
// Business tab already makes (services/businessMetrics/revenue.js,
// twilioCosts.js); the ledger is only read if financial_entries exists.
'use strict';

const { buildLiveFigures, buildProfitAndLoss, monthToDatePeriod } = require('./financialReadModel');
const { resolveFixedCostSettings } = require('./fixedCostSettings');
const { getManualCostConnection } = require('./manualCosts');

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

const LEDGER_COLUMNS =
  'entry_class, category, cost_class, supplier, source_system, provenance, charge_observation, amount, native_currency, occurred_at, period_start, household_id, campaign_ref';

async function readLedgerEntries(supabaseAdmin, period) {
  const probe = await supabaseAdmin.from('financial_entries').select('id').limit(0);
  if (probe.error) return { connected: false, entries: null };
  const { data, error } = await supabaseAdmin
    .from('financial_entries')
    .select(LEDGER_COLUMNS)
    .gte('occurred_at', new Date(period.startMs).toISOString())
    .lt('occurred_at', new Date(period.endMs).toISOString())
    .limit(50000);
  if (error) return { connected: true, entries: null, error: error.message };
  return { connected: true, entries: data || [] };
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

  const [stripe, twilio, callStats, price, appleCount, ledger, manual, subscriptions, monitoredMinutes] = await Promise.all([
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
    readLedgerEntries(supabaseAdmin, period),
    getManualCostConnection(supabaseAdmin),
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
    fixedCostSettings: resolveFixedCostSettings(process.env, now),
    manualCostsConnected: manual.connected,
  });

  const c = subscriptions.available ? subscriptions.counts : null;
  const pnl = buildProfitAndLoss({
    period,
    ledgerEntries: ledger.entries,
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
      ledger: ledger.connected ? (ledger.error ? `connected (read error: ${ledger.error})` : 'connected') : 'not connected (migration 048 not applied)',
      manualCosts: manual.connected ? 'connected' : manual.reason,
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
