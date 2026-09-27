// Business control centre — Finance read model (pure).
//
// Presents, month to date:
//   Revenue ex VAT (genuine customers only)
//   − Payment fees − Telephony − AI/transcription      = Gross contribution
//   − Railway − Supabase − Resend − Other               = Operating contribution
//   (Advertising shown separately, before marketing)
//   Total operating cost = every cost line above except advertising
// Every line carries its provenance — ACTUAL / ALLOCATED / ESTIMATED /
// MANUAL / NOT_CONNECTED — and a basis. A NOT_CONNECTED line has no
// amount (never £0) and makes every total containing it "incomplete".
// Amounts are GBP; nothing in another currency is added in without an
// explicit, displayed conversion.
//
// Two input adapters, one output shape:
//   buildLiveLines()        — interim: Stripe (genuine customers only,
//                             never in test mode), Twilio totals, the
//                             OpenAI estimate and fixed-cost settings.
//   linesFromFinanceViews() — the Finance workstream's ledger reporting
//                             interface (finance_monthly_contribution +
//                             finance_entries_reporting, migration 051;
//                             docs/finance/LEDGER_REPORTING_INTERFACE.md on
//                             the ledger branch). The dashboard reads those
//                             views; it never aggregates financial_entries
//                             itself or keeps its own cost tables.
'use strict';

const PROVENANCE = {
  ACTUAL: 'ACTUAL',
  ALLOCATED: 'ALLOCATED',
  ESTIMATED: 'ESTIMATED',
  MANUAL: 'MANUAL',
  NOT_CONNECTED: 'NOT_CONNECTED',
};

const LINE_ORDER = [
  ['revenue_ex_vat', 'Revenue ex VAT (genuine customers)', 'revenue'],
  ['payment_fees', 'Payment fees', 'direct'],
  ['telephony', 'Telephony', 'direct'],
  ['ai_transcription', 'AI / transcription', 'direct'],
  ['railway', 'Railway', 'overhead'],
  ['supabase', 'Supabase', 'overhead'],
  ['resend', 'Resend', 'overhead'],
  ['other', 'Other', 'overhead'],
  ['advertising', 'Advertising / marketing', 'marketing'],
];

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

function notConnected(basis) {
  return { amountGbp: null, provenance: PROVENANCE.NOT_CONNECTED, basis };
}

function gbp(map) {
  return map && Number.isFinite(Number(map.GBP)) ? Number(map.GBP) : 0;
}

function otherCurrencies(map) {
  return Object.keys(map || {}).filter((c) => c !== 'GBP' && Number(map[c]) !== 0);
}

// Interim live adapter.
function buildLiveLines({ stripeRevenue, twilio, openaiEstimate, fixedCostSettings, manualCostsConnected = false }) {
  const lines = {};

  if (!stripeRevenue || !stripeRevenue.available) {
    lines.revenue_ex_vat = notConnected(`Stripe unavailable: ${(stripeRevenue && stripeRevenue.reason) || 'not configured'}`);
    lines.payment_fees = notConnected('Stripe unavailable');
  } else if (stripeRevenue.mode !== 'live') {
    lines.revenue_ex_vat = notConnected(`Stripe is in ${String(stripeRevenue.mode).toUpperCase()} mode in this environment — test payments are never shown as revenue`);
    lines.payment_fees = notConnected(`Stripe ${stripeRevenue.mode} mode`);
  } else {
    const c = stripeRevenue.collectedThisMonth;
    const foreign = otherCurrencies(c.genuine);
    const nonGenuine = Object.entries(c.otherNonGenuine || {});
    lines.revenue_ex_vat = {
      amountGbp: round2(gbp(c.genuineExVat)),
      provenance: PROVENANCE.ESTIMATED,
      basis: `£${gbp(c.genuine).toFixed(2)} collected from ${c.genuineCharges} genuine-customer payment(s) (Stripe, net of refunds) less VAT at ${Math.round(stripeRevenue.vatRate * 100)}% — the VAT split is calculated; confirm treatment with your accountant`
        + (foreign.length ? `; ${foreign.join(', ')} amounts not converted` : '')
        + (nonGenuine.length ? `; excludes receipts from non-genuine accounts (${nonGenuine.map(([k, v]) => k + ' ' + Number(v).toFixed(2)).join(', ')})` : ''),
    };
    lines.payment_fees = c.feesMissing
      ? notConnected(`${c.feesMissing} genuine payment(s) had no fee record — not shown rather than understated`)
      : { amountGbp: round2(gbp(c.genuineFees)), provenance: PROVENANCE.ACTUAL, basis: `Stripe's own fee on each genuine-customer payment (${c.genuineCharges})` };
  }

  if (twilio && twilio.available) {
    lines.telephony = {
      amountGbp: round2(twilio.spendMtdGbp),
      provenance: PROVENANCE.ACTUAL,
      basis: `Twilio's own month-to-date total (rental £${Number(twilio.spendMtdSplit.numberRentalGbp).toFixed(2)} + usage £${Number(twilio.spendMtdSplit.callUsageGbp).toFixed(2)}). Includes numbers not linked to production households — see Overview.`,
    };
  } else {
    lines.telephony = notConnected(`Twilio unavailable: ${(twilio && twilio.reason) || 'not configured'}`);
  }

  lines.ai_transcription = openaiEstimate
    ? { amountGbp: round2(openaiEstimate.estimatedCostGbp), provenance: PROVENANCE.ESTIMATED, basis: `${openaiEstimate.unknownCallCount} monitored call(s) × ${openaiEstimate.assumedAvgMinutesPerCall} min assumed × configured USD rate, converted at ${openaiEstimate.fxRateUsdToGbp} USD→GBP (configured). OpenAI's actual costs need an Admin API key.` }
    : notConnected('No OpenAI estimate available');

  const bySupplier = Object.fromEntries((fixedCostSettings || []).map((f) => [f.supplier, f]));
  for (const supplier of ['railway', 'supabase', 'resend']) {
    const f = bySupplier[supplier];
    lines[supplier] = f && f.configured
      ? { amountGbp: round2(f.valueGbp), provenance: PROVENANCE.MANUAL, stale: !!f.stale, checkedAt: f.asOf, basis: `${f.note} — full month, not pro-rated` }
      : notConnected(f ? `Not set — ${f.howToFind} Then set ${f.amountVar} and ${f.asOfVar}.` : 'No setting defined');
  }

  lines.other = notConnected(manualCostsConnected ? 'No other costs recorded for this period' : 'Other costs need the Finance ledger (migration 051) and manual cost schedules — not connected');
  lines.advertising = notConnected('No advertising spend source yet (ledger + manual costs, or an ad-platform import)');
  return lines;
}

// Ledger adapter over the Finance reporting views (contract:
// LEDGER_REPORTING_INTERFACE.md). `contribution`: the GBP row of
// finance_monthly_contribution for the month. `bucketRows`: GBP rows of
// finance_monthly_summary for the month ({ dashboard_bucket,
// amount_quality, signed_total, entries_without_amount }).
// `infrastructureBySupplier`: GBP rows { supplier, signed_total } from
// finance_entries_reporting where dashboard_bucket = 'infrastructure'.
// Signed totals: revenue positive; tax, fees and costs negative.
function linesFromFinanceViews({ contribution, bucketRows = [], infrastructureBySupplier = [] }) {
  if (!contribution) return null;
  const neg = (v) => (v === null || v === undefined ? null : round2(-Number(v)));
  const bucket = (name) => {
    const rows = bucketRows.filter((r) => r.dashboard_bucket === name);
    if (!rows.length) return null;
    const qualities = [...new Set(rows.filter((r) => Number(r.signed_total || 0) !== 0).map((r) => r.amount_quality))].filter((q) => q !== 'UNKNOWN');
    const unpriced = rows.reduce((a, r) => a + Number(r.entries_without_amount || 0), 0);
    return {
      amountGbp: neg(rows.reduce((a, r) => a + Number(r.signed_total || 0), 0)),
      provenance: qualities.length === 1 ? qualities[0] : qualities.length ? 'MIXED' : PROVENANCE.ACTUAL,
      basis: `finance_monthly_summary: ${name}${unpriced ? ` · ${unpriced} item(s) not yet priced (not counted as £0)` : ''}`,
    };
  };
  const overallQuality = Number(contribution.estimated_or_allocated_part || 0) !== 0 ? 'MIXED' : PROVENANCE.ACTUAL;
  const lines = {
    revenue_ex_vat: { amountGbp: round2(Number(contribution.revenue || 0) + Number(contribution.tax || 0)), provenance: overallQuality, basis: 'finance_monthly_contribution: revenue − tax' },
    payment_fees: bucket('payment_fees') || { amountGbp: neg(contribution.payment_fees), provenance: overallQuality, basis: 'finance_monthly_contribution: payment_fees' },
    telephony: bucket('telephony') || notConnected('No telephony rows in the ledger for this month'),
    ai_transcription: bucket('ai_transcription') || notConnected('No AI/transcription rows in the ledger for this month'),
  };
  const infra = {};
  for (const r of infrastructureBySupplier) infra[r.supplier] = (infra[r.supplier] || 0) + Number(r.signed_total || 0);
  for (const supplier of ['railway', 'supabase', 'resend']) {
    lines[supplier] = supplier in infra ? { amountGbp: neg(infra[supplier]), provenance: PROVENANCE.MANUAL, basis: `finance_entries_reporting: infrastructure / ${supplier}` } : notConnected(`No ${supplier} entries in the ledger for this month`);
  }
  const otherSuppliers = Object.keys(infra).filter((s) => !['railway', 'supabase', 'resend'].includes(s));
  const otherBucket = bucket('other');
  const otherTotal = otherSuppliers.reduce((acc, s) => acc + infra[s], 0) + (otherBucket ? -otherBucket.amountGbp : 0);
  lines.other = otherSuppliers.length || otherBucket ? { amountGbp: neg(otherTotal), provenance: PROVENANCE.MANUAL, basis: 'Other infrastructure suppliers + ledger bucket "other"' } : notConnected('No other costs in the ledger for this month');
  lines.advertising = bucket('advertising') || notConnected('No advertising rows in the ledger for this month');
  return lines;
}

// A total never manufactures precision:
//   - every part known      → amount, complete
//   - some parts known      → amount of the KNOWN parts only, partial=true
//                             (shown as "known part only", never as the total)
//   - no part known         → amount null (NOT CONNECTED)
function total(lines, ids) {
  const known = ids.map((id) => lines[id]).filter((l) => l && l.amountGbp !== null && l.amountGbp !== undefined);
  const missing = ids.filter((id) => !lines[id] || lines[id].amountGbp === null || lines[id].amountGbp === undefined);
  const mix = {};
  for (const l of known) mix[l.provenance] = (mix[l.provenance] || 0) + 1;
  return {
    amountGbp: known.length ? round2(known.reduce((acc, l) => acc + Number(l.amountGbp), 0)) : null,
    complete: missing.length === 0,
    partial: missing.length > 0 && known.length > 0,
    missing,
    provenanceMix: mix,
  };
}

// Pure — the P&L in the requested order.
function buildProfitAndLoss({ period, lines, source, units }) {
  const ordered = LINE_ORDER.map(([id, label, section]) => ({ id, label, section, ...(lines[id] || notConnected('No source')) }));
  const revenue = total(lines, ['revenue_ex_vat']);
  const direct = total(lines, ['payment_fees', 'telephony', 'ai_transcription']);
  const overhead = total(lines, ['railway', 'supabase', 'resend', 'other']);
  // A result (revenue − costs) is only computed when revenue is known AND
  // every cost is known; otherwise there is no honest figure to show.
  const minus = (a, b) => {
    const complete = a.complete && b.complete;
    return { amountGbp: complete ? round2(a.amountGbp - b.amountGbp) : null, complete, partial: false, missing: [...a.missing, ...b.missing] };
  };
  const grossContribution = minus(revenue, direct);
  const operatingContribution = minus(grossContribution, overhead);
  const totalOperatingCost = total(lines, ['payment_fees', 'telephony', 'ai_transcription', 'railway', 'supabase', 'resend', 'other']);
  const u = units || {};
  const per = (t, n) => (n && t.amountGbp !== null ? { amountGbp: round2(t.amountGbp / n), complete: t.complete, partial: !!t.partial } : null);
  return {
    period: { label: period.label, start: new Date(period.startMs).toISOString(), end: new Date(period.endMs).toISOString() },
    source,
    lines: ordered,
    totals: { revenueExVat: revenue, directCost: direct, grossContribution, overheadCost: overhead, operatingContribution, totalOperatingCost, marketing: total(lines, ['advertising']) },
    unitEconomics: {
      accountsWithAccess: u.accountsWithAccess ?? null,
      genuinePayingCustomers: u.genuinePayingCustomers ?? null,
      operatingCostPerAccountWithAccess: per(totalOperatingCost, u.accountsWithAccess),
      telephonyPerAccountWithAccess: lines.telephony && lines.telephony.amountGbp !== null && u.accountsWithAccess ? { amountGbp: round2(lines.telephony.amountGbp / u.accountsWithAccess), complete: true } : null,
      revenueExVatPerGenuinePayingCustomer: per(revenue, u.genuinePayingCustomers),
      monitoredMinutes: u.monitoredMinutes ?? null,
      customerAcquisitionCost: { amountGbp: null, provenance: PROVENANCE.NOT_CONNECTED, basis: 'Needs attributed paying customers (migration 049) and advertising spend (ledger)' },
    },
  };
}

function monthToDatePeriod(now) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return { label: 'Month to date', startMs: start, endMs: now.getTime() + 1 };
}

module.exports = { PROVENANCE, LINE_ORDER, buildLiveLines, linesFromFinanceViews, buildProfitAndLoss, monthToDatePeriod };
