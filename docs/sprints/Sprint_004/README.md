Document: Sprint 4 Review
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 4

---

# Sprint 4 Review

## Objective

Connect Home Call Guard to a professional cloud backend.

## Scope

Set up Supabase as the project's cloud backend, secure the credentials
needed to reach it, and bring the contacts flow (table, CSV upload, RLS)
onto that backend.

## Outcome

Sprint successful. Home Call Guard now has a secure cloud backend ready
for persistent customer data.

Lessons learned:

- Always read the first error, never guess.
- Verify infrastructure before building features.
- Solve one layer at a time.
- Good architecture makes future features easier.

Technical debt: none identified. Risks: none identified.

Known issue at close: dashboard was still static (not yet reading live
data).

## Next steps

Display live contacts on the dashboard.

---

See `WORKLOG.md` for work completed / files / database changes,
`DECISIONS.md` for decisions, and `VERIFICATION.md` for
verification / outstanding tests.
