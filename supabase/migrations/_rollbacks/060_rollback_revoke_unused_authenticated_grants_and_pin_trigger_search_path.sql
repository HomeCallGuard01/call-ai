-- Rollback for 060_revoke_unused_authenticated_grants_and_pin_trigger_search_path.sql.
-- Valid for BOTH projects: restores the explicit 008/011 authenticated grants
-- (identical on staging after 059 and on production) and the function's
-- unpinned search_path. The function's pre-060 ACL differed per project
-- (production: default NULL = PUBLIC execute; staging: explicit anon/
-- authenticated/service_role/PUBLIC); PUBLIC execute covers both.

begin;

grant select, insert, update, delete on table public.contacts to authenticated;
grant select on table public.subscriptions to authenticated;
grant select on table public.entitlements to authenticated;

alter function public.hcg_set_updated_at() reset search_path;
grant execute on function public.hcg_set_updated_at() to public;

commit;
