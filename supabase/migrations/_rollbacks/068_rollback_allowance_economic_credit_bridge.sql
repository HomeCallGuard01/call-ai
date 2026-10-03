-- Rollback for 068_allowance_economic_credit_bridge.sql (integration 2026-10-03).
-- STATUS: DRAFT — NOT APPLIED. Disable top-up sales (ALLOWANCE_TOPUPS_ENABLED
-- off) and deploy code that calls the 15-argument credit_allowance BEFORE
-- running this: afterwards a credit moves minutes only, which Fortress (£)
-- does not fund. £ already credited through fc_admin_adjust stays in the
-- Fortress ledger (it is append-only) — reverse it explicitly if required.
begin;
drop function if exists public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean, numeric);
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
  p_allow_non_production boolean
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
  v_id bigint;
begin
  if p_household_id is null or p_provider_transaction_id is null or length(p_provider_transaction_id) = 0 then
    raise exception 'credit_allowance: household and transaction id are required';
  end if;
  if p_environment is distinct from 'production' and not coalesce(p_allow_non_production, false) then
    return jsonb_build_object('credited', false, 'reason', 'non_production_purchase');
  end if;

  -- Same lock begin_monitoring_session (056) takes for this household.
  perform pg_advisory_xact_lock(hashtext('hcg_monitoring:' || p_household_id::text));

  select * into v_existing from public.allowance_credits
   where source = p_source and provider_transaction_id = p_provider_transaction_id and kind = p_kind;
  if found then
    return jsonb_build_object('credited', false, 'duplicate', true, 'creditId', v_existing.id,
      'appliedSeconds', v_existing.applied_seconds, 'periodStart', v_existing.period_start,
      'sameHousehold', v_existing.household_id is not distinct from p_household_id);
  end if;

  if p_kind = 'topup_reversal' then
    select * into v_original from public.allowance_credits
     where source = p_source and provider_transaction_id = p_provider_transaction_id and kind = 'topup';
    if not found or v_original.household_id is distinct from p_household_id then
      return jsonb_build_object('credited', false, 'reason', 'original_not_found');
    end if;
    -- The reversal applies to the period the top-up was credited to.
    v_period_start := v_original.period_start;
    v_period_end := v_original.period_end;
    p_seconds := -v_original.applied_seconds;
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

  insert into public.allowance_credits (household_id, kind, requested_seconds, applied_seconds,
    period_start, period_end, source, environment, provider_transaction_id, provider_event_id,
    product_code, amount_minor, currency, reverses_credit_id, actor, reason)
  values (p_household_id, p_kind, p_seconds, v_applied, v_period_start, v_period_end, p_source,
    p_environment, p_provider_transaction_id, p_provider_event_id, p_product_code, p_amount_minor,
    p_currency, case when p_kind = 'topup_reversal' then v_original.id end, p_actor, p_reason)
  returning id into v_id;

  return jsonb_build_object('credited', true, 'creditId', v_id, 'appliedSeconds', v_applied,
    'bonusSeconds', v_bonus + v_applied, 'periodStart', v_period_start, 'periodEnd', v_period_end);
end;
$$;
revoke all on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean) to service_role;
alter table public.allowance_credits drop column if exists applied_budget_gbp;
commit;
