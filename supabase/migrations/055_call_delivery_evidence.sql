-- Call-delivery evidence (2026-09-29) — P0 call-delivery resilience.
--
-- STATUS: DRAFT — NOT APPLIED to any database. Number 055 was chosen to
-- avoid every migration number in use on any remote branch at the time
-- of writing (047, 048–050 reserved, 051–054 used); renumber at
-- integration if the sequence has moved.
--
-- Why: household f06bc964's app failed 4/4 deliveries on 24–26 Sep 2026
-- and nothing in this database could say why. Two gaps:
--
-- 1. calls.dial_call_sid — the Twilio SID of the <Dial><Client> child
--    leg (Twilio's DialCallSid on the Dial action callback). Every piece
--    of evidence about the APP side of a call is keyed by this child SID,
--    not by the parent call_sid this table already stores:
--      * Twilio Monitor push-failure alerts (e.g. 52103) carry it as
--        primaryCorrelationId;
--      * the mobile app's CallInvite.getCallSid() is it, so
--        POST /api/v1/voice/call-invite-received has been matching zero
--        rows since migration 045 shipped (zero production rows have
--        client_invite_received_at, including calls that connected).
--
-- 2. calls.push_failure / push_failure_at — the provider's reason when
--    Twilio could not push the call to the device (e.g.
--    'fcm:NotRegistered'). Without it a dead device token is
--    indistinguishable from a customer not answering.
--
-- Additive, nullable, no backfill, no behaviour change on its own. The
-- application code that writes these fails open: if this migration has
-- not been applied, the new writes log an error and every existing
-- write (dial_call_status, duration_seconds, delivery_verified_at) is
-- unaffected because they are separate statements.
--
-- Access: service_role already has table-level UPDATE on public.calls
-- (migration 026) and SELECT/INSERT (migration 009); no new grants.

begin;

alter table public.calls
  add column if not exists dial_call_sid text,
  add column if not exists push_failure text,
  add column if not exists push_failure_at timestamptz;

create index if not exists calls_dial_call_sid
  on public.calls (dial_call_sid)
  where dial_call_sid is not null;

commit;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calls' and column_name = 'dial_call_sid'
  ) then
    raise exception 'MIGRATION 055 VERIFICATION FAILED: calls.dial_call_sid does not exist';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'calls' and column_name = 'push_failure'
  ) then
    raise exception 'MIGRATION 055 VERIFICATION FAILED: calls.push_failure does not exist';
  end if;
end $$;
