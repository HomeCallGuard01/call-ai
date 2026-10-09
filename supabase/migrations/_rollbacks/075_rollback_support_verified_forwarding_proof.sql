-- 075_rollback_support_verified_forwarding_proof.sql
--
-- STATUS: DRAFT — NOT APPLIED. Reverses 075_support_verified_forwarding_proof.sql.
-- Refuses while any household carries a 'support_verified' proof or any audit
-- row exists (both are customer-protection evidence — export first). With
-- 075 gone the application cannot record support proof (the RPC is absent ⇒
-- the admin route reports failure); nobody becomes Protected by a rollback.

begin;

do $$
begin
  if exists (select 1 from public.households where forwarding_proof_method = 'support_verified') then
    raise exception 'rollback 075: % household(s) carry support-verified proof — clear and export first',
      (select count(*) from public.households where forwarding_proof_method = 'support_verified');
  end if;
  if to_regclass('public.forwarding_proof_audit') is not null
     and exists (select 1 from public.forwarding_proof_audit) then
    raise exception 'rollback 075: forwarding_proof_audit has rows — export first';
  end if;
end;
$$;

drop function if exists public.hcg_record_support_forwarding_proof(uuid, text, text, text[], text, text, integer, timestamptz);
drop function if exists public.hcg_clear_forwarding_proof(uuid, text, text);
drop function if exists public.hcg_phone_key(text);
drop table if exists public.forwarding_proof_audit;
drop function if exists public.forwarding_proof_audit_block();

alter table public.households drop constraint if exists households_forwarding_proof_method_check;
alter table public.households
  add constraint households_forwarding_proof_method_check
  check (forwarding_proof_method is null or forwarding_proof_method in ('verification_call'));

commit;
