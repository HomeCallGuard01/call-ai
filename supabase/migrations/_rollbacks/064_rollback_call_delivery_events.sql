-- Rollback for 064_call_delivery_events.sql (drafted as 060). Drops only the telemetry
-- table. Set CALL_DELIVERY_EVENTS_DB=off (or unset) first; the writes fail
-- open, so running this first only produces one logged write error.

begin;

drop table if exists public.call_delivery_events;

commit;
