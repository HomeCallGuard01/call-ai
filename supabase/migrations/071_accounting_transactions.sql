-- 071 — Accounting automation: transaction sub-ledger, exception queue,
-- Xero posting outbox, settlements (feature/accounting-automation, 2026-10-04).
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE. Additive only: five new tables and
-- service-role-only SQL functions. Touches no existing table, function or
-- grant. Nothing writes to these tables until the accounting capture is
-- explicitly enabled (ACCOUNTING_CAPTURE_ENABLED=true) after this is applied.
--
-- The functions implement the store interface of
-- services/accounting/memoryStore.js (the reference semantics); the same
-- scenario suite runs against both (tests/accounting-store-parity.pglite.test.mjs).
--
-- Idempotency is enforced HERE, not only in JS:
--   accounting_source_events   unique (source, source_event_id)
--   accounting_transactions    unique (economic_key) + immutable money identity
--   accounting_exceptions      unique (exception_key)
--   accounting_postings        unique (posting_key)
--   accounting_settlements     unique (channel, settlement_ref)
--
-- Privacy: no webhook payload is stored — only a SHA-256 digest. Households
-- are referenced by id and the permanent HCG account number; no name, email
-- or address is held here.
--
-- Rollback: _rollbacks/071_rollback_accounting_transactions.sql (drops all of it).

begin;

-- ── Source events (every webhook/report delivery, deduplicated) ─────────────
create table if not exists public.accounting_source_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('stripe_webhook', 'revenuecat_webhook', 'settlement_report', 'manual')),
  source_event_id text not null check (length(source_event_id) between 1 and 255),
  event_type text not null,
  environment text not null check (environment in ('production', 'sandbox')),
  payload_digest text,
  outcome text check (outcome in ('recorded', 'non_economic', 'duplicate_event', 'duplicate_economic',
                                  'superseded_by_primary', 'sandbox', 'complimentary', 'ignored')),
  outcome_detail text,
  transaction_ids uuid[] not null default '{}',
  delivery_count integer not null default 1 check (delivery_count >= 1),
  received_at timestamptz not null default clock_timestamp(),
  last_received_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint accounting_source_events_unique unique (source, source_event_id)
);

-- ── Transactions (one row per piece of money) ───────────────────────────────
create table if not exists public.accounting_transactions (
  id uuid primary key default gen_random_uuid(),
  economic_key text not null,
  channel text not null check (channel in ('stripe', 'app_store', 'play_store', 'complimentary')),
  kind text not null check (kind in ('sale', 'refund', 'chargeback', 'chargeback_reversal')),
  environment text not null check (environment in ('production', 'sandbox')),
  source text not null,
  household_id uuid references public.households(id) on delete set null,
  account_number text check (account_number is null or account_number ~ '^HCG-[0-9]{8,}$'),
  provider_transaction_id text not null,
  provider_refs jsonb not null default '{}'::jsonb,
  original_refs jsonb,
  original_transaction_id uuid references public.accounting_transactions(id) on delete restrict,
  product text,
  product_code text,
  currency text check (currency ~ '^[A-Z]{3}$'),
  gross_minor bigint,
  tax_minor bigint,
  net_minor bigint,
  fee_minor bigint,
  proceeds_minor bigint,
  amount_quality text not null check (amount_quality in ('provider_actual', 'estimated', 'settled')),
  tax_source text not null check (tax_source in ('provider', 'provider_estimate', 'pro_rata_from_original', 'missing')),
  customer_country text,
  occurred_at timestamptz not null,
  service_period_start timestamptz,
  service_period_end timestamptz,
  status text not null check (status in ('excluded_sandbox', 'subledger_only', 'blocked', 'ready', 'posting', 'posted', 'failed')),
  blocked_reasons text[] not null default '{}',
  content_digest text not null,
  first_source_event_id uuid references public.accounting_source_events(id) on delete restrict,
  settlement_id uuid,
  xero_status text check (xero_status is null or xero_status in ('posted', 'failed')),
  xero_reference text,
  xero_document_ids jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint accounting_transactions_economic_key_unique unique (economic_key),
  constraint accounting_transactions_amounts_non_negative check (
    (gross_minor is null or gross_minor >= 0) and (tax_minor is null or tax_minor >= 0) and (fee_minor is null or fee_minor >= 0)),
  constraint accounting_transactions_net_consistent check (
    net_minor is null or (gross_minor is not null and tax_minor is not null and net_minor = gross_minor - tax_minor)),
  constraint accounting_transactions_reversal_has_original_when_posted check (
    kind = 'sale' or status not in ('ready', 'posting', 'posted') or original_transaction_id is not null),
  constraint accounting_transactions_postable_has_account check (
    status not in ('ready', 'posting', 'posted') or account_number is not null),
  constraint accounting_transactions_sandbox_never_posted check (
    environment = 'production' or status = 'excluded_sandbox' or status = 'blocked')
);
create index if not exists accounting_transactions_status_idx on public.accounting_transactions (status, occurred_at);
create index if not exists accounting_transactions_household_idx on public.accounting_transactions (household_id, occurred_at);
create index if not exists accounting_transactions_refs_idx on public.accounting_transactions using gin (provider_refs jsonb_path_ops);
create index if not exists accounting_transactions_original_idx on public.accounting_transactions (original_transaction_id);

-- Money identity never changes; posted money is frozen. Corrections are new
-- transactions (refund / credit), never edits.
create or replace function public.accounting_transactions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.economic_key is distinct from old.economic_key or new.channel is distinct from old.channel
     or new.kind is distinct from old.kind or new.environment is distinct from old.environment
     or new.gross_minor is distinct from old.gross_minor or new.currency is distinct from old.currency
     or new.provider_transaction_id is distinct from old.provider_transaction_id
     or new.content_digest is distinct from old.content_digest then
    raise exception 'accounting transaction % identity is immutable', old.economic_key;
  end if;
  if old.status = 'posted' and (new.tax_minor is distinct from old.tax_minor or new.net_minor is distinct from old.net_minor
     or new.household_id is distinct from old.household_id or new.account_number is distinct from old.account_number) then
    raise exception 'transaction % is posted; tax_minor/net_minor/household/account are frozen', old.economic_key;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists accounting_transactions_guard on public.accounting_transactions;
create trigger accounting_transactions_guard before update on public.accounting_transactions
  for each row execute function public.accounting_transactions_guard();

-- ── Exception / reconciliation queue ────────────────────────────────────────
create table if not exists public.accounting_exceptions (
  id uuid primary key default gen_random_uuid(),
  exception_key text not null,
  type text not null check (type in ('unmatched_payment', 'duplicate', 'missing_account', 'conflicting_entitlement',
    'refund_mismatch', 'failed_xero_posting', 'amount_discrepancy', 'tax_treatment_unconfirmed', 'unsupported_currency')),
  severity text not null check (severity in ('low', 'medium', 'high')),
  status text not null default 'open' check (status in ('open', 'resolved', 'auto_resolved', 'dismissed')),
  transaction_id uuid references public.accounting_transactions(id) on delete set null,
  household_id uuid,
  account_number text,
  detail jsonb not null default '{}'::jsonb,
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  constraint accounting_exceptions_key_unique unique (exception_key),
  constraint accounting_exceptions_resolution_recorded check (status = 'open' or (resolved_at is not null and resolved_by is not null))
);
create index if not exists accounting_exceptions_open_idx on public.accounting_exceptions (status, type, first_seen_at);

-- ── Xero posting outbox ─────────────────────────────────────────────────────
create table if not exists public.accounting_postings (
  id uuid primary key default gen_random_uuid(),
  posting_key text not null,
  target text not null default 'xero' check (target = 'xero'),
  subject_type text not null check (subject_type in ('transaction', 'settlement')),
  transaction_id uuid references public.accounting_transactions(id) on delete restrict,
  settlement_id uuid,
  document_plan jsonb,
  status text not null default 'pending' check (status in ('pending', 'in_flight', 'retry', 'held', 'posted', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  claim_count integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz,
  last_error text,
  last_error_class text check (last_error_class is null or last_error_class in ('unavailable', 'rate_limited', 'unknown_outcome', 'rejected')),
  completed_steps jsonb not null default '{}'::jsonb,
  payload_digest text,
  created_at timestamptz not null default clock_timestamp(),
  posted_at timestamptz,
  constraint accounting_postings_key_unique unique (posting_key),
  constraint accounting_postings_subject check ((subject_type = 'transaction') = (transaction_id is not null)),
  constraint accounting_postings_posted_has_time check (status <> 'posted' or posted_at is not null)
);
create index if not exists accounting_postings_due_idx on public.accounting_postings (status, next_attempt_at);

create or replace function public.accounting_postings_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'posted' and new.status <> 'posted' then
    raise exception 'posting % is posted; status cannot change', old.posting_key;
  end if;
  if new.posting_key is distinct from old.posting_key or new.transaction_id is distinct from old.transaction_id then
    raise exception 'posting identity is immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists accounting_postings_guard on public.accounting_postings;
create trigger accounting_postings_guard before update on public.accounting_postings
  for each row execute function public.accounting_postings_guard();

-- ── Settlements (Stripe payouts, store proceeds reports) ────────────────────
create table if not exists public.accounting_settlements (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('stripe', 'app_store', 'play_store')),
  settlement_ref text not null,
  environment text not null default 'production' check (environment in ('production', 'sandbox')),
  currency text check (currency ~ '^[A-Z]{3}$'),
  period_start timestamptz,
  period_end timestamptz,
  paid_at timestamptz,
  totals jsonb not null default '{}'::jsonb,
  lines jsonb not null default '[]'::jsonb,
  status text not null default 'imported' check (status in ('imported', 'reconciled', 'discrepancy', 'posted', 'excluded_sandbox')),
  reconciled_at timestamptz,
  xero_document_ids jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint accounting_settlements_unique unique (channel, settlement_ref)
);

-- ── Privileges: service role only (no anon/authenticated access at all) ─────
alter table public.accounting_source_events enable row level security;
alter table public.accounting_transactions enable row level security;
alter table public.accounting_exceptions enable row level security;
alter table public.accounting_postings enable row level security;
alter table public.accounting_settlements enable row level security;
revoke all on public.accounting_source_events, public.accounting_transactions, public.accounting_exceptions,
  public.accounting_postings, public.accounting_settlements from public, anon, authenticated;
grant select on public.accounting_source_events, public.accounting_transactions, public.accounting_exceptions,
  public.accounting_postings, public.accounting_settlements to service_role;

-- ── Store functions (all security definer, service_role only) ───────────────

create or replace function public.acc_claim_source_event(p_source text, p_source_event_id text, p_event_type text, p_environment text, p_payload_digest text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_source_events; v_id uuid; v_inserted boolean;
begin
  insert into public.accounting_source_events (source, source_event_id, event_type, environment, payload_digest)
  values (p_source, p_source_event_id, p_event_type, p_environment, p_payload_digest)
  on conflict (source, source_event_id) do update
    set delivery_count = public.accounting_source_events.delivery_count + 1, last_received_at = clock_timestamp()
  returning id, (xmax = 0) into v_id, v_inserted;
  select * into v from public.accounting_source_events where id = v_id;
  return jsonb_build_object('inserted', v_inserted, 'event', to_jsonb(v));
end;
$$;

create or replace function public.acc_complete_source_event(p_id uuid, p_outcome text, p_outcome_detail text, p_transaction_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_source_events;
begin
  update public.accounting_source_events
     set outcome = p_outcome, outcome_detail = p_outcome_detail, transaction_ids = coalesce(p_transaction_ids, '{}'), completed_at = clock_timestamp()
   where id = p_id returning * into v;
  if not found then raise exception 'source event not found'; end if;
  return to_jsonb(v);
end;
$$;

create or replace function public.acc_list_source_events()
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.received_at), '[]'::jsonb) from public.accounting_source_events e;
$$;

create or replace function public.acc_insert_transaction(p_tx jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.accounting_transactions; v public.accounting_transactions; v_inserted boolean := true;
begin
  r := jsonb_populate_record(null::public.accounting_transactions, p_tx);
  insert into public.accounting_transactions (
    economic_key, channel, kind, environment, source, household_id, account_number, provider_transaction_id,
    provider_refs, original_refs, original_transaction_id, product, product_code, currency, gross_minor, tax_minor, net_minor,
    fee_minor, proceeds_minor, amount_quality, tax_source, customer_country, occurred_at, service_period_start, service_period_end,
    status, blocked_reasons, content_digest, first_source_event_id, settlement_id, xero_status, xero_reference, xero_document_ids)
  values (
    r.economic_key, r.channel, r.kind, r.environment, r.source, r.household_id, r.account_number, r.provider_transaction_id,
    coalesce(r.provider_refs, '{}'::jsonb), r.original_refs, r.original_transaction_id, r.product, r.product_code, r.currency,
    r.gross_minor, r.tax_minor, r.net_minor, r.fee_minor, r.proceeds_minor, r.amount_quality, r.tax_source, r.customer_country,
    r.occurred_at, r.service_period_start, r.service_period_end, r.status, coalesce(r.blocked_reasons, '{}'), r.content_digest,
    r.first_source_event_id, r.settlement_id, r.xero_status, r.xero_reference, coalesce(r.xero_document_ids, '{}'::jsonb))
  on conflict (economic_key) do nothing
  returning * into v;
  if not found then
    v_inserted := false;
    select * into v from public.accounting_transactions where economic_key = r.economic_key;
  end if;
  return jsonb_build_object('inserted', v_inserted, 'transaction', to_jsonb(v));
end;
$$;

create or replace function public.acc_update_transaction(p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_transactions; k text;
begin
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('household_id', 'account_number', 'original_transaction_id', 'status', 'blocked_reasons', 'tax_minor', 'net_minor',
                 'fee_minor', 'tax_source', 'settlement_id', 'xero_status', 'xero_reference', 'xero_document_ids') then
      raise exception 'transaction field % is not patchable', k;
    end if;
  end loop;
  update public.accounting_transactions t set
    household_id = case when p_patch ? 'household_id' then (p_patch->>'household_id')::uuid else t.household_id end,
    account_number = case when p_patch ? 'account_number' then p_patch->>'account_number' else t.account_number end,
    original_transaction_id = case when p_patch ? 'original_transaction_id' then (p_patch->>'original_transaction_id')::uuid else t.original_transaction_id end,
    status = case when p_patch ? 'status' then p_patch->>'status' else t.status end,
    blocked_reasons = case when p_patch ? 'blocked_reasons' then array(select jsonb_array_elements_text(p_patch->'blocked_reasons')) else t.blocked_reasons end,
    tax_minor = case when p_patch ? 'tax_minor' then (p_patch->>'tax_minor')::bigint else t.tax_minor end,
    net_minor = case when p_patch ? 'net_minor' then (p_patch->>'net_minor')::bigint else t.net_minor end,
    fee_minor = case when p_patch ? 'fee_minor' then (p_patch->>'fee_minor')::bigint else t.fee_minor end,
    tax_source = case when p_patch ? 'tax_source' then p_patch->>'tax_source' else t.tax_source end,
    settlement_id = case when p_patch ? 'settlement_id' then (p_patch->>'settlement_id')::uuid else t.settlement_id end,
    xero_status = case when p_patch ? 'xero_status' then p_patch->>'xero_status' else t.xero_status end,
    xero_reference = case when p_patch ? 'xero_reference' then p_patch->>'xero_reference' else t.xero_reference end,
    xero_document_ids = case when p_patch ? 'xero_document_ids' then coalesce(p_patch->'xero_document_ids', '{}'::jsonb) else t.xero_document_ids end
  where t.id = p_id returning * into v;
  if not found then raise exception 'transaction not found'; end if;
  return to_jsonb(v);
end;
$$;

create or replace function public.acc_get_transaction(p_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(t) from public.accounting_transactions t where t.id = p_id;
$$;

create or replace function public.acc_find_transaction_by_key(p_key text)
returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(t) from public.accounting_transactions t where t.economic_key = p_key;
$$;

create or replace function public.acc_find_transactions_by_ref(p_ref text, p_value text)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]'::jsonb)
    from public.accounting_transactions t
   where p_value is not null and t.provider_refs @> jsonb_build_object(p_ref, p_value);
$$;

create or replace function public.acc_list_transactions(p_filter jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.occurred_at, t.created_at), '[]'::jsonb)
    from public.accounting_transactions t
   where (not (p_filter ? 'status') or (case jsonb_typeof(p_filter->'status')
            when 'array' then t.status in (select jsonb_array_elements_text(p_filter->'status'))
            else t.status = p_filter->>'status' end))
     and (not (p_filter ? 'channel') or t.channel = p_filter->>'channel')
     and (not (p_filter ? 'household_id') or t.household_id = (p_filter->>'household_id')::uuid)
     and (not (p_filter ? 'original_transaction_id') or t.original_transaction_id = (p_filter->>'original_transaction_id')::uuid);
$$;

-- Raise or re-observe. Reopens auto_resolved/resolved; a DISMISSED exception
-- stays dismissed (a person decided) but its occurrences are still counted.
create or replace function public.acc_raise_exception(p_ex jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_exceptions; v_id uuid; v_inserted boolean;
begin
  insert into public.accounting_exceptions (exception_key, type, severity, transaction_id, household_id, account_number, detail)
  values (p_ex->>'exception_key', p_ex->>'type', p_ex->>'severity', (p_ex->>'transaction_id')::uuid,
          (p_ex->>'household_id')::uuid, p_ex->>'account_number', coalesce(p_ex->'detail', '{}'::jsonb))
  on conflict (exception_key) do update set
    occurrences = public.accounting_exceptions.occurrences + 1,
    last_seen_at = clock_timestamp(),
    detail = coalesce(nullif(excluded.detail, '{}'::jsonb), public.accounting_exceptions.detail),
    status = case when public.accounting_exceptions.status in ('auto_resolved', 'resolved') then 'open' else public.accounting_exceptions.status end,
    resolved_at = case when public.accounting_exceptions.status in ('auto_resolved', 'resolved') then null else public.accounting_exceptions.resolved_at end,
    resolved_by = case when public.accounting_exceptions.status in ('auto_resolved', 'resolved') then null else public.accounting_exceptions.resolved_by end,
    resolution_note = case when public.accounting_exceptions.status in ('auto_resolved', 'resolved') then null else public.accounting_exceptions.resolution_note end
  returning id, (xmax = 0) into v_id, v_inserted;
  select * into v from public.accounting_exceptions where id = v_id;
  return jsonb_build_object('inserted', v_inserted, 'exception', to_jsonb(v));
end;
$$;

create or replace function public.acc_resolve_exception(p_key text, p_status text, p_resolved_by text, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_exceptions;
begin
  if p_status not in ('resolved', 'auto_resolved', 'dismissed') then raise exception 'invalid resolution status'; end if;
  if p_resolved_by is null or length(trim(p_resolved_by)) = 0 then raise exception 'resolved_by required'; end if;
  update public.accounting_exceptions
     set status = p_status, resolved_by = p_resolved_by, resolution_note = p_note, resolved_at = clock_timestamp()
   where exception_key = p_key and status = 'open' returning * into v;
  if not found then select * into v from public.accounting_exceptions where exception_key = p_key; end if;
  if not found then return null; end if;
  return to_jsonb(v);
end;
$$;

create or replace function public.acc_list_exceptions(p_filter jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.first_seen_at, e.exception_key), '[]'::jsonb)
    from public.accounting_exceptions e
   where (not (p_filter ? 'status') or e.status = p_filter->>'status')
     and (not (p_filter ? 'type') or e.type = p_filter->>'type')
     and (not (p_filter ? 'transaction_id') or e.transaction_id = (p_filter->>'transaction_id')::uuid);
$$;

create or replace function public.acc_enqueue_posting(p_posting jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_postings; v_inserted boolean := true;
begin
  insert into public.accounting_postings (posting_key, target, subject_type, transaction_id, settlement_id, document_plan, next_attempt_at)
  values (p_posting->>'posting_key', coalesce(p_posting->>'target', 'xero'), p_posting->>'subject_type',
          (p_posting->>'transaction_id')::uuid, (p_posting->>'settlement_id')::uuid, p_posting->'document_plan',
          coalesce((p_posting->>'next_attempt_at')::timestamptz, clock_timestamp()))
  on conflict (posting_key) do nothing returning * into v;
  if not found then
    v_inserted := false;
    select * into v from public.accounting_postings where posting_key = p_posting->>'posting_key';
  end if;
  return jsonb_build_object('inserted', v_inserted, 'posting', to_jsonb(v));
end;
$$;

-- Claim due postings with a lease. FOR UPDATE SKIP LOCKED: concurrent workers
-- on separate connections never claim the same row.
create or replace function public.acc_claim_due_postings(p_now timestamptz, p_limit integer, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with due as (
    select p.id from public.accounting_postings p
     where ((p.status in ('pending', 'retry') and p.next_attempt_at <= p_now)
            or (p.status = 'in_flight' and p.lease_until is not null and p.lease_until <= p_now))
     order by p.next_attempt_at, p.created_at
     limit greatest(1, least(coalesce(p_limit, 10), 100))
     for update skip locked
  ), upd as (
    update public.accounting_postings p
       set status = 'in_flight', claim_count = p.claim_count + 1,
           lease_until = p_now + make_interval(secs => greatest(30, coalesce(p_lease_seconds, 120)))
      from due where p.id = due.id
    returning p.*
  )
  select coalesce(jsonb_agg(to_jsonb(upd) order by upd.next_attempt_at, upd.created_at), '[]'::jsonb) into v from upd;
  return v;
end;
$$;

create or replace function public.acc_update_posting(p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_postings; k text;
begin
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('status', 'attempts', 'next_attempt_at', 'lease_until', 'last_error', 'last_error_class', 'completed_steps', 'posted_at', 'payload_digest') then
      raise exception 'posting field % is not patchable', k;
    end if;
  end loop;
  update public.accounting_postings p set
    status = case when p_patch ? 'status' then p_patch->>'status' else p.status end,
    attempts = case when p_patch ? 'attempts' then (p_patch->>'attempts')::integer else p.attempts end,
    next_attempt_at = case when p_patch ? 'next_attempt_at' then (p_patch->>'next_attempt_at')::timestamptz else p.next_attempt_at end,
    lease_until = case when p_patch ? 'lease_until' then (p_patch->>'lease_until')::timestamptz else p.lease_until end,
    last_error = case when p_patch ? 'last_error' then p_patch->>'last_error' else p.last_error end,
    last_error_class = case when p_patch ? 'last_error_class' then p_patch->>'last_error_class' else p.last_error_class end,
    completed_steps = case when p_patch ? 'completed_steps' then coalesce(p_patch->'completed_steps', '{}'::jsonb) else p.completed_steps end,
    posted_at = case when p_patch ? 'posted_at' then (p_patch->>'posted_at')::timestamptz else p.posted_at end,
    payload_digest = case when p_patch ? 'payload_digest' then p_patch->>'payload_digest' else p.payload_digest end
  where p.id = p_id returning * into v;
  if not found then raise exception 'posting not found'; end if;
  return to_jsonb(v);
end;
$$;

create or replace function public.acc_find_posting_by_key(p_key text)
returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(p) from public.accounting_postings p where p.posting_key = p_key;
$$;

create or replace function public.acc_list_postings(p_filter jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at), '[]'::jsonb)
    from public.accounting_postings p
   where not (p_filter ? 'status') or p.status = p_filter->>'status';
$$;

create or replace function public.acc_upsert_settlement(p_s jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_settlements; v_inserted boolean := true;
begin
  insert into public.accounting_settlements (channel, settlement_ref, environment, currency, period_start, period_end, paid_at, totals, lines, status, xero_document_ids)
  values (p_s->>'channel', p_s->>'settlement_ref', coalesce(p_s->>'environment', 'production'), p_s->>'currency',
          (p_s->>'period_start')::timestamptz, (p_s->>'period_end')::timestamptz, (p_s->>'paid_at')::timestamptz,
          coalesce(p_s->'totals', '{}'::jsonb), coalesce(p_s->'lines', '[]'::jsonb), coalesce(p_s->>'status', 'imported'),
          coalesce(p_s->'xero_document_ids', '{}'::jsonb))
  on conflict (channel, settlement_ref) do nothing returning * into v;
  if not found then
    v_inserted := false;
    select * into v from public.accounting_settlements where channel = p_s->>'channel' and settlement_ref = p_s->>'settlement_ref';
  end if;
  return jsonb_build_object('inserted', v_inserted, 'settlement', to_jsonb(v));
end;
$$;

create or replace function public.acc_update_settlement(p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.accounting_settlements; k text;
begin
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('status', 'reconciled_at', 'xero_document_ids') then raise exception 'settlement field % is not patchable', k; end if;
  end loop;
  update public.accounting_settlements s set
    status = case when p_patch ? 'status' then p_patch->>'status' else s.status end,
    reconciled_at = case when p_patch ? 'reconciled_at' then (p_patch->>'reconciled_at')::timestamptz else s.reconciled_at end,
    xero_document_ids = case when p_patch ? 'xero_document_ids' then coalesce(p_patch->'xero_document_ids', '{}'::jsonb) else s.xero_document_ids end
  where s.id = p_id returning * into v;
  if not found then raise exception 'settlement not found'; end if;
  return to_jsonb(v);
end;
$$;

create or replace function public.acc_list_settlements()
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at), '[]'::jsonb) from public.accounting_settlements s;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'acc_claim_source_event(text, text, text, text, text)', 'acc_complete_source_event(uuid, text, text, uuid[])', 'acc_list_source_events()',
    'acc_insert_transaction(jsonb)', 'acc_update_transaction(uuid, jsonb)', 'acc_get_transaction(uuid)', 'acc_find_transaction_by_key(text)',
    'acc_find_transactions_by_ref(text, text)', 'acc_list_transactions(jsonb)', 'acc_raise_exception(jsonb)',
    'acc_resolve_exception(text, text, text, text)', 'acc_list_exceptions(jsonb)', 'acc_enqueue_posting(jsonb)',
    'acc_claim_due_postings(timestamptz, integer, integer)', 'acc_update_posting(uuid, jsonb)', 'acc_find_posting_by_key(text)',
    'acc_list_postings(jsonb)', 'acc_upsert_settlement(jsonb)', 'acc_update_settlement(uuid, jsonb)', 'acc_list_settlements()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
revoke all on function public.accounting_transactions_guard() from public, anon, authenticated, service_role;
revoke all on function public.accounting_postings_guard() from public, anon, authenticated, service_role;

commit;
