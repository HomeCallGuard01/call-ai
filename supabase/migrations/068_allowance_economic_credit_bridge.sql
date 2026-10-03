-- 068 — Customer allowance ↔ Financial Fortress economic bridge
-- (integration/launch-fortress-2026-10-03).
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (not staging, not production).
-- Depends on 063 (allowance_credits, credit_allowance) and 067 (fc_admin_adjust,
-- fc_budget_accounts). Apply after both.
--
-- WHY: 063 credited a paid top-up (and an admin adjustment) as MINUTES on
-- 056's household_usage_periods.bonus_monitored_seconds. The Financial
-- Fortress (067) enforces a £ budget per household per period and refuses /
-- ends calls on £, not minutes — so a top-up that only added minutes would
-- sell capacity the authoritative enforcer never funds (and a refund would
-- claw back minutes but leave £ capacity in place). This migration makes
-- every allowance credit move the SAME £ capacity Fortress enforces, in the
-- SAME transaction as the audit row and the minute counter:
--
--   topup             +p_budget_gbp     fc_admin_adjust(source 'topup')
--   admin_adjustment  ±p_budget_gbp     fc_admin_adjust(source 'admin')
--   topup_reversal    −original £       fc_admin_adjust(source 'topup'), ONLY if
--                                       the original's period is still the
--                                       current Fortress period (an expired
--                                       period's capacity no longer exists to
--                                       claw back; minutes follow 063's rule)
--
-- The £ amount is validated here as well as in the app (finite, non-zero for
-- topup, ≤ £50 = fc_admin_adjust's own bound, sign agrees with the minutes for
-- an admin adjustment). The margin guard that bounds £ per price paid lives in
-- services/allowance/productCatalog.js (maxBudgetForPrice) and is applied at
-- credit time in services/allowance/topUpCredit.js.
--
-- Rollback: _rollbacks/068_rollback_allowance_economic_credit_bridge.sql —
-- restores 063's minutes-only function. Only with top-up sales disabled.

alter table public.allowance_credits
  add column if not exists applied_budget_gbp numeric(12, 5)
    check (applied_budget_gbp is null or (applied_budget_gbp >= -50 and applied_budget_gbp <= 50));

drop function if exists public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean);

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
  else
    -- Truncated (toward zero) to the Fortress account precision (numeric
    -- 12,4), so account, ledger and this audit row always agree and rounding
    -- can never over-credit.
    v_budget := trunc(p_budget_gbp, 4);
    if p_kind = 'topup' and v_budget <= 0 then
      raise exception 'credit_allowance: a top-up must add at least £0.0001';
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

  insert into public.allowance_credits (household_id, kind, requested_seconds, applied_seconds,
    period_start, period_end, source, environment, provider_transaction_id, provider_event_id,
    product_code, amount_minor, currency, reverses_credit_id, actor, reason, applied_budget_gbp)
  values (p_household_id, p_kind, p_seconds, v_applied, v_period_start, v_period_end, p_source,
    p_environment, p_provider_transaction_id, p_provider_event_id, p_product_code, p_amount_minor,
    p_currency, case when p_kind = 'topup_reversal' then v_original.id end, p_actor, p_reason, v_budget)
  returning id into v_id;

  return jsonb_build_object('credited', true, 'creditId', v_id, 'appliedSeconds', v_applied,
    'bonusSeconds', v_bonus + v_applied, 'appliedBudgetGbp', v_budget, 'budgetPeriodStart', case when v_adjust is null then null else v_adjust->>'periodStart' end,
    'periodStart', v_period_start, 'periodEnd', v_period_end);
end;
$$;

revoke all on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean, numeric) from public, anon, authenticated;
grant execute on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean, numeric) to service_role;
