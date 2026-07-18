Document: Sprint 7 – Household Identity
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 7

---

# Sprint 7 – Household Identity

## Objective

Per `docs/PROJECT_STATUS.md`'s roadmap section (written during Sprint 6,
before this sprint started): introduce household records, ownership, and
authentication groundwork — specifically a `households` table,
`contacts.household_id`/`calls.household_id` backfilled and FK-constrained,
Supabase Auth wiring (`auth_user_id`), and real per-row RLS on
`contacts`/`calls` keyed on `auth.uid()`.

## Scope

Database schema and RLS foundations only. Building the actual
registration/login flow that uses this schema was explicitly deferred and
became Sprint 8.

## Outcome

The household/role data model and ownership columns are live in
production. Full row-level security enforcement on `contacts` and `calls`
was designed and reviewed but deliberately not shipped this sprint.

## Next steps

Sprint 8 – Customer Registration & Authentication, built directly on this
sprint's schema (see `docs/sprints/Sprint_008/README.md`).

---

See `WORKLOG.md` for work completed / files / database changes,
`DECISIONS.md` for decisions, and `VERIFICATION.md` for
verification / outstanding tests.
