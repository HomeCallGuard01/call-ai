-- 072_rollback_operational_events.sql
--
-- STATUS: DRAFT — NOT APPLIED. Reverses 072_operational_events.sql.
-- Refuses (raises) if any operational event exists: the event history is an
-- audit record. Export ops_events / ops_event_deliveries first if needed.

begin;

do $$
begin
  if to_regclass('public.ops_events') is not null and exists (select 1 from public.ops_events) then
    raise exception 'rollback 072: % operational event(s) recorded — export ops_events/ops_event_deliveries first',
      (select count(*) from public.ops_events);
  end if;
end;
$$;

drop function if exists public.ops_mark_event_seen(uuid, text);
drop function if exists public.ops_complete_delivery(uuid, text, text, timestamptz);
drop function if exists public.ops_claim_due_deliveries(timestamptz, integer, integer);
drop function if exists public.ops_record_event(jsonb, jsonb);
drop table if exists public.ops_event_deliveries;
drop table if exists public.ops_events;
drop function if exists public.ops_event_deliveries_guard();

commit;
