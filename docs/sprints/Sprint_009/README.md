Document: Sprint 9 – Complete Household Isolation
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 9

---

# Sprint 9 – Complete Household Isolation

## Objective

Ensure no household can ever see or modify another household's contacts
or calls, across every layer — RLS, table grants, and application code —
not just the dashboard bug that first surfaced the problem.

## Scope

`contacts` RLS, `service_role` table grants, and every server.js route/
function that reads or writes `contacts` or `calls`
(`/dashboard-data`, `/logs`, `/upload-contacts`, `/test-get-contacts`,
`/voice`, `/process`). No changes to Twilio call-screening logic itself,
authentication routes, or unrelated files.

## Outcome

All 7 planned verification tests passed (see `VERIFICATION.md`). Fixes
the dashboard bug that started this sprint, closes the cross-household
data leak in `getCallsToday`/`getRecentCalls`/`logCall`, and removes the
legacy permissive `contacts` policies entirely.

## Next steps

- Update `LAUNCH_CHECKLIST.md` items #5 (upload contacts), #7 (calls
  screened correctly), #8 (working dashboard) to reflect this fix.
- Disposable test data created during verification (two test households,
  test contacts, test calls) is left in the database, clearly named —
  `service_role` correctly has no `DELETE` grant to clean it up itself;
  manual cleanup SQL can be provided if wanted.
- Migration `005_household_rls.sql` (the broader, still-frozen
  contacts/calls RLS draft from Sprint 7) remains superseded in part by
  this sprint's narrower `008`/`009` — still not applied, no action taken.

---

See `WORKLOG.md` for work completed / files changed / database changes,
`DECISIONS.md` for decisions, and `VERIFICATION.md` for the full test
evidence.
