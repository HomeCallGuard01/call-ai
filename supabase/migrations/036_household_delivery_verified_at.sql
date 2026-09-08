-- Adds households.delivery_verified_at: the last time a real, approved
-- call was PROVEN to actually connect to this household's protected
-- phone — a genuine Twilio DialCallStatus of "completed" on the
-- customer-facing leg of dialHouseholdOrFailClosed's <Dial> (server.js's
-- /call-delivery-failed, the currently-reachable client-only delivery
-- path), never a customer's self-report or an inference from anything
-- else.
--
-- STATUS: DRAFT — NOT APPLIED.
--
-- Closes a distinct, separate gap from migration 035: this codebase's
-- existing activation_verified_at (021) proves only that a call reached
-- HCG (the customer's own forwarding registered and Twilio routed it to
-- /voice) — it says nothing about whether HCG could ever deliver an
-- approved call back out to the customer. Production evidence
-- 2026-09-07: every genuine paying household had activation_verified_at
-- behaviour working (or working-adjacent) while 100% of approved-call
-- deliveries silently failed — "You're protected" must not be shown on
-- inbound-only evidence. See docs/mobile-app/
-- APP_DECISION_008_call_delivery_architecture.md.
--
-- Three distinct states now exist, deliberately kept separate rather
-- than collapsed into one flag:
--   1. forwarding verified   — activation_verified_at (021, unchanged)
--   2. delivery ready        — voice_client_registered_at fresh (035) —
--                               a capability/readiness fact, not proof
--                               anything was ever actually delivered
--   3. end-to-end delivery verified — this column: real evidence a
--                               specific approved call actually
--                               connected
-- server.js/routes/mobileApi.js combine these into one "fully protected"
-- boolean for the UI (never (1) alone) — see the routing/dashboard
-- changes in this same change series. A households.device_type column
-- and an explicitly-classified-landline delivery path were designed
-- alongside these two migrations, then deferred before release (see
-- migration 035's own scope note) — this column's semantics are
-- unaffected either way: it only ever records genuine Dial-leg evidence,
-- regardless of which delivery mode produced it.
--
-- Deliberately NOT idempotent-once, matching voice_client_registered_at's
-- own reasoning (035): a mobile customer's delivery capability can
-- regress (app uninstalled, push credential revoked, OS killed the
-- background process) after one real success, so "has this ever
-- happened" alone would be stale/misleading indefinitely. Every genuine
-- completed delivery moves this forward; nothing ever moves it backward
-- automatically — a lapsed household simply stops accumulating fresh
-- evidence rather than being flagged unprotected the instant one call is
-- missed, matching activation_verified_at's own "don't punish a single
-- no-answer" precedent.
--
-- Recording point is a plain, already-authenticated-by-Twilio server
-- write (no new customer step, no new RPC caller beyond server.js
-- itself, which already owns every calls-table write in this action
-- callback) — SECURITY DEFINER RPC used for consistency with every other
-- households write in this codebase, not because a new privilege
-- boundary is needed here.

begin;

alter table public.households
  add column if not exists delivery_verified_at timestamptz;

create or replace function public.mark_household_delivery_verified(
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
    set delivery_verified_at = now()
    where id = p_household_id
    returning delivery_verified_at into v_result;

  if not found then
    raise exception 'mark_household_delivery_verified: household % does not exist', p_household_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.mark_household_delivery_verified(uuid) from public;
grant execute on function public.mark_household_delivery_verified(uuid) to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households'
      and column_name = 'delivery_verified_at' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'MIGRATION 036 VERIFICATION FAILED: households.delivery_verified_at missing or wrong type';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mark_household_delivery_verified'
  ) then
    raise exception 'MIGRATION 036 VERIFICATION FAILED: mark_household_delivery_verified function missing';
  end if;
end
$$;
