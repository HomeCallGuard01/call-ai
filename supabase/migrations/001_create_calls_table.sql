-- Sprint 6: Reliable Call History
--
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New query)
-- BEFORE deploying the updated server.js.
--
-- Access model: RLS is enabled with NO policies for anon/authenticated.
-- The table is reachable only via the service_role key, used exclusively
-- by server.js for calls-table operations. The existing anon key continues
-- to serve `contacts`, unchanged this sprint.
--
-- Manual step required after running this: add SUPABASE_SERVICE_ROLE_KEY
-- to .env (Supabase Project Settings > API > service_role key), then
-- restart the server.

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  household_id uuid,
  call_sid text unique,
  number text not null,
  status text not null check (status in ('Known', 'Unknown')),
  result text not null check (result in ('SAFE', 'SCAM')),
  decision_reason text,
  risk_score numeric check (risk_score is null or (risk_score >= 0 and risk_score <= 100)),
  processing_time_ms integer check (processing_time_ms is null or processing_time_ms >= 0),
  call_duration integer check (call_duration is null or call_duration >= 0),
  ai_model text,
  created_at timestamptz not null default now()
);

create index if not exists calls_created_at_idx on calls (created_at desc);
-- No separate call_sid index: the `unique` constraint already creates one.
-- household_id composite index deferred to Sprint 7 (Customer Identity),
-- once household_id is actually populated.

alter table calls enable row level security;

-- Intentionally no policies for anon/authenticated: default-deny.
-- Access is via the service_role key only, from server.js.
