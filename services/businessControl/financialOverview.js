// Business control centre — gathers the Finance tab's inputs (read-only)
// and hands them to financialReadModel.js.
//
// Source selection (explicit, never silent):
//   - Finance ledger views (finance_monthly_contribution etc., migration
//     051, owned by the Finance workstream) are used ONLY when the views
//     exist AND BUSINESS_FINANCE_LEDGER_VIEWS=enabled. That switch makes
//     the move to ledger figures a deliberate, reviewed step.
//   - Otherwise the interim live sources: Stripe (genuine customers only;
//     test mode never shown as revenue), Twilio's own totals, the OpenAI
//     estimate, and the Railway/Supabase/Resend fixed-cost settings.
'use strict';

const { buildLiveLines, linesFromFinanceViews, buildProfitAndLoss, monthToDatePeriod } = require('./financialReadModel');
const { resolveFixedCostSettings } = require('./fixedCostSettings');
const { classifyHouseholdForBusiness } = require('./definitions');

function resolve(path, key) {
  try {
    return require(path)[key];
  } catch (err) {
    return null;
  }
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows || []) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
}

// Unknown-caller minutes for unit economics, from the same rule as
// Operations → Usage & cost safety: monitoredMinutes = how long live
// monitoring ran (monitored_duration_seconds); unknownCallMinutes = the
// unknown callers' call durations (inbound telephony). They differ: a
// call over the monitoring limit, or one never monitored, still bills
// inbound minutes. Unmeasured calls are counted, never treated as 0.
// Paginated (see selectAll.js); null when unreadable.
async function readCallMinutes(supabaseAdmin, period) {
  const { selectAll } = require('./selectAll');
  const { summariseMinutes } = require('./usageSafety');
  const res = await selectAll(() => supabaseAdmin
    .from('calls')
    .select('status, result, duration_seconds, monitored_duration_seconds, monitoring_limit_reached, warning_sent')
    .eq('status', 'Unknown')
    .gte('created_at', new Date(period.startMs).toISOString())
    .order('created_at', { ascending: true }));
  if (res.error) return null;
  const m = summariseMinutes(res.data);
  return {
    monitoredMinutes: m.monitoredMinutes,
    unknownCallMinutes: m.unknownCallMinutes,
    unmeasuredCalls: m.callsWithoutDuration + m.unknownCallsWithoutMonitoringRecord,
    truncated: res.truncated,
  };
}

async function readFinanceViews(supabaseAdmin, period) {
  const month = new Date(period.startMs).toISOString().slice(0, 10);
  const probe = await supabaseAdmin.from('finance_monthly_contribution').select('reporting_month').limit(0);
  if (probe.error) return { available: false, reason: 'Finance ledger views not present (migration 051 not applied here)' };
  const [contribution, summary, infra] = await Promise.all([
    supabaseAdmin.from('finance_monthly_contribution').select('*').eq('reporting_month', month).eq('native_currency', 'GBP').maybeSingle(),
    supabaseAdmin.from('finance_monthly_summary').select('dashboard_bucket, amount_quality, signed_total, entries_without_amount').eq('reporting_month', month).eq('native_currency', 'GBP'),
    supabaseAdmin.from('finance_entries_reporting').select('supplier, signed_total').eq('reporting_month', month).eq('native_currency', 'GBP').eq('dashboard_bucket', 'infrastructure'),
  ]);
  for (const r of [contribution, summary, infra]) if (r.error) return { available: false, reason: `Finance views read failed: ${r.error.message}` };
  return { available: true, lines: linesFromFinanceViews({ contribution: contribution.data, bucketRows: summary.data || [], infrastructureBySupplier: infra.data || [] }) };
}

async function getFinancialOverview(now = new Date(), env = process.env) {
  const supabaseAdmin = resolve('../supabaseClients', 'supabaseAdmin');
  if (!supabaseAdmin) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  const { getTwilioAccountSnapshot } = require('../businessMetrics/twilioCosts');
  const { estimateOpenAiCostGbp } = require('../businessMetrics/openaiCosts');
  const { getCallStatsMtd } = require('../businessMetrics/callStats');
  const { resolveVatRate } = require('../businessMetrics/config');
  const { getClassificationMap } = require('../businessMetrics/accountClassification');
  const { getGenuineStripeRevenue } = require('./stripeRevenue');

  const period = monthToDatePeriod(now);
  const [hRes, eRes, sRes, classification] = await Promise.all([
    supabaseAdmin.from('households').select('id, email, stripe_customer_id, twilio_number, activation_verified_at, voice_client_registered_at, delivery_verified_at'),
    require('../commercial/householdCommercialIndex').selectEntitlementsWithEnvironment(supabaseAdmin), // 2026-10-04 MI-1: + store environment (053), tolerant
    supabaseAdmin.from('subscriptions').select('household_id, status, cancel_at_period_end, updated_at'),
    getClassificationMap(),
  ]);
  for (const r of [hRes, eRes, sRes]) if (r.error) return { available: false, reason: r.error.message };
  if (!classification.available) return { available: false, reason: classification.reason };

  const entsBy = groupBy(eRes.data, 'household_id');
  const subsBy = groupBy(sRes.data, 'household_id');
  const biz = (hRes.data || []).map((h) => classifyHouseholdForBusiness({ household: h, entitlements: entsBy.get(h.id) || [], subscriptions: subsBy.get(h.id) || [], classification: classification.map.get(h.id) }, now));
  const genuineByCustomer = new Map();
  // 2026-10-04 (MI-1a): attribute by the canonical commercial status (same rule as the Overview).
  (hRes.data || []).forEach((h, i) => { if (h.stripe_customer_id && biz[i].isGenuinePayingCustomer) genuineByCustomer.set(h.stripe_customer_id, h.id); });

  const ledgerSwitch = env.BUSINESS_FINANCE_LEDGER_VIEWS === 'enabled';
  const [views, stripeRevenue, twilio, callStats, callMinutes] = await Promise.all([
    ledgerSwitch ? readFinanceViews(supabaseAdmin, period) : Promise.resolve({ available: false, reason: 'Ledger views not enabled (BUSINESS_FINANCE_LEDGER_VIEWS)' }),
    getGenuineStripeRevenue({ stripe: resolve('../stripeClient', 'stripe'), genuineByCustomer, vatRate: resolveVatRate(), now, env }),
    getTwilioAccountSnapshot({}),
    getCallStatsMtd(),
    readCallMinutes(supabaseAdmin, period),
  ]);

  const useViews = views.available && views.lines;
  const lines = useViews
    ? views.lines
    : buildLiveLines({
        stripeRevenue,
        twilio,
        openaiEstimate: estimateOpenAiCostGbp(callStats.available ? callStats.unknownMonitoredCalls : 0),
        fixedCostSettings: resolveFixedCostSettings(env, now),
        manualCostsConnected: false,
      });

  const pnl = buildProfitAndLoss({
    period,
    lines,
    source: useViews ? 'finance_ledger_views' : 'interim_live_sources',
    units: {
      accountsWithAccess: biz.filter((b) => b.accountClass !== 'deleted' && b.membership === 'current').length,
      genuinePayingCustomers: biz.filter((b) => b.isGenuinePayingCustomer).length,
      monitoredMinutes: callMinutes ? callMinutes.monitoredMinutes : null,
      unknownCallMinutes: callMinutes ? callMinutes.unknownCallMinutes : null,
      minutesIncomplete: callMinutes ? callMinutes.unmeasuredCalls > 0 || callMinutes.truncated : null,
    },
  });

  // Spend safety (Pricing Safety's layer; NOT CONNECTED until shipped).
  const { loadFinancialSafety } = require('./financialSafetyAdapter');
  const safety = await loadFinancialSafety({ now });

  return {
    available: true,
    generatedAt: now.toISOString(),
    ...pnl,
    safety,
    stripeMode: stripeRevenue.available ? stripeRevenue.mode : 'unavailable',
    fixedCostSettings: resolveFixedCostSettings(env, now).map((f) => ({ supplier: f.supplier, label: f.label, amountVar: f.amountVar, asOfVar: f.asOfVar, configured: f.configured, valueGbp: f.valueGbp, asOf: f.asOf, stale: f.stale, howToFind: f.howToFind })),
    connections: {
      source: useViews ? 'Finance ledger views (migration 051)' : `Interim live sources — ${views.reason}`,
      stripe: stripeRevenue.available ? `connected (read-only), ${stripeRevenue.mode} mode` : stripeRevenue.reason,
      twilio: twilio.available ? 'connected (read-only usage records)' : twilio.reason,
      openai: 'estimate only (organisation cost API needs an Admin key)',
      railway: 'no billing integration — monthly setting',
      supabase: 'no billing integration — monthly setting',
      resend: 'no billing integration — monthly setting',
      appStore: 'App Store Connect reports not connected',
      advertising: 'no spend source yet',
      spendMonitor: safety.state === 'not_connected' ? 'not connected — ' + safety.reason : `${safety.state} (as of ${safety.asOf || 'unknown'})`,
    },
  };
}

module.exports = { getFinancialOverview, readFinanceViews };
