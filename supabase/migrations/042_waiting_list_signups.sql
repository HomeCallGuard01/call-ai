-- Waiting-list capture — one reusable mechanism for every "not available
-- to you yet" reason a prospective customer can hit before ever becoming
-- a household: today, iPhone (IOS_COMING_SOON) and an unsupported/
-- unverified mobile carrier. Deliberately NOT tied to public.households
-- or auth.users — a waiting-list signup is, by definition, someone who
-- is not (yet) a customer and may never have an authenticated session at
-- all, so this table and its capture route must work fully
-- unauthenticated, matching the existing unauthenticated /register
-- route's own trust model (service_role-mediated insert, customer never
-- touches Supabase directly).
--
-- STATUS: NOT YET APPLIED to any database. Prepared alongside the
-- Android/landline launch work (2026-09-19) — see
-- docs/launch/IOS_COMING_SOON_LAUNCH_FLAG.md.
--
-- Captures only what's genuinely needed to follow up and to understand
-- demand by reason: email, a reason code, and two optional context
-- fields (which provider, which device type) populated only when
-- relevant to that reason. No name, no phone number, no address —
-- nothing beyond what a "let us know when this is ready" signup
-- genuinely requires.

begin;

create table if not exists public.waiting_list_signups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text not null,
  -- 'ios_coming_soon' | 'unsupported_carrier' — an open text column
  -- rather than an enum, matching this codebase's established
  -- carrier_provider_key precedent (services/providerPolicy.js's own
  -- header explains why: the reason set is expected to grow, and
  -- validating membership belongs in application code, not a SQL
  -- constraint that would need updating in lockstep with it).
  reason text not null,
  -- Populated only for reason = 'unsupported_carrier' (the exact
  -- PROVIDER_POLICY key, e.g. 'tesco') — null for every other reason.
  provider_key text,
  -- Whatever device_type context is known at signup time ('iphone',
  -- 'mobile', 'landline') — optional, purely informational, never used
  -- for any eligibility decision.
  device_type text
);

alter table public.waiting_list_signups enable row level security;

-- No policy grants anon or authenticated any access at all — every read
-- and write happens through the backend's service-role client, exactly
-- like every other unauthenticated-capture table in this project
-- (see e.g. registration_requests). RLS is enabled with zero permissive
-- policies as the fail-closed default, not because a policy will ever
-- be added for anon/authenticated.
revoke all on public.waiting_list_signups from anon, authenticated;
grant select, insert on public.waiting_list_signups to service_role;

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'waiting_list_signups'
  ) then
    raise exception 'MIGRATION 042 VERIFICATION FAILED: public.waiting_list_signups does not exist';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'waiting_list_signups'
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'MIGRATION 042 VERIFICATION FAILED: anon/authenticated has a grant on waiting_list_signups';
  end if;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'waiting_list_signups'
      and grantee = 'service_role' and privilege_type = 'INSERT'
  ) then
    raise exception 'MIGRATION 042 VERIFICATION FAILED: service_role cannot insert into waiting_list_signups';
  end if;
end
$$;
