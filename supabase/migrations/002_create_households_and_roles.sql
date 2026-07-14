-- Sprint 7: Household Identity — households + roles
--
-- Run this in the Supabase SQL Editor:
-- Project > SQL Editor > New query
--
-- Run this migration BEFORE 003 / 004 / 005.
--
-- Purely additive:
-- - creates households table
-- - creates user_roles table
-- - creates one updated_at trigger function
--
-- Nothing existing is altered or dropped.

-- ------------------------------------------------------------
-- Shared trigger function for updated_at columns
-- ------------------------------------------------------------

create or replace function public.hcg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- Households
-- ------------------------------------------------------------

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),

  -- A household may temporarily exist without a login.
  -- If an auth user is deleted, preserve the household record
  -- and its future contacts, calls, subscriptions and entitlements.
  auth_user_id uuid unique
    references auth.users(id)
    on delete set null,

  email text not null unique,

  phone_number text,
  twilio_number text,

  status text not null default 'active'
    check (status in ('active', 'suspended', 'cancelled')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists households_set_updated_at
  on public.households;

create trigger households_set_updated_at
  before update on public.households
  for each row
  execute function public.hcg_set_updated_at();

alter table public.households enable row level security;

-- A logged-in user may read only their own household record.
-- Household creation and modification remain server-side only.
drop policy if exists households_select_own
  on public.households;

create policy households_select_own
  on public.households
  for select
  to authenticated
  using (auth_user_id = auth.uid());

-- ------------------------------------------------------------
-- User roles
-- ------------------------------------------------------------

-- Supported roles:
-- - admin
-- - support
-- - household
--
-- Ordinary customers receive the household role during registration.
-- Admin and support roles must be assigned manually or through
-- controlled server-side administration.

create table if not exists public.user_roles (
  auth_user_id uuid primary key
    references auth.users(id)
    on delete cascade,

  role text not null default 'household'
    check (role in ('admin', 'support', 'household')),

  created_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

-- A logged-in user may read only their own role.
-- No authenticated insert or update policy is created.
drop policy if exists user_roles_select_own
  on public.user_roles;

create policy user_roles_select_own
  on public.user_roles
  for select
  to authenticated
  using (auth_user_id = auth.uid());
  