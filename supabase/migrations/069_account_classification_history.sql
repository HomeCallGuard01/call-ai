-- 069_account_classification_history.sql (drafted as 055; NUMBERED 069 at
-- integration/launch-fortress-2026-10-03 — delivery evidence keeps 055)
--
-- STATUS: DRAFT — NOT APPLIED (2026-09-29, branch
-- feature/admin-control-centre-v2). Tested only against the in-memory
-- PGlite replay (tests/migrations.pglite.test.mjs). Do NOT apply to
-- production or staging without Andrew's explicit approval.
--
-- Purpose: let an admin classify an account (genuine customer / internal
-- test / reviewer / other non-customer) from the dashboard, with a full,
-- append-only audit trail: previous value, new value, who, when, why.
--
-- What it touches: ONLY public.account_classifications (migration 031)
-- and the new public.account_classification_events. It never reads or
-- writes entitlements, subscriptions, households, calls, numbers or any
-- telephony state: classification is a reporting label. (Known reader to
-- be aware of: the unmerged lifecycle sweep, #49, sends a pre-expiry SMS
-- to test/reviewer accounts — reclassifying an account as a test account
-- can therefore make it eligible for that warning once #49 ships.)
--
-- Design:
--   1. 'other_non_customer' joins the allowed values (the existing five
--      stay valid; nothing is migrated away).
--   2. account_classification_events is append-only: an UPDATE or DELETE
--      raises, for every role. There is deliberately NO foreign key to
--      households, so the audit record survives an account deletion.
--   3. set_account_classification() is the one write path: it locks the
--      household's row, refuses a stale edit (p_expected_previous must
--      equal the current value — two admins cannot silently overwrite each
--      other), refuses a no-op and an empty reason, then writes the
--      classification and its event in the same transaction.
--   4. Existing classifications get one 'baseline' event each, so every
--      current value has a starting point in the history.
--
-- Rollback: supabase/migrations/_rollbacks/069_rollback_account_classification_history.sql
-- (drops the function, trigger and events table and restores 031's check;
-- refuses if any row already uses 'other_non_customer').

begin;

-- 1. allowed values
alter table public.account_classifications
  drop constraint if exists account_classifications_classification_check;
alter table public.account_classifications
  add constraint account_classifications_classification_check
  check (classification in ('genuine_customer', 'internal_test', 'admin', 'reviewer', 'qa_automation', 'other_non_customer'));

-- 2. append-only history
create table if not exists public.account_classification_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  previous_classification text,
  new_classification text not null
    check (new_classification in ('genuine_customer', 'internal_test', 'admin', 'reviewer', 'qa_automation', 'other_non_customer')),
  note text not null check (length(btrim(note)) >= 3),
  changed_by_user_id uuid,
  changed_by_email text,
  source text not null default 'admin_dashboard'
    check (source in ('admin_dashboard', 'baseline')),
  created_at timestamptz not null default now()
);

create index if not exists account_classification_events_household_idx
  on public.account_classification_events (household_id, created_at desc);

create or replace function public.account_classification_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'account_classification_events is append-only (% refused)', tg_op;
end;
$$;

drop trigger if exists account_classification_events_no_update on public.account_classification_events;
create trigger account_classification_events_no_update
  before update or delete on public.account_classification_events
  for each row execute function public.account_classification_events_append_only();

alter table public.account_classification_events enable row level security;
revoke all on public.account_classification_events from public, anon, authenticated;
grant select on public.account_classification_events to service_role;

-- 3. the one write path
create or replace function public.set_account_classification(
  p_household_id uuid,
  p_classification text,
  p_note text,
  p_actor_user_id uuid,
  p_actor_email text,
  p_expected_previous text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
begin
  if p_classification not in ('genuine_customer', 'internal_test', 'reviewer', 'other_non_customer', 'admin', 'qa_automation') then
    raise exception 'set_account_classification: unknown classification %', p_classification;
  end if;
  if p_note is null or length(btrim(p_note)) < 3 then
    raise exception 'set_account_classification: a reason (at least 3 characters) is required';
  end if;
  if not exists (select 1 from public.households h where h.id = p_household_id) then
    raise exception 'set_account_classification: household % does not exist', p_household_id;
  end if;

  -- Serialise concurrent edits of the same household.
  perform 1 from public.households h where h.id = p_household_id for update;

  select c.classification into v_current
    from public.account_classifications c
   where c.household_id = p_household_id;

  -- 'unclassified' is how the dashboard names "no row".
  if coalesce(v_current, 'unclassified') is distinct from coalesce(p_expected_previous, 'unclassified') then
    raise exception 'set_account_classification: stale edit — current classification is %, expected %',
      coalesce(v_current, 'unclassified'), coalesce(p_expected_previous, 'unclassified');
  end if;
  if v_current is not distinct from p_classification then
    raise exception 'set_account_classification: already %', p_classification;
  end if;

  insert into public.account_classifications (household_id, classification, note, classified_by)
  values (p_household_id, p_classification, btrim(p_note), coalesce(p_actor_email, p_actor_user_id::text, 'admin'))
  on conflict (household_id) do update
    set classification = excluded.classification,
        note = excluded.note,
        classified_by = excluded.classified_by,
        updated_at = now();

  insert into public.account_classification_events
    (household_id, previous_classification, new_classification, note, changed_by_user_id, changed_by_email, source)
  values
    (p_household_id, v_current, p_classification, btrim(p_note), p_actor_user_id, p_actor_email, 'admin_dashboard');

  return jsonb_build_object('previous', coalesce(v_current, 'unclassified'), 'classification', p_classification);
end;
$$;

revoke all on function public.set_account_classification(uuid, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_account_classification(uuid, text, text, uuid, text, text) to service_role;

-- 4. baseline history for existing classifications
insert into public.account_classification_events
  (household_id, previous_classification, new_classification, note, changed_by_email, source, created_at)
select c.household_id, null, c.classification,
       case when length(btrim(coalesce(c.note, ''))) >= 3 then btrim(c.note) else 'classified before history was recorded' end,
       c.classified_by, 'baseline', c.updated_at
  from public.account_classifications c
 where not exists (
   select 1 from public.account_classification_events e where e.household_id = c.household_id
 );

commit;
