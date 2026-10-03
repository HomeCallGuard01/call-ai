-- Financial containment P0 — authorisation ledger, reservations/leases,
-- global breaker (2026-10-03).
--
-- STATUS: PROVISIONAL DRAFT — NOT APPLIED ANYWHERE (not staging, not
-- production). Deliberately NOT in supabase/migrations/: no safe permanent
-- number exists (046/055/058/060/061 are each claimed twice across branches,
-- 060/061 security migrations are applied to STAGING only). It must be given
-- a number at integration time, AFTER 056 (feature/financial-safety-hard-
-- limits) and after the security/readiness renumbering is settled. See
-- docs/handovers/2026-10-03-financial-fortress-p0-handover.md §Migrations.
--
-- Depends only on: public.households, public.entitlements (011),
-- public.account_classifications (031), entitlements.plan_code (056; read
-- defensively — absent column is tolerated via to_jsonb()).
--
-- Design: docs/finance/FINANCIAL_CONTAINMENT_P0.md. Invariants I1–I10 there.
--
-- Concurrency: every mutating function takes the row lock on
-- fc_global_state (id = 1) FIRST. All authorisation, renewal, settlement and
-- adjustment is therefore serialised — a deliberate choice: it makes the
-- per-household and global £ invariants hold under any number of server
-- instances and connections, at the cost of one short critical section per
-- operation (single-digit ms). Revisit only if authorisation throughput
-- ever becomes a bottleneck (thousands per second).
--
-- Money is numeric GBP. Estimates are never written as actual (I7).

begin;

-- ---------------------------------------------------------------------------
-- Policy (authoritative limits; CHECK-constrained; audited changes only)
-- ---------------------------------------------------------------------------
create table if not exists public.fc_policy (
  id integer primary key check (id = 1),
  version integer not null default 1,
  enforcement_mode text not null default 'enforce' check (enforcement_mode in ('enforce', 'shadow')),
  -- leases
  lease_seconds integer not null default 300 check (lease_seconds between 60 and 1800),
  renew_ahead_seconds integer not null default 90 check (renew_ahead_seconds between 15 and 900),
  termination_grace_seconds integer not null default 60 check (termination_grace_seconds between 0 and 300),
  max_call_seconds integer not null default 14400 check (max_call_seconds between 60 and 14400),
  breaker_terminates_active boolean not null default true,
  -- Fraction of the household's remaining (worst-case-adjusted) headroom one
  -- call's provider backstop may claim (I5 per household). <1 leaves room
  -- for a simultaneous call; 1.0 lets one call claim it all.
  backstop_share numeric(4, 3) not null default 0.5 check (backstop_share >= 0.1 and backstop_share <= 1),
  -- rates (GBP) and estimation
  connected_rate_gbp_per_min numeric(12, 6) not null default 0.010718 check (connected_rate_gbp_per_min > 0 and connected_rate_gbp_per_min < 1),
  monitoring_rate_gbp_per_min numeric(12, 6) not null default 0.008069 check (monitoring_rate_gbp_per_min > 0 and monitoring_rate_gbp_per_min < 1),
  monitoring_max_seconds integer not null default 1800 check (monitoring_max_seconds between 60 and 14400),
  call_fixed_fee_gbp numeric(12, 6) not null default 0.0006 check (call_fixed_fee_gbp >= 0 and call_fixed_fee_gbp < 1),
  billing_granularity_seconds integer not null default 60 check (billing_granularity_seconds between 1 and 60),
  estimate_uplift numeric(6, 3) not null default 1.10 check (estimate_uplift >= 1 and estimate_uplift <= 5),
  sms_unit_gbp numeric(12, 6) not null default 0.042325 check (sms_unit_gbp > 0 and sms_unit_gbp < 1),
  ai_request_gbp numeric(12, 6) not null default 0.001 check (ai_request_gbp > 0 and ai_request_gbp < 1),
  number_purchase_gbp numeric(12, 6) not null default 1.15 check (number_purchase_gbp > 0 and number_purchase_gbp < 20),
  -- global breaker
  global_hourly_floor_gbp numeric(12, 4) not null default 4 check (global_hourly_floor_gbp > 0),
  global_hourly_per_household_gbp numeric(12, 4) not null default 0.03 check (global_hourly_per_household_gbp >= 0),
  global_daily_floor_gbp numeric(12, 4) not null default 15 check (global_daily_floor_gbp > 0),
  global_daily_per_household_gbp numeric(12, 4) not null default 0.20 check (global_daily_per_household_gbp >= 0),
  global_daily_absolute_max_gbp numeric(12, 4) not null default 1000 check (global_daily_absolute_max_gbp > 0),
  global_exposure_floor_gbp numeric(12, 4) not null default 5 check (global_exposure_floor_gbp > 0),
  global_exposure_per_household_gbp numeric(12, 4) not null default 0.05 check (global_exposure_per_household_gbp >= 0),
  global_worst_case_floor_gbp numeric(12, 4) not null default 40 check (global_worst_case_floor_gbp > 0),
  global_worst_case_per_household_gbp numeric(12, 4) not null default 0.50 check (global_worst_case_per_household_gbp >= 0),
  global_active_floor integer not null default 20 check (global_active_floor > 0),
  global_active_households_per_call integer not null default 5 check (global_active_households_per_call > 0),
  global_monitoring_hourly_floor_gbp numeric(12, 4) not null default 1.5 check (global_monitoring_hourly_floor_gbp > 0),
  global_monitoring_hourly_per_household_gbp numeric(12, 4) not null default 0.02 check (global_monitoring_hourly_per_household_gbp >= 0),
  global_unattributed_daily_gbp numeric(12, 4) not null default 2 check (global_unattributed_daily_gbp > 0),
  global_number_purchases_per_day integer not null default 10 check (global_number_purchases_per_day between 0 and 1000),
  breaker_latch_on_rate boolean not null default true,
  entitled_count_max_age_seconds integer not null default 93600 check (entitled_count_max_age_seconds > 0),
  -- periods
  max_period_days integer not null default 35 check (max_period_days between 1 and 35),
  updated_at timestamptz not null default now(),
  updated_by text,
  check (renew_ahead_seconds < lease_seconds),
  check (lease_seconds <= max_call_seconds)
);
insert into public.fc_policy (id) values (1) on conflict (id) do nothing;

-- Per-profile household budgets (GBP per billing period). DECISION REQUIRED
-- (D1). Seeds = the conservative derivation in
-- services/containment/economicPolicy.js at £5.99 inc. VAT: total HCG-funded
-- variable spend per customer per month (budget + delivery reserve +
-- essential pool + lease-overrun allowance) must fit inside
--   60% × net revenue − number rental − worst platform fee − infrastructure
--   allowance, less a 15% safety reserve  ≈ £0.86.
-- 'plus' is not on sale (no price exists), so it gets the standard figures;
-- complimentary/test accounts earn no revenue and get the same caps.
create table if not exists public.fc_budget_profiles (
  profile text primary key check (profile ~ '^[a-z_]{1,32}$'),
  period_budget_gbp numeric(12, 4) not null check (period_budget_gbp >= 0 and period_budget_gbp <= 100),
  delivery_reserve_gbp numeric(12, 4) not null check (delivery_reserve_gbp >= 0 and delivery_reserve_gbp <= 100),
  delivery_reserve_scope text not null default 'all' check (delivery_reserve_scope in ('all', 'trusted_only', 'none')),
  essential_reserve_gbp numeric(12, 4) not null check (essential_reserve_gbp >= 0 and essential_reserve_gbp <= 20),
  monitoring_allowed boolean not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.fc_budget_profiles (profile, period_budget_gbp, delivery_reserve_gbp, delivery_reserve_scope, essential_reserve_gbp, monitoring_allowed) values
  ('standard',      0.50, 0.25, 'all', 0.10, true),
  ('plus',          0.50, 0.25, 'all', 0.10, true),
  ('complimentary', 0.50, 0.25, 'all', 0.10, true),
  ('internal_test', 0.50, 0.25, 'all', 0.10, true),
  ('unentitled',    0.00, 0.10, 'all', 0.10, false)
on conflict (profile) do nothing;

create table if not exists public.fc_policy_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor text not null,
  reason text not null,
  target text not null,
  before jsonb,
  after jsonb
);

-- ---------------------------------------------------------------------------
-- Global state (THE serialisation point) and spend buckets
-- ---------------------------------------------------------------------------
create table if not exists public.fc_global_state (
  id integer primary key check (id = 1),
  kill_switch boolean not null default false,
  kill_reason text,
  breaker_open boolean not null default false,
  breaker_reason text,
  breaker_opened_at timestamptz,
  entitled_households integer not null default 0 check (entitled_households >= 0),
  entitled_counted_at timestamptz,
  active_count integer not null default 0 check (active_count >= 0),
  active_reserved_gbp numeric(14, 6) not null default 0 check (active_reserved_gbp >= 0),
  active_worst_case_gbp numeric(14, 6) not null default 0 check (active_worst_case_gbp >= 0),
  updated_at timestamptz not null default now()
);
insert into public.fc_global_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.fc_spend_minutes (
  minute timestamptz primary key,
  authorized_gbp numeric(14, 6) not null default 0,
  committed_gbp numeric(14, 6) not null default 0,
  monitoring_authorized_gbp numeric(14, 6) not null default 0,
  monitoring_committed_gbp numeric(14, 6) not null default 0,
  unattributed_gbp numeric(14, 6) not null default 0,
  number_purchases integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Household budget accounts (one per household per billing period)
-- ---------------------------------------------------------------------------
create table if not exists public.fc_budget_accounts (
  household_id uuid not null references public.households(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  profile text not null,
  base_budget_gbp numeric(12, 4) not null check (base_budget_gbp >= 0),
  delivery_reserve_gbp numeric(12, 4) not null check (delivery_reserve_gbp >= 0),
  essential_reserve_gbp numeric(12, 4) not null check (essential_reserve_gbp >= 0),
  adjustments_gbp numeric(12, 4) not null default 0,
  reserved_gbp numeric(14, 6) not null default 0 check (reserved_gbp >= 0),
  consumed_gbp numeric(14, 6) not null default 0 check (consumed_gbp >= 0),
  essential_reserved_gbp numeric(14, 6) not null default 0 check (essential_reserved_gbp >= 0),
  essential_consumed_gbp numeric(14, 6) not null default 0 check (essential_consumed_gbp >= 0),
  actual_gbp numeric(14, 6) not null default 0 check (actual_gbp >= 0),
  last_denial_reason text,
  last_denial_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (household_id, period_start),
  check (period_end > period_start)
);

-- ---------------------------------------------------------------------------
-- Reservations (one per cost-bearing resource) and the append-only ledger
-- ---------------------------------------------------------------------------
create table if not exists public.fc_reservations (
  id bigint generated always as identity primary key,
  idempotency_key text not null unique check (length(idempotency_key) between 3 and 200),
  household_id uuid references public.households(id) on delete set null,
  period_start timestamptz,
  call_sid text,
  category text not null check (category in ('call', 'unattributed_call', 'sms', 'ai', 'number_purchase')),
  funding text check (funding in ('budget', 'reserve', 'essential', 'unattributed', 'degraded', 'global')),
  state text not null check (state in ('active', 'terminating', 'settled', 'denied')),
  deny_reason text,
  shadow_denied_reason text,
  monitored boolean not null default false,
  monitoring_started boolean not null default false,
  is_known boolean not null default false,
  connected_rate_gbp_per_min numeric(12, 6),
  monitoring_rate_gbp_per_min numeric(12, 6),
  started_at timestamptz not null,
  covered_seconds integer not null default 0 check (covered_seconds >= 0),
  lease_expires_at timestamptz,
  backstop_seconds integer check (backstop_seconds is null or backstop_seconds > 0),
  worst_case_gbp numeric(14, 6) not null default 0 check (worst_case_gbp >= 0),
  reserved_gbp numeric(14, 6) not null default 0 check (reserved_gbp >= 0),
  total_authorized_gbp numeric(14, 6) not null default 0 check (total_authorized_gbp >= 0),
  committed_gbp numeric(14, 6) not null default 0 check (committed_gbp >= 0),
  actual_gbp numeric(14, 6) not null default 0 check (actual_gbp >= 0),
  overrun_gbp numeric(14, 6) not null default 0 check (overrun_gbp >= 0),
  extensions integer not null default 0,
  terminate_at timestamptz,
  termination_reason text,
  termination_attempts integer not null default 0,
  termination_last_attempt_at timestamptz,
  termination_confirmed_at timestamptz,
  settled_at timestamptz,
  settle_source text,
  settled_duration_seconds integer,
  provider_status text,
  last_provider_check_at timestamptz,
  details jsonb
);
create unique index if not exists fc_reservations_call_sid_live
  on public.fc_reservations (call_sid) where call_sid is not null and category in ('call', 'unattributed_call');
create index if not exists fc_reservations_live
  on public.fc_reservations (lease_expires_at) where state in ('active', 'terminating');
create index if not exists fc_reservations_household
  on public.fc_reservations (household_id, started_at desc);

create table if not exists public.fc_ledger (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  idempotency_key text not null unique,
  reservation_id bigint references public.fc_reservations(id) on delete set null,
  household_id uuid references public.households(id) on delete set null,
  call_sid text,
  category text not null,
  entry_type text not null check (entry_type in ('reserve', 'extend', 'commit', 'release', 'actual', 'adjust', 'deny', 'terminate', 'adopt')),
  basis text not null check (basis in ('estimate', 'actual', 'admin', 'none')),
  amount_gbp numeric(14, 6) not null check (amount_gbp >= -100 and amount_gbp <= 1000),
  provider text,
  provider_ref text,
  reason text,
  details jsonb
);
create index if not exists fc_ledger_household on public.fc_ledger (household_id, created_at desc);
create index if not exists fc_ledger_reservation on public.fc_ledger (reservation_id);

create table if not exists public.fc_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  level text not null check (level in ('info', 'warning', 'critical', 'emergency')),
  rule text not null,
  household_id uuid references public.households(id) on delete set null,
  call_sid text,
  details jsonb
);
create index if not exists fc_events_recent on public.fc_events (created_at desc);

-- Lock everything down: RLS on, no anon/authenticated access at all.
alter table public.fc_policy enable row level security;
alter table public.fc_budget_profiles enable row level security;
alter table public.fc_policy_audit enable row level security;
alter table public.fc_global_state enable row level security;
alter table public.fc_spend_minutes enable row level security;
alter table public.fc_budget_accounts enable row level security;
alter table public.fc_reservations enable row level security;
alter table public.fc_ledger enable row level security;
alter table public.fc_events enable row level security;
revoke all on public.fc_policy, public.fc_budget_profiles, public.fc_policy_audit, public.fc_global_state,
  public.fc_spend_minutes, public.fc_budget_accounts, public.fc_reservations, public.fc_ledger, public.fc_events
  from public, anon, authenticated;
-- service_role may READ (admin read model); every write goes through the
-- SECURITY DEFINER functions below.
grant select on public.fc_policy, public.fc_budget_profiles, public.fc_policy_audit, public.fc_global_state,
  public.fc_spend_minutes, public.fc_budget_accounts, public.fc_reservations, public.fc_ledger, public.fc_events
  to service_role;

-- ---------------------------------------------------------------------------
-- Internal helpers (no grants; run only inside the definer functions)
-- ---------------------------------------------------------------------------

-- Estimated cost of covering a call for p_seconds (§4.1). 0 for 0 seconds.
create or replace function public.fc_call_cost(
  p_seconds integer, p_conn numeric, p_mon numeric, p_mon_seconds integer,
  p_monitored boolean, p_gran integer, p_uplift numeric, p_fixed numeric
) returns numeric
language sql immutable
set search_path = ''
as $$
  select case when coalesce(p_seconds, 0) <= 0 then 0::numeric else
    ceil(p_seconds::numeric / p_gran) * p_gran / 60.0 * p_conn * p_uplift
    + case when p_monitored then ceil(least(p_seconds, p_mon_seconds)::numeric / p_gran) * p_gran / 60.0 * p_mon * p_uplift else 0 end
    + p_fixed
  end;
$$;

create or replace function public.fc_minute(p_at timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$ select date_trunc('minute', p_at at time zone 'UTC') at time zone 'UTC'; $$;

create or replace function public.fc_bump_minute(
  p_at timestamptz, p_authorized numeric, p_committed numeric, p_monitoring numeric, p_unattributed numeric, p_purchases integer,
  p_monitoring_committed numeric default 0
) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.fc_spend_minutes as s (minute, authorized_gbp, committed_gbp, monitoring_authorized_gbp, monitoring_committed_gbp, unattributed_gbp, number_purchases)
  values (public.fc_minute(p_at), p_authorized, p_committed, p_monitoring, p_monitoring_committed, p_unattributed, p_purchases)
  on conflict (minute) do update set
    authorized_gbp = s.authorized_gbp + excluded.authorized_gbp,
    committed_gbp = s.committed_gbp + excluded.committed_gbp,
    monitoring_authorized_gbp = s.monitoring_authorized_gbp + excluded.monitoring_authorized_gbp,
    monitoring_committed_gbp = s.monitoring_committed_gbp + excluded.monitoring_committed_gbp,
    unattributed_gbp = s.unattributed_gbp + excluded.unattributed_gbp,
    number_purchases = s.number_purchases + excluded.number_purchases;
end;
$$;

create or replace function public.fc_event(p_level text, p_rule text, p_household uuid, p_call_sid text, p_details jsonb)
returns void language sql security invoker set search_path = '' as $$
  insert into public.fc_events (level, rule, household_id, call_sid, details) values (p_level, p_rule, p_household, p_call_sid, p_details);
$$;

-- Effective policy: database policy, tightened (never loosened) by the
-- app's overrides. Unknown override keys are ignored.
create or replace function public.fc_effective_policy(p_overrides jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  p public.fc_policy%rowtype;
  o jsonb := coalesce(p_overrides, '{}'::jsonb);
  r jsonb;
  k text;
  tighten_min text[] := array['lease_seconds', 'max_call_seconds', 'monitoring_max_seconds', 'backstop_share',
    'global_hourly_floor_gbp', 'global_daily_floor_gbp', 'global_daily_absolute_max_gbp', 'global_exposure_floor_gbp',
    'global_worst_case_floor_gbp', 'global_active_floor', 'global_monitoring_hourly_floor_gbp',
    'global_unattributed_daily_gbp', 'global_number_purchases_per_day',
    'global_hourly_per_household_gbp', 'global_daily_per_household_gbp', 'global_exposure_per_household_gbp',
    'global_worst_case_per_household_gbp', 'global_monitoring_hourly_per_household_gbp'];
  tighten_max text[] := array['connected_rate_gbp_per_min', 'monitoring_rate_gbp_per_min', 'call_fixed_fee_gbp',
    'estimate_uplift', 'sms_unit_gbp', 'ai_request_gbp', 'number_purchase_gbp', 'renew_ahead_seconds'];
begin
  select * into p from public.fc_policy where id = 1;
  if not found then raise exception 'fc: policy missing'; end if;
  r := to_jsonb(p);
  foreach k in array tighten_min loop
    if o ? k and jsonb_typeof(o->k) = 'number' and (o->>k)::numeric > 0 then
      r := jsonb_set(r, array[k], to_jsonb(least((r->>k)::numeric, (o->>k)::numeric)));
    end if;
  end loop;
  foreach k in array tighten_max loop
    if o ? k and jsonb_typeof(o->k) = 'number' and (o->>k)::numeric > 0 and (o->>k)::numeric < 1000 then
      r := jsonb_set(r, array[k], to_jsonb(greatest((r->>k)::numeric, (o->>k)::numeric)));
    end if;
  end loop;
  -- renew_ahead must stay below the (possibly tightened) lease.
  if (r->>'renew_ahead_seconds')::numeric >= (r->>'lease_seconds')::numeric then
    r := jsonb_set(r, '{renew_ahead_seconds}', to_jsonb(floor((r->>'lease_seconds')::numeric / 2)));
  end if;
  if o ? 'enforcement_mode' and o->>'enforcement_mode' = 'enforce' then
    r := jsonb_set(r, '{enforcement_mode}', '"enforce"');   -- app may force enforce, never shadow
  end if;
  return r;
end;
$$;

-- Global caps for the current entitled-household count (floors if stale).
create or replace function public.fc_global_caps(p_pol jsonb, p_state public.fc_global_state, p_now timestamptz) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  n numeric := 0;
begin
  if p_state.entitled_counted_at is not null
     and p_state.entitled_counted_at > p_now - make_interval(secs => (p_pol->>'entitled_count_max_age_seconds')::integer) then
    n := p_state.entitled_households;
  end if;
  return jsonb_build_object(
    'n', n,
    'hourly', greatest((p_pol->>'global_hourly_floor_gbp')::numeric, n * (p_pol->>'global_hourly_per_household_gbp')::numeric),
    'daily', least((p_pol->>'global_daily_absolute_max_gbp')::numeric,
                   greatest((p_pol->>'global_daily_floor_gbp')::numeric, n * (p_pol->>'global_daily_per_household_gbp')::numeric)),
    'exposure', greatest((p_pol->>'global_exposure_floor_gbp')::numeric, n * (p_pol->>'global_exposure_per_household_gbp')::numeric),
    'worstCase', greatest((p_pol->>'global_worst_case_floor_gbp')::numeric, n * (p_pol->>'global_worst_case_per_household_gbp')::numeric),
    'active', greatest((p_pol->>'global_active_floor')::numeric, ceil(n / (p_pol->>'global_active_households_per_call')::numeric)),
    'monitoringHourly', greatest((p_pol->>'global_monitoring_hourly_floor_gbp')::numeric, n * (p_pol->>'global_monitoring_hourly_per_household_gbp')::numeric),
    'unattributedDaily', (p_pol->>'global_unattributed_daily_gbp')::numeric,
    'numberPurchasesDaily', (p_pol->>'global_number_purchases_per_day')::numeric);
end;
$$;

create or replace function public.fc_window_sums(p_now timestamptz) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'hourAuthorized', coalesce(sum(authorized_gbp) filter (where minute > p_now - interval '1 hour'), 0),
    'dayAuthorized', coalesce(sum(authorized_gbp), 0),
    'hourCommitted', coalesce(sum(committed_gbp) filter (where minute > p_now - interval '1 hour'), 0),
    'dayCommitted', coalesce(sum(committed_gbp), 0),
    'hourMonitoringAuthorized', coalesce(sum(monitoring_authorized_gbp) filter (where minute > p_now - interval '1 hour'), 0),
    'hourMonitoringCommitted', coalesce(sum(monitoring_committed_gbp) filter (where minute > p_now - interval '1 hour'), 0),
    'dayUnattributed', coalesce(sum(unattributed_gbp), 0),
    'dayNumberPurchases', coalesce(sum(number_purchases), 0))
  from public.fc_spend_minutes where minute > p_now - interval '24 hours';
$$;

-- Server-side profile for a household (never supplied by the app):
-- internal/test classifications → internal_test; active entitlement →
-- complimentary / plus / standard; otherwise unentitled.
create or replace function public.fc_resolve_profile(p_household_id uuid, p_now timestamptz) returns text
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_class text;
  v_ent jsonb;
begin
  select classification into v_class from public.account_classifications where household_id = p_household_id;
  if v_class in ('internal_test', 'admin', 'reviewer', 'qa_automation') then return 'internal_test'; end if;
  select to_jsonb(e) into v_ent from public.entitlements e
   where e.household_id = p_household_id and e.status = 'active'
     and e.starts_at <= p_now and (e.ends_at is null or e.ends_at > p_now)
   order by e.starts_at desc limit 1;
  if v_ent is null then return 'unentitled'; end if;
  if v_ent->>'entitlement_type' in ('complimentary', 'partner', 'staff') then return 'complimentary'; end if;
  if v_ent->>'plan_code' = 'plus' then return 'plus'; end if;
  return 'standard';
end;
$$;

-- The household's account for the period containing p_now (I8: a new
-- period never starts before the previous one ends, never > max days).
create or replace function public.fc_account(
  p_household_id uuid, p_period_start timestamptz, p_period_end timestamptz, p_now timestamptz, p_pol jsonb
) returns public.fc_budget_accounts
language plpgsql security invoker set search_path = '' as $$
declare
  a public.fc_budget_accounts%rowtype;
  v_prev_end timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_profile text;
  pr public.fc_budget_profiles%rowtype;
begin
  select * into a from public.fc_budget_accounts
   where household_id = p_household_id and period_start <= p_now and period_end > p_now
   order by period_start desc limit 1;
  if found then return a; end if;

  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start
     or not (p_period_start <= p_now and p_now < p_period_end) then
    -- Unusable period from the app: a calendar month in UTC.
    v_start := date_trunc('month', p_now at time zone 'UTC') at time zone 'UTC';
    v_end := (date_trunc('month', p_now at time zone 'UTC') + interval '1 month') at time zone 'UTC';
  else
    v_start := p_period_start;
    v_end := p_period_end;
  end if;
  select max(period_end) into v_prev_end from public.fc_budget_accounts where household_id = p_household_id;
  if v_prev_end is not null and v_start < v_prev_end then v_start := v_prev_end; end if;
  if v_end > v_start + make_interval(days => (p_pol->>'max_period_days')::integer) then
    v_end := v_start + make_interval(days => (p_pol->>'max_period_days')::integer);
  end if;
  if v_end <= p_now then
    v_end := v_start + make_interval(days => (p_pol->>'max_period_days')::integer);
  end if;

  v_profile := public.fc_resolve_profile(p_household_id, p_now);
  select * into pr from public.fc_budget_profiles where profile = v_profile;
  if not found then select * into pr from public.fc_budget_profiles where profile = 'unentitled'; end if;
  if not found then raise exception 'fc: budget profile % missing', v_profile; end if;

  insert into public.fc_budget_accounts (household_id, period_start, period_end, profile, base_budget_gbp, delivery_reserve_gbp, essential_reserve_gbp)
  values (p_household_id, v_start, v_end, pr.profile, pr.period_budget_gbp, pr.delivery_reserve_gbp, pr.essential_reserve_gbp)
  returning * into a;
  return a;
end;
$$;

revoke all on function public.fc_call_cost(integer, numeric, numeric, integer, boolean, integer, numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function public.fc_minute(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.fc_bump_minute(timestamptz, numeric, numeric, numeric, numeric, integer, numeric) from public, anon, authenticated, service_role;
revoke all on function public.fc_event(text, text, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fc_effective_policy(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fc_global_caps(jsonb, public.fc_global_state, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.fc_window_sums(timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.fc_resolve_profile(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.fc_account(uuid, timestamptz, timestamptz, timestamptz, jsonb) from public, anon, authenticated, service_role;

-- Shared global gate (caller already holds the global row lock). Returns a
-- deny reason or null; latches the breaker on a spend-rate trip.
create or replace function public.fc_global_gate(
  p_pol jsonb, p_now timestamptz, p_add_authorized numeric, p_add_worst numeric, p_new_reservation boolean,
  p_household uuid, p_call_sid text
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  g public.fc_global_state%rowtype;
  caps jsonb;
  w jsonb;
  v_reason text;
begin
  select * into g from public.fc_global_state where id = 1;
  if g.kill_switch then return 'kill_switch'; end if;
  if g.breaker_open then return 'breaker_open'; end if;
  caps := public.fc_global_caps(p_pol, g, p_now);
  w := public.fc_window_sums(p_now);
  v_reason := case
    -- Spend rate = estimated spend committed in the window + everything
    -- still reserved for live resources + this request. (Released
    -- reservations are not spend; an over-reservation can't false-trip.)
    when (w->>'hourCommitted')::numeric + g.active_reserved_gbp + p_add_authorized > (caps->>'hourly')::numeric then 'global_hourly_cap'
    when (w->>'dayCommitted')::numeric + g.active_reserved_gbp + p_add_authorized > (caps->>'daily')::numeric then 'global_daily_cap'
    when p_new_reservation and g.active_count + 1 > (caps->>'active')::numeric then 'global_active_count'
    when g.active_reserved_gbp + p_add_authorized > (caps->>'exposure')::numeric then 'global_exposure_cap'
    when g.active_worst_case_gbp + p_add_worst > (caps->>'worstCase')::numeric then 'global_worst_case_cap'
    else null end;
  if v_reason in ('global_hourly_cap', 'global_daily_cap') and (p_pol->>'breaker_latch_on_rate')::boolean then
    update public.fc_global_state set breaker_open = true, breaker_reason = v_reason, breaker_opened_at = p_now, updated_at = p_now where id = 1;
    perform public.fc_event('emergency', 'breaker_opened', p_household, p_call_sid,
      jsonb_build_object('reason', v_reason, 'caps', caps, 'window', w, 'requested', p_add_authorized));
  elsif v_reason is not null then
    perform public.fc_event('critical', v_reason, p_household, p_call_sid, jsonb_build_object('caps', caps, 'window', w,
      'activeCount', g.active_count, 'activeReserved', g.active_reserved_gbp, 'activeWorstCase', g.active_worst_case_gbp));
  end if;
  return v_reason;
end;
$$;
revoke all on function public.fc_global_gate(jsonb, timestamptz, numeric, numeric, boolean, uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- fc_authorize_call — /voice, BEFORE any billable TwiML (I1, I2, I4, I5, I6)
-- p_household_id null ⇒ unattributed call (number with no household).
-- Returns { allowed, reason, telephony, monitoring, funding, timeLimitSeconds,
--   leaseExpiresAt, reservedGbp, reservationId, existing, monitoringDeniedReason }
-- ---------------------------------------------------------------------------
create or replace function public.fc_authorize_call(
  p_household_id uuid,
  p_call_sid text,
  p_is_known boolean,
  p_wants_monitoring boolean,
  p_is_essential boolean,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_now timestamptz,
  p_overrides jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pol jsonb;
  g public.fc_global_state%rowtype;
  caps jsonb;
  w jsonb;
  a public.fc_budget_accounts%rowtype;
  pr public.fc_budget_profiles%rowtype;
  r public.fc_reservations%rowtype;
  v_key text;
  v_conn numeric; v_mon numeric; v_uplift numeric; v_fixed numeric;
  v_gran integer; v_lease integer; v_grace integer; v_monmax integer; v_maxcall integer;
  v_monitored boolean := false;
  v_mon_denied text;
  v_funding text;
  v_cost numeric;
  v_avail_budget numeric; v_avail_reserve numeric; v_avail_essential numeric; v_avail numeric;
  v_backstop integer;
  v_worst numeric;
  v_unit numeric;
  v_reason text;
  v_shadow text;
  v_tel_cost numeric;
  v_mon_cost numeric;
  v_contingent numeric; v_ess_contingent numeric;
  v_bs_avail numeric;
begin
  if p_call_sid is null or length(p_call_sid) < 3 or length(p_call_sid) > 64 then
    raise exception 'fc_authorize_call: invalid call sid';
  end if;
  if p_now is null then raise exception 'fc_authorize_call: now required'; end if;

  -- Serialisation point (see header).
  select * into g from public.fc_global_state where id = 1 for update;
  pol := public.fc_effective_policy(p_overrides);

  v_key := 'call:' || p_call_sid;
  select * into r from public.fc_reservations where idempotency_key = v_key;
  if found then
    return jsonb_build_object('allowed', r.state <> 'denied', 'existing', true, 'reason', r.deny_reason,
      'telephony', r.state <> 'denied', 'monitoring', r.monitored, 'funding', r.funding,
      'timeLimitSeconds', r.backstop_seconds, 'leaseExpiresAt', r.lease_expires_at,
      'reservedGbp', r.reserved_gbp, 'reservationId', r.id, 'state', r.state);
  end if;

  v_conn := (pol->>'connected_rate_gbp_per_min')::numeric;
  v_mon := (pol->>'monitoring_rate_gbp_per_min')::numeric;
  v_uplift := (pol->>'estimate_uplift')::numeric;
  v_fixed := (pol->>'call_fixed_fee_gbp')::numeric;
  v_gran := (pol->>'billing_granularity_seconds')::integer;
  v_lease := (pol->>'lease_seconds')::integer;
  v_grace := (pol->>'termination_grace_seconds')::integer;
  v_monmax := (pol->>'monitoring_max_seconds')::integer;
  v_maxcall := (pol->>'max_call_seconds')::integer;
  v_unit := v_gran / 60.0 * v_conn * v_uplift;   -- telephony £ per granularity block

  -- ---------------- unattributed call (no household) ----------------
  if p_household_id is null then
    v_backstop := least(v_maxcall, 120);
    v_cost := public.fc_call_cost(v_backstop + v_grace, v_conn, v_mon, v_monmax, false, v_gran, v_uplift, v_fixed);
    w := public.fc_window_sums(p_now);
    caps := public.fc_global_caps(pol, g, p_now);
    v_reason := public.fc_global_gate(pol, p_now, v_cost, v_cost, true, null, p_call_sid);
    if v_reason is null and (w->>'dayUnattributed')::numeric + v_cost > (caps->>'unattributedDaily')::numeric then
      v_reason := 'global_unattributed_cap';
      perform public.fc_event('critical', v_reason, null, p_call_sid, jsonb_build_object('window', w));
    end if;
    if v_reason is not null then
      insert into public.fc_reservations (idempotency_key, call_sid, category, state, deny_reason, started_at)
      values (v_key, p_call_sid, 'unattributed_call', 'denied', v_reason, p_now) returning * into r;
      insert into public.fc_ledger (idempotency_key, reservation_id, call_sid, category, entry_type, basis, amount_gbp, reason)
      values (v_key || ':deny', r.id, p_call_sid, 'unattributed_call', 'deny', 'none', 0, v_reason);
      return jsonb_build_object('allowed', false, 'reason', v_reason, 'telephony', false, 'monitoring', false, 'reservationId', r.id);
    end if;
    insert into public.fc_reservations (idempotency_key, call_sid, category, funding, state, connected_rate_gbp_per_min,
      monitoring_rate_gbp_per_min, started_at, covered_seconds, lease_expires_at, backstop_seconds, worst_case_gbp, reserved_gbp, total_authorized_gbp)
    values (v_key, p_call_sid, 'unattributed_call', 'unattributed', 'active', v_conn, v_mon, p_now, v_backstop + v_grace,
      p_now + make_interval(secs => v_backstop + v_grace), v_backstop, v_cost, v_cost, v_cost) returning * into r;
    insert into public.fc_ledger (idempotency_key, reservation_id, call_sid, category, entry_type, basis, amount_gbp, reason)
    values (v_key || ':reserve', r.id, p_call_sid, 'unattributed_call', 'reserve', 'estimate', v_cost, 'unattributed');
    update public.fc_global_state set active_count = active_count + 1, active_reserved_gbp = active_reserved_gbp + v_cost,
      active_worst_case_gbp = active_worst_case_gbp + v_cost, updated_at = p_now where id = 1;
    perform public.fc_bump_minute(p_now, v_cost, 0, 0, v_cost, 0);
    return jsonb_build_object('allowed', true, 'reason', null, 'telephony', true, 'monitoring', false, 'funding', 'unattributed',
      'timeLimitSeconds', v_backstop, 'leaseExpiresAt', r.lease_expires_at, 'reservedGbp', v_cost, 'reservationId', r.id);
  end if;

  -- ---------------- household call ----------------
  a := public.fc_account(p_household_id, p_period_start, p_period_end, p_now, pol);
  select * into pr from public.fc_budget_profiles where profile = a.profile;

  -- Headroom after reservations AND after the unreserved worst case of the
  -- household's other live calls (their backstop cost beyond what they have
  -- reserved): consumed + Σ live worst cases ≤ budget + adjustments +
  -- reserve, so even if every HCG server stopped now, the provider time
  -- limits keep the household inside its authorisation (I5).
  select coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding <> 'essential'), 0),
         coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding = 'essential'), 0)
    into v_contingent, v_ess_contingent
    from public.fc_reservations where household_id = p_household_id and state in ('active', 'terminating');
  v_avail_budget := a.base_budget_gbp + a.adjustments_gbp - a.consumed_gbp - a.reserved_gbp - v_contingent;
  v_avail_reserve := v_avail_budget + a.delivery_reserve_gbp;
  v_avail_essential := a.essential_reserve_gbp - a.essential_consumed_gbp - a.essential_reserved_gbp - v_ess_contingent;

  -- Monitoring: profile, soft global monitoring cap, and affordability of
  -- the FULL monitoring window + first lease from the main budget.
  if coalesce(p_wants_monitoring, false) then
    w := public.fc_window_sums(p_now);
    caps := public.fc_global_caps(pol, g, p_now);
    v_mon_cost := public.fc_call_cost(v_monmax, 0, v_mon, v_monmax, true, v_gran, v_uplift, 0);
    if pr.profile is null or not pr.monitoring_allowed then
      v_mon_denied := 'monitoring_not_in_profile';
    elsif (w->>'hourMonitoringCommitted')::numeric
          + v_mon_cost * (select count(*) from public.fc_reservations where monitored and state in ('active', 'terminating'))
          + v_mon_cost > (caps->>'monitoringHourly')::numeric then
      v_mon_denied := 'global_monitoring_hourly_cap';
    elsif v_avail_budget < public.fc_call_cost(v_lease + v_grace, v_conn, v_mon, v_monmax, false, v_gran, v_uplift, v_fixed) + v_mon_cost then
      v_mon_denied := 'monitoring_budget_insufficient';
    else
      v_monitored := true;
    end if;
  end if;

  v_tel_cost := public.fc_call_cost(v_lease + v_grace, v_conn, v_mon, v_monmax, false, v_gran, v_uplift, v_fixed);
  -- A monitored call reserves the WHOLE monitoring window up front (it is
  -- never renewed); telephony is leased.
  v_cost := v_tel_cost + case when v_monitored then public.fc_call_cost(v_monmax, 0, v_mon, v_monmax, true, v_gran, v_uplift, 0) else 0 end;

  -- Funding: budget → delivery reserve (scope) → essential pool.
  if v_avail_budget >= v_cost then
    v_funding := 'budget'; v_avail := v_avail_budget;
  elsif pr.delivery_reserve_scope <> 'none' and (pr.delivery_reserve_scope = 'all' or coalesce(p_is_known, false))
        and v_avail_reserve >= v_tel_cost then
    v_funding := 'reserve'; v_avail := v_avail_reserve; v_monitored := false; v_cost := v_tel_cost;
    v_mon_denied := coalesce(v_mon_denied, case when coalesce(p_wants_monitoring, false) then 'monitoring_budget_insufficient' end);
  elsif coalesce(p_is_essential, false) and v_avail_essential >= v_tel_cost then
    v_funding := 'essential'; v_avail := v_avail_essential; v_monitored := false; v_cost := v_tel_cost;
  else
    v_funding := null;
  end if;

  if v_funding is null then
    if pol->>'enforcement_mode' = 'shadow' then
      v_shadow := 'household_budget_exhausted';
      v_funding := 'budget'; v_avail := greatest(v_avail_reserve, v_cost); v_monitored := false; v_cost := v_tel_cost;
    else
      v_reason := 'household_budget_exhausted';
    end if;
  end if;

  if v_reason is null then
    -- Backstop (I4): what the funding source could afford at admission,
    -- capped by policy, never below the lease.
    v_mon_cost := case when v_monitored then public.fc_call_cost(v_monmax, 0, v_mon, v_monmax, true, v_gran, v_uplift, 0) else 0 end;
    v_bs_avail := greatest(v_avail * (pol->>'backstop_share')::numeric, v_cost);
    v_backstop := least(v_maxcall, greatest(v_lease,
      (floor(greatest(v_bs_avail - v_mon_cost - v_fixed, 0) / v_unit) * v_gran)::integer - v_grace));
    if v_shadow is not null then v_backstop := v_maxcall; end if;
    v_worst := public.fc_call_cost(v_backstop + v_grace, v_conn, v_mon, v_monmax, v_monitored, v_gran, v_uplift, v_fixed);
    v_reason := public.fc_global_gate(pol, p_now, v_cost, v_worst, true, p_household_id, p_call_sid);
    -- If only the monitoring share broke a global cap, retry unmonitored.
    if v_reason in ('global_exposure_cap', 'global_worst_case_cap') and v_monitored then
      v_monitored := false; v_cost := v_tel_cost; v_mon_denied := v_reason;
      v_bs_avail := greatest(v_avail * (pol->>'backstop_share')::numeric, v_cost);
      v_backstop := least(v_maxcall, greatest(v_lease, (floor(greatest(v_bs_avail - v_fixed, 0) / v_unit) * v_gran)::integer - v_grace));
      v_worst := public.fc_call_cost(v_backstop + v_grace, v_conn, v_mon, v_monmax, false, v_gran, v_uplift, v_fixed);
      v_reason := public.fc_global_gate(pol, p_now, v_cost, v_worst, true, p_household_id, p_call_sid);
    end if;
  end if;

  if v_reason is not null then
    insert into public.fc_reservations (idempotency_key, household_id, period_start, call_sid, category, state, deny_reason, is_known, started_at)
    values (v_key, p_household_id, a.period_start, p_call_sid, 'call', 'denied', v_reason, coalesce(p_is_known, false), p_now) returning * into r;
    insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
    values (v_key || ':deny', r.id, p_household_id, p_call_sid, 'call', 'deny', 'none', 0, v_reason);
    update public.fc_budget_accounts set last_denial_reason = v_reason, last_denial_at = p_now, updated_at = p_now
     where household_id = p_household_id and period_start = a.period_start;
    if v_reason = 'household_budget_exhausted' then
      perform public.fc_event('warning', v_reason, p_household_id, p_call_sid, jsonb_build_object('profile', a.profile,
        'availableBudget', v_avail_budget, 'availableWithReserve', v_avail_reserve, 'availableEssential', v_avail_essential));
    end if;
    return jsonb_build_object('allowed', false, 'reason', v_reason, 'telephony', false, 'monitoring', false, 'reservationId', r.id);
  end if;

  insert into public.fc_reservations (idempotency_key, household_id, period_start, call_sid, category, funding, state, shadow_denied_reason,
    monitored, is_known, connected_rate_gbp_per_min, monitoring_rate_gbp_per_min, started_at, covered_seconds, lease_expires_at,
    backstop_seconds, worst_case_gbp, reserved_gbp, total_authorized_gbp, details)
  values (v_key, p_household_id, a.period_start, p_call_sid, 'call', v_funding, 'active', v_shadow,
    v_monitored, coalesce(p_is_known, false), v_conn, v_mon, p_now, v_lease + v_grace, p_now + make_interval(secs => v_lease),
    v_backstop, v_worst, v_cost, v_cost, jsonb_build_object('monitoringDeniedReason', v_mon_denied, 'profile', a.profile))
  returning * into r;
  insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
  values (v_key || ':reserve', r.id, p_household_id, p_call_sid, 'call', 'reserve', 'estimate', v_cost, v_funding);

  if v_funding = 'essential' then
    update public.fc_budget_accounts set essential_reserved_gbp = essential_reserved_gbp + v_cost, updated_at = p_now
     where household_id = p_household_id and period_start = a.period_start;
  else
    update public.fc_budget_accounts set reserved_gbp = reserved_gbp + v_cost, updated_at = p_now
     where household_id = p_household_id and period_start = a.period_start;
  end if;
  update public.fc_global_state set active_count = active_count + 1, active_reserved_gbp = active_reserved_gbp + v_cost,
    active_worst_case_gbp = active_worst_case_gbp + v_worst, updated_at = p_now where id = 1;
  perform public.fc_bump_minute(p_now, v_cost, 0,
    case when v_monitored then public.fc_call_cost(v_monmax, 0, v_mon, v_monmax, true, v_gran, v_uplift, 0) else 0 end, 0, 0);

  -- Opportunistic retention of minute buckets.
  delete from public.fc_spend_minutes where minute < p_now - interval '3 days';

  return jsonb_build_object('allowed', true, 'reason', null, 'existing', false, 'telephony', true, 'monitoring', v_monitored,
    'monitoringDeniedReason', v_mon_denied, 'funding', v_funding, 'shadowDeniedReason', v_shadow,
    'timeLimitSeconds', v_backstop, 'leaseExpiresAt', r.lease_expires_at, 'reservedGbp', v_cost,
    'worstCaseGbp', v_worst, 'reservationId', r.id, 'profile', a.profile);
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal: move a live reservation to settled (caller holds the global lock).
-- ---------------------------------------------------------------------------
create or replace function public.fc_settle_locked(
  p_res public.fc_reservations, p_duration_seconds integer, p_monitored_seconds integer, p_source text, p_now timestamptz
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  r public.fc_reservations := p_res;
  v_dur integer;
  v_mon_secs integer;
  v_commit numeric;
  v_release numeric;
  v_overrun numeric;
  v_gran integer;
  v_uplift numeric;
  v_fixed numeric;
  v_monmax integer;
  v_extra numeric;
  pol jsonb := public.fc_effective_policy(null);
begin
  if r.state not in ('active', 'terminating') then
    return jsonb_build_object('ok', true, 'alreadySettled', true, 'state', r.state, 'committedGbp', r.committed_gbp);
  end if;
  v_gran := (pol->>'billing_granularity_seconds')::integer;
  v_uplift := (pol->>'estimate_uplift')::numeric;
  v_fixed := (pol->>'call_fixed_fee_gbp')::numeric;
  v_monmax := (pol->>'monitoring_max_seconds')::integer;

  v_dur := greatest(0, coalesce(p_duration_seconds, ceil(extract(epoch from (p_now - r.started_at)))::integer));
  -- A duration claim above the provider backstop + grace is impossible; clamp.
  if r.backstop_seconds is not null then v_dur := least(v_dur, r.backstop_seconds + (pol->>'termination_grace_seconds')::integer + v_gran); end if;
  v_mon_secs := case when r.monitored and r.monitoring_started then least(v_dur, coalesce(p_monitored_seconds, v_dur), v_monmax) else 0 end;

  if r.category in ('call', 'unattributed_call') then
    v_commit := public.fc_call_cost(v_dur, r.connected_rate_gbp_per_min, r.monitoring_rate_gbp_per_min, v_monmax, false, v_gran, v_uplift, v_fixed)
      + case when v_mon_secs > 0 then public.fc_call_cost(v_mon_secs, 0, r.monitoring_rate_gbp_per_min, v_monmax, true, v_gran, v_uplift, 0) else 0 end;
  else
    v_commit := r.total_authorized_gbp;
  end if;
  v_overrun := greatest(0, v_commit - r.total_authorized_gbp);
  v_release := greatest(0, r.reserved_gbp - v_commit);
  -- Provider actual recorded BEFORE settlement and above the estimate: the
  -- household is charged max(estimate, actual) (I7).
  v_extra := greatest(0, r.actual_gbp - v_commit);

  update public.fc_reservations set state = 'settled', settled_at = p_now, settle_source = p_source,
    settled_duration_seconds = v_dur, committed_gbp = v_commit, overrun_gbp = v_overrun, reserved_gbp = 0
   where id = r.id;
  insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason, details)
  values (r.idempotency_key || ':commit', r.id, r.household_id, r.call_sid, r.category, 'commit', 'estimate', v_commit, p_source,
    jsonb_build_object('durationSeconds', v_dur, 'monitoredSeconds', v_mon_secs, 'overrunGbp', v_overrun))
  on conflict (idempotency_key) do nothing;
  if v_release > 0 then
    insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
    values (r.idempotency_key || ':release', r.id, r.household_id, r.call_sid, r.category, 'release', 'estimate', v_release, p_source)
    on conflict (idempotency_key) do nothing;
  end if;

  if r.household_id is not null and r.period_start is not null then
    if r.funding = 'essential' then
      update public.fc_budget_accounts set essential_reserved_gbp = greatest(0, essential_reserved_gbp - r.reserved_gbp),
        essential_consumed_gbp = essential_consumed_gbp + v_commit + v_extra, updated_at = p_now
       where household_id = r.household_id and period_start = r.period_start;
    elsif r.funding is distinct from 'global' then
      update public.fc_budget_accounts set reserved_gbp = greatest(0, reserved_gbp - r.reserved_gbp),
        consumed_gbp = consumed_gbp + v_commit + v_extra, updated_at = p_now
       where household_id = r.household_id and period_start = r.period_start;
    end if;
  end if;
  if v_extra > 0 then
    insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
    values (r.idempotency_key || ':commit-actual-excess', r.id, r.household_id, r.call_sid, r.category, 'commit', 'actual', v_extra, 'actual_exceeds_estimate')
    on conflict (idempotency_key) do nothing;
    perform public.fc_event('critical', 'estimate_undercount', r.household_id, r.call_sid,
      jsonb_build_object('estimateGbp', v_commit, 'actualGbp', r.actual_gbp, 'chargedGbp', v_extra));
  end if;
  if r.category in ('call', 'unattributed_call') then
    update public.fc_global_state set active_count = greatest(0, active_count - 1),
      active_reserved_gbp = greatest(0, active_reserved_gbp - r.reserved_gbp),
      active_worst_case_gbp = greatest(0, active_worst_case_gbp - r.worst_case_gbp), updated_at = p_now where id = 1;
  end if;
  perform public.fc_bump_minute(p_now, v_overrun + v_extra, v_commit + v_extra, 0, 0, 0,
    case when v_mon_secs > 0 then public.fc_call_cost(v_mon_secs, 0, r.monitoring_rate_gbp_per_min, v_monmax, true, v_gran, v_uplift, 0) else 0 end);
  if v_overrun > 0 then
    perform public.fc_event('warning', 'lease_overrun', r.household_id, r.call_sid,
      jsonb_build_object('overrunGbp', v_overrun, 'durationSeconds', v_dur, 'coveredSeconds', r.covered_seconds, 'source', p_source));
  end if;
  return jsonb_build_object('ok', true, 'alreadySettled', false, 'committedGbp', v_commit, 'releasedGbp', v_release,
    'overrunGbp', v_overrun, 'durationSeconds', v_dur);
end;
$$;
revoke all on function public.fc_settle_locked(public.fc_reservations, integer, integer, text, timestamptz) from public, anon, authenticated, service_role;

-- Settle a call (Dial action callback, provider status, stale sweep). Idempotent.
create or replace function public.fc_settle_call(
  p_call_sid text, p_duration_seconds integer, p_monitored_seconds integer, p_source text, p_now timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.fc_reservations%rowtype;
begin
  if p_duration_seconds is not null and (p_duration_seconds < 0 or p_duration_seconds > 86400) then
    raise exception 'fc_settle_call: invalid duration';
  end if;
  perform 1 from public.fc_global_state where id = 1 for update;
  select * into r from public.fc_reservations where idempotency_key = 'call:' || p_call_sid for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_call'); end if;
  return public.fc_settle_locked(r, p_duration_seconds, p_monitored_seconds, coalesce(p_source, 'unspecified'), p_now);
end;
$$;

-- The media stream for this call actually started (monitoring cost is
-- committed only if it did). Idempotent; refused if not authorised.
create or replace function public.fc_mark_monitoring_started(p_call_sid text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.fc_reservations%rowtype;
begin
  select * into r from public.fc_reservations where idempotency_key = 'call:' || p_call_sid for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_reservation'); end if;
  if not r.monitored then return jsonb_build_object('ok', false, 'reason', 'monitoring_not_authorized'); end if;
  if r.state not in ('active', 'terminating') then return jsonb_build_object('ok', false, 'reason', 'call_not_live'); end if;
  update public.fc_reservations set monitoring_started = true where id = r.id;
  return jsonb_build_object('ok', true, 'alreadyStarted', r.monitoring_started);
end;
$$;

-- ---------------------------------------------------------------------------
-- fc_renew_lease — re-authorise one live call (I3). Idempotent within a
-- lease: a renewal that isn't due is a no-op. Returns { action } where
-- action ∈ not_due | renewed | at_backstop | terminate | already_terminating | settled.
-- ---------------------------------------------------------------------------
create or replace function public.fc_renew_lease(p_call_sid text, p_now timestamptz, p_overrides jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pol jsonb;
  g public.fc_global_state%rowtype;
  r public.fc_reservations%rowtype;
  a public.fc_budget_accounts%rowtype;
  pr public.fc_budget_profiles%rowtype;
  v_lease integer; v_grace integer; v_gran integer; v_uplift numeric; v_monmax integer;
  v_new_cover integer;
  v_inc numeric;
  v_avail numeric;
  v_reason text;
begin
  select * into g from public.fc_global_state where id = 1 for update;
  pol := public.fc_effective_policy(p_overrides);
  select * into r from public.fc_reservations where idempotency_key = 'call:' || p_call_sid for update;
  if not found then return jsonb_build_object('action', 'unknown_call'); end if;
  if r.state = 'settled' or r.state = 'denied' then return jsonb_build_object('action', 'settled', 'state', r.state); end if;
  if r.state = 'terminating' then
    return jsonb_build_object('action', 'already_terminating', 'terminateAt', r.terminate_at, 'reason', r.termination_reason);
  end if;

  v_lease := (pol->>'lease_seconds')::integer;
  v_grace := (pol->>'termination_grace_seconds')::integer;
  v_gran := (pol->>'billing_granularity_seconds')::integer;
  v_uplift := (pol->>'estimate_uplift')::numeric;
  v_monmax := (pol->>'monitoring_max_seconds')::integer;

  if r.lease_expires_at > p_now + make_interval(secs => (pol->>'renew_ahead_seconds')::integer) then
    return jsonb_build_object('action', 'not_due', 'leaseExpiresAt', r.lease_expires_at);
  end if;
  if r.covered_seconds >= coalesce(r.backstop_seconds, 0) + v_grace then
    return jsonb_build_object('action', 'at_backstop', 'leaseExpiresAt', r.lease_expires_at);
  end if;

  v_new_cover := least(r.covered_seconds + v_lease, coalesce(r.backstop_seconds, r.covered_seconds + v_lease) + v_grace);
  v_inc := public.fc_call_cost(v_new_cover, r.connected_rate_gbp_per_min, 0, v_monmax, false, v_gran, v_uplift, 0)
         - public.fc_call_cost(r.covered_seconds, r.connected_rate_gbp_per_min, 0, v_monmax, false, v_gran, v_uplift, 0);
  v_inc := greatest(v_inc, 0);

  -- Breaker / kill switch: refuse renewals (live calls end at lease end).
  if g.kill_switch and (pol->>'breaker_terminates_active')::boolean then v_reason := 'kill_switch';
  elsif g.breaker_open and (pol->>'breaker_terminates_active')::boolean then v_reason := 'breaker_open';
  end if;

  if v_reason is null and r.household_id is not null and r.funding in ('budget', 'reserve', 'essential') then
    select * into a from public.fc_budget_accounts where household_id = r.household_id and period_start = r.period_start for update;
    select * into pr from public.fc_budget_profiles where profile = a.profile;
    if r.funding = 'essential' then
      v_avail := a.essential_reserve_gbp - a.essential_consumed_gbp - a.essential_reserved_gbp;
    else
      -- Budget first; the delivery reserve continues the (telephony) call
      -- when the profile's scope covers this caller.
      v_avail := a.base_budget_gbp + a.adjustments_gbp - a.consumed_gbp - a.reserved_gbp
               + case when pr.delivery_reserve_scope = 'all' or (pr.delivery_reserve_scope = 'trusted_only' and r.is_known)
                      then a.delivery_reserve_gbp else 0 end;
    end if;
    if v_avail < v_inc then
      if pol->>'enforcement_mode' = 'shadow' then
        update public.fc_reservations set shadow_denied_reason = 'household_budget_exhausted' where id = r.id;
      else
        v_reason := 'household_budget_exhausted';
      end if;
    end if;
  end if;
  if v_reason is null then
    -- Renewal adds authorisation, not a new reservation; worst case unchanged.
    v_reason := public.fc_global_gate(pol, p_now, v_inc, 0, false, r.household_id, r.call_sid);
    -- An existing call's lease never fails on capacity caps (only on spend
    -- rate, which latches the breaker, or on its own budget).
    if v_reason in ('global_exposure_cap', 'global_worst_case_cap', 'global_active_count') then v_reason := null; end if;
  end if;

  if v_reason is not null then
    update public.fc_reservations set state = 'terminating', terminate_at = r.lease_expires_at, termination_reason = v_reason
     where id = r.id;
    insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
    values (r.idempotency_key || ':terminate', r.id, r.household_id, r.call_sid, r.category, 'terminate', 'none', 0, v_reason)
    on conflict (idempotency_key) do nothing;
    perform public.fc_event('warning', 'lease_renewal_refused', r.household_id, r.call_sid,
      jsonb_build_object('reason', v_reason, 'terminateAt', r.lease_expires_at, 'coveredSeconds', r.covered_seconds));
    return jsonb_build_object('action', 'terminate', 'reason', v_reason, 'terminateAt', r.lease_expires_at);
  end if;

  update public.fc_reservations set covered_seconds = v_new_cover,
    lease_expires_at = least(r.started_at + make_interval(secs => v_new_cover - v_grace), r.started_at + make_interval(secs => coalesce(r.backstop_seconds, v_new_cover))),
    reserved_gbp = reserved_gbp + v_inc, total_authorized_gbp = total_authorized_gbp + v_inc, extensions = extensions + 1
   where id = r.id returning * into r;
  insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
  values (r.idempotency_key || ':extend:' || r.extensions, r.id, r.household_id, r.call_sid, r.category, 'extend', 'estimate', v_inc, r.funding);
  if r.household_id is not null and r.funding = 'essential' then
    update public.fc_budget_accounts set essential_reserved_gbp = essential_reserved_gbp + v_inc, updated_at = p_now
     where household_id = r.household_id and period_start = r.period_start;
  elsif r.household_id is not null and r.funding in ('budget', 'reserve', 'degraded') then
    update public.fc_budget_accounts set reserved_gbp = reserved_gbp + v_inc, updated_at = p_now
     where household_id = r.household_id and period_start = r.period_start;
  end if;
  update public.fc_global_state set active_reserved_gbp = active_reserved_gbp + v_inc, updated_at = p_now where id = 1;
  perform public.fc_bump_minute(p_now, v_inc, 0, 0, 0, 0);
  return jsonb_build_object('action', 'renewed', 'leaseExpiresAt', r.lease_expires_at, 'coveredSeconds', r.covered_seconds,
    'addedGbp', v_inc, 'extensions', r.extensions);
end;
$$;

-- Live reservations the sweeper must act on: lease ending within
-- renew-ahead, or terminating and due. Read-only.
create or replace function public.fc_due_leases(p_now timestamptz, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('callSid', call_sid, 'state', state, 'leaseExpiresAt', lease_expires_at,
      'terminateAt', terminate_at, 'terminationAttempts', termination_attempts, 'startedAt', started_at,
      'backstopSeconds', backstop_seconds, 'category', category, 'funding', funding) order by lease_expires_at), '[]'::jsonb)
  from (
    select * from public.fc_reservations
     where category in ('call', 'unattributed_call')
       and ((state = 'active' and lease_expires_at <= p_now + make_interval(secs => (select renew_ahead_seconds from public.fc_policy where id = 1))
             and (last_provider_check_at is null or last_provider_check_at < p_now - interval '20 seconds'))
         or (state = 'terminating' and termination_confirmed_at is null
             and (termination_last_attempt_at is null or termination_last_attempt_at < p_now - interval '10 seconds')))
     order by lease_expires_at
     limit greatest(1, least(coalesce(p_limit, 100), 1000))
  ) d;
$$;

create or replace function public.fc_record_termination(p_call_sid text, p_confirmed boolean, p_provider_status text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.fc_reservations set termination_attempts = termination_attempts + 1, termination_last_attempt_at = p_now,
    termination_confirmed_at = case when p_confirmed then coalesce(termination_confirmed_at, p_now) else termination_confirmed_at end,
    provider_status = coalesce(p_provider_status, provider_status)
   where idempotency_key = 'call:' || p_call_sid;
  return jsonb_build_object('ok', found);
end;
$$;

create or replace function public.fc_note_provider_check(p_call_sid text, p_provider_status text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.fc_reservations set last_provider_check_at = p_now, provider_status = coalesce(p_provider_status, provider_status)
   where idempotency_key = 'call:' || p_call_sid;
  return jsonb_build_object('ok', found);
end;
$$;

-- ---------------------------------------------------------------------------
-- Adopt a call admitted by the degraded envelope while the DB was down
-- (it HAS already happened: counted, never refused). Idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.fc_adopt_degraded_call(
  p_household_id uuid, p_call_sid text, p_started_at timestamptz, p_time_limit_seconds integer,
  p_period_start timestamptz, p_period_end timestamptz, p_now timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pol jsonb;
  a public.fc_budget_accounts%rowtype;
  r public.fc_reservations%rowtype;
  v_cost numeric;
  v_grace integer;
begin
  if p_time_limit_seconds is null or p_time_limit_seconds <= 0 or p_time_limit_seconds > 14400 then
    raise exception 'fc_adopt_degraded_call: invalid time limit';
  end if;
  perform 1 from public.fc_global_state where id = 1 for update;
  pol := public.fc_effective_policy(null);
  select * into r from public.fc_reservations where idempotency_key = 'call:' || p_call_sid;
  if found then return jsonb_build_object('ok', true, 'existing', true, 'state', r.state); end if;
  v_grace := (pol->>'termination_grace_seconds')::integer;
  v_cost := public.fc_call_cost(p_time_limit_seconds + v_grace, (pol->>'connected_rate_gbp_per_min')::numeric, 0, 1, false,
    (pol->>'billing_granularity_seconds')::integer, (pol->>'estimate_uplift')::numeric, (pol->>'call_fixed_fee_gbp')::numeric);
  if p_household_id is not null then
    a := public.fc_account(p_household_id, p_period_start, p_period_end, p_started_at, pol);
  end if;
  insert into public.fc_reservations (idempotency_key, household_id, period_start, call_sid, category, funding, state,
    connected_rate_gbp_per_min, monitoring_rate_gbp_per_min, started_at, covered_seconds, lease_expires_at, backstop_seconds,
    worst_case_gbp, reserved_gbp, total_authorized_gbp, details)
  values ('call:' || p_call_sid, p_household_id, a.period_start, p_call_sid,
    case when p_household_id is null then 'unattributed_call' else 'call' end, 'degraded', 'active',
    (pol->>'connected_rate_gbp_per_min')::numeric, (pol->>'monitoring_rate_gbp_per_min')::numeric,
    p_started_at, p_time_limit_seconds + v_grace, p_started_at + make_interval(secs => p_time_limit_seconds),
    p_time_limit_seconds, v_cost, v_cost, v_cost, jsonb_build_object('adoptedAt', p_now))
  returning * into r;
  insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
  values (r.idempotency_key || ':adopt', r.id, p_household_id, p_call_sid, r.category, 'adopt', 'estimate', v_cost, 'degraded_envelope');
  if p_household_id is not null then
    update public.fc_budget_accounts set reserved_gbp = reserved_gbp + v_cost, updated_at = p_now
     where household_id = p_household_id and period_start = a.period_start;
  end if;
  update public.fc_global_state set active_count = active_count + 1, active_reserved_gbp = active_reserved_gbp + v_cost,
    active_worst_case_gbp = active_worst_case_gbp + v_cost, updated_at = p_now where id = 1;
  perform public.fc_bump_minute(p_now, v_cost, 0, 0, 0, 0);
  perform public.fc_event('critical', 'degraded_call_adopted', p_household_id, p_call_sid, jsonb_build_object('reservedGbp', v_cost));
  return jsonb_build_object('ok', true, 'existing', false, 'reservedGbp', v_cost);
end;
$$;

-- ---------------------------------------------------------------------------
-- One-shot spend (SMS, AI request, number purchase): authorise + commit in
-- one step (I1, I6). Idempotent per key. Household may be null (global).
-- ---------------------------------------------------------------------------
create or replace function public.fc_authorize_spend(
  p_idempotency_key text, p_household_id uuid, p_category text, p_units integer,
  p_period_start timestamptz, p_period_end timestamptz, p_now timestamptz, p_overrides jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pol jsonb;
  g public.fc_global_state%rowtype;
  a public.fc_budget_accounts%rowtype;
  r public.fc_reservations%rowtype;
  w jsonb;
  caps jsonb;
  v_cost numeric;
  v_reason text;
  v_funding text := 'global';
  v_key text;
begin
  if p_category not in ('sms', 'ai', 'number_purchase') then raise exception 'fc_authorize_spend: invalid category'; end if;
  if p_units is null or p_units < 1 or p_units > 20 then raise exception 'fc_authorize_spend: invalid units'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 3 or length(p_idempotency_key) > 180 then
    raise exception 'fc_authorize_spend: invalid idempotency key';
  end if;
  select * into g from public.fc_global_state where id = 1 for update;
  pol := public.fc_effective_policy(p_overrides);
  v_key := p_category || ':' || p_idempotency_key;
  select * into r from public.fc_reservations where idempotency_key = v_key;
  if found then
    return jsonb_build_object('allowed', r.state <> 'denied', 'existing', true, 'reason', r.deny_reason, 'reservationId', r.id);
  end if;

  v_cost := p_units * (pol->>'estimate_uplift')::numeric * case p_category
    when 'sms' then (pol->>'sms_unit_gbp')::numeric
    when 'ai' then (pol->>'ai_request_gbp')::numeric
    else (pol->>'number_purchase_gbp')::numeric end;

  v_reason := public.fc_global_gate(pol, p_now, v_cost, 0, false, p_household_id, null);
  if v_reason = 'global_exposure_cap' or v_reason = 'global_worst_case_cap' then v_reason := null; end if; -- one-shot: no live exposure
  if v_reason is null and p_category = 'number_purchase' then
    w := public.fc_window_sums(p_now);
    caps := public.fc_global_caps(pol, g, p_now);
    if (w->>'dayNumberPurchases')::numeric + 1 > (caps->>'numberPurchasesDaily')::numeric then
      v_reason := 'global_number_purchase_cap';
      perform public.fc_event('emergency', v_reason, p_household_id, null, jsonb_build_object('window', w));
    end if;
  end if;
  if v_reason is null and p_household_id is not null and p_category <> 'number_purchase' then
    a := public.fc_account(p_household_id, p_period_start, p_period_end, p_now, pol);
    v_funding := 'budget';
    if a.base_budget_gbp + a.adjustments_gbp - a.consumed_gbp - a.reserved_gbp
       - (select coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)), 0) from public.fc_reservations
           where household_id = p_household_id and state in ('active', 'terminating') and funding <> 'essential') < v_cost then
      if pol->>'enforcement_mode' = 'shadow' then null; else v_reason := 'household_budget_exhausted'; end if;
    end if;
  end if;

  if v_reason is not null then
    insert into public.fc_reservations (idempotency_key, household_id, period_start, category, state, deny_reason, started_at)
    values (v_key, p_household_id, a.period_start, p_category, 'denied', v_reason, p_now) returning * into r;
    insert into public.fc_ledger (idempotency_key, reservation_id, household_id, category, entry_type, basis, amount_gbp, reason)
    values (v_key || ':deny', r.id, p_household_id, p_category, 'deny', 'none', 0, v_reason);
    return jsonb_build_object('allowed', false, 'reason', v_reason, 'reservationId', r.id);
  end if;

  insert into public.fc_reservations (idempotency_key, household_id, period_start, category, funding, state, started_at,
    total_authorized_gbp, committed_gbp, settled_at, settle_source)
  values (v_key, p_household_id, a.period_start, p_category, v_funding, 'settled', p_now, v_cost, v_cost, p_now, 'one_shot')
  returning * into r;
  insert into public.fc_ledger (idempotency_key, reservation_id, household_id, category, entry_type, basis, amount_gbp, reason)
  values (v_key || ':commit', r.id, p_household_id, p_category, 'commit', 'estimate', v_cost, 'one_shot');
  if v_funding = 'budget' then
    update public.fc_budget_accounts set consumed_gbp = consumed_gbp + v_cost, updated_at = p_now
     where household_id = p_household_id and period_start = a.period_start;
  end if;
  perform public.fc_bump_minute(p_now, v_cost, v_cost, 0, 0, case when p_category = 'number_purchase' then 1 else 0 end);
  return jsonb_build_object('allowed', true, 'reason', null, 'costGbp', v_cost, 'reservationId', r.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Actual provider cost (I7). Unique per provider reference: duplicated
-- provider callbacks or re-run reconciliations add nothing.
-- ---------------------------------------------------------------------------
create or replace function public.fc_record_actual(
  p_provider text, p_provider_ref text, p_call_sid text, p_category text, p_amount_gbp numeric, p_now timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.fc_reservations%rowtype;
  v_key text;
  v_total numeric;
  v_charge numeric := 0;
  v_rows integer;
begin
  if p_provider is null or p_provider_ref is null or length(p_provider_ref) < 3 then raise exception 'fc_record_actual: provider reference required'; end if;
  if p_amount_gbp is null or p_amount_gbp = 'NaN'::numeric or p_amount_gbp < 0 or p_amount_gbp > 1000 then
    raise exception 'fc_record_actual: invalid amount';
  end if;
  perform 1 from public.fc_global_state where id = 1 for update;
  v_key := 'actual:' || p_provider || ':' || p_provider_ref || ':' || coalesce(p_category, 'unknown');
  if p_call_sid is not null then
    select * into r from public.fc_reservations where idempotency_key = 'call:' || p_call_sid for update;
  end if;
  insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, provider, provider_ref, reason)
  values (v_key, r.id, r.household_id, p_call_sid, coalesce(p_category, 'unknown'), 'actual', 'actual', p_amount_gbp, p_provider, p_provider_ref, 'provider_cost')
  on conflict (idempotency_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('ok', true, 'duplicate', true); end if;

  if r.id is null then
    perform public.fc_bump_minute(p_now, 0, p_amount_gbp, 0, 0, 0);
    return jsonb_build_object('ok', true, 'duplicate', false, 'matched', false);
  end if;

  v_total := r.actual_gbp + p_amount_gbp;
  update public.fc_reservations set actual_gbp = v_total where id = r.id;
  -- Charge the household max(estimate, actual): only the part of actual
  -- above what was already charged (estimate or earlier actual).
  if r.state = 'settled' then
    v_charge := greatest(0, v_total - greatest(r.committed_gbp, r.actual_gbp));
  end if;
  if r.household_id is not null and r.period_start is not null then
    update public.fc_budget_accounts set actual_gbp = actual_gbp + p_amount_gbp,
      consumed_gbp = consumed_gbp + v_charge, updated_at = p_now
     where household_id = r.household_id and period_start = r.period_start;
  end if;
  if v_charge > 0 then
    insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, provider, provider_ref, reason)
    values (v_key || ':undercount', r.id, r.household_id, p_call_sid, r.category, 'commit', 'actual', v_charge, p_provider, p_provider_ref, 'actual_exceeds_estimate');
    perform public.fc_bump_minute(p_now, v_charge, v_charge, 0, 0, 0);
    perform public.fc_event('critical', 'estimate_undercount', r.household_id, p_call_sid,
      jsonb_build_object('estimateGbp', r.committed_gbp, 'actualGbp', v_total, 'chargedGbp', v_charge));
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'matched', true, 'actualTotalGbp', v_total, 'chargedGbp', v_charge);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin controls (audited; bounded)
-- ---------------------------------------------------------------------------
create or replace function public.fc_admin_adjust(
  p_household_id uuid, p_amount_gbp numeric, p_reason text, p_actor text, p_idempotency_key text,
  p_source text, p_period_start timestamptz, p_period_end timestamptz, p_now timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.fc_budget_accounts%rowtype;
  v_key text;
  v_rows integer;
begin
  if p_household_id is null then raise exception 'fc_admin_adjust: household required'; end if;
  if p_amount_gbp is null or p_amount_gbp = 'NaN'::numeric or p_amount_gbp = 0 or p_amount_gbp < -50 or p_amount_gbp > 50 then
    raise exception 'fc_admin_adjust: amount must be non-zero and within ±£50';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then
    raise exception 'fc_admin_adjust: reason and actor required';
  end if;
  if coalesce(p_source, '') not in ('admin', 'topup', 'plan_change', 'goodwill', 'test') then
    raise exception 'fc_admin_adjust: invalid source';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 3 then raise exception 'fc_admin_adjust: idempotency key required'; end if;
  perform 1 from public.fc_global_state where id = 1 for update;
  a := public.fc_account(p_household_id, p_period_start, p_period_end, p_now, public.fc_effective_policy(null));
  v_key := 'adjust:' || p_source || ':' || p_idempotency_key;
  insert into public.fc_ledger (idempotency_key, household_id, category, entry_type, basis, amount_gbp, reason, details)
  values (v_key, p_household_id, 'adjustment', 'adjust', 'admin', p_amount_gbp, p_reason,
    jsonb_build_object('actor', p_actor, 'source', p_source, 'periodStart', a.period_start))
  on conflict (idempotency_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('ok', true, 'duplicate', true); end if;
  update public.fc_budget_accounts set adjustments_gbp = adjustments_gbp + p_amount_gbp, updated_at = p_now
   where household_id = p_household_id and period_start = a.period_start;
  perform public.fc_event('info', 'budget_adjusted', p_household_id, null,
    jsonb_build_object('amountGbp', p_amount_gbp, 'actor', p_actor, 'source', p_source, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'duplicate', false, 'periodStart', a.period_start);
end;
$$;

create or replace function public.fc_set_kill_switch(p_on boolean, p_reason text, p_actor text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.fc_global_state%rowtype;
begin
  if p_on is null or coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then
    raise exception 'fc_set_kill_switch: state, reason and actor required';
  end if;
  select * into g from public.fc_global_state where id = 1 for update;
  update public.fc_global_state set kill_switch = p_on, kill_reason = p_reason, updated_at = now() where id = 1;
  insert into public.fc_policy_audit (actor, reason, target, before, after)
  values (p_actor, p_reason, 'kill_switch', jsonb_build_object('kill_switch', g.kill_switch), jsonb_build_object('kill_switch', p_on));
  perform public.fc_event('emergency', case when p_on then 'kill_switch_on' else 'kill_switch_off' end, null, null,
    jsonb_build_object('actor', p_actor, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'killSwitch', p_on);
end;
$$;

create or replace function public.fc_reset_breaker(p_reason text, p_actor text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.fc_global_state%rowtype;
begin
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then
    raise exception 'fc_reset_breaker: reason and actor required';
  end if;
  select * into g from public.fc_global_state where id = 1 for update;
  update public.fc_global_state set breaker_open = false, breaker_reason = null, breaker_opened_at = null, updated_at = now() where id = 1;
  insert into public.fc_policy_audit (actor, reason, target, before, after)
  values (p_actor, p_reason, 'breaker', jsonb_build_object('breaker_open', g.breaker_open, 'breaker_reason', g.breaker_reason),
    jsonb_build_object('breaker_open', false));
  perform public.fc_event('critical', 'breaker_reset', null, null, jsonb_build_object('actor', p_actor, 'reason', p_reason, 'was', g.breaker_reason));
  return jsonb_build_object('ok', true, 'wasOpen', g.breaker_open);
end;
$$;

-- Policy change: only listed columns; CHECK constraints validate values.
create or replace function public.fc_set_policy(p_changes jsonb, p_reason text, p_actor text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb;
  after_row jsonb;
  k text;
  allowed text[] := array['enforcement_mode', 'lease_seconds', 'renew_ahead_seconds', 'termination_grace_seconds',
    'max_call_seconds', 'breaker_terminates_active', 'backstop_share', 'connected_rate_gbp_per_min', 'monitoring_rate_gbp_per_min',
    'monitoring_max_seconds', 'call_fixed_fee_gbp', 'billing_granularity_seconds', 'estimate_uplift', 'sms_unit_gbp',
    'ai_request_gbp', 'number_purchase_gbp', 'global_hourly_floor_gbp', 'global_hourly_per_household_gbp',
    'global_daily_floor_gbp', 'global_daily_per_household_gbp', 'global_daily_absolute_max_gbp',
    'global_exposure_floor_gbp', 'global_exposure_per_household_gbp', 'global_worst_case_floor_gbp',
    'global_worst_case_per_household_gbp', 'global_active_floor', 'global_active_households_per_call',
    'global_monitoring_hourly_floor_gbp', 'global_monitoring_hourly_per_household_gbp', 'global_unattributed_daily_gbp',
    'global_number_purchases_per_day', 'breaker_latch_on_rate', 'entitled_count_max_age_seconds', 'max_period_days'];
  merged public.fc_policy%rowtype;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'fc_set_policy: changes required'; end if;
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then raise exception 'fc_set_policy: reason and actor required'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(allowed)) then raise exception 'fc_set_policy: % is not a policy field', k; end if;
  end loop;
  perform 1 from public.fc_global_state where id = 1 for update;
  select to_jsonb(p) into before_row from public.fc_policy p where id = 1 for update;
  merged := jsonb_populate_record(null::public.fc_policy, before_row || p_changes);
  update public.fc_policy set
    version = version + 1, enforcement_mode = merged.enforcement_mode, lease_seconds = merged.lease_seconds,
    renew_ahead_seconds = merged.renew_ahead_seconds, termination_grace_seconds = merged.termination_grace_seconds,
    max_call_seconds = merged.max_call_seconds, breaker_terminates_active = merged.breaker_terminates_active,
    backstop_share = merged.backstop_share,
    connected_rate_gbp_per_min = merged.connected_rate_gbp_per_min, monitoring_rate_gbp_per_min = merged.monitoring_rate_gbp_per_min,
    monitoring_max_seconds = merged.monitoring_max_seconds, call_fixed_fee_gbp = merged.call_fixed_fee_gbp,
    billing_granularity_seconds = merged.billing_granularity_seconds, estimate_uplift = merged.estimate_uplift,
    sms_unit_gbp = merged.sms_unit_gbp, ai_request_gbp = merged.ai_request_gbp, number_purchase_gbp = merged.number_purchase_gbp,
    global_hourly_floor_gbp = merged.global_hourly_floor_gbp, global_hourly_per_household_gbp = merged.global_hourly_per_household_gbp,
    global_daily_floor_gbp = merged.global_daily_floor_gbp, global_daily_per_household_gbp = merged.global_daily_per_household_gbp,
    global_daily_absolute_max_gbp = merged.global_daily_absolute_max_gbp, global_exposure_floor_gbp = merged.global_exposure_floor_gbp,
    global_exposure_per_household_gbp = merged.global_exposure_per_household_gbp, global_worst_case_floor_gbp = merged.global_worst_case_floor_gbp,
    global_worst_case_per_household_gbp = merged.global_worst_case_per_household_gbp, global_active_floor = merged.global_active_floor,
    global_active_households_per_call = merged.global_active_households_per_call,
    global_monitoring_hourly_floor_gbp = merged.global_monitoring_hourly_floor_gbp,
    global_monitoring_hourly_per_household_gbp = merged.global_monitoring_hourly_per_household_gbp,
    global_unattributed_daily_gbp = merged.global_unattributed_daily_gbp, global_number_purchases_per_day = merged.global_number_purchases_per_day,
    breaker_latch_on_rate = merged.breaker_latch_on_rate, entitled_count_max_age_seconds = merged.entitled_count_max_age_seconds,
    max_period_days = merged.max_period_days, updated_at = now(), updated_by = p_actor
  where id = 1;
  select to_jsonb(p) into after_row from public.fc_policy p where id = 1;
  insert into public.fc_policy_audit (actor, reason, target, before, after) values (p_actor, p_reason, 'policy', before_row, after_row);
  return jsonb_build_object('ok', true, 'version', (after_row->>'version')::integer);
end;
$$;

create or replace function public.fc_set_budget_profile(
  p_profile text, p_period_budget_gbp numeric, p_delivery_reserve_gbp numeric, p_delivery_reserve_scope text,
  p_essential_reserve_gbp numeric, p_monitoring_allowed boolean, p_reason text, p_actor text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb;
begin
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then raise exception 'fc_set_budget_profile: reason and actor required'; end if;
  perform 1 from public.fc_global_state where id = 1 for update;
  select to_jsonb(b) into before_row from public.fc_budget_profiles b where profile = p_profile;
  insert into public.fc_budget_profiles (profile, period_budget_gbp, delivery_reserve_gbp, delivery_reserve_scope, essential_reserve_gbp, monitoring_allowed, updated_at, updated_by)
  values (p_profile, p_period_budget_gbp, p_delivery_reserve_gbp, p_delivery_reserve_scope, p_essential_reserve_gbp, p_monitoring_allowed, now(), p_actor)
  on conflict (profile) do update set period_budget_gbp = excluded.period_budget_gbp, delivery_reserve_gbp = excluded.delivery_reserve_gbp,
    delivery_reserve_scope = excluded.delivery_reserve_scope, essential_reserve_gbp = excluded.essential_reserve_gbp,
    monitoring_allowed = excluded.monitoring_allowed, updated_at = now(), updated_by = p_actor;
  insert into public.fc_policy_audit (actor, reason, target, before, after)
  values (p_actor, p_reason, 'profile:' || p_profile, before_row, (select to_jsonb(b) from public.fc_budget_profiles b where profile = p_profile));
  -- Applies to accounts opened from now on; existing period accounts keep
  -- their figures (use fc_admin_adjust for the current period).
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.fc_refresh_entitled_count(p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  select count(distinct household_id) into n from public.entitlements
   where status = 'active' and starts_at <= p_now and (ends_at is null or ends_at > p_now);
  update public.fc_global_state set entitled_households = n, entitled_counted_at = p_now where id = 1;
  return jsonb_build_object('ok', true, 'entitledHouseholds', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Read models (admin / customer allowance service). No writes.
-- ---------------------------------------------------------------------------
create or replace function public.fc_household_status(p_household_id uuid, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.fc_budget_accounts%rowtype;
  v_live jsonb;
begin
  select * into a from public.fc_budget_accounts
   where household_id = p_household_id and period_start <= p_now and period_end > p_now order by period_start desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('callSid', call_sid, 'state', state, 'funding', funding, 'monitored', monitored,
      'startedAt', started_at, 'leaseExpiresAt', lease_expires_at, 'reservedGbp', reserved_gbp, 'worstCaseGbp', worst_case_gbp,
      'terminateAt', terminate_at, 'terminationReason', termination_reason)), '[]'::jsonb)
    into v_live from public.fc_reservations where household_id = p_household_id and state in ('active', 'terminating');
  if a.household_id is null then
    return jsonb_build_object('householdId', p_household_id, 'hasAccount', false, 'profile', public.fc_resolve_profile(p_household_id, p_now), 'live', v_live);
  end if;
  return jsonb_build_object(
    'householdId', p_household_id, 'hasAccount', true, 'profile', a.profile,
    'periodStart', a.period_start, 'periodEnd', a.period_end,
    'budgetGbp', a.base_budget_gbp, 'adjustmentsGbp', a.adjustments_gbp,
    'deliveryReserveGbp', a.delivery_reserve_gbp, 'essentialReserveGbp', a.essential_reserve_gbp,
    'reservedGbp', a.reserved_gbp, 'estimatedConsumedGbp', a.consumed_gbp, 'actualReconciledGbp', a.actual_gbp,
    'essentialConsumedGbp', a.essential_consumed_gbp,
    'remainingBudgetGbp', a.base_budget_gbp + a.adjustments_gbp - a.consumed_gbp - a.reserved_gbp,
    'remainingWithReserveGbp', a.base_budget_gbp + a.adjustments_gbp - a.consumed_gbp - a.reserved_gbp + a.delivery_reserve_gbp,
    'activeExposureGbp', (select coalesce(sum(reserved_gbp), 0) from public.fc_reservations where household_id = p_household_id and state in ('active', 'terminating')),
    'worstCaseExposureGbp', (select coalesce(sum(worst_case_gbp), 0) from public.fc_reservations where household_id = p_household_id and state in ('active', 'terminating')),
    'lastDenialReason', a.last_denial_reason, 'lastDenialAt', a.last_denial_at, 'live', v_live);
end;
$$;

create or replace function public.fc_global_status(p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.fc_global_state%rowtype;
  pol jsonb := public.fc_effective_policy(null);
begin
  select * into g from public.fc_global_state where id = 1;
  return jsonb_build_object(
    'killSwitch', g.kill_switch, 'killReason', g.kill_reason,
    'breakerOpen', g.breaker_open, 'breakerReason', g.breaker_reason, 'breakerOpenedAt', g.breaker_opened_at,
    'activeCount', g.active_count, 'activeReservedGbp', g.active_reserved_gbp, 'activeWorstCaseGbp', g.active_worst_case_gbp,
    'entitledHouseholds', g.entitled_households, 'entitledCountedAt', g.entitled_counted_at,
    'caps', public.fc_global_caps(pol, g, p_now), 'window', public.fc_window_sums(p_now),
    'policyVersion', (pol->>'version')::integer, 'enforcementMode', pol->>'enforcement_mode');
end;
$$;

-- Recompute the incremental counters from the reservations and report any
-- mismatch (used by tests and by the sweeper as a self-check).
create or replace function public.fc_check_invariants() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.fc_global_state%rowtype;
  v_count integer; v_res numeric; v_worst numeric;
  v_bad_accounts integer;
begin
  select * into g from public.fc_global_state where id = 1;
  select count(*), coalesce(sum(reserved_gbp), 0), coalesce(sum(worst_case_gbp), 0) into v_count, v_res, v_worst
    from public.fc_reservations where state in ('active', 'terminating') and category in ('call', 'unattributed_call');
  select count(*) into v_bad_accounts from public.fc_budget_accounts a
   where abs(a.reserved_gbp - (select coalesce(sum(r.reserved_gbp), 0) from public.fc_reservations r
       where r.household_id = a.household_id and r.period_start = a.period_start and r.state in ('active', 'terminating') and r.funding in ('budget', 'reserve', 'degraded'))) > 0.000001;
  return jsonb_build_object(
    'ok', g.active_count = v_count and abs(g.active_reserved_gbp - v_res) < 0.000001 and abs(g.active_worst_case_gbp - v_worst) < 0.000001 and v_bad_accounts = 0,
    'activeCount', jsonb_build_array(g.active_count, v_count),
    'activeReserved', jsonb_build_array(g.active_reserved_gbp, v_res),
    'activeWorstCase', jsonb_build_array(g.active_worst_case_gbp, v_worst),
    'accountsWithReservedMismatch', v_bad_accounts);
end;
$$;

-- Grants: service_role only. Nothing for anon/authenticated (I9).
do $$
declare
  f text;
begin
  foreach f in array array[
    'fc_authorize_call(uuid, text, boolean, boolean, boolean, timestamptz, timestamptz, timestamptz, jsonb)',
    'fc_settle_call(text, integer, integer, text, timestamptz)',
    'fc_mark_monitoring_started(text)',
    'fc_renew_lease(text, timestamptz, jsonb)',
    'fc_due_leases(timestamptz, integer)',
    'fc_record_termination(text, boolean, text, timestamptz)',
    'fc_note_provider_check(text, text, timestamptz)',
    'fc_adopt_degraded_call(uuid, text, timestamptz, integer, timestamptz, timestamptz, timestamptz)',
    'fc_authorize_spend(text, uuid, text, integer, timestamptz, timestamptz, timestamptz, jsonb)',
    'fc_record_actual(text, text, text, text, numeric, timestamptz)',
    'fc_admin_adjust(uuid, numeric, text, text, text, text, timestamptz, timestamptz, timestamptz)',
    'fc_set_kill_switch(boolean, text, text)',
    'fc_reset_breaker(text, text)',
    'fc_set_policy(jsonb, text, text)',
    'fc_set_budget_profile(text, numeric, numeric, text, numeric, boolean, text, text)',
    'fc_refresh_entitled_count(timestamptz)',
    'fc_household_status(uuid, timestamptz)',
    'fc_global_status(timestamptz)',
    'fc_check_invariants()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
