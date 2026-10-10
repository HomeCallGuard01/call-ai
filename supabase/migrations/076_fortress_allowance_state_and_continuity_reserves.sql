-- 076_fortress_allowance_state_and_continuity_reserves.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (WS2 financial protection, 2026-10-10).
-- Numbering: 076 allocated to WS2 by the launch lead (076/077). Depends on 067
-- (Financial Fortress). Rollback: _rollbacks/076_rollback_fortress_allowance_state_and_continuity_reserves.sql
-- (refuses while any unscreened-reserve spend exists; restores 067's bodies).
--
-- WHAT THIS ADDS (docs/launch/2026-10-10-WS2-REPORT.md §A, §2):
--
-- 1. A SEPARATE, BOUNDED UNSCREENED-DELIVERY RESERVE for unknown callers
--    (fc_budget_profiles.unscreened_reserve_gbp, default £0 = today's
--    behaviour exactly). Accounted like the essential pool — its own
--    reserved/consumed counters on fc_budget_accounts — so:
--      * unknown callers past the screening budget may still be connected,
--        UNSCREENED (never monitored, no SMS/AI), only while this pool lasts;
--      * it can never drain the trusted continuity reserve (delivery reserve,
--        scope trusted_only) and trusted calls never draw on it;
--      * its worst case is counted against itself, never against the budget.
--    Funding order for a call: budget → delivery reserve (scope) →
--    unscreened reserve (unknown callers only) → essential pool → refuse.
--
-- 2. A DETERMINISTIC ALLOWANCE STATE per household
--    (fortress_household_allowance_state): normal → screening_low →
--    screening_paused → continuity → continuity_low → hard_ceiling, plus held.
--    Computed with the SAME arithmetic fc_authorize_call uses (headroom after
--    reservations and live worst cases), so "screening active" is true
--    exactly when a new unknown call would be admitted monitored.
--
-- 3. A TRANSITION LOG (fortress_allowance_state_log) written by
--    fortress_record_allowance_state — one row and one fc_events row
--    ('allowance_state_changed') per state change. Event emission only.
--
-- Functions REPLACED from 067 (bodies identical except where marked "076:"):
--   fc_account, fc_authorize_call, fc_settle_locked, fc_renew_lease,
--   fc_authorize_spend, fc_check_invariants, fc_household_status.
-- No 067 limit is loosened: with unscreened_reserve_gbp = 0 every decision is
-- identical to 067 (tests/fortress-allowance-state.pglite.test.mjs proves the
-- 067 suites still pass with 076 applied, and adds the new cases).

begin;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.fc_budget_profiles
  add column if not exists unscreened_reserve_gbp numeric(12, 4) not null default 0
    check (unscreened_reserve_gbp >= 0 and unscreened_reserve_gbp <= 20);

alter table public.fc_budget_accounts
  add column if not exists unscreened_reserve_gbp numeric(12, 4) not null default 0 check (unscreened_reserve_gbp >= 0),
  add column if not exists unscreened_reserved_gbp numeric(14, 6) not null default 0 check (unscreened_reserved_gbp >= 0),
  add column if not exists unscreened_consumed_gbp numeric(14, 6) not null default 0 check (unscreened_consumed_gbp >= 0);

alter table public.fc_reservations drop constraint if exists fc_reservations_funding_check;
alter table public.fc_reservations add constraint fc_reservations_funding_check
  check (funding in ('budget', 'reserve', 'essential', 'unattributed', 'degraded', 'global', 'unscreened'));

-- ---------------------------------------------------------------------------
-- Allowance-state thresholds (audited; CHECK-constrained)
-- ---------------------------------------------------------------------------
create table if not exists public.fortress_allowance_policy (
  id integer primary key check (id = 1),
  -- screening_low when (consumed + reserved) / screening budget ≥ this
  screening_low_ratio numeric(4, 3) not null default 0.80 check (screening_low_ratio >= 0.5 and screening_low_ratio <= 0.99),
  -- continuity_low when a continuity reserve in use is ≥ this fraction spent
  continuity_low_ratio numeric(4, 3) not null default 0.80 check (continuity_low_ratio >= 0.5 and continuity_low_ratio <= 0.99),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.fortress_allowance_policy (id) values (1) on conflict (id) do nothing;

create table if not exists public.fortress_allowance_state_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  period_start timestamptz,
  state text not null check (state in ('normal', 'screening_low', 'screening_paused', 'continuity', 'continuity_low', 'hard_ceiling', 'held')),
  previous_state text,
  at timestamptz not null,
  details jsonb
);
create index if not exists fortress_allowance_state_log_household on public.fortress_allowance_state_log (household_id, id desc);

alter table public.fortress_allowance_policy enable row level security;
alter table public.fortress_allowance_state_log enable row level security;
revoke all on public.fortress_allowance_policy, public.fortress_allowance_state_log from public, anon, authenticated;
revoke all on sequence public.fortress_allowance_state_log_id_seq from public, anon, authenticated;
grant select on public.fortress_allowance_policy, public.fortress_allowance_state_log to service_role;

-- ---------------------------------------------------------------------------
-- fc_account (076: copies the profile's unscreened reserve into the account)
-- ---------------------------------------------------------------------------
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

  insert into public.fc_budget_accounts (household_id, period_start, period_end, profile, base_budget_gbp, delivery_reserve_gbp, essential_reserve_gbp,
    unscreened_reserve_gbp)   -- 076
  values (p_household_id, v_start, v_end, pr.profile, pr.period_budget_gbp, pr.delivery_reserve_gbp, pr.essential_reserve_gbp,
    pr.unscreened_reserve_gbp)   -- 076
  returning * into a;
  return a;
end;
$$;
revoke all on function public.fc_account(uuid, timestamptz, timestamptz, timestamptz, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- fc_authorize_call (076: unscreened-reserve funding for unknown callers;
-- unscreened worst cases are contingent on that pool, not on the budget)
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
  v_avail_unscreened numeric;   -- 076
  v_backstop integer;
  v_worst numeric;
  v_unit numeric;
  v_reason text;
  v_shadow text;
  v_tel_cost numeric;
  v_mon_cost numeric;
  v_contingent numeric; v_ess_contingent numeric;
  v_uns_contingent numeric;     -- 076
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

  -- Integration 2026-10-04: per-household financial hold — before ANY funding
  -- decision; no funding source, trusted status or shadow mode bypasses it.
  if public.fc_household_auto_hold(p_household_id, p_now, pol) then
    insert into public.fc_reservations (idempotency_key, household_id, period_start, call_sid, category, state, deny_reason, is_known, started_at)
    values (v_key, p_household_id, a.period_start, p_call_sid, 'call', 'denied', 'household_hold', coalesce(p_is_known, false), p_now) returning * into r;
    insert into public.fc_ledger (idempotency_key, reservation_id, household_id, call_sid, category, entry_type, basis, amount_gbp, reason)
    values (v_key || ':deny', r.id, p_household_id, p_call_sid, 'call', 'deny', 'none', 0, 'household_hold');
    update public.fc_budget_accounts set last_denial_reason = 'household_hold', last_denial_at = p_now, updated_at = p_now
     where household_id = p_household_id and period_start = a.period_start;
    return jsonb_build_object('allowed', false, 'reason', 'household_hold', 'telephony', false, 'monitoring', false, 'reservationId', r.id);
  end if;

  -- Headroom after reservations AND after the unreserved worst case of the
  -- household's other live calls (their backstop cost beyond what they have
  -- reserved): consumed + Σ live worst cases ≤ budget + adjustments +
  -- reserve, so even if every HCG server stopped now, the provider time
  -- limits keep the household inside its authorisation (I5).
  -- 076: unscreened-funded calls are contingent on their own pool only.
  select coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding not in ('essential', 'unscreened')), 0),
         coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding = 'essential'), 0),
         coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding = 'unscreened'), 0)
    into v_contingent, v_ess_contingent, v_uns_contingent
    from public.fc_reservations where household_id = p_household_id and state in ('active', 'terminating');
  v_avail_budget := a.base_budget_gbp + a.adjustments_gbp - a.consumed_gbp - a.reserved_gbp - v_contingent;
  v_avail_reserve := v_avail_budget + a.delivery_reserve_gbp;
  v_avail_essential := a.essential_reserve_gbp - a.essential_consumed_gbp - a.essential_reserved_gbp - v_ess_contingent;
  v_avail_unscreened := a.unscreened_reserve_gbp - a.unscreened_consumed_gbp - a.unscreened_reserved_gbp - v_uns_contingent;   -- 076

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

  -- Funding: budget → delivery reserve (scope) → unscreened reserve (076,
  -- unknown callers only) → essential pool.
  if v_avail_budget >= v_cost then
    v_funding := 'budget'; v_avail := v_avail_budget;
  elsif pr.delivery_reserve_scope <> 'none' and (pr.delivery_reserve_scope = 'all' or coalesce(p_is_known, false))
        and v_avail_reserve >= v_tel_cost then
    v_funding := 'reserve'; v_avail := v_avail_reserve; v_monitored := false; v_cost := v_tel_cost;
    v_mon_denied := coalesce(v_mon_denied, case when coalesce(p_wants_monitoring, false) then 'monitoring_budget_insufficient' end);
  elsif not coalesce(p_is_known, false) and v_avail_unscreened >= v_tel_cost then
    -- 076: past the screening budget an unknown caller is connected UNSCREENED
    -- from its own bounded pool; never monitored (no stream/AI/SMS spend).
    v_funding := 'unscreened'; v_avail := v_avail_unscreened; v_monitored := false; v_cost := v_tel_cost;
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
        'availableBudget', v_avail_budget, 'availableWithReserve', v_avail_reserve, 'availableEssential', v_avail_essential,
        'availableUnscreened', v_avail_unscreened));   -- 076
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
  elsif v_funding = 'unscreened' then   -- 076
    update public.fc_budget_accounts set unscreened_reserved_gbp = unscreened_reserved_gbp + v_cost, updated_at = p_now
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
-- fc_settle_locked (076: unscreened-funded calls settle into their own pool)
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
    elsif r.funding = 'unscreened' then   -- 076
      update public.fc_budget_accounts set unscreened_reserved_gbp = greatest(0, unscreened_reserved_gbp - r.reserved_gbp),
        unscreened_consumed_gbp = unscreened_consumed_gbp + v_commit + v_extra, updated_at = p_now
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

-- ---------------------------------------------------------------------------
-- fc_renew_lease (076: an unscreened-funded call renews only from its own pool)
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
  -- Integration 2026-10-04: a held household's live calls are not renewed (end at lease end).
  elsif public.fc_household_held(r.household_id) then v_reason := 'household_hold';
  end if;

  if v_reason is null and r.household_id is not null and r.funding in ('budget', 'reserve', 'essential', 'unscreened') then
    select * into a from public.fc_budget_accounts where household_id = r.household_id and period_start = r.period_start for update;
    select * into pr from public.fc_budget_profiles where profile = a.profile;
    if r.funding = 'essential' then
      v_avail := a.essential_reserve_gbp - a.essential_consumed_gbp - a.essential_reserved_gbp;
    elsif r.funding = 'unscreened' then   -- 076
      v_avail := a.unscreened_reserve_gbp - a.unscreened_consumed_gbp - a.unscreened_reserved_gbp;
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
  elsif r.household_id is not null and r.funding = 'unscreened' then   -- 076
    update public.fc_budget_accounts set unscreened_reserved_gbp = unscreened_reserved_gbp + v_inc, updated_at = p_now
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

-- ---------------------------------------------------------------------------
-- fc_authorize_spend (076: the budget headroom excludes unscreened worst
-- cases, which are contingent on their own pool — exactly as essential)
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

  -- Integration 2026-10-04: a held household gets NO one-shot spend (SMS, AI,
  -- number purchase incl. a replacement number) — checked before the global
  -- gate so a held household's request never counts towards a breaker trip.
  if public.fc_household_auto_hold(p_household_id, p_now, pol) then
    v_reason := 'household_hold';
  else
    v_reason := public.fc_global_gate(pol, p_now, v_cost, 0, false, p_household_id, null);
  end if;
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
           where household_id = p_household_id and state in ('active', 'terminating') and funding not in ('essential', 'unscreened')) < v_cost then   -- 076
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
-- fc_check_invariants (076: also checks the unscreened reserved counters)
-- ---------------------------------------------------------------------------
create or replace function public.fc_check_invariants() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  g public.fc_global_state%rowtype;
  v_count integer; v_res numeric; v_worst numeric;
  v_bad_accounts integer;
  v_bad_unscreened integer;
begin
  select * into g from public.fc_global_state where id = 1;
  select count(*), coalesce(sum(reserved_gbp), 0), coalesce(sum(worst_case_gbp), 0) into v_count, v_res, v_worst
    from public.fc_reservations where state in ('active', 'terminating') and category in ('call', 'unattributed_call');
  select count(*) into v_bad_accounts from public.fc_budget_accounts a
   where abs(a.reserved_gbp - (select coalesce(sum(r.reserved_gbp), 0) from public.fc_reservations r
       where r.household_id = a.household_id and r.period_start = a.period_start and r.state in ('active', 'terminating') and r.funding in ('budget', 'reserve', 'degraded'))) > 0.000001;
  select count(*) into v_bad_unscreened from public.fc_budget_accounts a
   where abs(a.unscreened_reserved_gbp - (select coalesce(sum(r.reserved_gbp), 0) from public.fc_reservations r
       where r.household_id = a.household_id and r.period_start = a.period_start and r.state in ('active', 'terminating') and r.funding = 'unscreened')) > 0.000001
      or a.unscreened_consumed_gbp > a.unscreened_reserve_gbp + 1;   -- consumed beyond the pool by more than overrun ⇒ broken accounting
  return jsonb_build_object(
    'ok', g.active_count = v_count and abs(g.active_reserved_gbp - v_res) < 0.000001 and abs(g.active_worst_case_gbp - v_worst) < 0.000001
          and v_bad_accounts = 0 and v_bad_unscreened = 0,
    'activeCount', jsonb_build_array(g.active_count, v_count),
    'activeReserved', jsonb_build_array(g.active_reserved_gbp, v_res),
    'activeWorstCase', jsonb_build_array(g.active_worst_case_gbp, v_worst),
    'accountsWithReservedMismatch', v_bad_accounts,
    'accountsWithUnscreenedMismatch', v_bad_unscreened);
end;
$$;

-- ---------------------------------------------------------------------------
-- fc_household_status (076: adds the unscreened pool and the derived
-- remaining figures; every 067 key is unchanged)
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
    return jsonb_build_object('householdId', p_household_id, 'hasAccount', false, 'profile', public.fc_resolve_profile(p_household_id, p_now), 'live', v_live,
      'held', public.fc_household_held(p_household_id));
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
    'lastDenialReason', a.last_denial_reason, 'lastDenialAt', a.last_denial_at, 'live', v_live,
    -- Integration 2026-10-03: who the delivery reserve funds ('all' |
    -- 'trusted_only' | 'none'), so the customer view never claims every call
    -- still connects when only trusted callers would.
    'deliveryReserveScope', (select pr.delivery_reserve_scope from public.fc_budget_profiles pr where pr.profile = a.profile),
    -- Integration 2026-10-04: per-household financial hold.
    'held', public.fc_household_held(p_household_id),
    'hold', (select jsonb_build_object('source', h.source, 'reason', h.reason, 'heldAt', h.held_at) from public.fc_household_holds h where h.household_id = p_household_id),
    -- 076: the unscreened-delivery reserve for unknown callers.
    'unscreenedReserveGbp', a.unscreened_reserve_gbp,
    'unscreenedReservedGbp', a.unscreened_reserved_gbp,
    'unscreenedConsumedGbp', a.unscreened_consumed_gbp,
    'remainingUnscreenedGbp', a.unscreened_reserve_gbp - a.unscreened_consumed_gbp - a.unscreened_reserved_gbp);
end;
$$;

-- ---------------------------------------------------------------------------
-- Audited setters
-- ---------------------------------------------------------------------------
create or replace function public.fortress_set_unscreened_reserve(p_profile text, p_reserve_gbp numeric, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb;
begin
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then
    raise exception 'fortress_set_unscreened_reserve: reason and actor required';
  end if;
  if p_reserve_gbp is null or p_reserve_gbp = 'NaN'::numeric or p_reserve_gbp < 0 or p_reserve_gbp > 20 then
    raise exception 'fortress_set_unscreened_reserve: reserve must be within £0–£20';
  end if;
  perform 1 from public.fc_global_state where id = 1 for update;
  select to_jsonb(b) into before_row from public.fc_budget_profiles b where profile = p_profile for update;
  if before_row is null then raise exception 'fortress_set_unscreened_reserve: unknown profile %', p_profile; end if;
  update public.fc_budget_profiles set unscreened_reserve_gbp = p_reserve_gbp, updated_at = now(), updated_by = p_actor where profile = p_profile;
  insert into public.fc_policy_audit (actor, reason, target, before, after)
  values (p_actor, p_reason, 'profile:' || p_profile || ':unscreened_reserve', before_row,
    (select to_jsonb(b) from public.fc_budget_profiles b where profile = p_profile));
  -- Applies to accounts opened from now on (like fc_set_budget_profile).
  return jsonb_build_object('ok', true, 'profile', p_profile, 'unscreenedReserveGbp', p_reserve_gbp);
end;
$$;

create or replace function public.fortress_set_allowance_policy(p_changes jsonb, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb;
  k text;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'fortress_set_allowance_policy: changes required'; end if;
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then raise exception 'fortress_set_allowance_policy: reason and actor required'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('screening_low_ratio', 'continuity_low_ratio') then raise exception 'fortress_set_allowance_policy: % is not a policy field', k; end if;
    if jsonb_typeof(p_changes->k) <> 'number' then raise exception 'fortress_set_allowance_policy: % must be a number', k; end if;
  end loop;
  select to_jsonb(p) into before_row from public.fortress_allowance_policy p where id = 1 for update;
  update public.fortress_allowance_policy set
    screening_low_ratio = coalesce((p_changes->>'screening_low_ratio')::numeric, screening_low_ratio),
    continuity_low_ratio = coalesce((p_changes->>'continuity_low_ratio')::numeric, continuity_low_ratio),
    updated_at = now(), updated_by = p_actor
  where id = 1;
  insert into public.fc_policy_audit (actor, reason, target, before, after)
  values (p_actor, p_reason, 'allowance_policy', before_row, (select to_jsonb(p) from public.fortress_allowance_policy p where id = 1));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- fortress_household_allowance_state — the deterministic state (read-only).
-- Uses fc_authorize_call's own arithmetic: headroom after consumed, reserved
-- and the live worst cases; screening needs the first lease + the WHOLE
-- monitoring window; a call needs the first lease.
-- ---------------------------------------------------------------------------
create or replace function public.fortress_household_allowance_state(p_household_id uuid, p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pol jsonb;
  ap public.fortress_allowance_policy%rowtype;
  g public.fc_global_state%rowtype;
  a public.fc_budget_accounts%rowtype;
  pr public.fc_budget_profiles%rowtype;
  v_has_account boolean := true;
  v_profile text;
  v_budget numeric; v_used numeric;
  v_contingent numeric := 0; v_uns_contingent numeric := 0; v_ess_contingent numeric := 0;
  v_avail_budget numeric; v_trusted_rem numeric; v_uns_rem numeric; v_ess_rem numeric;
  v_tel_cost numeric; v_mon_cost numeric; v_screen_cost numeric;
  v_budget_can_call boolean; v_trusted_can boolean; v_unknown_can boolean; v_screening boolean;
  v_pct numeric;
  v_trusted_used numeric; v_uns_used numeric;
  v_state text;
  v_held boolean;
  v_since timestamptz;
begin
  if p_household_id is null or p_now is null then raise exception 'fortress_household_allowance_state: household and now required'; end if;
  pol := public.fc_effective_policy(null);
  select * into ap from public.fortress_allowance_policy where id = 1;
  select * into g from public.fc_global_state where id = 1;
  select * into a from public.fc_budget_accounts
   where household_id = p_household_id and period_start <= p_now and period_end > p_now order by period_start desc limit 1;
  if not found then
    -- No account yet this period: evaluate a fresh account of the profile
    -- Fortress would open now (nothing used).
    v_has_account := false;
    v_profile := public.fc_resolve_profile(p_household_id, p_now);
    select * into pr from public.fc_budget_profiles where profile = v_profile;
    if not found then select * into pr from public.fc_budget_profiles where profile = 'unentitled'; end if;
    a.base_budget_gbp := pr.period_budget_gbp; a.adjustments_gbp := 0; a.consumed_gbp := 0; a.reserved_gbp := 0;
    a.delivery_reserve_gbp := pr.delivery_reserve_gbp; a.essential_reserve_gbp := pr.essential_reserve_gbp;
    a.essential_consumed_gbp := 0; a.essential_reserved_gbp := 0;
    a.unscreened_reserve_gbp := pr.unscreened_reserve_gbp; a.unscreened_consumed_gbp := 0; a.unscreened_reserved_gbp := 0;
    a.profile := pr.profile;
  else
    select * into pr from public.fc_budget_profiles where profile = a.profile;
    select coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding not in ('essential', 'unscreened')), 0),
           coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding = 'essential'), 0),
           coalesce(sum(greatest(worst_case_gbp - reserved_gbp, 0)) filter (where funding = 'unscreened'), 0)
      into v_contingent, v_ess_contingent, v_uns_contingent
      from public.fc_reservations where household_id = p_household_id and state in ('active', 'terminating');
  end if;

  v_tel_cost := public.fc_call_cost((pol->>'lease_seconds')::integer + (pol->>'termination_grace_seconds')::integer,
    (pol->>'connected_rate_gbp_per_min')::numeric, (pol->>'monitoring_rate_gbp_per_min')::numeric, (pol->>'monitoring_max_seconds')::integer,
    false, (pol->>'billing_granularity_seconds')::integer, (pol->>'estimate_uplift')::numeric, (pol->>'call_fixed_fee_gbp')::numeric);
  v_mon_cost := public.fc_call_cost((pol->>'monitoring_max_seconds')::integer, 0, (pol->>'monitoring_rate_gbp_per_min')::numeric,
    (pol->>'monitoring_max_seconds')::integer, true, (pol->>'billing_granularity_seconds')::integer, (pol->>'estimate_uplift')::numeric, 0);
  v_screen_cost := v_tel_cost + v_mon_cost;

  v_budget := a.base_budget_gbp + a.adjustments_gbp;
  v_used := a.consumed_gbp + a.reserved_gbp;
  v_avail_budget := v_budget - v_used - v_contingent;
  v_trusted_rem := case when coalesce(pr.delivery_reserve_scope, 'none') = 'none' then 0
                        else greatest(0, least(a.delivery_reserve_gbp, v_avail_budget + a.delivery_reserve_gbp)) end;
  v_uns_rem := greatest(0, a.unscreened_reserve_gbp - a.unscreened_consumed_gbp - a.unscreened_reserved_gbp - v_uns_contingent);
  v_ess_rem := greatest(0, a.essential_reserve_gbp - a.essential_consumed_gbp - a.essential_reserved_gbp - v_ess_contingent);

  v_budget_can_call := v_avail_budget >= v_tel_cost;
  v_trusted_can := v_budget_can_call
    or (coalesce(pr.delivery_reserve_scope, 'none') <> 'none' and v_avail_budget + a.delivery_reserve_gbp >= v_tel_cost);
  v_unknown_can := v_budget_can_call
    or (coalesce(pr.delivery_reserve_scope, 'none') = 'all' and v_avail_budget + a.delivery_reserve_gbp >= v_tel_cost)
    or (v_uns_rem >= v_tel_cost);
  v_screening := coalesce(pr.monitoring_allowed, false) and v_avail_budget >= v_screen_cost;
  v_pct := case when v_budget > 0 then least(1, greatest(0, v_used / v_budget)) else 1 end;
  v_trusted_used := case when a.delivery_reserve_gbp > 0 and coalesce(pr.delivery_reserve_scope, 'none') <> 'none'
                         then 1 - v_trusted_rem / a.delivery_reserve_gbp end;
  v_uns_used := case when a.unscreened_reserve_gbp > 0 then 1 - v_uns_rem / a.unscreened_reserve_gbp end;
  v_held := public.fc_household_held(p_household_id);

  v_state := case
    when v_held then 'held'
    when not v_trusted_can and not v_unknown_can then 'hard_ceiling'
    when not v_budget_can_call and (coalesce(v_trusted_used, 0) >= ap.continuity_low_ratio or coalesce(v_uns_used, 0) >= ap.continuity_low_ratio) then 'continuity_low'
    when not v_budget_can_call then 'continuity'
    when not v_screening then 'screening_paused'
    when v_pct >= ap.screening_low_ratio then 'screening_low'
    else 'normal' end;

  select l.at into v_since from public.fortress_allowance_state_log l
   where l.household_id = p_household_id order by l.id desc limit 1;

  return jsonb_build_object(
    'householdId', p_household_id, 'hasAccount', v_has_account, 'profile', a.profile,
    'periodStart', a.period_start, 'periodEnd', a.period_end,
    'state', v_state, 'held', v_held,
    'serviceLimited', coalesce(g.kill_switch, false) or coalesce(g.breaker_open, false),
    'screeningActive', not v_held and v_screening,
    'unknownCallersDelivered', not v_held and v_unknown_can,
    'trustedCallersDelivered', not v_held and v_trusted_can,
    'percentUsed', floor(v_pct * 100)::integer,
    'budgetGbp', v_budget, 'usedGbp', v_used, 'contingentGbp', v_contingent, 'budgetAvailableGbp', v_avail_budget,
    'deliveryReserveScope', pr.delivery_reserve_scope,
    'trustedReserveGbp', a.delivery_reserve_gbp, 'trustedReserveRemainingGbp', v_trusted_rem,
    'unknownReserveGbp', a.unscreened_reserve_gbp, 'unknownReserveRemainingGbp', v_uns_rem,
    'essentialRemainingGbp', v_ess_rem,
    'trustedReserveUsedFraction', v_trusted_used, 'unknownReserveUsedFraction', v_uns_used,
    'callAdmissionCostGbp', v_tel_cost, 'screeningAdmissionCostGbp', v_screen_cost,
    'thresholds', jsonb_build_object('screeningLowRatio', ap.screening_low_ratio, 'continuityLowRatio', ap.continuity_low_ratio),
    'lastDenialReason', a.last_denial_reason, 'lastDenialAt', a.last_denial_at,
    'since', v_since);
end;
$$;

-- Record the state; on a CHANGE (or a new period) write one log row and one
-- fc_events row. Idempotent: an unchanged state writes nothing.
create or replace function public.fortress_record_allowance_state(p_household_id uuid, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s jsonb;
  v_last public.fortress_allowance_state_log%rowtype;
  v_period timestamptz;
  v_to text;
  v_level text;
begin
  if p_household_id is null or p_now is null then raise exception 'fortress_record_allowance_state: household and now required'; end if;
  perform 1 from public.households where id = p_household_id;
  if not found then raise exception 'fortress_record_allowance_state: unknown household'; end if;
  perform pg_advisory_xact_lock(hashtext('fortress_allowance_state:' || p_household_id::text));
  s := public.fortress_household_allowance_state(p_household_id, p_now);
  v_to := s->>'state';
  v_period := nullif(s->>'periodStart', '')::timestamptz;
  select * into v_last from public.fortress_allowance_state_log where household_id = p_household_id order by id desc limit 1;
  if found and v_last.state = v_to and v_last.period_start is not distinct from v_period then
    return jsonb_build_object('changed', false, 'state', v_to, 'from', v_last.state);
  end if;
  if not found and v_to = 'normal' then
    -- First observation in the normal state is not a transition worth an event.
    insert into public.fortress_allowance_state_log (household_id, period_start, state, previous_state, at, details)
    values (p_household_id, v_period, v_to, null, p_now, jsonb_build_object('percentUsed', s->'percentUsed'));
    return jsonb_build_object('changed', false, 'state', v_to, 'from', null, 'initial', true);
  end if;
  insert into public.fortress_allowance_state_log (household_id, period_start, state, previous_state, at, details)
  values (p_household_id, v_period, v_to, v_last.state, p_now,
    jsonb_build_object('percentUsed', s->'percentUsed', 'budgetAvailableGbp', s->'budgetAvailableGbp',
      'trustedReserveRemainingGbp', s->'trustedReserveRemainingGbp', 'unknownReserveRemainingGbp', s->'unknownReserveRemainingGbp'));
  v_level := case when v_to in ('normal', 'screening_low') then 'info'
                  when v_to in ('hard_ceiling') then 'critical'
                  else 'warning' end;
  perform public.fc_event(v_level, 'allowance_state_changed', p_household_id, null,
    jsonb_build_object('from', v_last.state, 'to', v_to, 'periodStart', v_period, 'percentUsed', s->'percentUsed'));
  return jsonb_build_object('changed', true, 'state', v_to, 'from', v_last.state, 'periodStart', v_period);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'fortress_set_unscreened_reserve(text, numeric, text, text)',
    'fortress_set_allowance_policy(jsonb, text, text)',
    'fortress_household_allowance_state(uuid, timestamptz)',
    'fortress_record_allowance_state(uuid, timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
