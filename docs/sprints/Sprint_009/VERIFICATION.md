Document: Sprint 9 – Verification
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 9

---

# Sprint 9 – Verification

All 7 planned tests passed. No failures encountered during this run.

## 1. Service-role reads households successfully

Direct query via `supabaseAdmin.from("households").select("id")` — `OK`,
after the service-role key rotation and Migration 009.

## 2. Authenticated login

Two disposable test households (A, B) created via the service-role Admin
API (`auth.admin.createUser`, `email_confirm: true` — no real inbox
needed) and logged in through the actual `/login` route. Server log
confirmed the full sequence for both:
```
[LOGIN] User authenticated
[LOGIN] Checking household
[LOGIN] Household exists? false
[LOGIN] Creating household...
[LOGIN] Household created
[LOGIN] Creating role...
[LOGIN] Role created
[LOGIN] Redirect dashboard
```

## 3 & 4. Household A and B dashboards

Both `GET /dashboard-data` calls (with each household's real session
cookie) returned `200` with valid JSON, no redirect, no error — confirms
`requireAuth` correctly resolves each household via the now-working
service-role client.

## 5. Contacts remain isolated

Uploaded distinct CSVs to each household via the real `/upload-contacts`
route. Result:
- Household A (`92120b02-...`): sees exactly Alice and Bob (2 contacts)
- Household B (`7e1dc2ff-...`): sees exactly Carol (1 contact)

Confirmed both via the app (`/dashboard-data`, `/test-get-contacts`) and,
separately, via a direct Supabase REST call bypassing `server.js`
entirely using each household's own access token — proving RLS itself
enforces the isolation, not just the app's query filter:
```
As A - direct REST read, row count: 2 [ 'Alice Household A', 'Bob Household A' ]
As B - direct REST read, row count: 1 [ 'Carol Household B' ]
```

## 6. Calls remain isolated

Inserted one `SAFE` call tagged to household A and one `SCAM` call tagged
to household B (via `service_role`'s `INSERT`, the same privilege
`logCall()` itself uses). Result:
- A's `/logs` and `/dashboard-data`: only the `SAFE` call to
  `+447700900099`, `callsToday: 1, safe: 1, blocked: 0`
- B's `/logs` and `/dashboard-data`: only the `SCAM` call to
  `+447700900098`, `callsToday: 1, safe: 0, blocked: 1`

No cross-contamination in either direction.

## 7. Unmatched Twilio numbers fail safely

- **Matched** (`To=+441615700779`, the one real household with a
  registered number): resolved silently and correctly — no error logged,
  and the resulting call row was confirmed written with the correct
  `household_id` (`e10c267b-...`).
- **Unmatched** (`To=+19995550000`, nobody's number): logged
  `CALL ROUTING ERROR: no household matches dialled number +19995550000`
  and `CALL LOG SKIPPED: no household matches dialled number
  +19995550000` — confirmed via direct query that **no call row was
  written** for this attempt at all.

## Known follow-up, not a failure

Disposable test data (two test auth users/households, 3 test contacts, 3
test calls) remains in the database, clearly named
(`sprint9-test-a/b-...@example.com`, `Household A`/`Household B`
contacts). `service_role` correctly has no `DELETE` grant on any of these
tables per Migration 009, so it cannot be cleaned up via the app's own
privilege model — this is expected, not a bug. Manual cleanup SQL can be
provided on request.
