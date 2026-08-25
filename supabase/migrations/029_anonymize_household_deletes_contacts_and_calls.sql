-- Household anonymisation: also delete trusted contacts and call/
-- screening records, not just scrub the household row
--
-- STATUS: APPLIED — confirmed live in production (project ref
-- psbzynxplxfbyrbdidmn) on 2026-08-25, applied by Andrew via the
-- Supabase SQL Editor after project-identity verification (household/
-- entitlement counts cross-checked against a live, independent read
-- immediately beforehand). Post-application verification query
-- confirmed all of: security definer true, owner postgres, search_path
-- pinned empty, correct (uuid, text) arguments, and the function body
-- containing both new delete statements (public.contacts,
-- public.calls). Not tested against a real customer's data — deletion/
-- anonymisation was never exercised on a live household as part of
-- this verification, only the function's own definition/configuration.
--
-- Root cause this closes: 020_anonymize_inactive_household.sql's own
-- function only ever updated the households row itself — it never
-- touched public.contacts or public.calls. privacy.html promises that
-- deleting an account removes "your trusted-contact data", but nothing
-- in the actual RPC did that: a customer's real trusted contacts (their
-- family/friends' names and phone numbers) and their full call/
-- screening history remained in the database indefinitely after
-- "deletion", tied to the now-anonymised household_id, unless a human
-- separately, manually deleted them — which no code path enforced or
-- even reliably prompted. Found while preparing the Google Play
-- delete-account.html page and cross-checking its wording against what
-- actually happens; confirmed by direct inspection of both tables and
-- of database/contacts.js (only a single-contact delete exists, never a
-- bulk per-household one), not assumed.
--
-- What stays exactly as before, deliberately: subscriptions,
-- entitlements, and stripe_webhook_events are still never touched by
-- this function, for the same reason 020 gave — that's real financial/
-- audit history a business is legally required to keep (UK tax/
-- accounting law), not customer-identifying data in itself once the
-- household row's own email/phone/name-bearing fields are scrubbed.
-- Those three tables were checked directly as part of this change: none
-- of them stores a customer's name, email, or phone number in a
-- dedicated column — the only linkage is household_id (a UUID, useless
-- once the household row it points to is anonymised) and Stripe's own
-- identifiers. The one caveat worth recording, not fixed here: Stripe's
-- webhook event payload is stored verbatim in
-- stripe_webhook_events.payload (jsonb) for audit/replay purposes
-- (11's own comment), and depending on event type this can carry
-- fragments like a customer's email. Redacting inside that column is a
-- separate, materially riskier change (it's the only durable record of
-- exactly what Stripe sent, relied on to safely reprocess a failed
-- event) — flagged for a deliberate future decision, not bundled into
-- this fix.
--
-- Same existing mechanism, not a parallel path: the two hard refusals
-- from 020 (a live Twilio number still assigned; an active entitlement)
-- are preserved verbatim and still run first, before anything
-- destructive. The new deletes only run once every existing guard has
-- already passed.
--
-- Atomicity: a PL/pgSQL function body is one implicit transaction — if
-- any statement here raises, everything the function did earlier in
-- the same call (including the two new deletes) rolls back with it.
-- There is no explicit BEGIN/COMMIT inside the function for this
-- reason; the migration's own top-level begin/commit only wraps
-- *creating* the function, not each future call to it.
--
-- Run this AFTER:
-- 020_anonymize_inactive_household.sql

begin;

create or replace function public.anonymize_inactive_household(
  p_household_id uuid,
  p_reason text default 'test data cleanup'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_twilio_number text;
  v_active_entitlement_count integer;
  v_contacts_deleted integer;
  v_calls_deleted integer;
begin
  select h.twilio_number
    into v_twilio_number
    from public.households h
    where h.id = p_household_id;

  if not found then
    raise exception 'anonymize_inactive_household: household % does not exist', p_household_id;
  end if;

  if v_twilio_number is not null then
    raise exception
      'anonymize_inactive_household: household % still has an assigned Twilio number (%) — release it first (releaseTwilioNumberImmediately), then anonymise',
      p_household_id, v_twilio_number;
  end if;

  select count(*) into v_active_entitlement_count
    from public.entitlements e
    where e.household_id = p_household_id and e.status = 'active';

  if v_active_entitlement_count > 0 then
    raise exception
      'anonymize_inactive_household: household % still has an active entitlement, refusing to anonymise a genuinely protected account',
      p_household_id;
  end if;

  -- Every guard above has passed — only now do anything destructive,
  -- and only ever scoped to this one household_id.

  delete from public.contacts where household_id = p_household_id;
  get diagnostics v_contacts_deleted = row_count;

  delete from public.calls where household_id = p_household_id;
  get diagnostics v_calls_deleted = row_count;

  update public.households
    set email = 'anonymized-' || p_household_id || '@deleted.homecallguard.internal',
        phone_number = null,
        auth_user_id = null,
        stripe_customer_id = null,
        twilio_number = null,
        twilio_number_pending_release_at = null,
        twilio_provisioning_status = 'pending',
        twilio_provisioning_attempts = 0,
        twilio_provisioning_last_error = null,
        status = 'cancelled',
        updated_at = now()
    where id = p_household_id;

  raise notice 'anonymize_inactive_household: household % anonymised (%) — % contact(s) and % call record(s) deleted',
    p_household_id, p_reason, v_contacts_deleted, v_calls_deleted;
end;
$$;

revoke all on function public.anonymize_inactive_household(uuid, text) from public;
grant execute on function public.anonymize_inactive_household(uuid, text) to service_role;

-- Hard assertion, matching this project's established convention
-- (019/021/022 etc.) after two earlier incidents where a migration
-- reported success in the SQL Editor without the change actually
-- taking hold: confirm the function still exists with exactly the
-- expected signature, is still SECURITY DEFINER, and still has the
-- fail-closed grant/search_path/owner posture the generic test-suite
-- check (tests/migrations.pglite.test.mjs) also verifies independently.
do $$
declare
  v_fn_count integer;
  v_owner text;
  v_search_path text;
begin
  select count(*) into v_fn_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'anonymize_inactive_household'
    and pg_get_function_identity_arguments(p.oid) = 'p_household_id uuid, p_reason text';

  if v_fn_count <> 1 then
    raise exception 'MIGRATION 029 VERIFICATION FAILED: expected exactly 1 anonymize_inactive_household(uuid, text) function, found %', v_fn_count;
  end if;

  select pg_get_userbyid(p.proowner), (
    select c from unnest(p.proconfig) c where c like 'search_path=%'
  )
  into v_owner, v_search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'anonymize_inactive_household';

  if v_owner <> 'postgres' then
    raise exception 'MIGRATION 029 VERIFICATION FAILED: expected owner postgres, found %', v_owner;
  end if;

  if v_search_path is null or v_search_path not in ('search_path=', 'search_path=""') then
    raise exception 'MIGRATION 029 VERIFICATION FAILED: expected a pinned empty search_path, found %', coalesce(v_search_path, '<not set>');
  end if;
end
$$;

commit;
