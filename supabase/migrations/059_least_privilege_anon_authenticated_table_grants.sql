-- Reduce anon/authenticated privileges on every EXISTING public-schema
-- relation to the least-privilege set the application actually uses.
-- Companion to 058, which does the same for tables created in the future.
--
-- STATUS: APPLIED to staging (tigwgmayeuisrxjjykqd) 2026-09-30T19:26:35Z
-- via `supabase db query --linked -f` + `supabase migration repair --status
-- applied 059`; verified live (verify-table-grants.js all-clear, anon Data
-- API probes 42501, real ensureHouseholdAndRole() over HTTP). NOT applied to
-- production (psbzynxplxfbyrbdidmn) — awaiting Andrew's explicit approval;
-- see docs/engineering/SUPABASE_SECURITY_REMEDIATION_2026-09-30.md.
--
-- Why (catalog evidence, read-only, 2026-09-30):
--   staging: anon and authenticated hold ALL (arwdDxtm) on 13 public
--     tables, inherited from staging's default ACL (see 058). Only RLS
--     stands between those grants and the Data API; 057 was needed because
--     one table (terms_acceptances, 039) shipped without RLS.
--   production: anon/authenticated hold TRUNCATE/REFERENCES/TRIGGER/
--     MAINTAIN (Dxtm) on every table they aren't explicitly granted, from
--     production's older default ACL. Not reachable through PostgREST, but
--     never needed by anything.
--   both: authenticated holds table-wide INSERT/UPDATE on households (006).
--     The households_insert_own policy only checks auth_user_id/email, so
--     any signed-in user without a household can create one via the Data
--     API with arbitrary columns — twilio_number (not unique; inbound call
--     routing picks the first match in getHouseholdByTwilioNumber),
--     activation_verified_at, delivery_verified_at, self_protecting,
--     carrier_* (bypassing the carrier compatibility gate) etc. Reproduced
--     on staging in a rolled-back transaction.
--
-- Required access, traced from the code (nothing else reaches public
-- tables as anon/authenticated — the web pages and mobile app only call
-- Supabase Auth; every other read/write goes through supabaseAdmin):
--   services/householdBootstrap.js ensureHouseholdAndRole(), via
--   buildUserScopedClient() (role: authenticated):
--     households  select; update (auth_user_id, email); insert (auth_user_id, email, status)
--     user_roles  select; insert (auth_user_id, role)
--   Explicit, RLS-scoped grants from 008/011 kept as designed (own
--   household only; not used by current code, so removable later):
--     contacts       select, insert, update, delete
--     subscriptions  select
--     entitlements   select
--   anon: nothing.
--
-- Effect: strips every anon/authenticated/PUBLIC privilege on every
-- public table, view, materialized view and sequence, then re-grants only
-- the list above. RLS and policies are untouched. service_role is
-- untouched. No data is read or written; ACL-only, takes brief locks.
--
-- Production impact: no change to what any Data API caller can do today,
-- except that a signed-in user can no longer set households columns other
-- than auth_user_id/email/status on insert (the app never does).
--
-- Rollback: supabase/migrations/_rollbacks/059_rollback_*.sql (per-project
-- variants — the pre-059 ACLs differ between staging and production).

begin;

do $$
declare
  rel record;
begin
  for rel in
    select c.oid::regclass as name, c.relkind
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  loop
    if rel.relkind = 'S' then
      execute format('revoke all on sequence %s from public, anon, authenticated', rel.name);
    else
      execute format('revoke all on table %s from public, anon, authenticated', rel.name);
    end if;
  end loop;
end
$$;

grant select on table public.households to authenticated;
grant insert (auth_user_id, email, status) on table public.households to authenticated;
grant update (auth_user_id, email) on table public.households to authenticated;

grant select on table public.user_roles to authenticated;
grant insert (auth_user_id, role) on table public.user_roles to authenticated;

grant select, insert, update, delete on table public.contacts to authenticated;
grant select on table public.subscriptions to authenticated;
grant select on table public.entitlements to authenticated;

commit;

-- Read-only verification — run after commit. Reads relacl directly
-- (aclexplode) rather than information_schema, which filters by the
-- current role's memberships.
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ')
    into v_bad
  from pg_class c, aclexplode(c.relacl) a
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and (a.grantee = 0 or a.grantee = 'anon'::regrole);
  if v_bad is not null then
    raise exception 'MIGRATION 059 VERIFICATION FAILED: anon/PUBLIC still granted: %', v_bad;
  end if;

  select string_agg(format('%s:%s', c.relname, a.privilege_type), ', ')
    into v_bad
  from pg_class c, aclexplode(c.relacl) a
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and a.grantee = 'authenticated'::regrole
    and (c.relname::text, a.privilege_type::text) not in (
      ('households', 'SELECT'), ('user_roles', 'SELECT'),
      ('contacts', 'SELECT'), ('contacts', 'INSERT'), ('contacts', 'UPDATE'), ('contacts', 'DELETE'),
      ('subscriptions', 'SELECT'), ('entitlements', 'SELECT'));
  if v_bad is not null then
    raise exception 'MIGRATION 059 VERIFICATION FAILED: unexpected authenticated table grant: %', v_bad;
  end if;

  if has_column_privilege('authenticated', 'public.households', 'twilio_number', 'INSERT')
     or has_column_privilege('authenticated', 'public.households', 'twilio_number', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.households', 'auth_user_id', 'INSERT')
     or not has_column_privilege('authenticated', 'public.households', 'email', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.user_roles', 'role', 'INSERT') then
    raise exception 'MIGRATION 059 VERIFICATION FAILED: households/user_roles column grants for authenticated are wrong';
  end if;
end
$$;
