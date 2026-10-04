-- 072_operational_events.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (soft-launch integration 2026-10-04).
--
-- Operational events and their notification deliveries (Andrew, 2026-10-04:
-- "inform me of every genuine new customer"). services/opsEvents/.
--
--   ops_events            one row per business event, EXACTLY ONCE per
--                         event_key (unique). The payload carries no email,
--                         telephone number or payment identifier.
--   ops_event_deliveries  one row per (event, channel, recipient role).
--                         Retries update THIS row; they never create a second
--                         event. Status 'disabled' records a delivery that
--                         was not attempted because the channel is off.
--
-- Notification failure can never affect entitlement or protection: nothing
-- here is read by any entitlement, call or provisioning path.

begin;

create table if not exists public.ops_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  event_type text not null check (event_type in ('new_genuine_customer', 'customer_protected', 'customer_needs_attention')),
  household_id uuid references public.households(id) on delete set null,
  account_number text check (account_number is null or account_number ~ '^HCG-[0-9]{8,}$'),
  severity text not null default 'info' check (severity in ('info', 'action', 'critical')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  seen_at timestamptz,
  seen_by text,
  constraint ops_events_key_unique unique (event_key),
  constraint ops_events_payload_no_contact check (
    not (payload ?| array['email', 'phone', 'phone_number', 'twilio_number', 'stripe_customer_id', 'external_reference', 'payment_id']))
);
create index if not exists ops_events_unseen_idx on public.ops_events (created_at) where seen_at is null;
create index if not exists ops_events_household_idx on public.ops_events (household_id, created_at);

create table if not exists public.ops_event_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.ops_events(id) on delete restrict,
  channel text not null check (channel in ('dashboard', 'email', 'push')),
  recipient_role text not null check (recipient_role ~ '^[a-z][a-z_]{1,40}$'),
  status text not null default 'pending' check (status in ('pending', 'in_flight', 'retry', 'sent', 'failed', 'disabled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint ops_event_deliveries_unique unique (event_id, channel, recipient_role),
  constraint ops_event_deliveries_sent_has_time check (status <> 'sent' or sent_at is not null)
);
create index if not exists ops_event_deliveries_due_idx on public.ops_event_deliveries (status, next_attempt_at);

-- A sent delivery is terminal; identity is immutable.
create or replace function public.ops_event_deliveries_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then raise exception 'delivery % already sent', old.id; end if;
  if new.event_id is distinct from old.event_id or new.channel is distinct from old.channel or new.recipient_role is distinct from old.recipient_role then
    raise exception 'delivery identity is immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists ops_event_deliveries_guard on public.ops_event_deliveries;
create trigger ops_event_deliveries_guard before update on public.ops_event_deliveries
  for each row execute function public.ops_event_deliveries_guard();

-- Record an event exactly once (idempotent on event_key) with its deliveries.
create or replace function public.ops_record_event(p_event jsonb, p_deliveries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.ops_events; v_inserted boolean := true; d jsonb;
begin
  insert into public.ops_events (event_key, event_type, household_id, account_number, severity, payload, occurred_at)
  values (p_event->>'event_key', p_event->>'event_type', (p_event->>'household_id')::uuid, p_event->>'account_number',
          coalesce(p_event->>'severity', 'info'), coalesce(p_event->'payload', '{}'::jsonb), (p_event->>'occurred_at')::timestamptz)
  on conflict (event_key) do nothing returning * into v;
  if not found then
    v_inserted := false;
    select * into v from public.ops_events where event_key = p_event->>'event_key';
    return jsonb_build_object('inserted', false, 'event', to_jsonb(v));
  end if;
  for d in select * from jsonb_array_elements(coalesce(p_deliveries, '[]'::jsonb)) loop
    insert into public.ops_event_deliveries (event_id, channel, recipient_role, status)
    values (v.id, d->>'channel', d->>'recipient_role', coalesce(d->>'status', 'pending'))
    on conflict (event_id, channel, recipient_role) do nothing;
  end loop;
  return jsonb_build_object('inserted', v_inserted, 'event', to_jsonb(v));
end;
$$;

-- Claim due deliveries with a lease (FOR UPDATE SKIP LOCKED: concurrent
-- workers never claim the same row).
create or replace function public.ops_claim_due_deliveries(p_now timestamptz, p_limit integer, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with due as (
    select d.id from public.ops_event_deliveries d
     where d.channel <> 'dashboard'
       and ((d.status in ('pending', 'retry') and d.next_attempt_at <= p_now)
            or (d.status = 'in_flight' and d.lease_until is not null and d.lease_until <= p_now))
     order by d.next_attempt_at, d.created_at
     limit greatest(1, least(coalesce(p_limit, 10), 100))
     for update skip locked
  ), upd as (
    update public.ops_event_deliveries d
       set status = 'in_flight', attempts = d.attempts + 1,
           lease_until = p_now + make_interval(secs => greatest(30, coalesce(p_lease_seconds, 120)))
      from due where d.id = due.id
    returning d.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('delivery', to_jsonb(upd), 'event', to_jsonb(e))), '[]'::jsonb) into v
    from upd join public.ops_events e on e.id = upd.event_id;
  return v;
end;
$$;

create or replace function public.ops_complete_delivery(p_id uuid, p_status text, p_error text, p_next_attempt_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.ops_event_deliveries;
begin
  if p_status not in ('sent', 'retry', 'failed', 'disabled') then raise exception 'ops_complete_delivery: invalid status'; end if;
  update public.ops_event_deliveries
     set status = p_status, last_error = left(p_error, 500), lease_until = null,
         sent_at = case when p_status = 'sent' then clock_timestamp() else sent_at end,
         next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at)
   where id = p_id returning * into v;
  return to_jsonb(v);
end;
$$;

create or replace function public.ops_mark_event_seen(p_event_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.ops_events;
begin
  if coalesce(length(trim(p_actor)), 0) < 2 then raise exception 'ops_mark_event_seen: actor required'; end if;
  update public.ops_events set seen_at = coalesce(seen_at, clock_timestamp()), seen_by = coalesce(seen_by, p_actor)
   where id = p_event_id returning * into v;
  return to_jsonb(v);
end;
$$;

alter table public.ops_events enable row level security;
alter table public.ops_event_deliveries enable row level security;
revoke all on public.ops_events, public.ops_event_deliveries from public, anon, authenticated;
grant select on public.ops_events, public.ops_event_deliveries to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'ops_record_event(jsonb, jsonb)', 'ops_claim_due_deliveries(timestamptz, integer, integer)',
    'ops_complete_delivery(uuid, text, text, timestamptz)', 'ops_mark_event_seen(uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.ops_event_deliveries_guard() from public, anon, authenticated, service_role;

commit;
