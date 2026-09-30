-- Close the "RLS Disabled in Public" / "Table publicly accessible"
-- Supabase Security Advisor finding on public.terms_acceptances.
--
-- STATUS: APPLIED to staging (tigwgmayeuisrxjjykqd) 2026-09-30T17:56:24Z
-- via `supabase db query --linked -f` and recorded with
-- `supabase migration repair --status applied 057`; verified live (anon
-- and authenticated denied all verbs, service_role RPC insert and
-- household cascade intact, Security Advisor no longer reports
-- rls_disabled_in_public). NOT applied to production
-- (psbzynxplxfbyrbdidmn). Number 057 is provisional (highest number on
-- any remote branch at drafting time was 056); renumber at merge time if
-- another migration claims it first.
--
-- Root cause: migration 039 created this table without
-- `enable row level security` and without any explicit revoke, relying on
-- the comment "No grants at all on the table itself to anon/authenticated".
-- That assumption is false on any Supabase project created with the newer
-- default ACL template — staging (created 2026-07-30) is one — where every
-- table postgres creates in public implicitly gets ALL privileges for anon
-- and authenticated (see docs/engineering/MIGRATION_RECOVERY_PLAN.md:160;
-- migration 022 fixed exactly this for functions, never for tables).
-- Without RLS, those grants are directly exercisable through PostgREST with
-- only the public anon key: select, insert, update, delete.
--
-- Production's older default ACL does not grant tables to anon (a live
-- anon probe on 2026-09-30 returned 42501 permission denied), so production
-- is not anon-exploitable today — but RLS is still disabled there, so this
-- migration is required on both projects for defence in depth.
--
-- Minimum safe policy: RLS on, NO anon/authenticated policies (deny all),
-- and privileges revoked from anon/authenticated. Nothing in the app reads
-- or writes this table as anon/authenticated: the only access path is
-- database/households.js recordTermsAcceptance() -> supabaseAdmin (service
-- role) -> record_terms_acceptance() SECURITY DEFINER (owned by postgres,
-- which bypasses RLS). This matches the deny-by-default posture of the other
-- server-only evidence tables (031, 032, 037).
--
-- FORCE ROW LEVEL SECURITY is deliberately NOT used: it would apply RLS to
-- the table owner and could break record_terms_acceptance().
--
-- Append-only evidence: service_role gets select + insert only, and any
-- update/delete/truncate it may have inherited from default privileges is
-- revoked. Household deletion still removes rows via the existing
-- ON DELETE CASCADE foreign key (referential actions don't need the
-- caller to hold DELETE on this table).

begin;

alter table public.terms_acceptances enable row level security;

revoke all on table public.terms_acceptances from public;
revoke all on table public.terms_acceptances from anon;
revoke all on table public.terms_acceptances from authenticated;

revoke update, delete, truncate, references, trigger
  on table public.terms_acceptances from service_role;
grant select, insert on table public.terms_acceptances to service_role;

commit;

-- Read-only verification — run after commit.
do $$
declare
  r text;
  p text;
begin
  if not (select relrowsecurity from pg_class
          where oid = 'public.terms_acceptances'::regclass) then
    raise exception 'MIGRATION 057 VERIFICATION FAILED: RLS not enabled on terms_acceptances';
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(r, 'public.terms_acceptances', p) then
        raise exception 'MIGRATION 057 VERIFICATION FAILED: % still has % on terms_acceptances', r, p;
      end if;
    end loop;
  end loop;

  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'terms_acceptances') then
    raise exception 'MIGRATION 057 VERIFICATION FAILED: unexpected policy on terms_acceptances';
  end if;
end
$$;
