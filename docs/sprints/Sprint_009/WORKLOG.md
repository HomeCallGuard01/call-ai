Document: Sprint 9 – Work Log
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 9

---

# Sprint 9 – Work Log

## Work completed

1. **Diagnosis** (originated as a dashboard bug report): confirmed via
   direct code inspection that `getCallsToday()`/`getRecentCalls()` in
   `server.js` used `supabaseAdmin` with no `household_id` filter at all
   — any valid service-role key would return every household's calls
   combined. Also confirmed `logCall()` never set `household_id` on
   write, and `/dashboard-data` had no authentication at all.
2. **Contacts RLS verified before any change**: live `pg_policies` query
   showed exactly two permissive policies ("Allow development insert",
   "Allow development select"), both scoped to `anon`, both unrestricted
   — confirmed `contacts` was not household-isolated at all.
3. **Migration 008** written, reviewed, and applied: drops the two named
   legacy policies, revokes `anon`'s grants, adds household-scoped
   `SELECT`/`INSERT`/`UPDATE`/`DELETE` policies for `authenticated`.
4. **`server.js` changes**: wired `requireAuth` onto `/dashboard-data`,
   `/logs`, `/upload-contacts`, `/test-get-contacts`; replaced the inline,
   unscoped `getContacts()`/contacts-insert with the already-correct,
   household-scoped `database/contacts.js` functions; added a
   `householdId` parameter and filter to `getCallsToday`/`getRecentCalls`/
   `logCall`; `/voice` and `/process` now resolve the household via
   `getHouseholdByTwilioNumber(req.body.To)` and fail safely (no contacts
   query, no call write, clear operational error logged) when no
   household matches.
5. **Service-role key rotated** (manual step, by the user): the previous
   key was invalid; the new one is a genuine `service_role`-scoped JWT
   (confirmed by decoding its payload).
6. **Least-privilege audit performed before Migration 009**: every
   `supabaseAdmin` call site in the codebase was inspected function by
   function for which SQL operation it performs and whether it's
   currently reachable from a live route. Found two exported-but-unused
   functions (`claimOrCreateHousehold`, `setUserRole` in
   `database/households.js`) — dead code, superseded by
   `ensureHouseholdAndRole()`'s user-scoped approach.
7. **Migration 009** written, reviewed, and applied, granting
   `service_role` exactly what the audit showed was needed: `SELECT` on
   `households`/`user_roles`, `SELECT`+`INSERT` on `contacts`/`calls` —
   no `UPDATE`/`DELETE`/`TRUNCATE`/`TRIGGER`/`REFERENCES`.
8. **End-to-end household isolation test** performed via the real
   `/register`→`/login`→`/dashboard-data`/`/upload-contacts`/`/logs`
   routes (two disposable test households, created via the service-role
   Admin API so no real inbox was needed) — see `VERIFICATION.md`.

## Files changed

- `supabase/migrations/008_household_isolation_contacts.sql` (new)
- `supabase/migrations/009_service_role_minimum_app_privileges.sql` (new)
- `server.js` — `getContacts`/`insertContacts` now imported from
  `database/contacts.js` instead of an inline anon-key version;
  `getCallsToday`, `getRecentCalls`, `logCall` take a `householdId`
  parameter; `/dashboard-data`, `/logs`, `/upload-contacts`,
  `/test-get-contacts` behind `requireAuth`; `/voice`/`/process` resolve
  household via Twilio's `To` number.

## Database changes

- Migration 008: dropped `"Allow development insert"`/`"Allow development
  select"` on `contacts`; revoked `anon`'s `INSERT`/`SELECT`; granted
  `authenticated` `SELECT`/`INSERT`/`UPDATE`/`DELETE`; added
  `contacts_select_own_household`, `contacts_insert_own_household`,
  `contacts_update_own_household`, `contacts_delete_own_household`, all
  scoped via `household_id in (select id from households where
  auth_user_id = auth.uid())`.
- Migration 009: granted `service_role` `SELECT` on `households`/
  `user_roles`, `SELECT`+`INSERT` on `contacts`/`calls`.
