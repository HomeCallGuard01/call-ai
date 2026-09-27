// Business control dashboard (2026-09-27) — manual-cost facility.
//
// For costs with no sensible automatic source (an advertising invoice,
// Apple Developer Program, insurance, accountancy, Railway/Supabase until
// their billing APIs are connected). A schedule (public.manual_cost_
// schedules, draft migration 050) describes the cost; for each due
// period it produces exactly one ledger row in public.financial_entries
// (migration 048) with provenance 'manual' and entry_key
// 'schedule:<id>:<period>', so posting twice can never double-count.
//
// Pure functions here are unit-tested; the thin database functions check
// that BOTH tables exist and otherwise report "not connected" — they
// never create tables and never write anywhere else.
'use strict';

const COST_CATEGORIES = [
  'number_rental', 'inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts',
  'channel_capacity', 'platform_fee', 'sms', 'transcription', 'ai_inference', 'email',
  'hosting', 'database', 'domain', 'developer_program', 'saas', 'insurance', 'accountancy',
  'other_overhead', 'advertising', 'acquisition_other', 'other',
];
const COST_CLASSES = ['variable_direct', 'semi_variable', 'fixed_overhead', 'customer_acquisition'];
const CADENCES = ['one_off', 'monthly', 'annual'];
const ALLOCATION_RULES = ['none', 'per_active_customer', 'per_minute'];

// Sensible default class per category; the admin can override.
const DEFAULT_COST_CLASS = {
  advertising: 'customer_acquisition',
  acquisition_other: 'customer_acquisition',
  number_rental: 'semi_variable',
  channel_capacity: 'semi_variable',
  inbound_voice: 'variable_direct',
  app_leg: 'variable_direct',
  outbound_voice: 'variable_direct',
  media_stream: 'variable_direct',
  tts: 'variable_direct',
  platform_fee: 'variable_direct',
  sms: 'variable_direct',
  transcription: 'variable_direct',
  ai_inference: 'variable_direct',
};

const SLUG = /^[a-z][a-z0-9_]{1,31}$/;
const CAMPAIGN_REF = /^[a-z0-9_.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Pure — validates and normalises admin input. Never trusts the client.
function validateManualCostSchedule(input) {
  const errors = [];
  const raw = input || {};
  const supplier = typeof raw.supplier === 'string' ? raw.supplier.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const category = raw.category;
  const cadence = raw.cadence;
  const amount = Number(raw.amount);
  const currency = typeof raw.currency === 'string' && raw.currency ? raw.currency.trim().toUpperCase() : 'GBP';
  const startDate = raw.startDate;
  const endDate = raw.endDate ? raw.endDate : null;
  const costClass = raw.costClass || DEFAULT_COST_CLASS[category] || 'fixed_overhead';
  const allocationRule = raw.allocationRule || 'none';
  const campaignRef = typeof raw.campaignRef === 'string' && raw.campaignRef.trim() ? raw.campaignRef.trim().toLowerCase() : null;
  const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim().slice(0, 1000) : null;

  if (!SLUG.test(supplier)) errors.push('supplier must be a short name, e.g. "railway" or "meta"');
  if (!description || description.length > 200) errors.push('description is required (max 200 characters)');
  if (!COST_CATEGORIES.includes(category)) errors.push('category is not a recognised cost category');
  if (!COST_CLASSES.includes(costClass)) errors.push('cost class is not recognised');
  if (!CADENCES.includes(cadence)) errors.push('cadence must be one_off, monthly or annual');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) errors.push('amount must be a positive number');
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('currency must be a 3-letter code');
  if (!isValidDate(startDate)) errors.push('start date must be YYYY-MM-DD');
  if (endDate !== null && !isValidDate(endDate)) errors.push('end date must be YYYY-MM-DD');
  if (isValidDate(startDate) && endDate && isValidDate(endDate) && endDate < startDate) errors.push('end date is before start date');
  if (cadence === 'one_off' && endDate) errors.push('a one-off cost has no end date');
  if (!ALLOCATION_RULES.includes(allocationRule)) errors.push('allocation rule is not recognised');
  if (campaignRef && !CAMPAIGN_REF.test(campaignRef)) errors.push('campaign must look like source/medium/campaign, e.g. meta/paid_social/launch-oct');
  if (campaignRef && category !== 'advertising' && category !== 'acquisition_other') errors.push('a campaign can only be set on advertising/acquisition costs');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      supplier,
      description,
      category,
      cost_class: costClass,
      native_amount: Math.round(amount * 1e6) / 1e6,
      native_currency: currency,
      cadence,
      start_date: startDate,
      end_date: endDate,
      allocation_rule: allocationRule,
      campaign_ref: campaignRef,
      notes,
    },
  };
}

function utcDate(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

// Pure — every period of a schedule that is due on or before `now`
// (whole periods starting on/before today), bounded by end_date.
// Monthly: one per calendar month from the start month. Annual: one per
// anniversary year. One-off: a single period on start_date.
function duePeriods(schedule, now) {
  const today = utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [sy, sm, sd] = schedule.start_date.split('-').map(Number);
  const start = utcDate(sy, sm - 1, sd);
  const end = schedule.end_date ? (() => { const [ey, em, ed] = schedule.end_date.split('-').map(Number); return utcDate(ey, em - 1, ed); })() : null;
  if (start > today) return [];

  const periods = [];
  if (schedule.cadence === 'one_off') {
    periods.push({ key: 'once', start, end: new Date(start.getTime() + 24 * 3600 * 1000) });
    return periods;
  }

  const MAX = 240; // 20 years of months; a guard, not a business rule
  for (let i = 0; i < MAX; i += 1) {
    const pStart = schedule.cadence === 'monthly' ? utcDate(sy, sm - 1 + i, 1) : utcDate(sy + i, sm - 1, sd);
    if (schedule.cadence === 'monthly' && i === 0 && sd !== 1) {
      // First month begins on the actual start date.
      pStart.setTime(start.getTime());
    }
    if (pStart > today) break;
    if (end && pStart > end) break;
    const pEnd = schedule.cadence === 'monthly' ? utcDate(sy, sm + i, 1) : utcDate(sy + i + 1, sm - 1, sd);
    const key = schedule.cadence === 'monthly'
      ? `${pStart.getUTCFullYear()}-${String(pStart.getUTCMonth() + 1).padStart(2, '0')}`
      : `${pStart.getUTCFullYear()}`;
    periods.push({ key, start: pStart, end: pEnd });
  }
  return periods;
}

// Pure — the exact financial_entries row (048 columns) for one period.
// Satisfies every 048 constraint for a manual row: cost_class present
// (entry_class 'cost'), no charge_observation (not provider_actual),
// amount + currency + allocation_basis present, period_end > period_start,
// not 'final' (so no finalised_at requirement).
function toFinancialEntry(schedule, period, { createdBy = null } = {}) {
  return {
    source_system: 'manual',
    supplier: schedule.supplier,
    entry_key: `schedule:${schedule.id}:${period.key}`,
    native_reference: null,
    entry_class: 'cost',
    category: schedule.category,
    cost_class: schedule.cost_class,
    billing_model: schedule.cadence === 'one_off' ? 'other' : 'fixed_period',
    provenance: 'manual',
    charge_observation: null,
    reconciliation_status: 'provisional',
    native_amount: Number(schedule.native_amount),
    native_currency: schedule.native_currency,
    amount: Number(schedule.native_amount),
    occurred_at: period.start.toISOString(),
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    campaign_ref: schedule.campaign_ref || null,
    allocation_basis: `Manual cost schedule ${schedule.id} (${schedule.cadence}): ${schedule.description}`,
    notes: schedule.notes || null,
    created_by: createdBy,
  };
}

function resolveSupabaseAdmin() {
  try {
    return require('../supabaseClients').supabaseAdmin;
  } catch (err) {
    return null;
  }
}

// Both tables must exist (048 + 050 applied). A zero-row read; nothing
// is created or written.
async function getManualCostConnection(supabaseAdmin = resolveSupabaseAdmin()) {
  if (!supabaseAdmin) return { connected: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };
  const [schedules, ledger] = await Promise.all([
    supabaseAdmin.from('manual_cost_schedules').select('id').limit(0),
    supabaseAdmin.from('financial_entries').select('id').limit(0),
  ]);
  if (ledger.error) return { connected: false, reason: 'Ledger table financial_entries not present (migration 048 not applied)' };
  if (schedules.error) return { connected: false, reason: 'manual_cost_schedules not present (draft migration 050 not applied)' };
  return { connected: true };
}

async function listManualCostSchedules(supabaseAdmin = resolveSupabaseAdmin()) {
  const conn = await getManualCostConnection(supabaseAdmin);
  if (!conn.connected) return { connected: false, reason: conn.reason, schedules: [] };
  const { data, error } = await supabaseAdmin
    .from('manual_cost_schedules')
    .select('id, supplier, description, category, cost_class, native_amount, native_currency, cadence, start_date, end_date, allocation_rule, campaign_ref, notes, created_at')
    .order('created_at', { ascending: false });
  if (error) return { connected: true, error: error.message, schedules: [] };
  return { connected: true, schedules: data || [] };
}

async function createManualCostSchedule(input, { createdBy = null, supabaseAdmin = resolveSupabaseAdmin() } = {}) {
  const v = validateManualCostSchedule(input);
  if (!v.ok) return { ok: false, status: 400, errors: v.errors };
  const conn = await getManualCostConnection(supabaseAdmin);
  if (!conn.connected) return { ok: false, status: 503, errors: [conn.reason] };
  const { data, error } = await supabaseAdmin.from('manual_cost_schedules').insert({ ...v.value, created_by: createdBy }).select().single();
  if (error) return { ok: false, status: 500, errors: [error.message] };
  return { ok: true, schedule: data };
}

// Stops a recurring schedule from producing future periods. Never deletes
// it and never touches entries already posted.
async function endManualCostSchedule(id, endDate, { supabaseAdmin = resolveSupabaseAdmin() } = {}) {
  if (!isValidDate(endDate)) return { ok: false, status: 400, errors: ['end date must be YYYY-MM-DD'] };
  const conn = await getManualCostConnection(supabaseAdmin);
  if (!conn.connected) return { ok: false, status: 503, errors: [conn.reason] };
  const { data, error } = await supabaseAdmin
    .from('manual_cost_schedules')
    .update({ end_date: endDate, updated_at: new Date().toISOString() })
    .eq('id', id)
    .neq('cadence', 'one_off')
    .lte('start_date', endDate)
    .select()
    .maybeSingle();
  if (error) return { ok: false, status: 500, errors: [error.message] };
  if (!data) return { ok: false, status: 404, errors: ['recurring schedule not found, or end date is before its start'] };
  return { ok: true, schedule: data };
}

// Pure — the entries "Post due entries" WOULD write: every due period of
// every schedule whose entry_key is not already in the ledger. Lets the
// admin see exactly what will be posted (count and totals per currency)
// before posting, and makes posting a no-surprise action.
function computePendingEntries(schedules, postedKeys, now) {
  const posted = new Set(postedKeys || []);
  const pending = [];
  for (const s of schedules || []) {
    for (const p of duePeriods(s, now)) {
      const entry = toFinancialEntry(s, p);
      if (!posted.has(entry.entry_key)) pending.push({ scheduleId: s.id, description: s.description, period: p.key, amount: entry.amount, currency: entry.native_currency, entryKey: entry.entry_key });
    }
  }
  const totals = {};
  for (const e of pending) totals[e.currency] = Math.round(((totals[e.currency] || 0) + e.amount) * 100) / 100;
  return { pending, totals };
}

// Read-only preview (no writes): schedules + the manual entry keys
// already in the ledger.
async function previewDueManualCostEntries(now = new Date(), { supabaseAdmin = resolveSupabaseAdmin() } = {}) {
  const listed = await listManualCostSchedules(supabaseAdmin);
  if (!listed.connected) return { connected: false, reason: listed.reason, pending: [], totals: {} };
  const { data, error } = await supabaseAdmin
    .from('financial_entries')
    .select('entry_key')
    .eq('source_system', 'manual')
    .like('entry_key', 'schedule:%')
    .limit(100000);
  if (error) return { connected: true, error: error.message, pending: [], totals: {} };
  return { connected: true, ...computePendingEntries(listed.schedules, (data || []).map((r) => r.entry_key), now) };
}

// Posts every due, not-yet-posted period for every schedule into the
// ledger. Idempotent through 048's unique (source_system, entry_key):
// ignoreDuplicates makes a re-run a no-op for periods already posted.
async function postDueManualCostEntries(now = new Date(), { createdBy = null, supabaseAdmin = resolveSupabaseAdmin() } = {}) {
  const listed = await listManualCostSchedules(supabaseAdmin);
  if (!listed.connected) return { ok: false, status: 503, errors: [listed.reason] };
  const rows = [];
  for (const s of listed.schedules) for (const p of duePeriods(s, now)) rows.push(toFinancialEntry(s, p, { createdBy }));
  if (rows.length === 0) return { ok: true, considered: 0 };
  const { error } = await supabaseAdmin
    .from('financial_entries')
    .upsert(rows, { onConflict: 'source_system,entry_key', ignoreDuplicates: true });
  if (error) return { ok: false, status: 500, errors: [error.message] };
  return { ok: true, considered: rows.length };
}

module.exports = {
  COST_CATEGORIES,
  COST_CLASSES,
  CADENCES,
  DEFAULT_COST_CLASS,
  validateManualCostSchedule,
  duePeriods,
  toFinancialEntry,
  computePendingEntries,
  previewDueManualCostEntries,
  getManualCostConnection,
  listManualCostSchedules,
  createManualCostSchedule,
  endManualCostSchedule,
  postDueManualCostEntries,
};
