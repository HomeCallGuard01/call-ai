-- Financial safety: monitored-minute entitlement (Layer A) and hard
-- business protection (Layer B) — 2026-09-30.
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (not staging, not production).
-- Supersedes the unapplied draft 046_monitoring_usage_and_financial_safety
-- on wip/monitoring-allowance-financial-safety-2026-09-26 (production
-- already has a different 046). Numbered 056: the highest number in use
-- on any branch is 055 (claimed twice, by two other branches).
--
-- Two layers, deliberately separate (docs/finance/FINANCIAL_SAFETY_ARCHITECTURE.md):
--   Layer A — the customer's monthly monitored-minute allowance. Metered
--     in exact seconds per billing period. At 100% scam MONITORING stops;
--     calls keep connecting, unmonitored. Enforcement is a parameter
--     (p_enforce_allowance) so metering can ship before the commercial
--     allowance is approved.
--   Layer B — hard business protection, independent of any allowance:
--     call admission (simultaneous calls, bursts, caller floods, loops,
--     household daily/period £ ceilings, company £ ceilings, kill switch),
--     monitoring £ ceilings, SMS budget. A refused call is answered with
--     <Reject> as the first verb, which the provider does not bill.
--
-- Money here is an HCG ESTIMATE (rates passed in from services/usage/
-- costModel.js), used for real-time enforcement. The supplier-reconciled
-- truth is the ledger (051); services/finance/spendMonitor.js compares
-- the two and alerts if estimates run low.
--
-- Every write goes through a SECURITY DEFINER RPC under a per-household
-- advisory lock (idempotent per CallSid). The app only reads tables,
-- inserts audit events and flips the kill switches.

begin;

alter table public.entitlements
  add column if not exists plan_code text not null default 'standard';

alter table public.calls
  add column if not exists monitoring_status text;

-- ---------------------------------------------------------------------------
-- Usage counters
-- ---------------------------------------------------------------------------
create table if not exists public.household_usage_periods (
  household_id uuid not null references public.households(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  monitored_seconds integer not null default 0 check (monitored_seconds >= 0),
  -- Future top-ups/upgrades add seconds here (no product exists yet).
  bonus_monitored_seconds integer not null default 0 check (bonus_monitored_seconds >= 0),
  monitoring_cost_gbp numeric(12, 5) not null default 0,
  telephony_minutes integer not null default 0 check (telephony_minutes >= 0),
  telephony_cost_gbp numeric(12, 5) not null default 0,
  sms_count integer not null default 0 check (sms_count >= 0),
  sms_cost_gbp numeric(12, 5) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (household_id, period_start),
  check (period_end > period_start)
);

create table if not exists public.household_usage_days (
  household_id uuid not null references public.households(id) on delete cascade,
  day date not null,
  monitored_seconds integer not null default 0 check (monitored_seconds >= 0),
  monitoring_cost_gbp numeric(12, 5) not null default 0,
  telephony_minutes integer not null default 0 check (telephony_minutes >= 0),
  telephony_cost_gbp numeric(12, 5) not null default 0,
  sms_count integer not null default 0 check (sms_count >= 0),
  sms_cost_gbp numeric(12, 5) not null default 0,
  calls_admitted integer not null default 0,
  calls_rejected integer not null default 0,
  primary key (household_id, day)
);

create table if not exists public.platform_usage_hours (
  hour_start timestamptz primary key,
  monitored_seconds integer not null default 0,
  monitoring_cost_gbp numeric(12, 5) not null default 0,
  telephony_minutes integer not null default 0,
  telephony_cost_gbp numeric(12, 5) not null default 0,
  sms_count integer not null default 0,
  sms_cost_gbp numeric(12, 5) not null default 0,
  calls_admitted integer not null default 0,
  calls_rejected integer not null default 0
);

-- One row per monitored call (Layer A metering unit; WIP design).
create table if not exists public.monitoring_sessions (
  call_sid text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  allowance_seconds integer not null check (allowance_seconds >= 0),
  enforce_allowance boolean not null default false,
  daily_cost_limit_gbp numeric(12, 5) not null,
  period_cost_limit_gbp numeric(12, 5) not null,
  stream_sid text unique,
  status text not null default 'reserved' check (status in ('reserved', 'streaming', 'ended')),
  counted_seconds integer not null default 0 check (counted_seconds >= 0),
  created_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text
);
create index if not exists monitoring_sessions_active_by_household
  on public.monitoring_sessions (household_id) where status <> 'ended';

-- One row per ADMITTED call (Layer B telephony exposure unit).
create table if not exists public.telephony_call_sessions (
  call_sid text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active' check (status in ('active', 'ended')),
  caller_key text,
  is_known boolean not null default false,
  max_seconds integer not null check (max_seconds > 0),
  cost_per_minute_gbp numeric(12, 6) not null check (cost_per_minute_gbp >= 0),
  billed_minutes integer,
  estimated_cost_gbp numeric(12, 5),
  end_source text
);
create index if not exists telephony_call_sessions_active_by_household
  on public.telephony_call_sessions (household_id) where status = 'active';

-- Every admission decision, admitted or refused: the burst / caller-flood
-- windows count refused attempts too, so a flood stays refused (unbilled)
-- for as long as it continues. caller_key is a salted hash, never a number.
create table if not exists public.telephony_call_attempts (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  call_sid text not null unique,
  at timestamptz not null default now(),
  caller_key text,
  outcome text not null check (outcome in ('admitted', 'rejected')),
  reason text
);
create index if not exists telephony_call_attempts_window
  on public.telephony_call_attempts (household_id, at desc);
create index if not exists telephony_call_attempts_caller_window
  on public.telephony_call_attempts (household_id, caller_key, at desc) where caller_key is not null;

-- Customer warning points (75 / 90 / 100 %), claimed once per period.
create table if not exists public.usage_notifications (
  household_id uuid not null references public.households(id) on delete cascade,
  period_start timestamptz not null,
  kind text not null check (kind in ('warn_75', 'warn_90', 'exhausted_100')),
  claimed_at timestamptz not null default now(),
  primary key (household_id, period_start, kind)
);

create table if not exists public.financial_safety_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  household_id uuid references public.households(id) on delete set null,
  call_sid text,
  stream_sid text,
  level text not null check (level in ('info', 'warning', 'critical', 'emergency')),
  rule text not null,
  action text not null,
  usage_seconds_before integer,
  estimated_cost_before_gbp numeric(12, 5),
  notification text,
  details jsonb,
  resolved_at timestamptz
);
create index if not exists financial_safety_events_recent
  on public.financial_safety_events (created_at desc);

create table if not exists public.financial_safety_state (
  id integer primary key check (id = 1),
  monitoring_suspended boolean not null default false,
  telephony_suspended boolean not null default false,
  reason text,
  updated_at timestamptz not null default now()
);
insert into public.financial_safety_state (id) values (1) on conflict (id) do nothing;

alter table public.household_usage_periods enable row level security;
alter table public.household_usage_days enable row level security;
alter table public.platform_usage_hours enable row level security;
alter table public.monitoring_sessions enable row level security;
alter table public.telephony_call_sessions enable row level security;
alter table public.telephony_call_attempts enable row level security;
alter table public.usage_notifications enable row level security;
alter table public.financial_safety_events enable row level security;
alter table public.financial_safety_state enable row level security;

revoke all on public.household_usage_periods, public.household_usage_days, public.platform_usage_hours,
  public.monitoring_sessions, public.telephony_call_sessions, public.telephony_call_attempts,
  public.usage_notifications, public.financial_safety_events, public.financial_safety_state
  from public, anon, authenticated;

grant select on public.household_usage_periods, public.household_usage_days, public.platform_usage_hours,
  public.monitoring_sessions, public.telephony_call_sessions, public.telephony_call_attempts,
  public.usage_notifications to service_role;
grant select, insert on public.financial_safety_events to service_role;
grant select, update on public.financial_safety_state to service_role;

-- ---------------------------------------------------------------------------
-- Internal helpers: SECURITY INVOKER and granted to no one. They run only
-- inside the SECURITY DEFINER RPCs below (i.e. as the owner), so no role —
-- not even service_role — can move a counter except through those RPCs.
-- ---------------------------------------------------------------------------
create or replace function public.fs_add_usage(
  p_household_id uuid, p_period_start timestamptz, p_period_end timestamptz, p_at timestamptz,
  p_monitored_seconds integer, p_monitoring_cost numeric,
  p_telephony_minutes integer, p_telephony_cost numeric,
  p_sms integer, p_sms_cost numeric,
  p_admitted integer, p_rejected integer
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_day date := (p_at at time zone 'UTC')::date;
  v_hour timestamptz := date_trunc('hour', p_at at time zone 'UTC') at time zone 'UTC';
begin
  if p_period_start is not null then
    insert into public.household_usage_periods as u (household_id, period_start, period_end,
      monitored_seconds, monitoring_cost_gbp, telephony_minutes, telephony_cost_gbp, sms_count, sms_cost_gbp)
    values (p_household_id, p_period_start, p_period_end,
      p_monitored_seconds, p_monitoring_cost, p_telephony_minutes, p_telephony_cost, p_sms, p_sms_cost)
    on conflict (household_id, period_start) do update set
      monitored_seconds = u.monitored_seconds + excluded.monitored_seconds,
      monitoring_cost_gbp = u.monitoring_cost_gbp + excluded.monitoring_cost_gbp,
      telephony_minutes = u.telephony_minutes + excluded.telephony_minutes,
      telephony_cost_gbp = u.telephony_cost_gbp + excluded.telephony_cost_gbp,
      sms_count = u.sms_count + excluded.sms_count,
      sms_cost_gbp = u.sms_cost_gbp + excluded.sms_cost_gbp,
      updated_at = now();
  end if;

  insert into public.household_usage_days as d (household_id, day,
    monitored_seconds, monitoring_cost_gbp, telephony_minutes, telephony_cost_gbp, sms_count, sms_cost_gbp, calls_admitted, calls_rejected)
  values (p_household_id, v_day, p_monitored_seconds, p_monitoring_cost, p_telephony_minutes, p_telephony_cost, p_sms, p_sms_cost, p_admitted, p_rejected)
  on conflict (household_id, day) do update set
    monitored_seconds = d.monitored_seconds + excluded.monitored_seconds,
    monitoring_cost_gbp = d.monitoring_cost_gbp + excluded.monitoring_cost_gbp,
    telephony_minutes = d.telephony_minutes + excluded.telephony_minutes,
    telephony_cost_gbp = d.telephony_cost_gbp + excluded.telephony_cost_gbp,
    sms_count = d.sms_count + excluded.sms_count,
    sms_cost_gbp = d.sms_cost_gbp + excluded.sms_cost_gbp,
    calls_admitted = d.calls_admitted + excluded.calls_admitted,
    calls_rejected = d.calls_rejected + excluded.calls_rejected;

  insert into public.platform_usage_hours as g (hour_start,
    monitored_seconds, monitoring_cost_gbp, telephony_minutes, telephony_cost_gbp, sms_count, sms_cost_gbp, calls_admitted, calls_rejected)
  values (v_hour, p_monitored_seconds, p_monitoring_cost, p_telephony_minutes, p_telephony_cost, p_sms, p_sms_cost, p_admitted, p_rejected)
  on conflict (hour_start) do update set
    monitored_seconds = g.monitored_seconds + excluded.monitored_seconds,
    monitoring_cost_gbp = g.monitoring_cost_gbp + excluded.monitoring_cost_gbp,
    telephony_minutes = g.telephony_minutes + excluded.telephony_minutes,
    telephony_cost_gbp = g.telephony_cost_gbp + excluded.telephony_cost_gbp,
    sms_count = g.sms_count + excluded.sms_count,
    sms_cost_gbp = g.sms_cost_gbp + excluded.sms_cost_gbp,
    calls_admitted = g.calls_admitted + excluded.calls_admitted,
    calls_rejected = g.calls_rejected + excluded.calls_rejected;
end;
$$;

-- Closes one active telephony session: billed minutes = started minutes of
-- the server-observed duration (never less than 1, never more than the
-- call's own maximum + 1). Idempotent: an ended session is left alone.
create or replace function public.fs_close_call(p_call_sid text, p_ended_at timestamptz, p_source text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v public.telephony_call_sessions%rowtype;
  v_seconds numeric;
  v_minutes integer;
  v_cost numeric;
begin
  select * into v from public.telephony_call_sessions where call_sid = p_call_sid for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_call'); end if;
  if v.status = 'ended' then
    return jsonb_build_object('ok', true, 'alreadyEnded', true, 'billedMinutes', v.billed_minutes, 'estimatedCostGbp', v.estimated_cost_gbp);
  end if;
  v_seconds := least(greatest(extract(epoch from (p_ended_at - v.started_at)), 1), v.max_seconds + 60);
  v_minutes := ceil(v_seconds / 60.0)::integer;
  v_cost := v_minutes * v.cost_per_minute_gbp;
  update public.telephony_call_sessions
     set status = 'ended', ended_at = p_ended_at, billed_minutes = v_minutes,
         estimated_cost_gbp = v_cost, end_source = p_source
   where call_sid = p_call_sid;
  perform public.fs_add_usage(v.household_id, v.period_start, v.period_end, v.started_at, 0, 0, v_minutes, v_cost, 0, 0, 0, 0);
  return jsonb_build_object('ok', true, 'alreadyEnded', false, 'billedMinutes', v_minutes, 'estimatedCostGbp', v_cost);
end;
$$;

-- Household cost so far today / this period INCLUDING the elapsed time of
-- its still-active calls (so a long call in progress is never counted as £0).
create or replace function public.fs_household_exposure(
  p_household_id uuid, p_day date, p_period_start timestamptz, p_now timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_active_cost numeric;
  v_day_cost numeric;
  v_period_cost numeric;
begin
  select coalesce(sum(ceil(greatest(extract(epoch from (p_now - started_at)), 1) / 60.0) * cost_per_minute_gbp), 0)
    into v_active_cost
    from public.telephony_call_sessions
   where household_id = p_household_id and status = 'active';
  select coalesce(max(monitoring_cost_gbp + telephony_cost_gbp + sms_cost_gbp), 0) into v_day_cost
    from public.household_usage_days where household_id = p_household_id and day = p_day;
  select coalesce(max(monitoring_cost_gbp + telephony_cost_gbp + sms_cost_gbp), 0) into v_period_cost
    from public.household_usage_periods where household_id = p_household_id and period_start = p_period_start;
  return jsonb_build_object('dayCostGbp', v_day_cost + v_active_cost, 'periodCostGbp', v_period_cost + v_active_cost, 'activeCostGbp', v_active_cost);
end;
$$;

revoke all on function public.fs_add_usage(uuid, timestamptz, timestamptz, timestamptz, integer, numeric, integer, numeric, integer, numeric, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.fs_close_call(text, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function public.fs_household_exposure(uuid, date, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admit_call — Layer B call admission, called by /voice BEFORE any TwiML
-- that could be billed. Returns jsonb { allowed, reason, ... }. Reasons, in
-- precedence order:
--   telephony_kill_switch      manual company-wide stop (Andrew only)
--   forwarding_loop            the caller is an HCG number / the dialled number itself
--   household_call_limit       too many simultaneous calls
--   household_burst            too many call attempts in the burst window (loop/flood)
--   caller_flood               the same caller too often in the caller window
--   household_daily_hard       household £ today ≥ hard daily ceiling
--   household_period_hard      household £ this period ≥ hard period ceiling
--   household_period_unknown_block  (unknown callers only) period £ ≥ unknown-block ceiling
--   company_hard_unknown_block (unknown callers only) company £ today ≥ company hard ceiling
--   company_emergency_abnormal company £ today/hour ≥ emergency AND this household's £ today ≥ its WATCH level
-- Idempotent per CallSid (a Twilio retry gets the original answer, counted once).
-- ---------------------------------------------------------------------------
create or replace function public.admit_call(
  p_household_id uuid,
  p_call_sid text,
  p_caller_key text,
  p_is_known boolean,
  p_is_loop boolean,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_now timestamptz,
  p_limits jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior public.telephony_call_attempts%rowtype;
  v_day date := (p_now at time zone 'UTC')::date;
  v_hour timestamptz := date_trunc('hour', p_now at time zone 'UTC') at time zone 'UTC';
  v_max_calls integer := (p_limits->>'maxCallsPerHousehold')::integer;
  v_max_seconds integer := (p_limits->>'maxCallSeconds')::integer;
  v_rate numeric := (p_limits->>'costPerMinuteGbp')::numeric;
  v_active integer;
  v_burst integer;
  v_caller integer := 0;
  v_exposure jsonb;
  v_day_cost numeric;
  v_period_cost numeric;
  v_company_day numeric;
  v_company_hour numeric;
  v_suspended boolean;
  v_reason text;
  v_stale record;
begin
  if p_household_id is null or p_call_sid is null or length(p_call_sid) = 0 then
    raise exception 'admit_call: household and call sid are required';
  end if;
  if v_max_calls is null or v_max_seconds is null or v_rate is null then
    raise exception 'admit_call: limits incomplete';
  end if;

  perform pg_advisory_xact_lock(hashtext('hcg_admission:' || p_household_id::text));

  select * into v_prior from public.telephony_call_attempts where call_sid = p_call_sid;
  if found then
    return jsonb_build_object('allowed', v_prior.outcome = 'admitted', 'reason', v_prior.reason, 'existing', true);
  end if;

  -- Sessions whose end was never reported are closed CONSERVATIVELY at
  -- their full maximum — a missed callback is never counted as £0.
  for v_stale in
    select call_sid, started_at, max_seconds from public.telephony_call_sessions
     where household_id = p_household_id and status = 'active'
       and started_at < p_now - make_interval(secs => max_seconds + 300)
  loop
    perform public.fs_close_call(v_stale.call_sid, v_stale.started_at + make_interval(secs => v_stale.max_seconds), 'stale_closed_at_max');
  end loop;

  select count(*) into v_active from public.telephony_call_sessions
   where household_id = p_household_id and status = 'active';
  select count(*) into v_burst from public.telephony_call_attempts
   where household_id = p_household_id
     and at > p_now - make_interval(secs => (p_limits->>'burstWindowSeconds')::integer);
  if p_caller_key is not null then
    select count(*) into v_caller from public.telephony_call_attempts
     where household_id = p_household_id and caller_key = p_caller_key
       and at > p_now - make_interval(secs => (p_limits->>'callerWindowSeconds')::integer);
  end if;

  v_exposure := public.fs_household_exposure(p_household_id, v_day, p_period_start, p_now);
  v_day_cost := (v_exposure->>'dayCostGbp')::numeric;
  v_period_cost := (v_exposure->>'periodCostGbp')::numeric;

  select coalesce(sum(monitoring_cost_gbp + telephony_cost_gbp + sms_cost_gbp), 0) into v_company_day
    from public.platform_usage_hours
   where hour_start >= v_day::timestamp at time zone 'UTC' and hour_start < (v_day + 1)::timestamp at time zone 'UTC';
  select coalesce(max(monitoring_cost_gbp + telephony_cost_gbp + sms_cost_gbp), 0) into v_company_hour
    from public.platform_usage_hours where hour_start = v_hour;
  select telephony_suspended into v_suspended from public.financial_safety_state where id = 1;

  v_reason := case
    when coalesce(v_suspended, false) then 'telephony_kill_switch'
    when p_is_loop then 'forwarding_loop'
    when v_active >= v_max_calls then 'household_call_limit'
    when v_burst >= (p_limits->>'burstMaxAttempts')::integer then 'household_burst'
    when p_caller_key is not null and v_caller >= (p_limits->>'callerMaxAttempts')::integer then 'caller_flood'
    when v_day_cost >= (p_limits->>'householdDailyHardGbp')::numeric then 'household_daily_hard'
    when v_period_cost >= (p_limits->>'householdPeriodHardGbp')::numeric then 'household_period_hard'
    when not p_is_known and v_period_cost >= (p_limits->>'householdPeriodUnknownBlockGbp')::numeric then 'household_period_unknown_block'
    when not p_is_known and v_company_day >= (p_limits->>'companyDailyHardGbp')::numeric then 'company_hard_unknown_block'
    when (v_company_day >= (p_limits->>'companyDailyEmergencyGbp')::numeric
          or v_company_hour >= (p_limits->>'companyHourlyEmergencyGbp')::numeric)
         and v_day_cost >= (p_limits->>'householdDailyWatchGbp')::numeric then 'company_emergency_abnormal'
    else null
  end;

  insert into public.telephony_call_attempts (household_id, call_sid, at, caller_key, outcome, reason)
  values (p_household_id, p_call_sid, p_now, p_caller_key, case when v_reason is null then 'admitted' else 'rejected' end, v_reason);

  if v_reason is null then
    insert into public.telephony_call_sessions (call_sid, household_id, period_start, period_end, started_at, caller_key, is_known, max_seconds, cost_per_minute_gbp)
    values (p_call_sid, p_household_id, p_period_start, p_period_end, p_now, p_caller_key, coalesce(p_is_known, false), v_max_seconds, v_rate);
  end if;
  perform public.fs_add_usage(p_household_id, p_period_start, p_period_end, p_now, 0, 0, 0, 0, 0, 0,
    case when v_reason is null then 1 else 0 end, case when v_reason is null then 0 else 1 end);

  -- Opportunistic retention: attempts older than 2 days are not needed for any window.
  delete from public.telephony_call_attempts
   where household_id = p_household_id and at < p_now - interval '2 days';

  return jsonb_build_object(
    'allowed', v_reason is null,
    'reason', v_reason,
    'activeCalls', v_active,
    'burstAttempts', v_burst,
    'callerAttempts', v_caller,
    'dayCostGbp', v_day_cost,
    'periodCostGbp', v_period_cost,
    'companyDayCostGbp', v_company_day,
    'companyHourCostGbp', v_company_hour
  );
end;
$$;

-- end_call — the call's <Dial> has ended (action callback) or it never
-- reached one. Idempotent.
create or replace function public.end_call(p_call_sid text, p_ended_at timestamptz, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select household_id into v_household from public.telephony_call_sessions where call_sid = p_call_sid;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_call'); end if;
  perform pg_advisory_xact_lock(hashtext('hcg_admission:' || v_household::text));
  return public.fs_close_call(p_call_sid, p_ended_at, p_source);
end;
$$;

-- ---------------------------------------------------------------------------
-- begin_monitoring_session — Layer A + monitoring £ ceilings (WIP design).
-- Reasons in precedence: global_kill_switch, global_hourly_cost_limit,
-- global_daily_cost_limit, allowance_exhausted (only when enforced),
-- period_cost_limit, daily_cost_limit, household_stream_limit,
-- global_stream_limit. The global £ limits here count MONITORING cost only.
-- ---------------------------------------------------------------------------
create or replace function public.begin_monitoring_session(
  p_household_id uuid,
  p_call_sid text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_now timestamptz,
  p_allowance_seconds integer,
  p_enforce_allowance boolean,
  p_limits jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.monitoring_sessions%rowtype;
  v_day date := (p_now at time zone 'UTC')::date;
  v_hour timestamptz := date_trunc('hour', p_now at time zone 'UTC') at time zone 'UTC';
  v_live_after timestamptz := p_now - make_interval(secs => (p_limits->>'staleAfterSeconds')::integer);
  v_used integer;
  v_bonus integer;
  v_period_cost numeric;
  v_day_cost numeric;
  v_active integer;
  v_global_active integer;
  v_global_hour numeric;
  v_global_day numeric;
  v_suspended boolean;
  v_reason text;
begin
  if p_household_id is null or p_call_sid is null or length(p_call_sid) = 0 then
    raise exception 'begin_monitoring_session: household and call sid are required';
  end if;

  perform pg_advisory_xact_lock(hashtext('hcg_monitoring_global'));
  perform pg_advisory_xact_lock(hashtext('hcg_monitoring:' || p_household_id::text));

  select * into v_existing from public.monitoring_sessions where call_sid = p_call_sid;
  if found then
    return jsonb_build_object(
      'allowed', v_existing.status <> 'ended' and v_existing.household_id = p_household_id,
      'reason', case when v_existing.status <> 'ended' and v_existing.household_id = p_household_id then null else 'session_already_ended' end,
      'existing', true);
  end if;

  insert into public.household_usage_periods (household_id, period_start, period_end)
  values (p_household_id, p_period_start, p_period_end)
  on conflict (household_id, period_start) do nothing;

  select monitored_seconds, bonus_monitored_seconds, monitoring_cost_gbp
    into v_used, v_bonus, v_period_cost
    from public.household_usage_periods where household_id = p_household_id and period_start = p_period_start;
  select coalesce(max(monitoring_cost_gbp), 0) into v_day_cost
    from public.household_usage_days where household_id = p_household_id and day = v_day;
  select count(*) into v_active from public.monitoring_sessions
   where household_id = p_household_id and status <> 'ended' and last_heartbeat_at > v_live_after;
  select count(*) into v_global_active from public.monitoring_sessions
   where status <> 'ended' and last_heartbeat_at > v_live_after;
  select coalesce(max(monitoring_cost_gbp), 0) into v_global_hour from public.platform_usage_hours where hour_start = v_hour;
  select coalesce(sum(monitoring_cost_gbp), 0) into v_global_day from public.platform_usage_hours
   where hour_start >= v_day::timestamp at time zone 'UTC' and hour_start < (v_day + 1)::timestamp at time zone 'UTC';
  select monitoring_suspended into v_suspended from public.financial_safety_state where id = 1;

  v_reason := case
    when coalesce(v_suspended, true) then 'global_kill_switch'
    when v_global_hour >= (p_limits->>'globalHourlyCostLimitGbp')::numeric then 'global_hourly_cost_limit'
    when v_global_day >= (p_limits->>'globalDailyCostLimitGbp')::numeric then 'global_daily_cost_limit'
    when p_enforce_allowance and v_used >= p_allowance_seconds + v_bonus then 'allowance_exhausted'
    when v_period_cost >= (p_limits->>'periodCostLimitGbp')::numeric then 'period_cost_limit'
    when v_day_cost >= (p_limits->>'dailyCostLimitGbp')::numeric then 'daily_cost_limit'
    when v_active >= (p_limits->>'maxHouseholdStreams')::integer then 'household_stream_limit'
    when v_global_active >= (p_limits->>'globalMaxStreams')::integer then 'global_stream_limit'
    else null
  end;

  if v_reason is null then
    insert into public.monitoring_sessions (call_sid, household_id, period_start, period_end,
      allowance_seconds, enforce_allowance, daily_cost_limit_gbp, period_cost_limit_gbp, created_at, last_heartbeat_at)
    values (p_call_sid, p_household_id, p_period_start, p_period_end,
      p_allowance_seconds + v_bonus, coalesce(p_enforce_allowance, false),
      (p_limits->>'dailyCostLimitGbp')::numeric, (p_limits->>'periodCostLimitGbp')::numeric, p_now, p_now);
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null,
    'reason', v_reason,
    'periodSeconds', v_used,
    'allowanceSeconds', p_allowance_seconds + v_bonus,
    'periodCostGbp', v_period_cost,
    'dayCostGbp', v_day_cost,
    'activeStreams', v_active,
    'globalActiveStreams', v_global_active,
    'globalHourCostGbp', v_global_hour,
    'globalDayCostGbp', v_global_day);
end;
$$;

create or replace function public.attach_monitoring_stream(p_call_sid text, p_stream_sid text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.monitoring_sessions%rowtype;
begin
  select * into v from public.monitoring_sessions where call_sid = p_call_sid for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_reservation'); end if;
  if v.status = 'ended' then return jsonb_build_object('ok', false, 'reason', 'session_ended'); end if;
  if v.stream_sid is not null and v.stream_sid <> p_stream_sid then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_stream');
  end if;
  update public.monitoring_sessions set stream_sid = p_stream_sid, status = 'streaming', last_heartbeat_at = now()
   where call_sid = p_call_sid;
  return jsonb_build_object('ok', true, 'householdId', v.household_id, 'periodStart', v.period_start,
    'periodEnd', v.period_end, 'allowanceSeconds', v.allowance_seconds, 'enforceAllowance', v.enforce_allowance,
    'dailyCostLimitGbp', v.daily_cost_limit_gbp, 'periodCostLimitGbp', v.period_cost_limit_gbp,
    'countedSeconds', v.counted_seconds);
end;
$$;

-- p_total_seconds is the stream's ABSOLUTE monitored seconds; only the
-- positive delta is added (retries/replays add 0; nothing after the end).
create or replace function public.record_monitoring_progress(
  p_call_sid text, p_stream_sid text, p_total_seconds integer, p_cost_per_second_gbp numeric,
  p_now timestamptz, p_final boolean, p_end_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.monitoring_sessions%rowtype;
  v_delta integer;
  v_cost numeric;
  v_hour timestamptz := date_trunc('hour', p_now at time zone 'UTC') at time zone 'UTC';
  v_period record;
  v_day_cost numeric;
  v_global_hour numeric;
begin
  select * into v from public.monitoring_sessions where call_sid = p_call_sid for update;
  if not found or v.stream_sid is distinct from p_stream_sid then
    return jsonb_build_object('ok', false, 'reason', 'unknown_session');
  end if;
  v_delta := case when v.status = 'ended' then 0 else greatest(0, coalesce(p_total_seconds, 0) - v.counted_seconds) end;
  v_cost := v_delta * p_cost_per_second_gbp;

  update public.monitoring_sessions
     set counted_seconds = counted_seconds + v_delta,
         last_heartbeat_at = p_now,
         status = case when p_final then 'ended' else status end,
         ended_at = case when p_final and ended_at is null then p_now else ended_at end,
         end_reason = coalesce(end_reason, p_end_reason)
   where call_sid = p_call_sid;

  perform public.fs_add_usage(v.household_id, v.period_start, v.period_end, p_now, v_delta, v_cost, 0, 0, 0, 0, 0, 0);

  select monitored_seconds, monitoring_cost_gbp into v_period
    from public.household_usage_periods where household_id = v.household_id and period_start = v.period_start;
  select monitoring_cost_gbp into v_day_cost
    from public.household_usage_days where household_id = v.household_id and day = (p_now at time zone 'UTC')::date;
  select monitoring_cost_gbp into v_global_hour from public.platform_usage_hours where hour_start = v_hour;

  return jsonb_build_object('ok', true, 'deltaSeconds', v_delta, 'householdId', v.household_id,
    'periodStart', v.period_start, 'periodSeconds', v_period.monitored_seconds,
    'periodCostGbp', v_period.monitoring_cost_gbp, 'dayCostGbp', coalesce(v_day_cost, 0),
    'globalHourCostGbp', coalesce(v_global_hour, 0), 'allowanceSeconds', v.allowance_seconds,
    'enforceAllowance', v.enforce_allowance,
    'dailyCostLimitGbp', v.daily_cost_limit_gbp, 'periodCostLimitGbp', v.period_cost_limit_gbp);
end;
$$;

-- True exactly once per household per period per warning point.
create or replace function public.claim_usage_notification(p_household_id uuid, p_period_start timestamptz, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  insert into public.usage_notifications (household_id, period_start, kind)
  values (p_household_id, p_period_start, p_kind)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- SMS budget: true (and counted) only while under the household daily,
-- household period and company daily SMS ceilings.
create or replace function public.claim_sms_send(
  p_household_id uuid, p_period_start timestamptz, p_period_end timestamptz, p_now timestamptz,
  p_cost_gbp numeric, p_limits jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (p_now at time zone 'UTC')::date;
  v_hh_day integer;
  v_hh_period integer;
  v_company_day integer;
  v_reason text;
begin
  perform pg_advisory_xact_lock(hashtext('hcg_admission:' || p_household_id::text));
  select coalesce(max(sms_count), 0) into v_hh_day from public.household_usage_days where household_id = p_household_id and day = v_day;
  select coalesce(max(sms_count), 0) into v_hh_period from public.household_usage_periods where household_id = p_household_id and period_start = p_period_start;
  select coalesce(sum(sms_count), 0) into v_company_day from public.platform_usage_hours
   where hour_start >= v_day::timestamp at time zone 'UTC' and hour_start < (v_day + 1)::timestamp at time zone 'UTC';
  v_reason := case
    when v_hh_day >= (p_limits->>'householdDailySms')::integer then 'household_daily_sms_limit'
    when v_hh_period >= (p_limits->>'householdPeriodSms')::integer then 'household_period_sms_limit'
    when v_company_day >= (p_limits->>'companyDailySms')::integer then 'company_daily_sms_limit'
    else null end;
  if v_reason is null then
    perform public.fs_add_usage(p_household_id, p_period_start, p_period_end, p_now, 0, 0, 0, 0, 1, p_cost_gbp, 0, 0);
  end if;
  return jsonb_build_object('allowed', v_reason is null, 'reason', v_reason, 'householdDaySms', v_hh_day, 'companyDaySms', v_company_day);
end;
$$;

revoke all on function public.admit_call(uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.admit_call(uuid, text, text, boolean, boolean, timestamptz, timestamptz, timestamptz, jsonb) to service_role;
revoke all on function public.end_call(text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.end_call(text, timestamptz, text) to service_role;
revoke all on function public.begin_monitoring_session(uuid, text, timestamptz, timestamptz, timestamptz, integer, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.begin_monitoring_session(uuid, text, timestamptz, timestamptz, timestamptz, integer, boolean, jsonb) to service_role;
revoke all on function public.attach_monitoring_stream(text, text) from public, anon, authenticated;
grant execute on function public.attach_monitoring_stream(text, text) to service_role;
revoke all on function public.record_monitoring_progress(text, text, integer, numeric, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.record_monitoring_progress(text, text, integer, numeric, timestamptz, boolean, text) to service_role;
revoke all on function public.claim_usage_notification(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_usage_notification(uuid, timestamptz, text) to service_role;
revoke all on function public.claim_sms_send(uuid, timestamptz, timestamptz, timestamptz, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.claim_sms_send(uuid, timestamptz, timestamptz, timestamptz, numeric, jsonb) to service_role;

commit;
