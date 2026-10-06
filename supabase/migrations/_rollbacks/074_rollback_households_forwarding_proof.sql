-- 074_rollback_households_forwarding_proof.sql
--
-- STATUS: DRAFT — NOT APPLIED. Reverses 074_households_forwarding_proof.sql.
-- Refuses while any forwarding proof is recorded (that is customer protection
-- evidence). The application treats the absent column as "not proven", so a
-- schema rollback can never make anyone appear Protected.

begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'households' and column_name = 'forwarding_proven_at'
  ) and exists (select 1 from public.households where forwarding_proven_at is not null) then
    raise exception 'rollback 074: % household(s) carry recorded forwarding proof — export first',
      (select count(*) from public.households where forwarding_proven_at is not null);
  end if;
end;
$$;

alter table public.households drop constraint if exists households_forwarding_proof_method_check;
alter table public.households
  drop column if exists forwarding_proof_method,
  drop column if exists forwarding_proven_at;

comment on column public.households.activation_verified_at is null;

commit;
