-- Remove authenticated Data API grants that no code path uses, and pin the
-- search_path of the shared updated_at trigger function.
--
-- STATUS: APPLIED to staging (tigwgmayeuisrxjjykqd) 2026-09-30 (060 20:09:31Z, 061 20:09:33Z)
-- via `supabase db query --linked -f` + `migration repair`; verified live. NOT applied to
-- production (psbzynxplxfbyrbdidmn).
--
-- 1. contacts / subscriptions / entitlements (authenticated grants from
--    008 and 011). Every read/write of these tables in the application goes
--    through supabaseAdmin (database/contacts.js, database/billing.js); the
--    web pages and mobile app only call Supabase Auth. Traced 2026-09-30:
--    no branch uses a user-scoped client on these tables. The grants were
--    RLS-scoped to the caller's own household, so they never leaked another
--    household's rows — but they let a signed-in user write their own
--    trusted contacts straight through the Data API, skipping the backend's
--    validation (10-digit UK number, duplicate check, MAX_SYNC_CONTACTS
--    cap). A malformed or unbounded contacts list changes how that
--    household's calls are screened. RLS policies are left in place (inert
--    without a grant, and harmless if a grant is ever re-added deliberately).
--
-- 2. public.hcg_set_updated_at() — Security Advisor WARN
--    function_search_path_mutable on both projects. Body only calls now()
--    (pg_catalog, always searched), so search_path = '' is behaviour-
--    neutral. EXECUTE is revoked from PUBLIC/anon/authenticated: trigger
--    functions are permission-checked only at CREATE TRIGGER time, never
--    when the trigger fires, so every existing updated_at trigger keeps
--    working.
--
-- Rollback: supabase/migrations/_rollbacks/060_rollback_*.sql.

begin;

revoke all on table public.contacts from authenticated;
revoke all on table public.subscriptions from authenticated;
revoke all on table public.entitlements from authenticated;

alter function public.hcg_set_updated_at() set search_path = '';
revoke all on function public.hcg_set_updated_at() from public, anon, authenticated;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if has_table_privilege('authenticated', 'public.contacts', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.subscriptions', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.entitlements', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'MIGRATION 060 VERIFICATION FAILED: authenticated still has a grant on contacts/subscriptions/entitlements';
  end if;

  if not has_table_privilege('authenticated', 'public.households', 'SELECT')
     or not has_table_privilege('authenticated', 'public.user_roles', 'SELECT') then
    raise exception 'MIGRATION 060 VERIFICATION FAILED: household bootstrap grants were removed';
  end if;

  if not exists (
    select 1 from pg_proc
    where oid = 'public.hcg_set_updated_at()'::regprocedure
      and proconfig @> array['search_path=""']
  ) then
    raise exception 'MIGRATION 060 VERIFICATION FAILED: hcg_set_updated_at search_path not pinned';
  end if;

  if has_function_privilege('anon', 'public.hcg_set_updated_at()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hcg_set_updated_at()', 'EXECUTE') then
    raise exception 'MIGRATION 060 VERIFICATION FAILED: anon/authenticated can still execute hcg_set_updated_at';
  end if;
end
$$;
