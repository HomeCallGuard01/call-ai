-- Financial ledger core + provider-neutral telephony usage (2026-09-27).
--
-- STATUS: DRAFT — NOT APPLIED to any database (staging or production).
-- Apply to staging first; production only with explicit approval.
--
-- NUMBERING: 051. Rule (adopted 2026-09-27): migration numbers follow
-- merge/application order; unmerged branches renumber before integration.
-- This file was 048 until staging applied 047 (number-release entitlement
-- guard) and 050 (number_lifecycle_sweep_evidence); applying 048 after 050
-- would be out of order (`supabase db push --include-all`), so it moved to
-- the next number above the highest applied. Pending elsewhere: the
-- dashboard branch's manual_cost_schedules (currently a duplicate 050) and
-- the planned attribution migration take numbers above this one when they
-- are applied. tests/migration-number-uniqueness.test.mjs fails on any
-- duplicate.
--
-- Why: HCG cannot yet say what a customer, or the business, costs.
-- calls.duration_seconds is the answered app-leg duration (Twilio
-- DialCallDuration, 0 when unanswered), not what the provider bills; the
-- provider's own billed duration and price were never stored. Unconditional
-- forwarding means every call, trusted or not, bills an inbound leg.
--
-- Shape (see the financial architecture specification):
--   * public.financial_entries — THE single money ledger for every
--     revenue, tax, fee, refund and cost line from any supplier (telephony
--     now; Stripe/App Store/Play, OpenAI, SMS, hosting, advertising and
--     manual costs later). Dashboards will query only this table for money,
--     so no supplier is ever hard-coded into profitability calculations.
--   * public.telephony_call_legs — telephony USAGE evidence (billed
--     durations per provider call leg). Never holds money; money for a leg
--     is a financial_entries row pointing at it.
--
-- Rules enforced here:
--   * Provider/supplier-neutral: provider, source_system and supplier are
--     free slugs, so Telnyx or any other supplier needs no schema change.
--   * Supplier evidence is preserved verbatim: native signed amount, native
--     currency, native quantity/unit and the original reference id. No
--     currency conversion anywhere in the ledger; `amount` is only the
--     sign-normalised magnitude in the SAME currency. Reporting converts.
--   * Absence of a charge is never a zero charge. charge_observation
--     separates reported_zero (the supplier explicitly reported 0) from
--     not_observed (no charge seen after the reconciliation window),
--     unavailable and pending; only reported_zero carries amount 0, the
--     others must have no amount. This is how HCG will notice a supplier
--     starting to bill something (e.g. the Twilio Voice SDK app leg) that
--     currently appears uncharged.
--   * Provenance is explicit: provider_actual (the supplier priced this
--     exact item), provider_allocated (a supplier aggregate such as a daily
--     Media Streams total, apportioned by HCG; must cite the aggregate),
--     estimated (HCG's own calculation) and manual (entered by a person).
--     Derived rows must state their basis, so an allocated daily Media
--     Stream charge can never pass as a supplier per-call charge.
--   * Billing models include per_second, per_minute, per_started_minute,
--     per_channel, per_number and fixed_period, so channel-based pricing is
--     just a per_channel entry with a period and no leg.
--   * Costs and fees carry a cost class: variable_direct, semi_variable,
--     fixed_overhead or customer_acquisition.
--   * No phone numbers or other personal data; link by id. Service role only.
--
-- Additive only: two new tables; no existing table is altered.
-- Rollback: drop view public.finance_monthly_contribution,
-- public.finance_household_monthly, public.finance_monthly_summary,
-- public.finance_entries_reporting; then drop table public.financial_entries;
-- drop table public.telephony_call_legs;  (entries before legs, because of the FK).

create table if not exists public.telephony_call_legs (
  id uuid primary key default gen_random_uuid(),

  provider text not null
    check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_account_ref text,
  provider_call_id text not null,
  provider_parent_call_id text,

  leg_type text not null
    check (leg_type in ('inbound_pstn', 'app_client', 'outbound_pstn', 'sip', 'other')),
  provider_direction text,
  provider_status text,

  call_id uuid references public.calls(id) on delete set null,
  household_id uuid references public.households(id) on delete set null,
  household_match text not null default 'unmatched'
    check (household_match in ('via_call', 'via_parent', 'via_number', 'ambiguous', 'unmatched')),

  started_at timestamptz,
  ended_at timestamptz,

  -- Provider-native duration and billed quantity exactly as reported.
  provider_duration_seconds integer check (provider_duration_seconds >= 0),
  billing_model text
    check (billing_model in ('per_second', 'per_minute', 'per_started_minute', 'per_channel',
                             'per_number', 'fixed_period', 'per_transaction', 'percentage', 'other')),
  billing_increment_seconds integer check (billing_increment_seconds > 0),
  billed_quantity numeric(14, 4) check (billed_quantity >= 0),
  billed_unit text,

  reconciliation_status text not null default 'pending'
    check (reconciliation_status in ('pending', 'provisional', 'final', 'unreconciled',
                                     'unavailable', 'mismatch', 'error')),
  first_seen_at timestamptz not null default now(),
  retrieved_at timestamptz,
  finalised_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,

  -- Verbatim provider fields relevant to billing (ids, direction, status,
  -- duration, price, price unit, timestamps). Never phone numbers.
  provider_evidence jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint telephony_call_legs_provider_call_unique unique (provider, provider_call_id),
  constraint telephony_call_legs_final_has_timestamp
    check (reconciliation_status <> 'final' or finalised_at is not null)
);

create index if not exists telephony_call_legs_household_started_idx
  on public.telephony_call_legs (household_id, started_at);
create index if not exists telephony_call_legs_reconciliation_idx
  on public.telephony_call_legs (reconciliation_status, updated_at);
create index if not exists telephony_call_legs_call_idx
  on public.telephony_call_legs (call_id);
create index if not exists telephony_call_legs_parent_idx
  on public.telephony_call_legs (provider, provider_parent_call_id);

create table if not exists public.financial_entries (
  id uuid primary key default gen_random_uuid(),

  -- Where the record came from (twilio, stripe, revenuecat, manual, hcg…)
  -- and who the money is with (twilio, stripe, apple, railway…).
  source_system text not null check (source_system ~ '^[a-z][a-z0-9_]{1,31}$'),
  supplier text not null check (supplier ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- Deterministic idempotency key, unique per source system.
  entry_key text not null,
  -- Original supplier transaction/reference id (CallSid, Stripe txn id,
  -- invoice number, report line id).
  native_reference text,

  entry_class text not null
    check (entry_class in ('revenue', 'refund', 'tax', 'fee', 'cost')),
  category text not null
    check (category in (
      'subscription', 'vat_output', 'store_commission', 'payment_processing_fee', 'refund',
      'number_rental', 'inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts',
      'channel_capacity', 'platform_fee', 'sms', 'transcription', 'ai_inference', 'email',
      'hosting', 'database', 'domain', 'developer_program', 'saas', 'insurance', 'accountancy',
      'other_overhead', 'advertising', 'acquisition_other', 'other')),
  cost_class text
    check (cost_class in ('variable_direct', 'semi_variable', 'fixed_overhead', 'customer_acquisition')),
  billing_model text
    check (billing_model in ('per_second', 'per_minute', 'per_started_minute', 'per_channel',
                             'per_number', 'fixed_period', 'per_transaction', 'percentage', 'other')),

  provenance text not null
    check (provenance in ('provider_actual', 'provider_allocated', 'estimated', 'manual')),
  -- Only for provider_actual rows: what the supplier reported about THIS
  -- item. NULL for allocated, estimated and manual rows.
  charge_observation text
    check (charge_observation in ('reported_amount', 'reported_zero', 'not_observed', 'unavailable', 'pending')),
  reconciliation_status text not null default 'pending'
    check (reconciliation_status in ('pending', 'provisional', 'final', 'unreconciled',
                                     'unavailable', 'mismatch', 'error')),

  -- Supplier-native evidence, exactly as reported (signed).
  native_amount numeric(14, 6),
  native_currency text check (native_currency ~ '^[A-Z]{3}$'),
  native_quantity numeric(14, 4),
  native_unit text,

  -- Sign-normalised magnitude in native_currency (no FX). Direction comes
  -- from entry_class. NULL whenever no amount is known.
  amount numeric(14, 6) check (amount >= 0),

  occurred_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,

  household_id uuid references public.households(id) on delete set null,
  call_id uuid references public.calls(id) on delete set null,
  telephony_leg_id uuid references public.telephony_call_legs(id) on delete restrict,
  subscription_ref text,
  campaign_ref text,

  allocation_basis text,
  source_reference text,
  evidence jsonb,
  notes text,
  created_by text,

  retrieved_at timestamptz,
  finalised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint financial_entries_source_key_unique unique (source_system, entry_key),
  constraint financial_entries_period_order
    check (period_start is null or period_end is null or period_end > period_start),

  -- Costs and fees are always classified; revenue/refund/tax never are.
  constraint financial_entries_cost_class_matches_entry_class
    check ((entry_class in ('cost', 'fee')) = (cost_class is not null)),

  -- provider_actual rows say what was observed; other provenances don't.
  constraint financial_entries_observation_matches_provenance
    check ((provenance = 'provider_actual') = (charge_observation is not null)),

  -- Absence of a charge is never a zero charge.
  constraint financial_entries_no_amount_without_observation
    check (charge_observation is null
           or charge_observation not in ('not_observed', 'unavailable', 'pending')
           or (amount is null and native_amount is null)),
  constraint financial_entries_reported_zero_is_zero
    check (charge_observation is distinct from 'reported_zero'
           or (amount = 0 and native_amount = 0 and native_currency is not null)),
  constraint financial_entries_reported_amount_is_present
    check (charge_observation is distinct from 'reported_amount'
           or (amount is not null and native_amount is not null and native_currency is not null)),

  -- Allocated, estimated and manual rows carry an amount, a currency and
  -- the method; allocated rows also cite the supplier aggregate.
  constraint financial_entries_derived_rows_explained
    check (provenance = 'provider_actual'
           or (amount is not null and native_currency is not null and allocation_basis is not null)),
  constraint financial_entries_allocated_rows_cite_source
    check (provenance <> 'provider_allocated' or source_reference is not null),

  constraint financial_entries_final_has_timestamp
    check (reconciliation_status <> 'final' or finalised_at is not null)
);

create index if not exists financial_entries_household_idx
  on public.financial_entries (household_id, occurred_at);
create index if not exists financial_entries_leg_idx
  on public.financial_entries (telephony_leg_id);
create index if not exists financial_entries_supplier_category_idx
  on public.financial_entries (supplier, category, provenance);
create index if not exists financial_entries_class_occurred_idx
  on public.financial_entries (entry_class, cost_class, occurred_at);
create index if not exists financial_entries_period_idx
  on public.financial_entries (supplier, period_start);
create index if not exists financial_entries_campaign_idx
  on public.financial_entries (campaign_ref);
create index if not exists financial_entries_reconciliation_idx
  on public.financial_entries (reconciliation_status, updated_at);

-- Service-role only. RLS on with no policies, and explicit revokes, so a
-- platform default grant to anon/authenticated can never expose rows.
alter table public.telephony_call_legs enable row level security;
alter table public.financial_entries enable row level security;

revoke all on public.telephony_call_legs from public, anon, authenticated;
revoke all on public.financial_entries from public, anon, authenticated;

grant select, insert, update, delete on public.telephony_call_legs to service_role;
grant select, insert, update, delete on public.financial_entries to service_role;

-- ---------------------------------------------------------------------------
-- Reporting interface for the admin dashboard (read-only views).
--
-- The dashboard reads money ONLY through these views, so every figure it
-- shows carries:
--   dashboard_bucket  revenue | tax | payment_fees | telephony |
--                     ai_transcription | infrastructure | advertising | other
--   amount_quality    ACTUAL     supplier priced this item (reported amount or explicit zero)
--                     ALLOCATED  share of a supplier aggregate
--                     ESTIMATED  HCG calculation
--                     MANUAL     entered by a person
--                     UNKNOWN    supplier outcome pending / not observed / unavailable (no amount)
--   is_unallocated    a cost with no evidence-based household
--   signed_amount     revenue positive; refunds, tax, fees and costs negative
-- Amounts stay in native currency; views group by currency and never
-- convert (FX belongs to the reporting layer).
--
-- security_invoker so the views can never bypass the tables' RLS, and
-- service-role only, like the tables.
-- ---------------------------------------------------------------------------

create or replace view public.finance_entries_reporting
with (security_invoker = true) as
select
  e.*,
  case
    when e.entry_class in ('revenue', 'refund') then 'revenue'
    when e.entry_class = 'tax' then 'tax'
    when e.entry_class = 'fee' then 'payment_fees'
    when e.cost_class = 'customer_acquisition' then 'advertising'
    when e.category in ('transcription', 'ai_inference') then 'ai_transcription'
    when e.category in ('number_rental', 'inbound_voice', 'app_leg', 'outbound_voice', 'media_stream',
                        'tts', 'channel_capacity', 'platform_fee', 'sms') then 'telephony'
    when e.category in ('hosting', 'database', 'domain', 'developer_program', 'saas', 'insurance',
                        'accountancy', 'other_overhead', 'email') then 'infrastructure'
    else 'other'
  end as dashboard_bucket,
  case
    when e.provenance = 'provider_actual' and e.charge_observation in ('reported_amount', 'reported_zero') then 'ACTUAL'
    when e.provenance = 'provider_allocated' then 'ALLOCATED'
    when e.provenance = 'estimated' then 'ESTIMATED'
    when e.provenance = 'manual' then 'MANUAL'
    else 'UNKNOWN'
  end as amount_quality,
  (e.household_id is null and e.entry_class in ('cost', 'fee')) as is_unallocated,
  case when e.entry_class = 'revenue' then e.amount else -e.amount end as signed_amount,
  date_trunc('month', coalesce(e.occurred_at, e.period_start, e.created_at)) as reporting_month
from public.financial_entries e;

create or replace view public.finance_monthly_summary
with (security_invoker = true) as
select
  reporting_month,
  dashboard_bucket,
  amount_quality,
  native_currency,
  count(*)                                   as entries,
  count(*) filter (where amount is null)     as entries_without_amount,
  coalesce(sum(signed_amount), 0)            as signed_total,
  coalesce(sum(signed_amount) filter (where is_unallocated), 0) as unallocated_signed_total
from public.finance_entries_reporting
group by reporting_month, dashboard_bucket, amount_quality, native_currency;

create or replace view public.finance_household_monthly
with (security_invoker = true) as
select
  household_id,
  reporting_month,
  dashboard_bucket,
  amount_quality,
  native_currency,
  count(*)                        as entries,
  coalesce(sum(signed_amount), 0) as signed_total
from public.finance_entries_reporting
where household_id is not null
group by household_id, reporting_month, dashboard_bucket, amount_quality, native_currency;

-- Contribution per month and currency. Only same-currency amounts are ever
-- added together; a dashboard showing a single GBP figure converts
-- explicitly. estimated_/unknown_ columns say how much of each total isn't
-- supplier-confirmed.
create or replace view public.finance_monthly_contribution
with (security_invoker = true) as
select
  reporting_month,
  native_currency,
  coalesce(sum(signed_amount) filter (where dashboard_bucket = 'revenue'), 0)                          as revenue,
  coalesce(sum(signed_amount) filter (where dashboard_bucket = 'tax'), 0)                              as tax,
  coalesce(sum(signed_amount) filter (where dashboard_bucket = 'payment_fees'), 0)                     as payment_fees,
  coalesce(sum(signed_amount) filter (where dashboard_bucket in ('telephony', 'ai_transcription')), 0) as direct_service_costs,
  coalesce(sum(signed_amount) filter (where dashboard_bucket in ('revenue', 'tax', 'payment_fees', 'telephony', 'ai_transcription')), 0) as contribution,
  coalesce(sum(signed_amount) filter (where dashboard_bucket = 'infrastructure'), 0)                   as infrastructure,
  coalesce(sum(signed_amount) filter (where dashboard_bucket = 'advertising'), 0)                      as advertising,
  coalesce(sum(signed_amount) filter (where dashboard_bucket <> 'other'), 0)                           as operating_result,
  coalesce(sum(signed_amount) filter (where is_unallocated), 0)                                        as unallocated_costs,
  coalesce(sum(signed_amount) filter (where amount_quality in ('ESTIMATED', 'ALLOCATED')), 0)          as estimated_or_allocated_part,
  count(*) filter (where amount_quality = 'UNKNOWN')                                                   as unknown_items
from public.finance_entries_reporting
group by reporting_month, native_currency;

revoke all on public.finance_entries_reporting, public.finance_monthly_summary,
              public.finance_household_monthly, public.finance_monthly_contribution
  from public, anon, authenticated;
grant select on public.finance_entries_reporting, public.finance_monthly_summary,
                public.finance_household_monthly, public.finance_monthly_contribution
  to service_role;
