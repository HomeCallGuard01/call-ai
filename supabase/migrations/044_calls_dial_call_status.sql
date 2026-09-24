-- Adds calls.dial_call_status: Twilio's own, real DialCallStatus value
-- ("completed"/"no-answer"/"failed"/"busy"/"canceled") for the approved-
-- call delivery attempt this row represents.
--
-- STATUS: DRAFT — NOT APPLIED.
--
-- Diagnostic gap found 2026-09-24 tracing a real production household's
-- failed call: server.js's /call-delivery-failed action callback
-- (dialHouseholdOrFailClosed's <Dial> action) already receives Twilio's
-- authoritative DialCallStatus in req.body.DialCallStatus — it was used
-- transiently for a console.error and a one-off email alert
-- (services/alerting.js), then discarded. duration_seconds alone (0 for
-- any non-"completed" outcome) cannot distinguish "rang, unanswered"
-- from "Twilio couldn't even reach the Client" from "busy" from
-- "canceled" — all four collapse to the identical database signature
-- today, making a genuine production failure impossible to diagnose
-- without live server logs or an out-of-band alert email. This column
-- makes that distinction queryable after the fact, same as
-- duration_seconds already is.
--
-- Deliberately just a raw text column, not an enum: Twilio's own set of
-- DialCallStatus values is stable but not contractually exhaustive from
-- this app's side, and a raw value is more useful for diagnosis than a
-- constrained one that could silently reject something new. Written
-- alongside duration_seconds in the exact same
-- recordApprovedCallDeliveryOutcome call site server.js already has —
-- no new write path, no new privilege boundary (service_role already has
-- UPDATE on calls for this exact row).

begin;

alter table public.calls
  add column if not exists dial_call_status text;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calls'
      and column_name = 'dial_call_status' and data_type = 'text'
  ) then
    raise exception 'MIGRATION 044 VERIFICATION FAILED: calls.dial_call_status missing or wrong type';
  end if;
end
$$;
