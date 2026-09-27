// Business control dashboard (2026-09-27) — Financial / profitability
// read model. Pure and unit-tested (tests/business-control.test.mjs).
//
// This does NOT create a second ledger. The money ledger is
// financial_entries (migration 048, feature/provider-neutral-billing-
// ledger, docs/architecture/FINANCIAL_DATA_ARCHITECTURE.md). This module
// only READS money figures and presents them as P&L lines, each with an
// honest provenance label:
//
//   ACTUAL        — the supplier's own reported figure (Stripe balance
//                   transactions, Twilio usage records, ledger
//                   provider_actual rows)
//   ALLOCATED     — a real supplier total apportioned by HCG (ledger
//                   provider_allocated rows)
//   ESTIMATED     — calculated by HCG from assumptions (OpenAI from call
//                   counts, VAT at the configured rate, Apple gross from
//                   entitlement count × list price)
//   MANUAL        — entered by the administrator (fixed-cost settings
//                   today; manual_cost_schedules → ledger 'manual' rows
//                   once migrations 048 + 050 are applied)
//   NOT_CONNECTED — no data source exists yet. Never shown as £0.
//
// Line by line, a figure comes from the ledger when the ledger holds
// matching entries for the period, otherwise from the live source that
// exists on origin/main today. So the dashboard works now and moves onto
// the ledger automatically, category by category, as the ledger fills —
// with no dashboard change.
'use strict';

const PROVENANCE = {
  ACTUAL: 'ACTUAL',
  ALLOCATED: 'ALLOCATED',
  ESTIMATED: 'ESTIMATED',
  MANUAL: 'MANUAL',
  NOT_CONNECTED: 'NOT_CONNECTED',
};

// Must stay identical to services/ledger/contract.js PROVENANCE on the
// ledger branch (tests/business-control.test.mjs checks this whenever
// that module exists in the tree).
const LEDGER_PROVENANCE_MAP = {
  provider_actual: PROVENANCE.ACTUAL,
  provider_allocated: PROVENANCE.ALLOCATED,
  estimated: PROVENANCE.ESTIMATED,
  manual: PROVENANCE.MANUAL,
};

const SECTIONS = {
  REVENUE: 'revenue',
  DEDUCTIONS: 'deductions',
  VARIABLE: 'variable',
  FIXED: 'fixed',
  MARKETING: 'marketing',
};

// Each line: which ledger rows it sums (entry_class + categories, and
// optionally suppliers), and which live source key it falls back to.
// Categories are exactly the ledger contract's taxonomy.
const LINE_DEFINITIONS = [
  { id: 'revenue_stripe', section: SECTIONS.REVENUE, label: 'Subscriptions — Stripe (web/Android)', ledger: { entryClass: 'revenue', categories: ['subscription'], suppliers: ['stripe'] } },
  { id: 'revenue_app_stores', section: SECTIONS.REVENUE, label: 'Subscriptions — App Store / Google Play', ledger: { entryClass: 'revenue', categories: ['subscription'], suppliers: ['apple', 'google'] } },
  { id: 'refunds', section: SECTIONS.DEDUCTIONS, label: 'Refunds', ledger: { entryClass: 'refund', categories: ['refund'] } },
  { id: 'vat_output', section: SECTIONS.DEDUCTIONS, label: 'VAT on UK sales', ledger: { entryClass: 'tax', categories: ['vat_output'] } },
  { id: 'payment_fees', section: SECTIONS.VARIABLE, label: 'Payment processing fees', ledger: { entryClass: 'fee', categories: ['payment_processing_fee'] } },
  { id: 'store_commission', section: SECTIONS.VARIABLE, label: 'App store commission', ledger: { entryClass: 'fee', categories: ['store_commission'] } },
  { id: 'telephony_usage', section: SECTIONS.VARIABLE, label: 'Telephony usage (calls, media streams, TTS, SMS)', ledger: { entryClass: 'cost', categories: ['inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts', 'sms', 'platform_fee'] } },
  { id: 'number_rental', section: SECTIONS.VARIABLE, label: 'Phone number rental & capacity', ledger: { entryClass: 'cost', categories: ['number_rental', 'channel_capacity'] } },
  { id: 'ai_transcription', section: SECTIONS.VARIABLE, label: 'AI / transcription', ledger: { entryClass: 'cost', categories: ['transcription', 'ai_inference'] } },
  { id: 'hosting', section: SECTIONS.FIXED, label: 'Hosting (Railway)', ledger: { entryClass: 'cost', categories: ['hosting'] } },
  { id: 'database', section: SECTIONS.FIXED, label: 'Database (Supabase)', ledger: { entryClass: 'cost', categories: ['database'] } },
  { id: 'email', section: SECTIONS.FIXED, label: 'Email (Resend)', ledger: { entryClass: 'cost', categories: ['email'] } },
  { id: 'other_overhead', section: SECTIONS.FIXED, label: 'Other overheads (developer programmes, domains, SaaS, insurance, accountancy…)', ledger: { entryClass: 'cost', categories: ['developer_program', 'domain', 'saas', 'insurance', 'accountancy', 'other_overhead', 'other'] } },
  { id: 'advertising', section: SECTIONS.MARKETING, label: 'Advertising & marketing', ledger: { entryClass: 'cost', categories: ['advertising', 'acquisition_other'] } },
];

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

function inPeriod(entry, period) {
  const t = Date.parse(entry.occurred_at || entry.period_start || '');
  if (Number.isNaN(t)) return false;
  return t >= period.startMs && t < period.endMs;
}

// Pure — sums ledger rows for one line definition within the period.
// GBP only: rows in another currency are counted and excluded (fx_rates
// is reporting-only and not built yet), never silently converted.
// A row with a null amount (a charge not yet observed) is never a zero.
function aggregateLedgerLine(entries, def, period) {
  const matched = (entries || []).filter(
    (e) =>
      e.entry_class === def.ledger.entryClass &&
      def.ledger.categories.includes(e.category) &&
      (!def.ledger.suppliers || def.ledger.suppliers.includes(e.supplier)) &&
      inPeriod(e, period)
  );
  if (matched.length === 0) return null;

  let amount = 0;
  let unobserved = 0;
  let nonGbp = 0;
  const provenanceMix = {};
  for (const e of matched) {
    if (e.native_currency && e.native_currency !== 'GBP') {
      nonGbp += 1;
      continue;
    }
    if (e.amount === null || e.amount === undefined) {
      unobserved += 1;
      continue;
    }
    amount += Number(e.amount);
    const p = LEDGER_PROVENANCE_MAP[e.provenance] || PROVENANCE.ESTIMATED;
    provenanceMix[p] = (provenanceMix[p] || 0) + 1;
  }
  const kinds = Object.keys(provenanceMix);
  return {
    amountGbp: kinds.length ? round2(amount) : null,
    provenance: kinds.length === 0 ? PROVENANCE.NOT_CONNECTED : kinds.length === 1 ? kinds[0] : 'MIXED',
    provenanceMix,
    source: 'ledger',
    entryCount: matched.length,
    unobservedEntries: unobserved,
    excludedNonGbpEntries: nonGbp,
    basis: unobserved || nonGbp
      ? `financial_entries: ${matched.length} rows (${unobserved} charge(s) not yet observed, ${nonGbp} non-GBP row(s) excluded)`
      : `financial_entries: ${matched.length} rows`,
  };
}

// Pure — the live (pre-ledger) value for each line, from snapshots that
// already exist on origin/main. Returns a map line id → figure.
function buildLiveFigures({ stripe, twilio, openaiEstimate, appleEstimate, vatRate, fixedCostsStatus, fixedCostSettings = null, manualCostsConnected }) {
  const figures = {};
  const notConnected = (basis) => ({ amountGbp: null, provenance: PROVENANCE.NOT_CONNECTED, source: 'none', basis });

  if (stripe && stripe.available) {
    figures.revenue_stripe = { amountGbp: round2(stripe.grossRevenueMtdGbp), provenance: PROVENANCE.ACTUAL, source: 'stripe', basis: `Stripe balance transactions (charges), ${stripe.chargeCountMtd} this month` };
    figures.refunds = { amountGbp: round2(stripe.refundsMtdGbp), provenance: PROVENANCE.ACTUAL, source: 'stripe', basis: 'Stripe balance transactions (refunds)' };
    figures.payment_fees = { amountGbp: round2(stripe.stripeFeesMtdGbp), provenance: PROVENANCE.ACTUAL, source: 'stripe', basis: 'Stripe fees on this month\'s charges' };
    const vatBase = (stripe.grossRevenueMtdGbp || 0) - (stripe.refundsMtdGbp || 0);
    figures.vat_output = {
      amountGbp: round2(vatBase - vatBase / (1 + vatRate)),
      provenance: PROVENANCE.ESTIMATED,
      source: 'calculated',
      basis: `${Math.round(vatRate * 100)}% VAT inside VAT-inclusive Stripe receipts net of refunds (confirm treatment with your accountant)`,
    };
  } else {
    const reason = `Stripe unavailable: ${(stripe && stripe.reason) || 'not configured'}`;
    figures.revenue_stripe = notConnected(reason);
    figures.refunds = notConnected(reason);
    figures.payment_fees = notConnected(reason);
    figures.vat_output = notConnected(reason);
  }

  if (appleEstimate && appleEstimate.activeAppleEntitlements > 0) {
    figures.revenue_app_stores = { amountGbp: round2(appleEstimate.grossRevenueEstimateGbp), provenance: PROVENANCE.ESTIMATED, source: 'calculated', basis: `${appleEstimate.activeAppleEntitlements} active Apple entitlement(s) × list price — not Apple's reported proceeds` };
    figures.store_commission = notConnected('Apple commission not available: App Store Connect reports not connected (15% vs 30% tier unconfirmed)');
  } else {
    figures.revenue_app_stores = { amountGbp: 0, provenance: PROVENANCE.ACTUAL, source: 'hcg', basis: 'No active App Store / Google Play subscriptions recorded (Android pays through Stripe)' };
    figures.store_commission = { amountGbp: 0, provenance: PROVENANCE.ACTUAL, source: 'hcg', basis: 'No app-store sales, so no commission' };
  }

  if (twilio && twilio.available && twilio.spendMtdSplit) {
    figures.telephony_usage = { amountGbp: round2(twilio.spendMtdSplit.callUsageGbp), provenance: PROVENANCE.ACTUAL, source: 'twilio', basis: 'Twilio usage records, month to date (supplier totals, not per call)' };
    figures.number_rental = { amountGbp: round2(twilio.spendMtdSplit.numberRentalGbp), provenance: PROVENANCE.ACTUAL, source: 'twilio', basis: `Twilio usage records (number rental), ${twilio.numberCount} number(s) on the account` };
  } else {
    const reason = `Twilio unavailable: ${(twilio && twilio.reason) || 'not configured'}`;
    figures.telephony_usage = notConnected(reason);
    figures.number_rental = notConnected(reason);
  }

  figures.ai_transcription = openaiEstimate
    ? { amountGbp: round2(openaiEstimate.estimatedCostGbp), provenance: PROVENANCE.ESTIMATED, source: 'calculated', basis: `${openaiEstimate.unknownCallCount} monitored call(s) × ${openaiEstimate.assumedAvgMinutesPerCall} min assumed × configured rate — OpenAI's actual costs need an Admin API key` }
    : notConnected('No OpenAI estimate available');

  const fixed = (status, label) =>
    status && status.configured
      ? { amountGbp: round2(status.valueGbp), provenance: PROVENANCE.MANUAL, source: 'settings', basis: `${label}: monthly figure from admin settings (full month, not pro-rated)` }
      : notConnected(`${label}: no billing integration and no monthly figure set`);
  if (Array.isArray(fixedCostSettings)) {
    // fixedCostSettings.js interface: amount + "checked on" date + staleness.
    const byCategory = Object.fromEntries(fixedCostSettings.map((f) => [f.category, f]));
    for (const [line, category] of [['hosting', 'hosting'], ['database', 'database'], ['email', 'email']]) {
      const f = byCategory[category];
      figures[line] = f && f.configured
        ? { amountGbp: round2(f.valueGbp), provenance: PROVENANCE.MANUAL, source: 'settings', stale: !!f.stale, basis: `${f.label}: ${f.note} (full month, not pro-rated)` }
        : notConnected(f ? `${f.label}: not set — ${f.howToFind} Then set ${f.amountVar} (and ${f.asOfVar}).` : 'No setting defined');
    }
  } else {
    figures.hosting = fixed(fixedCostsStatus && fixedCostsStatus.railway, 'Railway');
    figures.database = fixed(fixedCostsStatus && fixedCostsStatus.supabase, 'Supabase');
    figures.email = fixed(fixedCostsStatus && fixedCostsStatus.resend, 'Resend');
  }

  const manualReason = manualCostsConnected
    ? 'No manual costs entered for this period'
    : 'Manual costs not connected yet (needs ledger migration 048 + manual-cost migration 050)';
  figures.other_overhead = notConnected(manualReason);
  figures.advertising = notConnected(manualReason + '; ad-platform spend import not built');

  return figures;
}

function sumLines(lines, ids) {
  const picked = lines.filter((l) => ids.includes(l.id));
  const known = picked.filter((l) => l.amountGbp !== null && l.amountGbp !== undefined);
  const missing = picked.filter((l) => l.amountGbp === null || l.amountGbp === undefined).map((l) => l.id);
  const provenanceMix = {};
  for (const l of known) provenanceMix[l.provenance] = (provenanceMix[l.provenance] || 0) + 1;
  return {
    amountGbp: round2(known.reduce((acc, l) => acc + Number(l.amountGbp), 0)),
    complete: missing.length === 0,
    missing,
    provenanceMix,
  };
}

function combine(parts, op) {
  // op: array of [sign, total]
  const amount = parts.reduce((acc, [sign, t]) => acc + sign * (t.amountGbp || 0), 0);
  const missing = parts.flatMap(([, t]) => t.missing);
  return { amountGbp: round2(amount), complete: missing.length === 0, missing: [...new Set(missing)] };
}

function perUnit(total, count) {
  if (!count || total.amountGbp === null) return null;
  return { amountGbp: round2(total.amountGbp / count), complete: total.complete };
}

// Pure — the whole P&L for one period. `ledgerEntries` is null when
// financial_entries doesn't exist; live figures fill every line the
// ledger doesn't cover. `units` supplies denominators.
function buildProfitAndLoss({ period, ledgerEntries, liveFigures, units }) {
  const lines = LINE_DEFINITIONS.map((def) => {
    const fromLedger = ledgerEntries ? aggregateLedgerLine(ledgerEntries, def, period) : null;
    const fig = fromLedger && fromLedger.amountGbp !== null ? fromLedger : liveFigures[def.id] || { amountGbp: null, provenance: PROVENANCE.NOT_CONNECTED, source: 'none', basis: 'No source' };
    return { id: def.id, section: def.section, label: def.label, ...fig };
  });

  const gross = sumLines(lines, ['revenue_stripe', 'revenue_app_stores']);
  const deductions = sumLines(lines, ['refunds', 'vat_output']);
  const netRevenue = combine([[1, gross], [-1, deductions]]);
  const variable = sumLines(lines, ['payment_fees', 'store_commission', 'telephony_usage', 'number_rental', 'ai_transcription']);
  const telephony = sumLines(lines, ['telephony_usage', 'number_rental']);
  const contribution = combine([[1, netRevenue], [-1, variable]]);
  const fixed = sumLines(lines, ['hosting', 'database', 'email', 'other_overhead']);
  const marketing = sumLines(lines, ['advertising']);
  const operatingProfit = combine([[1, contribution], [-1, fixed], [-1, marketing]]);
  const totalCost = combine([[1, variable], [1, fixed], [1, marketing]]);

  const u = units || {};
  const unitEconomics = {
    activeCustomers: u.activeCustomers ?? null,
    genuinePayingCustomers: u.genuinePayingCustomers ?? null,
    costPerActiveCustomer: perUnit(totalCost, u.activeCustomers),
    telephonyCostPerActiveCustomer: perUnit(telephony, u.activeCustomers),
    netRevenuePerPayingCustomer: perUnit(netRevenue, u.genuinePayingCustomers),
    monitoredMinutes: u.monitoredMinutes ?? null,
    monitoredMinutesPerActiveCustomer: u.activeCustomers && u.monitoredMinutes !== null && u.monitoredMinutes !== undefined ? round2(u.monitoredMinutes / u.activeCustomers) : null,
    customerAcquisitionCost: { amountGbp: null, provenance: PROVENANCE.NOT_CONNECTED, basis: 'Needs attributed paying customers (customer_acquisition, migration 049) and advertising spend (ledger)' },
  };

  return {
    period: { label: period.label, start: new Date(period.startMs).toISOString(), end: new Date(period.endMs).toISOString() },
    ledgerConnected: !!ledgerEntries,
    lines,
    totals: {
      grossRevenue: gross,
      netRevenueExVat: netRevenue,
      variableCost: variable,
      telephonyCost: telephony,
      grossContribution: contribution,
      fixedCost: fixed,
      marketingSpend: marketing,
      totalCost,
      operatingProfit,
    },
    unitEconomics,
  };
}

// Calendar month to date in UTC, the same window the existing Stripe and
// Twilio snapshots use on Railway (server time is UTC).
function monthToDatePeriod(now) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return { label: 'Month to date', startMs: start, endMs: now.getTime() + 1 };
}

module.exports = {
  PROVENANCE,
  LEDGER_PROVENANCE_MAP,
  LINE_DEFINITIONS,
  SECTIONS,
  aggregateLedgerLine,
  buildLiveFigures,
  buildProfitAndLoss,
  monthToDatePeriod,
};
