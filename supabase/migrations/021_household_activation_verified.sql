-- Mobile app Phase 2: tracks whether the CUSTOMER's own call-forwarding
-- activation has been verified — distinct from twilio_provisioning_status
-- (016), which only reflects whether a Twilio number was successfully
-- purchased/assigned server-side. A household can have
-- twilio_provisioning_status = 'active' (the number exists) while the
-- customer has never actually dialled their carrier's forwarding code —
-- there was previously no column tracking that second, customer-side fact
-- at all. This is exactly the gap APP_DECISION_003/005 (docs/mobile-app/)
-- identifies: activation verification needs to check for a real routed
-- call and remember that it happened.
--
-- STATUS: APPLIED — staging (tigwgmayeuisrxjjykqd), exact date not
-- recorded; production (psbzynxplxfbyrbdidmn) 2026-08-02, see
-- docs/releases/RELEASE_2026-08-02.md on main. Live re-verified against
-- both projects 2026-08-05 — see docs/launch/KNOWN_ISSUES.md's
-- reconciliation summary.

begin;

alter table public.households
  add column if not exists activation_verified_at timestamptz;

-- Narrow, single-purpose SECURITY DEFINER RPC — matching this codebase's
-- established pattern for every households write (set_household_stripe_
-- customer_id, the Twilio lifecycle functions, anonymize_inactive_
-- household) rather than a broad UPDATE grant. Idempotent: does not
-- overwrite an already-set timestamp with a later one — the first real
-- verified call is the meaningful moment, not the most recent one.
create or replace function public.mark_household_activation_verified(
  p_household_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result timestamptz;
begin
  update public.households
    set activation_verified_at = now()
    where id = p_household_id
      and activation_verified_at is null
    returning activation_verified_at into v_result;

  if v_result is not null then
    return v_result;
  end if;

  select activation_verified_at into v_result
    from public.households
    where id = p_household_id;

  if not found then
    raise exception 'mark_household_activation_verified: household % does not exist', p_household_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.mark_household_activation_verified(uuid) from public;
grant execute on function public.mark_household_activation_verified(uuid) to service_role;

commit;
