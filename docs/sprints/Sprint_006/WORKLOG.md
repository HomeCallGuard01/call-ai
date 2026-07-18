Document: Sprint 6 – Reliable Call History — Work Log
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 6

---

# Sprint 6 – Reliable Call History — Work Log

## Work completed

Per `docs/PROJECT_STATUS.md` and commit `dcee78e` ("Sprint 6 Complete:
Reliable Call History", 2026-07-11):

- New `calls` table in Supabase (`supabase/migrations/001_create_calls_table.sql`):
  `id`, `household_id` (nullable, unused until Sprint 7), `call_sid`
  (unique), `number`, `status`, `result`, `decision_reason`, `risk_score`,
  `processing_time_ms`, `call_duration`, `ai_model`, `created_at`. Check
  constraints on `status`, `result`, `risk_score` range, and non-negative
  `processing_time_ms`/`call_duration`.
- Removed the in-memory `callLogs` array from `server.js` entirely.
- `/process` writes every screened call via `logCall()`, fired without
  blocking the Twilio response.
- Idempotency: `logCall()` upserts on `call_sid` with
  `ignoreDuplicates: true` (`INSERT ... ON CONFLICT (call_sid) DO NOTHING`).
- Populated this sprint: `call_sid`, `ai_model` (only when the OpenAI
  branch runs), `processing_time_ms`.
- `/dashboard-data` computes `protectedContacts`, `callsToday`, `blocked`,
  `safe`, `recentCalls` from live Supabase queries.
- `/logs` reads from Supabase (capped at 200 rows) instead of the deleted
  array.
- Security: `calls` has RLS enabled with no `anon`/`authenticated`
  policies at all (default-deny) — reachable only through a
  `service_role`-backed client, used exclusively for `calls` operations.
  `contacts` was left unchanged this sprint (still the anon-key client).
- Bug found and fixed during implementation: the service-role Supabase
  client was originally constructed unconditionally, which throws
  synchronously and crashes the entire server (not just call logging) if
  `SUPABASE_SERVICE_ROLE_KEY` is unset. Fixed before shipping — constructed
  only when the key is present, with every calls-table helper failing open.

## Files changed

Per `git show --stat dcee78e`: `PROJECT.md`, `docs/DECISIONS.md`,
`docs/PROJECT_STATUS.md`, `server.js`, `supabase/migrations/001_create_calls_table.sql`.

## Database changes

`supabase/migrations/001_create_calls_table.sql` — creates `calls` with
the columns and constraints listed above; RLS enabled, no policies.
