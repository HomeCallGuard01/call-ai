-- Customer allowance: auditable allowance credits (top-ups, administrative
-- adjustments, reversals) and per-channel warning delivery — 2026-10-03.
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (not staging, not production).
-- Depends on 056_financial_safety_allowance_and_admission.sql (also DRAFT,
-- not applied): it extends 056's household_usage_periods.bonus_monitored_
-- seconds and usage_notifications rather than adding a second allowance
-- counter. Apply 056 first.
--
-- Numbered 063: on 2026-10-03, 057–061 are claimed (some twice) and 062 is
-- taken by feature/customer-identity-carrier-abstraction
-- (062_customer_identity_and_routing_assignments.sql). This file was first
-- pushed as 062 and renumbered the same day to avoid that clash. 048–050
-- are unused but 050 objects exist on staging without a file, so they are
-- avoided. Re-check before applying.
--
-- Design (docs/handovers/2026-10-03-customer-allowance-billing-handover.md):
--   * Financial Fortress (056 and successors) stays the ONLY enforcement
--     point. begin_monitoring_session already reads
--     allowance + bonus_monitored_seconds; a credit here changes that
--     number and nothing else. No second "remaining" counter exists.
--   * Every allowance change is a row in allowance_credits (append-only
--     audit trail) written in the SAME transaction as the bonus change,
--     under the same per-household advisory lock begin_monitoring_session
--     takes — a credit can never race a monitoring admission.
--   * Idempotent per (source, provider_transaction_id, kind): a replayed
--     webhook, a retry, or a store re-delivery credits nothing twice.
--   * Non-production purchases (Apple/Google sandbox, Stripe test mode)
--     are refused by the RPC itself unless the caller explicitly states
--     it runs outside production (defence in depth behind the app check).
--   * Top-up minutes belong to the allowance period that is current when
--     the payment is CONFIRMED, and expire at that period's reset.

begin;

create table if not exists public.allowance_credits (
  id bigint generated always as identity primary key,
  -- Kept (set null) if the household is deleted: these rows are the
  -- revenue/accounting trail for paid top-ups.
  household_id uuid references public.households(id) on delete set null,
  kind text not null check (kind in ('topup', 'topup_reversal', 'admin_adjustment')),
  -- Requested change in seconds (+ credit, − reduction).
  requested_seconds integer not null check (requested_seconds <> 0),
  -- Change actually applied to bonus_monitored_seconds (a reduction is
  -- clamped so the bonus never goes below 0; a reversal of a top-up whose
  -- period has already reset applies 0).
  applied_seconds integer not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  source text not null check (source in ('stripe', 'apple', 'google', 'admin')),
  environment text not null check (environment in ('production', 'sandbox')),
  -- Stripe PaymentIntent / store transaction id / admin idempotency key.
  provider_transaction_id text not null check (length(provider_transaction_id) between 1 and 200),
  provider_event_id text,
  product_code text,
  -- Gross amount the customer paid as reported by the provider (minor
  -- units, VAT inclusive) — for reconciliation only, never trusted for
  -- the credit itself (the credit comes from the product catalogue).
  amount_minor integer check (amount_minor is null or amount_minor >= 0),
  currency text,
  reverses_credit_id bigint references public.allowance_credits(id),
  actor text,
  reason text,
  created_at timestamptz not null default now(),
  check (period_end > period_start),
  check (kind <> 'topup' or requested_seconds > 0),
  check (kind <> 'topup_reversal' or (requested_seconds < 0 and reverses_credit_id is not null)),
  check (kind <> 'admin_adjustment' or (source = 'admin' and actor is not null and length(coalesce(reason, '')) > 0)),
  unique (source, provider_transaction_id, kind)
);
create index if not exists allowance_credits_by_household_period
  on public.allowance_credits (household_id, period_start);

-- One row per (claimed warning point × delivery channel). The FK means a
-- delivery can only exist for a warning point 056 has already claimed
-- once for that household and period — so no channel can ever send a
-- warning twice, or send one that was never reached.
create table if not exists public.allowance_notice_deliveries (
  household_id uuid not null,
  period_start timestamptz not null,
  kind text not null,
  channel text not null check (channel in ('email', 'push')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  primary key (household_id, period_start, kind, channel),
  foreign key (household_id, period_start, kind)
    references public.usage_notifications (household_id, period_start, kind) on delete cascade
);
create index if not exists allowance_notice_deliveries_due
  on public.allowance_notice_deliveries (next_attempt_at) where status in ('pending', 'failed', 'sending');

alter table public.allowance_credits enable row level security;
alter table public.allowance_notice_deliveries enable row level security;
revoke all on public.allowance_credits, public.allowance_notice_deliveries from public, anon, authenticated;
-- Credits are written ONLY through credit_allowance (below).
grant select on public.allowance_credits to service_role;
grant select, insert, update on public.allowance_notice_deliveries to service_role;

-- ---------------------------------------------------------------------------
-- credit_allowance: the single write path for every allowance change.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- claim_allowance_notice_batch: leases due deliveries to one sender.
-- A lease that expires (sender crashed) is picked up again; attempts
-- are capped by the caller (status 'failed' with no next attempt).
-- ---------------------------------------------------------------------------
create or replace function public.claim_allowance_notice_batch(p_now timestamptz, p_limit integer, p_lease_seconds integer)
returns setof public.allowance_notice_deliveries
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.allowance_notice_deliveries d
     set status = 'sending', attempts = d.attempts + 1,
         lease_until = p_now + make_interval(secs => p_lease_seconds)
   where (d.household_id, d.period_start, d.kind, d.channel) in (
     select x.household_id, x.period_start, x.kind, x.channel
       from public.allowance_notice_deliveries x
      where (x.status in ('pending', 'failed') and x.next_attempt_at <= p_now)
         or (x.status = 'sending' and x.lease_until < p_now)
      order by x.next_attempt_at
      limit greatest(1, least(p_limit, 100))
      for update skip locked)
  returning d.*;
end;
$$;

revoke all on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.credit_allowance(uuid, timestamptz, timestamptz, text, integer, text, text, text, text, text, integer, text, text, text, boolean) to service_role;
revoke all on function public.claim_allowance_notice_batch(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_allowance_notice_batch(timestamptz, integer, integer) to service_role;

commit;
