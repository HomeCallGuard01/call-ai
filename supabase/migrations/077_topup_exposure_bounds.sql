-- 077_topup_exposure_bounds.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (WS2 financial protection, 2026-10-10).
-- Numbering: 077 allocated to WS2 by the launch lead. Depends on 063 + 068
-- (allowance_credits, credit_allowance → fc_admin_adjust) and 067 (Fortress).
-- Rollback: _rollbacks/077_rollback_topup_exposure_bounds.sql (restores 068's
-- credit_allowance verbatim; holds already set by 077 are kept — release them
-- through the audited admin path).
--
-- WHY. A paid top-up adds £ capacity to the Fortress budget. 068 bounded the
-- £ per price only in the APP (productCatalog.maxBudgetForPrice). This makes
-- the DATABASE refuse any credit that could create exposure beyond top-up
-- revenue, whatever the caller sends:
--
--   1. Revenue-backed only: a top-up must carry the amount actually paid,
--      in GBP minor units (p_amount_minor > 0, p_currency = 'gbp'); the £
--      credited is capped at  paid ÷ (1 + VAT) × max_budget_per_net_revenue
--      (default 0.60). No amount / non-GBP ⇒ refused ('revenue_unverified').
--      Production only (068 already refuses sandbox unless explicitly allowed).
--   2. Per-period caps: at most max_credits_per_period top-ups and
--      max_budget_gbp_per_period of net credited £ per household per
--      allowance period ⇒ otherwise refused ('topup_period_cap').
--   3. Refund / dispute reversal: the full credited £ is reversed while its
--      period is current (068, unchanged). NEW: if any of that £ was already
--      CONSUMED (in the current OR an expired period), the household is put
--      on an automatic FINANCIAL HOLD (fc_household_holds, admin release only)
--      and the reversal row records consumedGbp. A refunded top-up can
--      therefore fund at most what was spent before the refund arrived, and
--      nothing after it.
--   4. Idempotent as before (unique source + transaction + kind): a refund
--      followed by a dispute on the same payment reverses once.
--
-- Policy is a single CHECK-constrained row changed only through the audited
-- fortress_set_topup_policy. Top-ups stay OFF (ALLOWANCE_TOPUPS_ENABLED).

begin;

create table if not exists public.fortress_topup_policy (
  id integer primary key check (id = 1),
  vat_rate numeric(5, 4) not null default 0.20 check (vat_rate >= 0 and vat_rate < 1),
  max_budget_per_net_revenue numeric(4, 3) not null default 0.60 check (max_budget_per_net_revenue > 0 and max_budget_per_net_revenue <= 1),
  max_credits_per_period integer not null default 3 check (max_credits_per_period between 0 and 20),
  max_budget_gbp_per_period numeric(12, 4) not null default 10 check (max_budget_gbp_per_period >= 0 and max_budget_gbp_per_period <= 50),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.fortress_topup_policy (id) values (1) on conflict (id) do nothing;
alter table public.fortress_topup_policy enable row level security;
revoke all on public.fortress_topup_policy from public, anon, authenticated;
grant select on public.fortress_topup_policy to service_role;

alter table public.allowance_credits
  add column if not exists consumed_at_reversal_gbp numeric(12, 5)
    check (consumed_at_reversal_gbp is null or consumed_at_reversal_gbp >= 0);

create or replace function public.fortress_set_topup_policy(p_changes jsonb, p_reason text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb;
  k text;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then raise exception 'fortress_set_topup_policy: changes required'; end if;
  if coalesce(length(trim(p_reason)), 0) < 5 or coalesce(length(trim(p_actor)), 0) < 2 then raise exception 'fortress_set_topup_policy: reason and actor required'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('vat_rate', 'max_budget_per_net_revenue', 'max_credits_per_period', 'max_budget_gbp_per_period') then
      raise exception 'fortress_set_topup_policy: % is not a policy field', k;
    end if;
    if jsonb_typeof(p_changes->k) <> 'number' then raise exception 'fortress_set_topup_policy: % must be a number', k; end if;
  end loop;
  select to_jsonb(p) into before_row from public.fortress_topup_policy p where id = 1 for update;
  update public.fortress_topup_policy set
    vat_rate = coalesce((p_changes->>'vat_rate')::numeric, vat_rate),
    max_budget_per_net_revenue = coalesce((p_changes->>'max_budget_per_net_revenue')::numeric, max_budget_per_net_revenue),
    max_credits_per_period = coalesce((p_changes->>'max_credits_per_period')::integer, max_credits_per_period),
    max_budget_gbp_per_period = coalesce((p_changes->>'max_budget_gbp_per_period')::numeric, max_budget_gbp_per_period),
    updated_at = now(), updated_by = p_actor
  where id = 1;
  insert into public.fc_policy_audit (actor, reason, target, before, after)
  values (p_actor, p_reason, 'topup_policy', before_row, (select to_jsonb(p) from public.fortress_topup_policy p where id = 1));
  return jsonb_build_object('ok', true);
end;
$$;

-- credit_allowance — same signature and behaviour as 068, plus the bounds
-- above (marked "077:").
create or replace function public.credit_allowance(
  p_household_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_kind text,
  p_seconds integer,
  p_source text,
  p_environment text,
  p_provider_transaction_id text,
  p_provider_event_id text,
  p_product_code text,
  p_amount_minor integer,
  p_currency text,
  p_actor text,
  p_reason text,
  p_allow_non_production boolean,
  p_budget_gbp numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.allowance_credits%rowtype;
  v_original public.allowance_credits%rowtype;
  v_bonus integer;
  v_applied integer;
  v_period_start timestamptz := p_period_start;
  v_period_end timestamptz := p_period_end;
  v_budget numeric := 0;
  v_id bigint;
  v_adjust jsonb;
  tp public.fortress_topup_policy%rowtype;        -- 077
  v_revenue_cap numeric;                          -- 077
  v_period_count integer; v_period_gbp numeric;   -- 077
  fa public.fc_budget_accounts%rowtype;           -- 077
  v_consumed numeric := 0;                        -- 077
  v_capped boolean := false;                      -- 077
  v_held boolean := false;                        -- 077
begin
  if p_household_id is null or p_provider_transaction_id is null or length(p_provider_transaction_id) = 0 then
    raise exception 'credit_allowance: household and transaction id are required';
  end if;
  if p_environment is distinct from 'production' and not coalesce(p_allow_non_production, false) then
    return jsonb_build_object('credited', false, 'reason', 'non_production_purchase');
  end if;
  if p_kind in ('topup', 'admin_adjustment') then
    if p_budget_gbp is null or p_budget_gbp = 'NaN'::numeric or p_budget_gbp < -50 or p_budget_gbp > 50 then
      raise exception 'credit_allowance: budget must be a finite £ amount within ±£50';
    end if;
    if p_kind = 'topup' and p_budget_gbp <= 0 then
      raise exception 'credit_allowance: a top-up must add a positive £ budget';
    end if;
    if p_kind = 'admin_adjustment' and (p_budget_gbp = 0 or sign(p_budget_gbp) <> sign(p_seconds)) then
      raise exception 'credit_allowance: an adjustment''s £ must be non-zero and move the same way as its minutes';
    end if;
  end if;

  -- Same lock begin_monitoring_session (056) takes for this household.
  perform pg_advisory_xact_lock(hashtext('hcg_monitoring:' || p_household_id::text));

  select * into v_existing from public.allowance_credits
   where source = p_source and provider_transaction_id = p_provider_transaction_id and kind = p_kind;
  if found then
    return jsonb_build_object('credited', false, 'duplicate', true, 'creditId', v_existing.id,
      'appliedSeconds', v_existing.applied_seconds, 'appliedBudgetGbp', v_existing.applied_budget_gbp,
      'periodStart', v_existing.period_start,
      'sameHousehold', v_existing.household_id is not distinct from p_household_id);
  end if;

  select * into tp from public.fortress_topup_policy where id = 1;   -- 077

  if p_kind = 'topup_reversal' then
    select * into v_original from public.allowance_credits
     where source = p_source and provider_transaction_id = p_provider_transaction_id and kind = 'topup';
    if not found or v_original.household_id is distinct from p_household_id then
      return jsonb_build_object('credited', false, 'reason', 'original_not_found');
    end if;
    v_period_start := v_original.period_start;
    v_period_end := v_original.period_end;
    p_seconds := -v_original.applied_seconds;
    v_budget := case when now() >= v_original.period_start and now() < v_original.period_end
                     then -coalesce(v_original.applied_budget_gbp, 0) else 0 end;
    -- 077: how much of the refunded £ was already spent. The Fortress account
    -- that received the credit is the one open when it was credited.
    select * into fa from public.fc_budget_accounts
     where household_id = p_household_id and period_start <= v_original.created_at and period_end > v_original.created_at
     order by period_start desc limit 1;
    if found then
      v_consumed := least(coalesce(v_original.applied_budget_gbp, 0), greatest(0,
        fa.consumed_gbp + fa.reserved_gbp - (fa.base_budget_gbp + fa.adjustments_gbp - coalesce(v_original.applied_budget_gbp, 0))));
    end if;
  else
    -- Truncated (toward zero) to the Fortress account precision (numeric
    -- 12,4), so account, ledger and this audit row always agree and rounding
    -- can never over-credit.
    v_budget := trunc(p_budget_gbp, 4);
    if p_kind = 'topup' and v_budget <= 0 then
      raise exception 'credit_allowance: a top-up must add at least £0.0001';
    end if;
    if p_kind = 'topup' then
      -- 077 (1): revenue-backed only — the GBP amount actually paid bounds the £.
      if p_amount_minor is null or p_amount_minor <= 0 or lower(coalesce(p_currency, '')) <> 'gbp' then
        return jsonb_build_object('credited', false, 'reason', 'revenue_unverified');
      end if;
      v_revenue_cap := trunc(p_amount_minor / 100.0 / (1 + tp.vat_rate) * tp.max_budget_per_net_revenue, 4);
      if v_budget > v_revenue_cap then v_budget := v_revenue_cap; v_capped := true; end if;
      if v_budget <= 0 then return jsonb_build_object('credited', false, 'reason', 'revenue_unverified'); end if;
      -- 077 (2): per-period caps (net of reversals).
      select count(*) filter (where kind = 'topup'), coalesce(sum(applied_budget_gbp) filter (where kind in ('topup', 'topup_reversal')), 0)
        into v_period_count, v_period_gbp
        from public.allowance_credits
       where household_id = p_household_id and period_start = v_period_start and kind in ('topup', 'topup_reversal');
      if v_period_count + 1 > tp.max_credits_per_period or v_period_gbp + v_budget > tp.max_budget_gbp_per_period then
        return jsonb_build_object('credited', false, 'reason', 'topup_period_cap', 'periodCredits', v_period_count, 'periodBudgetGbp', v_period_gbp);
      end if;
    end if;
  end if;

  insert into public.household_usage_periods (household_id, period_start, period_end)
  values (p_household_id, v_period_start, v_period_end)
  on conflict (household_id, period_start) do nothing;
  select bonus_monitored_seconds into v_bonus from public.household_usage_periods
   where household_id = p_household_id and period_start = v_period_start for update;

  v_applied := case when p_seconds >= 0 then p_seconds else -least(-p_seconds, v_bonus) end;

  update public.household_usage_periods
     set bonus_monitored_seconds = bonus_monitored_seconds + v_applied, updated_at = now()
   where household_id = p_household_id and period_start = v_period_start;

  -- The authoritative £ capacity, in this same transaction (any failure here
  -- rolls back the minutes and the audit row too: never one without the other).
  if v_budget <> 0 then
    v_adjust := public.fc_admin_adjust(
      p_household_id, v_budget,
      coalesce(nullif(trim(p_reason), ''), 'allowance ' || p_kind),
      coalesce(nullif(trim(p_actor), ''), 'system:' || p_source),
      'allowance:' || p_kind || ':' || p_source || ':' || p_provider_transaction_id,
      case when p_kind = 'admin_adjustment' then 'admin' else 'topup' end,
      v_period_start, v_period_end, now());
  end if;

  -- 077 (3): refunded £ already spent ⇒ automatic financial hold (admin release only).
  if p_kind = 'topup_reversal' and v_consumed > 0 then
    insert into public.fc_household_holds (household_id, source, reason, actor)
    values (p_household_id, 'financial', 'automatic: refunded/disputed top-up already consumed', 'system:topup')
    on conflict (household_id) do nothing;
    insert into public.fc_household_hold_audit (household_id, action, source, reason, actor)
    values (p_household_id, 'hold', 'financial', 'automatic: refunded/disputed top-up £' || round(v_consumed, 4) || ' already consumed (txn ' || left(p_provider_transaction_id, 40) || ')', 'system:topup');
    perform public.fc_event('emergency', 'household_hold_topup_reversal', p_household_id, null,
      jsonb_build_object('consumedGbp', v_consumed, 'creditedGbp', v_original.applied_budget_gbp, 'source', p_source));
    v_held := true;
  end if;

  insert into public.allowance_credits (household_id, kind, requested_seconds, applied_seconds,
    period_start, period_end, source, environment, provider_transaction_id, provider_event_id,
    product_code, amount_minor, currency, reverses_credit_id, actor, reason, applied_budget_gbp, consumed_at_reversal_gbp)
  values (p_household_id, p_kind, p_seconds, v_applied, v_period_start, v_period_end, p_source,
    p_environment, p_provider_transaction_id, p_provider_event_id, p_product_code, p_amount_minor,
    p_currency, case when p_kind = 'topup_reversal' then v_original.id end, p_actor, p_reason, v_budget,
    case when p_kind = 'topup_reversal' then v_consumed end)
  returning id into v_id;

  return jsonb_build_object('credited', true, 'creditId', v_id, 'appliedSeconds', v_applied,
    'bonusSeconds', v_bonus + v_applied, 'appliedBudgetGbp', v_budget, 'budgetPeriodStart', case when v_adjust is null then null else v_adjust->>'periodStart' end,
    'periodStart', v_period_start, 'periodEnd', v_period_end,
    'cappedByRevenue', v_capped, 'consumedGbp', case when p_kind = 'topup_reversal' then v_consumed end, 'householdHeld', v_held);
end;
$$;

revoke all on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean, numeric) from public, anon, authenticated;
grant execute on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean, numeric) to service_role;
revoke all on function public.fortress_set_topup_policy(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.fortress_set_topup_policy(jsonb, text, text) to service_role;

commit;
