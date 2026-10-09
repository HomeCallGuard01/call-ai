-- 075_support_verified_forwarding_proof.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (launch blocker B3, 2026-10-09).
-- Numbering: 075 verified free in the candidate tree before creation
-- (supabase/migrations ends at 074). Re-run scripts/check-migration-numbering.js.
--
-- LF-2 (074) made forwarding_proven_at the ONLY input to the protection gate
-- and, deliberately, nothing in the application wrote it. Result: no customer
-- could ever be shown Protected. Andrew (2026-10-09) approved a support-led
-- proof for the controlled cohort, requiring:
--   1. evidence of a successful forwarded call,
--   2. an authorised admin action,
--   3. an audit record.
--
-- Procedure (docs/launch/2026-10-09-SUPPORT-VERIFIED-PROTECTION.md): with the
-- customer's forwarding switched on, support calls the CUSTOMER'S OWN MOBILE
-- from a designated support phone; the carrier diverts it to the HCG number;
-- HCG delivers it to the app and the customer answers. Twilio cannot tell a
-- diverted call from a direct dial (ForwardedFrom = the Twilio number itself,
-- 184/184 production calls), so the operator also attests which number they
-- dialled (last 4 digits of the customer's own mobile, checked here).
--
-- hcg_record_support_forwarding_proof re-validates ALL evidence inside the
-- database (it cannot be bypassed by a caller of the API layer):
--   * the household exists, is not cancelled/deleted, has an ACTIVE HCG number;
--   * the evidence call row belongs to this household;
--   * it was answered in the app (dial_call_status = 'completed');
--   * it is fresh (within p_max_age_minutes of now, max 240) and not in the future;
--   * it happened on the CURRENT number (at/after the active primary
--     routing assignment's state_changed_at, when that is known);
--   * the caller is one of the designated support numbers passed in, and is
--     neither the customer's own mobile nor the HCG number;
--   * the attested last 4 digits match the customer's own mobile;
--   * the call has not already been used as evidence;
--   * the household is not already proven (clear first, also audited).
-- On success: forwarding_proven_at := the EVIDENCE CALL's time (not now()),
-- forwarding_proof_method := 'support_verified', and one append-only audit row.
-- Refusals raise (nothing written); the API layer logs them.
--
-- Additive only. The 074 rollback still refuses while proof is recorded.

begin;

-- 1. Allow the new proof method (074 allowed only 'verification_call').
alter table public.households drop constraint if exists households_forwarding_proof_method_check;
alter table public.households
  add constraint households_forwarding_proof_method_check
  check (forwarding_proof_method is null or forwarding_proof_method in ('verification_call', 'support_verified'));

-- 2. Append-only audit of every proof recorded or cleared.
create table if not exists public.forwarding_proof_audit (
  id bigint generated always as identity primary key,
  household_id uuid not null,
  action text not null check (action in ('recorded', 'cleared')),
  method text check (method is null or method in ('verification_call', 'support_verified')),
  evidence_call_sid text,
  evidence_call_at timestamptz,
  evidence_caller_last4 text check (evidence_caller_last4 is null or evidence_caller_last4 ~ '^[0-9]{4}$'),
  attested_dialled_last4 text check (attested_dialled_last4 is null or attested_dialled_last4 ~ '^[0-9]{4}$'),
  hcg_number_last4 text check (hcg_number_last4 is null or hcg_number_last4 ~ '^[0-9]{4}$'),
  previous_proven_at timestamptz,
  previous_method text,
  reason text not null check (length(btrim(reason)) >= 10),
  actor text not null check (length(btrim(actor)) >= 2),
  at timestamptz not null default now()
);
-- One proof per evidence call, ever.
create unique index if not exists forwarding_proof_audit_evidence_once
  on public.forwarding_proof_audit (evidence_call_sid) where action = 'recorded';
create index if not exists forwarding_proof_audit_household_idx
  on public.forwarding_proof_audit (household_id, at desc);

alter table public.forwarding_proof_audit enable row level security;
revoke all on public.forwarding_proof_audit from public, anon, authenticated;
revoke all on sequence public.forwarding_proof_audit_id_seq from public, anon, authenticated;
grant select on public.forwarding_proof_audit to service_role;

create or replace function public.forwarding_proof_audit_block() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'forwarding_proof_audit is append-only';
end;
$$;
drop trigger if exists forwarding_proof_audit_append_only on public.forwarding_proof_audit;
create trigger forwarding_proof_audit_append_only before update or delete on public.forwarding_proof_audit
  for each row execute function public.forwarding_proof_audit_block();
revoke all on function public.forwarding_proof_audit_block() from public, anon, authenticated, service_role;

-- Last 10 national digits, for UK number comparison across +44 / 0 formats.
create or replace function public.hcg_phone_key(p text) returns text
language sql immutable set search_path = '' as $$
  select case when length(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g')) >= 10
              then right(regexp_replace(p, '[^0-9]', '', 'g'), 10) end;
$$;
revoke all on function public.hcg_phone_key(text) from public, anon, authenticated, service_role;

-- 3. Record a support-verified proof (all checks above; raises on refusal).
create or replace function public.hcg_record_support_forwarding_proof(
  p_household_id uuid,
  p_evidence_call_sid text,
  p_attested_dialled_last4 text,
  p_support_caller_numbers text[],
  p_reason text,
  p_actor text,
  p_max_age_minutes integer default 60,
  p_now timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_h public.households%rowtype;
  v_call record;
  v_assigned_at timestamptz;
  v_caller_key text;
  v_support_keys text[];
begin
  if p_household_id is null or coalesce(btrim(p_evidence_call_sid), '') = '' then
    raise exception 'forwarding_proof: household and evidence call required';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 10 or coalesce(length(btrim(p_actor)), 0) < 2 then
    raise exception 'forwarding_proof: reason and actor required';
  end if;
  if coalesce(p_attested_dialled_last4, '') !~ '^[0-9]{4}$' then
    raise exception 'forwarding_proof: attested dialled last 4 digits required';
  end if;
  if p_max_age_minutes is null or p_max_age_minutes < 1 or p_max_age_minutes > 240 then
    raise exception 'forwarding_proof: max age must be 1..240 minutes';
  end if;
  select coalesce(array_agg(k), '{}') into v_support_keys
    from (select public.hcg_phone_key(n) as k from unnest(coalesce(p_support_caller_numbers, '{}')) as n) s
    where k is not null;
  if cardinality(v_support_keys) = 0 then
    raise exception 'forwarding_proof: no designated support caller numbers configured';
  end if;

  select * into v_h from public.households where id = p_household_id for update;
  if not found then raise exception 'forwarding_proof: unknown household'; end if;
  -- Deleted (029 anonymised) or cancelled households are never proven.
  if v_h.status = 'cancelled' then raise exception 'forwarding_proof: household cancelled or deleted'; end if;
  if v_h.twilio_number is null or v_h.twilio_provisioning_status is distinct from 'active' then
    raise exception 'forwarding_proof: household has no active HCG number';
  end if;
  if v_h.forwarding_proven_at is not null then
    raise exception 'forwarding_proof: already proven — clear the existing proof first';
  end if;
  if public.hcg_phone_key(v_h.phone_number) is null then
    raise exception 'forwarding_proof: customer mobile number unknown';
  end if;
  if right(public.hcg_phone_key(v_h.phone_number), 4) <> p_attested_dialled_last4 then
    raise exception 'forwarding_proof: attested number does not match the customer''s own mobile';
  end if;

  select c.call_sid, c.household_id, c.number, c.created_at, c.dial_call_status
    into v_call from public.calls c where c.call_sid = btrim(p_evidence_call_sid);
  if not found then raise exception 'forwarding_proof: evidence call not found'; end if;
  if v_call.household_id is distinct from p_household_id then
    raise exception 'forwarding_proof: evidence call belongs to another household';
  end if;
  if v_call.dial_call_status is distinct from 'completed' then
    raise exception 'forwarding_proof: evidence call was not answered in the app (dial status %)', coalesce(v_call.dial_call_status, 'none');
  end if;
  if v_call.created_at > p_now + interval '1 minute' then
    raise exception 'forwarding_proof: evidence call is in the future';
  end if;
  if v_call.created_at < p_now - make_interval(mins => p_max_age_minutes) then
    raise exception 'forwarding_proof: evidence call is older than % minutes', p_max_age_minutes;
  end if;
  v_caller_key := public.hcg_phone_key(v_call.number);
  if v_caller_key is null or not (v_caller_key = any (v_support_keys)) then
    raise exception 'forwarding_proof: evidence call did not come from a designated support phone';
  end if;
  if v_caller_key = public.hcg_phone_key(v_h.phone_number) or v_caller_key = public.hcg_phone_key(v_h.twilio_number) then
    raise exception 'forwarding_proof: support phone must differ from the customer and HCG numbers';
  end if;

  -- Current-number check (062). Unknown assignment time ⇒ accepted, as the gate does.
  if to_regclass('public.routing_assignments') is not null then
    execute 'select max(state_changed_at) from public.routing_assignments
              where household_id = $1 and state = ''active'' and is_primary and e164_number = $2'
      into v_assigned_at using p_household_id, v_h.twilio_number;
    if v_assigned_at is not null and v_call.created_at < v_assigned_at then
      raise exception 'forwarding_proof: evidence call predates the current HCG number';
    end if;
  end if;

  if exists (select 1 from public.forwarding_proof_audit where evidence_call_sid = v_call.call_sid and action = 'recorded') then
    raise exception 'forwarding_proof: evidence call already used';
  end if;

  update public.households
     set forwarding_proven_at = v_call.created_at,
         forwarding_proof_method = 'support_verified'
   where id = p_household_id;

  insert into public.forwarding_proof_audit
    (household_id, action, method, evidence_call_sid, evidence_call_at, evidence_caller_last4,
     attested_dialled_last4, hcg_number_last4, previous_proven_at, previous_method, reason, actor)
  values
    (p_household_id, 'recorded', 'support_verified', v_call.call_sid, v_call.created_at, right(v_caller_key, 4),
     p_attested_dialled_last4, right(public.hcg_phone_key(v_h.twilio_number), 4), null, v_h.forwarding_proof_method,
     btrim(p_reason), btrim(p_actor));

  return jsonb_build_object('ok', true, 'forwardingProvenAt', v_call.created_at, 'method', 'support_verified',
                            'evidenceCallSid', v_call.call_sid);
end;
$$;

-- 4. Clear a proof (e.g. the customer turned forwarding off, wrong evidence).
create or replace function public.hcg_clear_forwarding_proof(
  p_household_id uuid, p_reason text, p_actor text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_h public.households%rowtype;
begin
  if p_household_id is null then raise exception 'forwarding_proof: household required'; end if;
  if coalesce(length(btrim(p_reason)), 0) < 10 or coalesce(length(btrim(p_actor)), 0) < 2 then
    raise exception 'forwarding_proof: reason and actor required';
  end if;
  select * into v_h from public.households where id = p_household_id for update;
  if not found then raise exception 'forwarding_proof: unknown household'; end if;
  if v_h.forwarding_proven_at is null then
    return jsonb_build_object('ok', true, 'cleared', false, 'reason', 'not_proven');
  end if;
  update public.households set forwarding_proven_at = null, forwarding_proof_method = null where id = p_household_id;
  insert into public.forwarding_proof_audit (household_id, action, previous_proven_at, previous_method, reason, actor)
  values (p_household_id, 'cleared', v_h.forwarding_proven_at, v_h.forwarding_proof_method, btrim(p_reason), btrim(p_actor));
  return jsonb_build_object('ok', true, 'cleared', true, 'previousProvenAt', v_h.forwarding_proven_at);
end;
$$;

revoke all on function public.hcg_record_support_forwarding_proof(uuid, text, text, text[], text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.hcg_clear_forwarding_proof(uuid, text, text) from public, anon, authenticated;
grant execute on function public.hcg_record_support_forwarding_proof(uuid, text, text, text[], text, text, integer, timestamptz) to service_role;
grant execute on function public.hcg_clear_forwarding_proof(uuid, text, text) to service_role;

comment on table public.forwarding_proof_audit is
  'Append-only audit of every forwarding proof recorded or cleared (075). Written only by hcg_record_support_forwarding_proof / hcg_clear_forwarding_proof.';

commit;
