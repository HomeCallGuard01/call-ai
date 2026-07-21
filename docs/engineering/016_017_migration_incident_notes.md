Document: Migration 016/017 Application Incident — Notes
Version: 1.0
Last Updated: 2026-07-21
Status: Active
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — see docs/launch/KNOWN_ISSUES.md and docs/launch/FINAL_ACCEPTANCE_REPORT.md

---

# Migration 016/017 Application Incident — Notes

Working notes from a real, extended debugging session applying
`supabase/migrations/016_household_twilio_provisioning.sql`. Kept for
whoever next touches these migrations, or hits a similar symptom
elsewhere in this project.

## What happened

Running migration 016's full contents as one pasted script, wrapped in
its own `begin; ... commit;`, in the Supabase SQL Editor — repeatedly
reported success, but **verifiably changed nothing**: neither the four
new `households` columns nor the two new RPC functions existed afterward,
confirmed directly against `information_schema.columns`, `pg_proc`, and
PostgREST's own raw OpenAPI descriptor. This held even after:

- A manual `NOTIFY pgrst, 'reload schema';`
- A full Supabase project restart
- A live marker-column test (add a column, confirm via SQL, check
  PostgREST while it still existed, drop it) — the fresh marker was
  invisible to both PostgREST and the `supabase-js` application
  connection, instantly, with no propagation delay to blame

A close-matching, still-unresolved public report exists:
[supabase/supabase#42183](https://github.com/supabase/supabase/issues/42183)
— same symptom combination, no maintainer response, no confirmed root
cause. We could not find a definitive explanation either. Supabase
support was engaged in parallel with the workaround below.

## What actually worked

Splitting the same SQL into small, independent files — no surrounding
`BEGIN`/`COMMIT`, one concern per file — and running each as its own
statement:

1. `docs/engineering/sql/016_twilio_columns_only.sql` — the four
   `ALTER TABLE ... ADD COLUMN` clauses alone. **Succeeded independently**
   where the bundled version had not.
2. `docs/engineering/sql/016_twilio_backfill_only.sql` — the backfill
   `UPDATE` alone. Succeeded.
3. `docs/engineering/sql/016_twilio_assign_function_only.sql` — the
   `assign_household_twilio_number` function alone. Succeeded — and
   this isolation is what surfaced a real bug (below), which a bundled
   all-or-nothing run had been masking.
4. `record_household_twilio_provisioning_failure`, the grants, and the
   verification queries followed the same one-statement-at-a-time
   pattern.

**We don't have a confirmed root cause for why the bundled transaction
never landed.** The leading working theory — never proven — is an
interaction between our explicit `BEGIN`/`COMMIT` and the SQL Editor's
own transaction handling around multi-statement scripts. Recorded as a
theory, not a fact: if this happens again on migration 017 or a future
migration, the statement-by-statement approach here is the known-working
fallback, not necessarily the explanation.

## A real bug, found because of the isolation

`assign_household_twilio_number`'s originally-shipped body:

```sql
select h.twilio_number, true
  into v_existing, v_found
  from public.households h
  where h.id = p_household_id
  for update;

if not v_found then
  raise exception '...';
end if;
```

When the `WHERE` clause matches **zero rows**, PL/pgSQL sets *every*
`SELECT INTO` target variable to `NULL` — not `false`. So `v_found`
became `NULL`, `not v_found` evaluated to `NULL` under three-valued
logic, and an `IF` treats a `NULL` condition as not-true — the "household
does not exist" branch silently never fired. A nonexistent household id
fell through to a no-op `UPDATE` (zero rows affected, not an error) and
the function returned `true` as if it had succeeded.

Confirmed directly: calling the deployed function with
`00000000-0000-0000-0000-000000000000` returned `true`, no error.

**Fix:** use Postgres's built-in `FOUND` variable (automatically
`true`/`false`, never `NULL`, reflecting whether the immediately
preceding statement matched a row) instead of a manually-selected flag.
See `docs/engineering/sql/016_twilio_assign_function_fix.sql` for the
exact deployed fix, and the regression test added to
`tests/migrations.pglite.test.mjs` ("assign_household_twilio_number
raises 'does not exist' for a nonexistent household rather than silently
no-opping").

**Lesson for future RPCs in this codebase:** never use
`select ..., true into val, found_flag ... ` to detect row existence.
Use plain `select ... into val` followed by `if not found then`.

## What this means for migration 017

`017_household_twilio_number_lifecycle.sql` was written and tested
against pglite in the same session as 016, using the same bundled
transaction shape 016 turned out not to survive. It has **not** been
independently re-verified against the real database the way 016 now has.
One of its four functions
(`cancel_household_twilio_number_pending_release`) was directly confirmed
missing via a live application call on 2026-07-21. Treat the whole file
as unconfirmed — not necessarily broken, just unverified — until it goes
through the same staged, one-statement-at-a-time repair as 016. Tracked
as a separate outstanding item in `docs/launch/KNOWN_ISSUES.md`.

## Verified working end-to-end (2026-07-21)

With 016's repair complete, a full real-Twilio-API test (test Stripe
mode, real Twilio credentials, a temporary ngrok tunnel standing in for
a public `APP_URL`) confirmed the entire provisioning path actually
reaches Twilio's real purchase endpoint. It stopped there only on a
genuine business requirement — Twilio requires a registered `Address`
object (`AddressSid`) for UK local number purchases — not a code defect.
No number was purchased, no charge occurred (confirmed directly against
the Twilio account), and the failure was correctly recorded on the
household (`twilio_provisioning_status: 'failed'`, `attempts: 1`,
`last_error` holding Twilio's exact message). See
`docs/launch/KNOWN_ISSUES.md` for the current status of this blocker.
