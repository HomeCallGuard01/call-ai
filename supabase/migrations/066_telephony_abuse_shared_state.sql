-- 066 — Telephony abuse P0 shared state (2026-10-03)
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. NUMBERED 066 at integration
-- (integration/launch-fortress-2026-10-03; was the unnumbered
-- docs/security/provisional-migrations/PROVISIONAL_telephony_abuse_controls.sql).
-- Rollback: _rollbacks/066_rollback_telephony_abuse_shared_state.sql.
--
-- Original provisional note follows.
--
-- STATUS: DRAFT. NOT APPLIED ANYWHERE (not local, not staging, not
-- production). Deliberately kept OUT of supabase/migrations/ and UNNUMBERED:
-- 055, 058, 060 and 061 are each claimed twice across branches today and the
-- highest number in use was 061; 062 (customer identity) and 063 (customer
-- allowance) were claimed by other branches on 2026-10-03. Give this file the
-- next free number (>= 064, re-check) only at integration time, after the 055/060/061 collisions are
-- resolved, and only with Andrew's approval.
--
-- WHY: the abuse layer (services/abuse/*) works today with process-local
-- state. That is PARTIAL protection: a restart clears velocity counters and
-- cooldowns, a second instance halves their effect, and number-purchase
-- single-flight cannot span instances. This schema backs the existing ports:
--   abuse_decisions             ← createAbuseAudit({ writer })          (audit trail)
--   abuse_hit / abuse cooldowns ← velocity store interface              (shared velocity)
--   abuse_incident_state        ← createIncidentMode({ persistentFlag }) (shared breaker flag)
--   abuse_household_holds       ← createHoldStore                        (account status)
--   claim_number_provisioning   ← provisioningGuard claimProvisioning    (cross-instance purchase lock)
--
-- It does NOT duplicate Claude 1's financial ledger / reservations (056 and
-- successors). No £ amounts are stored here.
--
-- Data minimisation: no full phone numbers. Caller identity is the keyed
-- hash produced by abuseAudit (ABUSE_AUDIT_HASH_SECRET).

begin;

-- 1. Decision audit trail ---------------------------------------------------
create table if not exists public.abuse_decisions (
  id bigserial primary key,
  at timestamptz not null default now(),
  reason_code text not null check (length(reason_code) <= 120),
  action text not null check (action in ('reject', 'hold', 'degrade', 'allow_flagged', 'suppress')),
  kind text not null check (kind in ('inbound_call', 'sms', 'monitoring', 'number_purchase', 'number_release', 'webhook', 'number_write', 'incident', 'provision_number')),
  provider text not null default 'twilio',
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  household_id uuid references public.households(id) on delete set null,
  correlation_id text not null,
  facts jsonb not null default '{}'::jsonb
);
create index if not exists abuse_decisions_at_idx on public.abuse_decisions (at desc);
create index if not exists abuse_decisions_household_idx on public.abuse_decisions (household_id, at desc);
create index if not exists abuse_decisions_reason_idx on public.abuse_decisions (reason_code, at desc);
alter table public.abuse_decisions enable row level security; -- no policies: service role only

-- 2. Shared velocity --------------------------------------------------------
-- Fixed-window counters (window_start bucketed); abuse_hit returns the count
-- in the current window including this hit. Atomic under concurrency.
create table if not exists public.abuse_counters (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);
alter table public.abuse_counters enable row level security;

create or replace function public.abuse_hit(p_key text, p_window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_window_seconds is null or p_window_seconds <= 0 or p_key is null or length(p_key) > 200 then
    raise exception 'abuse_hit: invalid arguments';
  end if;
  -- Integration 2026-10-03: computed AFTER validation (it was in DECLARE,
  -- so a zero window raised division_by_zero before the check ran).
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.abuse_counters as c (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = c.count + 1
  returning c.count into v_count;
  return v_count;
end;
$$;

create table if not exists public.abuse_cooldowns (
  key text primary key check (length(key) <= 200),
  until timestamptz not null,
  reason text not null
);
alter table public.abuse_cooldowns enable row level security;

-- 3. Shared incident flag (singleton row) ------------------------------------
-- Automation never writes full_stop here (enforced in code AND by the check
-- below: only a named human may set it).
create table if not exists public.abuse_incident_state (
  id boolean primary key default true check (id),
  level text not null default 'normal' check (level in ('normal', 'contain', 'suspend_paid', 'full_stop')),
  reason text,
  set_by text not null default 'system',
  set_at timestamptz not null default now(),
  constraint full_stop_is_human check (level <> 'full_stop' or set_by <> 'system')
);
insert into public.abuse_incident_state (id) values (true) on conflict (id) do nothing;
alter table public.abuse_incident_state enable row level security;

-- 4. Account holds -------------------------------------------------------------
-- Set by operators or the provisioning risk layer ONLY — never by inbound
-- call patterns (that would let an attacker disable a victim's protection).
create table if not exists public.abuse_household_holds (
  household_id uuid primary key references public.households(id) on delete cascade,
  reason text not null,
  held_at timestamptz not null default now(),
  held_by text not null,
  released_at timestamptz
);
alter table public.abuse_household_holds enable row level security;

-- 5. Cross-instance number-purchase claim ------------------------------------
create table if not exists public.number_provisioning_claims (
  household_id uuid primary key references public.households(id) on delete cascade,
  claimed_until timestamptz not null,
  claimed_at timestamptz not null default now()
);
alter table public.number_provisioning_claims enable row level security;

create or replace function public.claim_number_provisioning(p_household_id uuid, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'claim_number_provisioning: invalid ttl';
  end if;
  insert into public.number_provisioning_claims as c (household_id, claimed_until)
  values (p_household_id, now() + make_interval(secs => p_ttl_seconds))
  on conflict (household_id) do update
    set claimed_until = excluded.claimed_until, claimed_at = now()
    where c.claimed_until < now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- Least privilege (same posture as the 057–061 Supabase hardening): nothing
-- here is reachable through the Data API with anon/authenticated keys.
revoke all on public.abuse_decisions, public.abuse_counters, public.abuse_cooldowns,
  public.abuse_incident_state, public.abuse_household_holds, public.number_provisioning_claims
  from anon, authenticated;
revoke all on sequence public.abuse_decisions_id_seq from anon, authenticated;
revoke execute on function public.abuse_hit(text, integer) from public, anon, authenticated;
revoke execute on function public.claim_number_provisioning(uuid, integer) from public, anon, authenticated;
-- Integration 2026-10-03: the server (service_role) is the only caller; the
-- repo-wide grants check requires the explicit grant and an empty search_path.
grant execute on function public.abuse_hit(text, integer) to service_role;
grant execute on function public.claim_number_provisioning(uuid, integer) to service_role;

commit;

-- ROLLBACK (provisional):
-- begin;
-- drop function if exists public.claim_number_provisioning(uuid, integer);
-- drop function if exists public.abuse_hit(text, integer);
-- drop table if exists public.number_provisioning_claims, public.abuse_household_holds,
--   public.abuse_incident_state, public.abuse_cooldowns, public.abuse_counters, public.abuse_decisions;
-- commit;
