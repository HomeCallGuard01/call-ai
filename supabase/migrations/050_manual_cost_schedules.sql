-- Adds public.manual_cost_schedules: the small manual-cost facility for
-- costs that cannot sensibly be integrated automatically (an advertising
-- invoice, Apple Developer Program fee, insurance, accountancy, a domain,
-- Railway/Supabase bills until their billing APIs are connected).
--
-- STATUS: DRAFT — NOT APPLIED to any database (staging or production).
--
-- Designed in docs/architecture/FINANCIAL_DATA_ARCHITECTURE.md §4
-- (feature/provider-neutral-billing-ledger). A schedule is NOT money in
-- itself: money lives only in public.financial_entries (migration 048).
-- For each due period a schedule produces exactly one financial_entries
-- row — source_system 'manual', provenance 'manual', entry_key
-- 'schedule:<id>:<period>' — so re-posting can never duplicate (048's
-- unique (source_system, entry_key)). Editing a schedule affects only
-- periods not yet posted; posted entries remain as history.
--
-- DEPENDENCY: posting entries needs migration 048 applied first. This
-- table itself references nothing in 048, so applying 050 before 048 is
-- harmless (the admin API reports manual costs as "not connected" until
-- both exist).
--
-- Numbering: 047 = number-release entitlement guard (fix/number-
-- lifecycle-entitlement-guard), 048 = financial ledger (feature/provider-
-- neutral-billing-ledger), 049 = reserved for customer_acquisition /
-- attribution (FINANCIAL_DATA_ARCHITECTURE.md §9.5). Checked across all
-- local/remote branches and worktrees on 2026-09-27. Note: an unrelated
-- duplicate 046 exists on wip/monitoring-allowance-financial-safety-
-- 2026-09-26 (not this migration's concern, flagged in the report).
--
-- Access: service_role only (admin API). RLS enabled with no policies, so
-- anon/authenticated clients can never read or write it.

begin;

create table if not exists public.manual_cost_schedules (
  id uuid primary key default gen_random_uuid(),

  supplier text not null check (supplier ~ '^[a-z][a-z0-9_]{1,31}$'),
  description text not null check (length(btrim(description)) between 1 and 200),

  -- Same taxonomy as financial_entries.category (048), cost side only.
  category text not null
    check (category in (
      'number_rental', 'inbound_voice', 'app_leg', 'outbound_voice', 'media_stream', 'tts',
      'channel_capacity', 'platform_fee', 'sms', 'transcription', 'ai_inference', 'email',
      'hosting', 'database', 'domain', 'developer_program', 'saas', 'insurance', 'accountancy',
      'other_overhead', 'advertising', 'acquisition_other', 'other')),
  cost_class text not null
    check (cost_class in ('variable_direct', 'semi_variable', 'fixed_overhead', 'customer_acquisition')),

  native_amount numeric(14, 6) not null check (native_amount > 0),
  native_currency text not null default 'GBP' check (native_currency ~ '^[A-Z]{3}$'),

  cadence text not null check (cadence in ('one_off', 'monthly', 'annual')),
  start_date date not null,
  end_date date,

  -- Recorded now, applied later: per-customer / per-minute allocation of a
  -- shared cost is a reporting concern (FINANCIAL_DATA_ARCHITECTURE.md §5).
  allocation_rule text not null default 'none'
    check (allocation_rule in ('none', 'per_active_customer', 'per_minute')),

  -- Advertising only: '<source>/<medium>/<campaign>', lower-case — the same
  -- normalisation as customer_acquisition and financial_entries.campaign_ref.
  campaign_ref text check (campaign_ref is null or campaign_ref ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+/[a-z0-9_.-]+$'),

  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint manual_cost_schedules_dates_ordered
    check (end_date is null or end_date >= start_date),
  constraint manual_cost_schedules_one_off_has_no_end
    check (cadence <> 'one_off' or end_date is null)
);

create index if not exists manual_cost_schedules_category_idx on public.manual_cost_schedules (category);

alter table public.manual_cost_schedules enable row level security;
revoke all on table public.manual_cost_schedules from anon, authenticated;
grant select, insert, update on table public.manual_cost_schedules to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'manual_cost_schedules'
  ) then
    raise exception 'MIGRATION 050 VERIFICATION FAILED: public.manual_cost_schedules missing';
  end if;
end
$$;
