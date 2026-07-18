Document: Sprint 8 Overview
Version: 2.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): Sprint 8

---

# Sprint 8 — Customer Registration & Authentication (Least-Privilege)

## Objective

Let a newly authenticated customer create or claim their own `households`
row and their own `user_roles` row, using only their own authenticated
session — with no service-role key involved in the registration/login
flow at all.

## Scope

**In scope:**
- Migration 006: grants + RLS policies enabling the authenticated-user
  self-service path.
- `server.js`: replacing the service-role-based household/role creation
  with the authenticated-user path, wired into `/register` and `/login`.
- Temporary debug logging to verify the first-login flow.

**Explicitly out of scope:**
- `/voice`, `/process`, `/dashboard-data`, `/upload-contacts`, `/logs`,
  dashboard design — untouched.
- Wiring `requireAuth` middleware onto dashboard/contacts/calls routes
  (dashboard gating) — deferred to a later sprint.
- `005_household_rls.sql` (contacts/calls RLS) — stays a reviewed,
  unapplied draft for the post-launch phase.
- Password policy, password generator, eye-icon toggle, passkeys,
  penetration testing — deferred to `docs/ENGINEERING_ROADMAP.md`.

## Outcome

Migrations 006 and 007 both applied. Registration, login, household
creation, and household-role creation are all confirmed by direct server
log evidence, end to end through a real dashboard redirect (see
`VERIFICATION.md` for exactly what's confirmed vs. not). This sprint is
**not yet fully closed**: email-delivery diagnosis (why the confirmation
email wasn't received) was never answered, and the row-level SQL
verification of the created `households`/`user_roles` rows was proposed
but the query output was never shared back — both remain open.

## Next steps

1. Answer the four outstanding email-confirmation diagnostic questions
   (see `VERIFICATION.md`).
2. Run the proposed `households`/`user_roles` verification queries and
   record the actual output in `VERIFICATION.md`.
3. Independently re-confirm Migration 007 via a fresh grants/policy query,
   matching the rigor already applied to Migration 006.
4. Remove the temporary `[LOGIN]`/`[REGISTER]` debug logging once all of
   the above is confirmed stable.
5. Post-launch: revisit `005_household_rls.sql` (contacts/calls RLS) and
   the dashboard-gating work deferred from this sprint.
6. Track password policy / generator / eye-icon / passkeys / security
   testing per `docs/ENGINEERING_ROADMAP.md`.

---

See `WORKLOG.md` for work completed / files / database changes,
`DECISIONS.md` for decisions, and `VERIFICATION.md` for
verification / outstanding tests.
