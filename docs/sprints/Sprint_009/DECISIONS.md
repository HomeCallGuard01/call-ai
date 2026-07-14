Document: Sprint 9 – Decisions
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 9

---

# Sprint 9 – Decisions

**Treat the dashboard bug as a full household-isolation sprint, not a
patch.** What started as "dashboard shows an error" turned out to be a
real cross-household data leak once traced (unfiltered service-role
`calls` queries, never-set `household_id` on write, and `contacts` still
on permissive development policies). Scoped as its own sprint rather than
folded quietly into a "bug fix" so the full extent got addressed and
tested, not just the visible symptom.

**Verify `contacts` RLS before writing any migration, not after.** A live
`pg_policies` query was required and reviewed before Migration 008 was
drafted, confirming the exact two legacy policy names rather than
assuming or dynamically dropping every policy on the table.

**Least-privilege audit before Migration 009, not a broad grant.** Rather
than granting `service_role` full CRUD on all four tables to unblock
testing quickly, every call site was inspected for actual reachability
first. This found two dead functions and narrowed the grant to exactly
`SELECT`/`INSERT` where needed — no `UPDATE`/`DELETE` anywhere, since no
live code path performs either via `service_role`.

**`service_role` still needs table grants despite `BYPASSRLS`.**
Confirmed directly (not assumed) when a validly-signed `service_role` JWT
still got `permission denied` — `BYPASSRLS` only skips RLS policy
evaluation, it doesn't substitute for the base table grant, which these
tables never received because they were created via raw SQL rather than
the Table Editor.

**Fail safe, not fail open, for unmatched Twilio numbers.** If
`getHouseholdByTwilioNumber` returns no match, `/voice`/`/process` now
skip the contacts query entirely and never write a call row — rather than
falling back to a global, unscoped query (the previous behavior) or
writing a call with a `null` household_id.

**Test with real end-to-end sessions, not shortcuts.** Verification used
the actual `/register`→`/login` flow (via the service-role Admin API to
create confirmed test users, avoiding the need for a real inbox) and the
actual `/dashboard-data`/`/upload-contacts`/`/logs` routes — plus a
direct Supabase REST call bypassing `server.js` entirely, to prove RLS
itself enforces isolation, not just the app's own query filters.
