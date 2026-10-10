-- 078_rollback_number_inventory.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Rolls back 078_number_inventory.sql.
-- Refuses while any inventory number is ASSIGNED: dropping the table would
-- lose which DDI belongs to which household (calls still route by
-- households.twilio_number, but release/cooling-off would be lost). Move
-- every assigned number through quarantine first, or record them manually.

do $$
begin
  if to_regclass('public.number_inventory') is not null
     and exists (select 1 from public.number_inventory where status = 'assigned') then
    raise exception '078 rollback refused: number_inventory still has assigned numbers';
  end if;
end $$;

drop function if exists public.release_inventory_number_after_quarantine(text, integer);
drop function if exists public.return_unassigned_inventory_number(text, uuid);
drop function if exists public.claim_inventory_number(uuid, text);
drop table if exists public.number_inventory;

