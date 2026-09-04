-- Business Dashboard V2 — explicit account classification
--
-- Purpose: the business dashboard's "Total Customers" and related KPIs
-- currently count every households row indiscriminately — admin, Apple
-- reviewer, QA sandbox, and internal test accounts included alongside
-- genuine customers, with no way to tell them apart. Confirmed this
-- session: neither households nor user_roles has any field for this
-- (user_roles only distinguishes admin/support/household), and
-- email-pattern inference is unsafe (a real internal test account can
-- use an address indistinguishable in shape from a genuine customer's —
-- confirmed directly this session with ad_74uk@yahoo.co.uk).
--
-- This is purely additive: one new table, no existing table altered.
-- Absence of a row is the safe default (UNCLASSIFIED) — the application
-- layer must never treat an unclassified household as a genuine
-- customer; nothing here makes that assumption automatically, so this
-- table can never silently inflate a customer count by itself.
--
-- Unlike households/user_roles (migration 002, deliberately minimal
-- service_role grants — see migration 009's own comment), this is a new
-- table with no customer-facing read/write path at all — it is admin-
-- dashboard-only metadata, so service_role is granted exactly what the
-- dashboard's own service-role client needs (select/insert/update),
-- decided at creation time rather than discovered missing later.

begin;

create table if not exists public.account_classifications (
  household_id uuid primary key
    references public.households(id)
    on delete cascade,

  classification text not null
    check (classification in ('genuine_customer', 'internal_test', 'admin', 'reviewer', 'qa_automation')),

  note text,
  classified_by text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists account_classifications_set_updated_at
  on public.account_classifications;

create trigger account_classifications_set_updated_at
  before update on public.account_classifications
  for each row
  execute function public.hcg_set_updated_at();

alter table public.account_classifications enable row level security;

-- No policy for `authenticated`/`anon` — this table is never read or
-- written by anything except the admin dashboard's own service-role
-- client (requireAuth + requireAdmin already gate every route that
-- reads it; see routes/adminBusiness.js). A household has no reason to
-- ever see its own classification row.

grant select, insert, update on public.account_classifications to service_role;

-- Seed the accounts whose purpose is already explicitly established by
-- development/testing records (2026-09) — resolved by email, safely a
-- no-op if a given household doesn't exist yet. Re-runnable: a second
-- application of this migration updates rather than duplicates.
-- Deliberately does NOT seed any ambiguous account (andrewbusinessai@,
-- gardenroombuild@, andrewdeane_uk@, andydeane+test2@, or the household
-- ad_74uk@yahoo.co.uk currently belongs to) — those stay UNCLASSIFIED
-- until a human explicitly decides, per this change's own brief.

insert into public.account_classifications (household_id, classification, note, classified_by)
select id, 'admin', 'Dedicated admin-only account, created 2026-09-04 — never a paying customer', 'migration 031 seed'
from public.households
where email = 'admin@homecallguard.co.uk'
on conflict (household_id) do update
  set classification = excluded.classification, note = excluded.note, updated_at = now();

insert into public.account_classifications (household_id, classification, note, classified_by)
select id, 'reviewer', 'Apple App Review account', 'migration 031 seed'
from public.households
where email = 'appreview@homecallguard.co.uk'
on conflict (household_id) do update
  set classification = excluded.classification, note = excluded.note, updated_at = now();

insert into public.account_classifications (household_id, classification, note, classified_by)
select id, 'reviewer', 'Apple/Play reviewer account', 'migration 031 seed'
from public.households
where email = 'review@homecallguard.co.uk'
on conflict (household_id) do update
  set classification = excluded.classification, note = excluded.note, updated_at = now();

insert into public.account_classifications (household_id, classification, note, classified_by)
select id, 'qa_automation', 'QA sandbox account (v1.5)', 'migration 031 seed'
from public.households
where email = 'qa-sandbox-v1.5@homecallguard.co.uk'
on conflict (household_id) do update
  set classification = excluded.classification, note = excluded.note, updated_at = now();

insert into public.account_classifications (household_id, classification, note, classified_by)
select id, 'internal_test', 'Andrew''s own reusable launch-test address', 'migration 031 seed'
from public.households
where email = 'ad_74uk@yahoo.co.uk'
on conflict (household_id) do update
  set classification = excluded.classification, note = excluded.note, updated_at = now();

commit;
