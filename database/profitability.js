// profitability.js — READ-ONLY data access for the per-household
// profitability read model (WS2, 2026-10-10). Never writes. Every read is
// paginated (Supabase caps a response at 1,000 rows) and re-filtered in JS,
// so a partial or loosely filtered response can never inflate a figure.
// Throws on any read failure: the router answers 500, never a partial page.
'use strict';

const PAGE = 1000;

function resolveClient(client) {
  if (client) return client;
  const { supabaseAdmin } = require('../services/supabaseClients');
  if (!supabaseAdmin) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  return supabaseAdmin;
}

async function selectAll(client, table, columns, apply = (q) => q) {
  const out = [];
  for (let from = 0; from < 1e6; from += PAGE) {
    const { data, error } = await apply(client.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message || error}`);
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const t = (v) => (v ? Date.parse(v) : null);

/** Pure: raw table rows → per-household inputs for the period. */
function assembleInputs({ households, entitlements, subscriptions, accounts, profiles, holds, credits }, { start, end }) {
  const S = Date.parse(start); const E = Date.parse(end);
  const scope = new Map((profiles || []).map((p) => [p.profile, p.delivery_reserve_scope]));
  const byHh = (rows, pred = () => true) => {
    const m = new Map();
    for (const r of rows || []) { if (!r.household_id || !pred(r)) continue; if (!m.has(r.household_id)) m.set(r.household_id, []); m.get(r.household_id).push(r); }
    return m;
  };
  const ents = byHh(entitlements, (e) => ['active', 'expired', 'revoked'].includes(e.status) && t(e.starts_at) < E && (e.ends_at === null || e.ends_at === undefined || t(e.ends_at) > S));
  const subs = byHh(subscriptions);
  const accs = byHh(accounts, (a) => t(a.period_start) < E && t(a.period_end) > S);
  const held = new Set((holds || []).map((h) => h.household_id));
  const creds = byHh(credits, (c) => t(c.created_at) >= S && t(c.created_at) < E);
  return (households || []).map((h) => {
    const e = (ents.get(h.id) || []).sort((a, b) => (a.status === 'active') - (b.status === 'active') || t(a.starts_at) - t(b.starts_at)).pop() || null;
    const s = (subs.get(h.id) || []).sort((a, b) => t(a.updated_at || a.created_at) - t(b.updated_at || b.created_at)).pop() || null;
    return {
      household: { id: h.id, account_number: h.account_number || null },
      entitlement: e,
      subscription: s,
      accounts: (accs.get(h.id) || []).sort((a, b) => t(a.period_start) - t(b.period_start)).map((a) => ({ ...a, delivery_reserve_scope: scope.get(a.profile) || 'none' })),
      credits: creds.get(h.id) || [],
      held: held.has(h.id),
      numbersHeld: h.twilio_number && h.twilio_provisioning_status !== 'released' ? 1 : 0,
    };
  });
}

async function loadProfitabilityInputs({ periodStart, periodEnd, householdId = null }, client) {
  const c = resolveClient(client);
  const one = (q) => (householdId ? q.eq('household_id', householdId) : q);
  const [households, entitlements, subscriptions, accounts, profiles, holds, credits] = await Promise.all([
    selectAll(c, 'households', 'id, account_number, twilio_number, twilio_provisioning_status', (q) => (householdId ? q.eq('id', householdId) : q)),
    selectAll(c, 'entitlements', 'household_id, entitlement_type, status, source, starts_at, ends_at, revenuecat_environment, store_refunded_at, plan_code',
      (q) => one(q.lt('starts_at', periodEnd))),
    selectAll(c, 'subscriptions', 'household_id, stripe_price_id, status, created_at, updated_at', one),
    selectAll(c, 'fc_budget_accounts', '*', (q) => one(q.lt('period_start', periodEnd).gt('period_end', periodStart))),
    selectAll(c, 'fc_budget_profiles', 'profile, delivery_reserve_scope'),
    selectAll(c, 'fc_household_holds', 'household_id', one),
    selectAll(c, 'allowance_credits', 'household_id, kind, source, environment, provider_transaction_id, amount_minor, currency, applied_budget_gbp, created_at',
      (q) => one(q.gte('created_at', periodStart).lt('created_at', periodEnd))),
  ]);
  return assembleInputs({ households, entitlements, subscriptions, accounts, profiles, holds, credits }, { start: periodStart, end: periodEnd });
}

module.exports = { loadProfitabilityInputs, assembleInputs, selectAll };
