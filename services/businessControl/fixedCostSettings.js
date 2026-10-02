// Business control dashboard — the fixed-cost settings interface for
// suppliers with no billing integration (Railway, Supabase, Resend).
//
// Builds on the EXISTING settings read by services/businessMetrics/
// config.js (BUSINESS_FIXED_COST_RAILWAY_GBP / _SUPABASE_GBP /
// _RESEND_GBP), which stay the single source of the amount. This adds:
//   - one optional companion setting per supplier, *_AS_OF (YYYY-MM-DD):
//     the date the figure was last checked against the supplier's
//     billing page, so a stale figure is visible instead of silently
//     trusted;
//   - where each figure comes from, so whoever maintains it knows exactly
//     what to read;
//   - an honest status per supplier: NOT_CONNECTED (unset/invalid),
//     MANUAL (set, recently checked) or MANUAL + stale (older than
//     STALE_AFTER_DAYS, or never dated).
//
// Semantics of the amount (see DECISION REQUIRED in
// docs/admin/BUSINESS_CONTROL_DASHBOARD.md): the full monthly amount in
// GBP as billed. An explicit "0" is a real, entered £0 (e.g. Resend free
// tier) and is shown as MANUAL £0 — it is a statement, not an absence.
// These are settings (Railway variables), so changing one redeploys the
// service; that is why manual_cost_schedules (migration 050) is the
// long-term home for costs that change often.
'use strict';

const STALE_AFTER_DAYS = 45;

const FIXED_COST_SETTINGS = [
  {
    supplier: 'railway',
    category: 'hosting',
    label: 'Railway (hosting)',
    amountVar: 'BUSINESS_FIXED_COST_RAILWAY_GBP',
    asOfVar: 'BUSINESS_FIXED_COST_RAILWAY_AS_OF',
    howToFind: 'Railway → Workspace → Usage / Billing: the current plan fee plus the month\'s usage estimate (or the last invoice).',
  },
  {
    supplier: 'supabase',
    category: 'database',
    label: 'Supabase (database)',
    amountVar: 'BUSINESS_FIXED_COST_SUPABASE_GBP',
    asOfVar: 'BUSINESS_FIXED_COST_SUPABASE_AS_OF',
    howToFind: 'Supabase → Organization → Billing: plan fee plus usage for BOTH production and staging projects.',
  },
  {
    supplier: 'resend',
    category: 'email',
    label: 'Resend (email)',
    amountVar: 'BUSINESS_FIXED_COST_RESEND_GBP',
    asOfVar: 'BUSINESS_FIXED_COST_RESEND_AS_OF',
    howToFind: 'Resend → Settings → Billing: plan fee (enter 0 while on the free tier).',
  },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseAmount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: false, reason: 'not set' };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: false, reason: `invalid value "${String(raw).slice(0, 20)}"` };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

function parseAsOf(raw) {
  if (typeof raw !== 'string' || !DATE.test(raw.trim())) return null;
  const d = new Date(raw.trim() + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw.trim() ? null : raw.trim();
}

// Pure — one status per supplier. `now` is a Date.
function resolveFixedCostSettings(env = process.env, now = new Date()) {
  return FIXED_COST_SETTINGS.map((s) => {
    const amount = parseAmount(env[s.amountVar]);
    const asOf = parseAsOf(env[s.asOfVar]);
    const ageDays = asOf ? Math.floor((now.getTime() - Date.parse(asOf + 'T00:00:00Z')) / 86400000) : null;
    if (!amount.ok) {
      return { ...s, configured: false, valueGbp: null, asOf, ageDays, stale: false, provenance: 'NOT_CONNECTED', note: `${s.amountVar} ${amount.reason}` };
    }
    const stale = asOf === null || ageDays > STALE_AFTER_DAYS || ageDays < 0;
    const when = asOf ? `checked ${asOf}${ageDays > STALE_AFTER_DAYS ? ` (${ageDays} days ago — re-check)` : ''}` : `no ${s.asOfVar} date — re-check and date it`;
    return { ...s, configured: true, valueGbp: amount.value, asOf, ageDays, stale, provenance: 'MANUAL', note: `Monthly figure from ${s.amountVar}, ${when}` };
  });
}

module.exports = { FIXED_COST_SETTINGS, STALE_AFTER_DAYS, resolveFixedCostSettings };
