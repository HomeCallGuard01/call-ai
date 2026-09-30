-- Call-delivery event timeline (2026-09-30) — release readiness P3.
--
-- STATUS: DRAFT — NOT APPLIED to any database. Number 058 avoids every
-- migration number in use on any remote branch at the time of writing
-- (047, 051–057 incl. two different 055s); renumber at integration if
-- the sequence has moved. Depends on nothing newer than 046.
--
-- Why: when a customer says "the phone didn't ring", the evidence is
-- spread across calls columns, Twilio Monitor alerts, the app's own
-- reports and log lines, and the stage at which delivery stopped cannot
-- be read off in one place. This table records one content-free row per
-- stage (services/callDeliveryEvents.js has the event list and the
-- per-event detail allow-list):
--   server: inbound_received, household_identified/_not_found,
--           caller_classified, routing_decision, push_requested,
--           dial_outcome, delivered, delivery_failed, fallback_triggered
--   poller: push_failed
--   app:    app_invite_received, app_ringing, app_presentation_blocked,
--           app_answered, app_declined, app_invite_cancelled,
--           app_media_connected, device_readiness
--
-- Privacy: `detail` holds only allow-listed enums/booleans/small numbers
-- (never caller numbers, names or transcript text); enforced in the
-- application and bounded here by size. No caller number column exists.
--
-- Write path is gated by CALL_DELIVERY_EVENTS_DB=on in the application, so
-- deploying the code before this migration changes nothing. Append-only:
-- the application never updates or deletes rows. Rows cascade with the
-- household (account deletion / anonymisation removes them).
--
-- Retention: 90 days is proposed; not enforced here (needs a decision).

begin;

create table if not exists public.call_delivery_events (
  id bigint generated always as identity primary key,
  household_id uuid references public.households(id) on delete cascade,
  call_sid text check (call_sid is null or call_sid ~ '^CA[0-9a-f]{32}$'),
  client_call_sid text check (client_call_sid is null or client_call_sid ~ '^CA[0-9a-f]{32}$'),
  event text not null check (event in (
    'inbound_received', 'household_identified', 'household_not_found',
    'caller_classified', 'routing_decision', 'push_requested', 'push_failed',
    'app_invite_received', 'app_ringing', 'app_presentation_blocked',
    'app_answered', 'app_declined', 'app_invite_cancelled', 'app_media_connected',
    'dial_outcome', 'delivered', 'delivery_failed', 'fallback_triggered',
    'device_readiness'
  )),
  source text not null check (source in ('server', 'app', 'poller')),
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 2000)
);

create index if not exists call_delivery_events_household_recent
  on public.call_delivery_events (household_id, occurred_at desc);
create index if not exists call_delivery_events_call_sid
  on public.call_delivery_events (call_sid) where call_sid is not null;
create index if not exists call_delivery_events_client_call_sid
  on public.call_delivery_events (client_call_sid) where client_call_sid is not null;

alter table public.call_delivery_events enable row level security;
-- No anon/authenticated policies: service_role only (server-side writes,
-- admin reads). Customers never read this table directly.
grant select, insert on public.call_delivery_events to service_role;

commit;

do $$
begin
  if to_regclass('public.call_delivery_events') is null then
    raise exception 'MIGRATION 058 VERIFICATION FAILED: public.call_delivery_events does not exist';
  end if;
end $$;
