Document: Sprint 6 – Reliable Call History — Verification
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 6

---

# Sprint 6 – Reliable Call History — Verification

## Verification

At the time `docs/PROJECT_STATUS.md` was written, success criteria were
recorded as: "Restart server → dashboard still shows previous calls:
pending manual migration + key," "Recent activity remains available:
pending manual migration + key," "Statistics generated from database:
pending manual migration + key," and "No functionality lost: confirmed."
The manual steps required were running the migration in the Supabase SQL
Editor and adding `SUPABASE_SERVICE_ROLE_KEY` to `.env`.

Later evidence (from Sprint 8 testing, this repository's own history)
confirms the `calls` table itself did get created at some point — Sprint
7's migrations (003, 004) reference and backfill `calls.household_id`
against an existing table. However, Sprint 8 testing also directly
observed `SUPABASE CALLS READ ERROR: Invalid API key` at runtime, meaning
the `SUPABASE_SERVICE_ROLE_KEY` value in `.env` was invalid at that later
point — whether it was ever valid in between is not recorded.

## Outstanding tests

As of Sprint 8, the `calls`-table service-role read path is still failing
(`Invalid API key`) — this was flagged during Sprint 8 work as a known,
separate, unresolved issue, not fixed as part of any sprint documented so
far.
