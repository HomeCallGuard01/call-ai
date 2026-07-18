-- Stripe Integration: subscriptions + entitlements + webhook event log
--
-- STATUS: DRAFT — NOT APPLIED
--
-- Purpose: creates the two tables from Decision 009 (docs/DECISIONS.md)
-- that were deliberately left documentation-only until Stripe
-- integration actually began, plus a webhook-event log added during
-- review of this migration. `subscriptions` is a direct mirror of
-- Stripe's own subscription objects (one row per Stripe subscription,
-- ever). `entitlements` is this project's own concept of "does this
-- household currently have the right to use the service" — read by the
-- app, never Stripe directly, so that free trials, founding-user
-- discounts, and complimentary/staff access (which have no corresponding
-- Stripe subscription at all) can be represented the same way as a paid
-- subscription. `stripe_webhook_events` is a dedup/audit log keyed by
-- Stripe's own event ID — subscription upserts and the entitlement
-- partial-unique-index only protect their own tables from duplicate
-- writes; they do nothing to stop a redelivered webhook event from
-- re-running other side effects, which is what this table is for.
--
-- All three tables are additive only — no existing table, column,
-- policy, or grant is touched. Writes are reserved for the service-role
-- webhook path; this migration grants authenticated users read-only
-- access to their own household's subscriptions/entitlements rows and
-- nothing else — stripe_webhook_events gets no authenticated access at
-- all (see the table's own comment below). service_role's own write
-- privileges are intentionally deferred to a separate migration (012),
-- following the same least-privilege audit pattern used for
-- 009_service_role_minimum_app_privileges.sql — this file only creates
-- the schema and the authenticated-read surface.
--
-- Household resolution for subscriptions/entitlements follows the exact
-- pattern already established for contacts/calls
-- (008_household_isolation_contacts.sql): a row belongs to a household,
-- and a signed-in user may see it only if that household's auth_user_id
-- matches auth.uid().
--
-- Run this AFTER:
-- 002_create_households_and_roles.sql
-- 010_add_stripe_customer_id.sql

begin;

-- ------------------------------------------------------------
-- Subscriptions — one row per Stripe subscription object, ever.
-- ------------------------------------------------------------
--
-- Historical rows are preserved by construction, not by a special flag:
-- a subscription's status changes in place over its own lifetime
-- (active -> past_due -> active -> canceled), keyed on the one
-- stripe_subscription_id it has for life, so cancelling never deletes a
-- row. If a household resubscribes later, Stripe issues a brand new
-- subscription object with a new ID, which becomes a brand new row here
-- — the old, now-canceled row is simply left in place as history.

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),

  household_id uuid not null
    references public.households(id)
    on delete restrict,

  stripe_subscription_id text not null,
  stripe_price_id text not null,

  -- Mirrors Stripe's own subscription status values exactly, so the
  -- webhook handler can always store whatever Stripe reports without a
  -- translation step.
  status text not null
    check (status in (
      'trialing', 'active', 'past_due', 'canceled',
      'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )),

  current_period_end timestamptz,

  -- True the moment a customer requests cancellation; the subscription
  -- itself stays in its current status (usually 'active') until Stripe
  -- actually ends it at period end and fires customer.subscription.deleted.
  cancel_at_period_end boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency key for the webhook: every Stripe event for a given
-- subscription carries the same stripe_subscription_id, so the handler
-- can always `insert ... on conflict (stripe_subscription_id) do update`
-- — a retried or duplicate-delivered event re-applies the same state
-- instead of creating a second row.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'subscriptions_stripe_subscription_id_key'
      and conrelid = 'public.subscriptions'::regclass
  ) then
    alter table public.subscriptions
      add constraint subscriptions_stripe_subscription_id_key
      unique (stripe_subscription_id);
  end if;
end
$$;

-- Prevents the one genuinely impossible state for this product (a
-- household with two simultaneously live subscription objects) without
-- ever blocking history. "Live" here means every status Stripe could
-- still transition further (including recover from) — trialing/active/
-- past_due/incomplete/unpaid/paused — leaving out only the two states
-- Stripe itself never revives (canceled, incomplete_expired), which can
-- freely accumulate as history alongside a later, genuinely new
-- subscription for the same household.
create unique index if not exists subscriptions_one_live_per_household
  on public.subscriptions (household_id)
  where status in (
    'trialing', 'active', 'past_due',
    'incomplete', 'unpaid', 'paused'
  );

create index if not exists subscriptions_household_id_idx
  on public.subscriptions (household_id);

create index if not exists subscriptions_status_idx
  on public.subscriptions (status);

create index if not exists subscriptions_stripe_price_id_idx
  on public.subscriptions (stripe_price_id);

drop trigger if exists subscriptions_set_updated_at
  on public.subscriptions;

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row
  execute function public.hcg_set_updated_at();

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_select_own_household
  on public.subscriptions;

create policy subscriptions_select_own_household
  on public.subscriptions
  for select
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

-- RLS policies alone are not enough — see 007_grant_authenticated_household_reads.sql
-- and 009_service_role_minimum_app_privileges.sql: a role needs the base
-- table grant before Postgres ever evaluates a policy. No insert/update/
-- delete grant is given to authenticated here, by design.
grant select on public.subscriptions to authenticated;

-- ------------------------------------------------------------
-- Entitlements — "does this household currently have the right to use
-- the service", independent of whether a Stripe subscription exists.
-- ------------------------------------------------------------
--
-- Historical rows are preserved the same way as subscriptions: a change
-- in access (trial -> paid -> promotion -> expired) is a new row, not an
-- overwrite of the old one. The partial unique index below guarantees
-- at most one row per household can be 'active' at any moment — scoped
-- to household_id alone, deliberately not (household_id, entitlement_type):
-- Decision 009 frames "is this household protected" as a single
-- yes/no check against one active row, not one per type, so a
-- transition between entitlement types (e.g. complimentary -> paid) must
-- explicitly expire/revoke the old active row in the same operation
-- that inserts the new one, rather than silently allowing two different
-- active grants to coexist.

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),

  household_id uuid not null
    references public.households(id)
    on delete restrict,

  entitlement_type text not null
    check (entitlement_type in (
      'paid_subscription', 'free_trial', 'founding_offer',
      'promotion', 'complimentary', 'partner', 'staff'
    )),

  status text not null
    check (status in ('scheduled', 'active', 'expired', 'revoked')),

  starts_at timestamptz not null default now(),
  ends_at timestamptz,

  -- Deliberately not constrained to a fixed enum: Decision 009 names
  -- 'stripe' and 'admin_manual' as the two values in use today, but
  -- unlike entitlement_type/status it was never given an exhaustive
  -- list, and future sources (e.g. a partner-referral tool) shouldn't
  -- require a schema migration just to add a label.
  source text not null,

  -- Populated for source = 'stripe' rows: the Stripe subscription ID
  -- this entitlement tracks. Null for admin-granted access, which has
  -- no corresponding Stripe object.
  external_reference text,

  notes text,

  created_at timestamptz not null default now(),

  -- The admin user who manually granted this entitlement, if any.
  -- Null for entitlements created by the webhook (no human actor) and
  -- preserved (not cascaded away) if that admin's own account is later
  -- deleted — same on-delete-set-null pattern as households.auth_user_id.
  created_by uuid
    references auth.users(id)
    on delete set null,

  updated_at timestamptz not null default now(),

  check (ends_at is null or ends_at > starts_at)
);

-- Prevents the one genuinely impossible state for this product (a
-- household simultaneously holding two active entitlements, of any
-- type) without blocking history: only 'active' is covered, so any
-- number of scheduled/expired/revoked rows can coexist per household.
create unique index if not exists entitlements_one_active_per_household
  on public.entitlements (household_id)
  where status = 'active';

create index if not exists entitlements_household_id_idx
  on public.entitlements (household_id);

create index if not exists entitlements_entitlement_type_idx
  on public.entitlements (entitlement_type);

create index if not exists entitlements_status_idx
  on public.entitlements (status);

create index if not exists entitlements_ends_at_idx
  on public.entitlements (ends_at);

drop trigger if exists entitlements_set_updated_at
  on public.entitlements;

create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row
  execute function public.hcg_set_updated_at();

alter table public.entitlements enable row level security;

drop policy if exists entitlements_select_own_household
  on public.entitlements;

create policy entitlements_select_own_household
  on public.entitlements
  for select
  to authenticated
  using (
    household_id in (
      select id from public.households where auth_user_id = auth.uid()
    )
  );

grant select on public.entitlements to authenticated;

-- ------------------------------------------------------------
-- Stripe webhook events — dedup + audit log, keyed by Stripe's own
-- event ID.
-- ------------------------------------------------------------
--
-- Subscription upserts and the entitlement partial-unique-index above
-- only protect their own tables from a duplicate write; they do nothing
-- to stop a redelivered webhook event (Stripe retries on any non-2xx
-- response or timeout) from re-running other side effects.
--
-- Claim/retry semantics by status (corrected during review — an earlier
-- draft of this table used a plain "on conflict do nothing", which would
-- have meant "row already exists" permanently suppressed retries after a
-- failed or interrupted attempt, forever stuck as 'received'):
--
--   processed / ignored -> terminal. Return 200, never reprocess.
--   failed              -> always eligible for retry immediately.
--   received, fresh     -> another request is actively processing this
--                          event right now (processing_started_at is
--                          recent). Return 200, do not reprocess
--                          concurrently.
--   received, stale     -> a prior attempt was interrupted (crash/
--                          timeout) before it could reach a terminal
--                          status. processing_started_at is older than
--                          the app's staleness threshold (e.g. 2
--                          minutes) -> eligible for retry/recovery.
--
-- The handler expresses all four cases in one statement:
--
--   insert into stripe_webhook_events
--     (stripe_event_id, event_type, stripe_customer_id, household_id,
--      payload, status, attempt_count, last_attempt_at, processing_started_at)
--   values ($1, $2, $3, $4, $5, 'received', 1, now(), now())
--   on conflict (stripe_event_id) do update
--     set attempt_count = stripe_webhook_events.attempt_count + 1,
--         last_attempt_at = now(),
--         processing_started_at = now()
--     where stripe_webhook_events.status = 'failed'
--        or (
--          stripe_webhook_events.status = 'received'
--          and stripe_webhook_events.processing_started_at
--            < now() - interval '2 minutes'
--        )
--   returning stripe_event_id;
--
-- A row coming back means this request just legitimately claimed the
-- event (first attempt, or a valid retry) and should proceed to handle
-- it. No row coming back means processed/ignored (done), or received-
-- and-fresh (someone else has it right now) — either way, return 200
-- and do nothing further.
--
-- household_id and stripe_customer_id are both nullable and best-effort:
-- some events may arrive before household resolution is possible (e.g.
-- lookup failure), and every event should still be recorded regardless.
--
-- Deliberately no authenticated access at all — not even scoped to a
-- household — unlike subscriptions/entitlements above. This is an
-- internal ops/audit table that may hold another household's raw event
-- payload before resolution succeeds; it is not customer-facing.

create table if not exists public.stripe_webhook_events (
  stripe_event_id text primary key,

  event_type text not null,

  stripe_customer_id text,

  household_id uuid
    references public.households(id)
    on delete set null,

  -- Full, unredacted event payload as delivered by Stripe. Deliberate:
  -- this is the only durable record of exactly what Stripe sent (needed
  -- to safely reprocess a failed event without re-fetching from Stripe's
  -- API, and for audit/dispute resolution), and it is not payment-
  -- sensitive in the PCI sense — Stripe never includes a raw card
  -- number/CVV in any webhook payload, only things like customer email,
  -- a card's last 4 digits, and invoice amounts, all of which this app
  -- already legitimately handles. This column is the single place that
  -- data lives: no authenticated policy exposes it (see below), and the
  -- webhook handler must log at most the event type/ID/outcome to the
  -- application's own console/error logs, never the full payload.
  payload jsonb not null,

  status text not null default 'received'
    check (status in ('received', 'processed', 'failed', 'ignored')),

  -- Incremented on every claimed attempt (first insert counts as 1).
  -- Lets a later admin/ops query distinguish "failed once" from
  -- "failed repeatedly", without needing a separate history table.
  attempt_count integer not null default 0,

  -- Wall-clock time of the most recent attempt, successful or not.
  last_attempt_at timestamptz,

  -- Set at the start of whichever attempt is currently "in flight" for
  -- this event. Only meaningful while status = 'received': that is what
  -- the claim query's staleness check above compares against to tell a
  -- crashed/interrupted attempt apart from one still genuinely running.
  -- Left populated (not cleared) once a terminal status is reached, as
  -- a simple audit trail of when the winning attempt began.
  processing_started_at timestamptz,

  error text,

  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists stripe_webhook_events_household_id_idx
  on public.stripe_webhook_events (household_id);

create index if not exists stripe_webhook_events_event_type_idx
  on public.stripe_webhook_events (event_type);

create index if not exists stripe_webhook_events_received_at_idx
  on public.stripe_webhook_events (received_at);

-- Supports both the claim query's WHERE clause (status = 'failed', or
-- status = 'received' filtered further by processing_started_at) and
-- ops/monitoring queries like "show me every failed event right now".
create index if not exists stripe_webhook_events_status_idx
  on public.stripe_webhook_events (status);

alter table public.stripe_webhook_events enable row level security;

-- No policy is created here, intentionally — see the table comment
-- above. RLS enabled with zero policies means default-deny for every
-- role except service_role (which bypasses RLS entirely once granted
-- the base table privilege in migration 012).

commit;
