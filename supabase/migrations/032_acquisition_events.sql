-- Acquisition/conversion analytics foundation -- privacy-minimised,
-- first-party, server-side only (2026-09).
--
-- Purpose: the private Business Dashboard has no visibility into
-- website traffic, registration/checkout funnel volume, or acquisition
-- source at all today (confirmed this session: no analytics script,
-- no UTM/referrer capture, no request logging anywhere in this
-- codebase). This adds exactly one new, append-only event log table --
-- no existing table or column is altered.
--
-- Explicitly NOT here, by design, matching the stated privacy
-- requirements: no fingerprinting identifier, no advertising ID, no
-- cross-site/cross-session identifier of any kind, no full IP address,
-- no full referrer URL (only the referring hostname is ever stored --
-- see services/acquisitionAnalytics.js's parseReferrerHost), no raw
-- user-agent string. household_id is the only identifying reference,
-- and only for the two event types that occur after a real,
-- authenticated household already exists (checkout_started,
-- paid_conversion) -- landing_visit/registration_submitted/
-- registration_completed always have household_id = null, since no
-- household exists yet at those points; this is a genuine, permanent
-- limitation of a cookie-free/session-free design, not an oversight --
-- see this build's own report for the full explanation.
--
-- Idempotency (2026-09, review correction): Stripe webhooks can be
-- retried/redelivered -- a single real subscription must never produce
-- more than one paid_conversion row. external_event_id carries Stripe's
-- own event.id (the authoritative, immutable identifier for that exact
-- webhook delivery) for paid_conversion rows, and the partial unique
-- index below enforces at the DATABASE level, not just in application
-- memory, that the same (event_type, external_event_id) pair can never
-- be inserted twice -- a replayed webhook's second insert attempt fails
-- with a unique-violation, which services/acquisitionAnalytics.js
-- treats as an expected, benign no-op, never a second analytics row and
-- never a logged error. Nullable and unused by the other four event
-- types today, which have no natural externally-issued identifier to
-- deduplicate against.
--
-- Additive, reversible, isolated: one new table, zero existing table
-- touched, ON DELETE SET NULL on household_id means this table can
-- never block a household deletion/anonymisation, and dropping this
-- table entirely (`drop table if exists public.acquisition_events;`)
-- has zero effect on any other feature -- nothing else references it,
-- and it references nothing calls/entitlements/subscriptions/auth
-- depend on. Cannot affect call routing, Twilio Voice, Media Streams,
-- transcription, scoring, entitlement/billing logic, or authentication
-- in any way -- it is a pure, independent, write-only-from-the-app
-- event log.

begin;

create table if not exists public.acquisition_events (
  id uuid primary key default gen_random_uuid(),

  event_type text not null
    check (event_type in (
      'landing_visit', 'registration_submitted', 'registration_completed',
      'checkout_started', 'paid_conversion'
    )),

  -- Only ever populated for checkout_started/paid_conversion -- see this
  -- migration's own header for why the earlier funnel stages cannot
  -- carry a household reference in a cookie-free design.
  household_id uuid
    references public.households(id)
    on delete set null,

  -- Authoritative external identifier for idempotent dedup -- see this
  -- migration's own header. Only populated for paid_conversion today
  -- (Stripe's event.id); null for every other event type.
  external_event_id text,

  utm_source text,
  utm_medium text,
  utm_campaign text,

  -- Hostname only (e.g. "google.com") -- never the full referrer URL,
  -- which can carry the referring page's own query string/path and
  -- therefore third-party information this app has no business storing.
  referrer_host text,

  -- Which page/route this event is about (e.g. '/' for a landing
  -- visit) -- a small fixed label, never a full URL with query string.
  path text,

  created_at timestamptz not null default now()
);

create index if not exists acquisition_events_event_type_created_at_idx
  on public.acquisition_events (event_type, created_at);

create index if not exists acquisition_events_household_id_idx
  on public.acquisition_events (household_id)
  where household_id is not null;

-- Database-level idempotency guard -- see this migration's own header.
-- Partial (only when external_event_id is actually present) so the
-- other four event types, which never populate this column, are
-- completely unaffected by this constraint.
create unique index if not exists acquisition_events_dedup_idx
  on public.acquisition_events (event_type, external_event_id)
  where external_event_id is not null;

alter table public.acquisition_events enable row level security;

-- No policy for `authenticated`/`anon` -- matches
-- account_classifications' exact precedent (migration 031): this table
-- is written and read exclusively by the app's own service-role
-- client (landing/registration/checkout/webhook handlers write it; the
-- admin dashboard reads it, gated by requireAuth + requireAdmin same
-- as every other business-metrics query). A customer/visitor has no
-- reason to ever read or write this table directly.

grant select, insert on public.acquisition_events to service_role;

commit;
