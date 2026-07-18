Document: Sprint 8 Work Log
Version: 2.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): Sprint 8

---

# Sprint 8 — Work Log

## Work completed

1. **Diagnosis** — before writing any migration, confirmed directly
   against the live project (anon key, no service-role) that authenticated
   writes to `households`/`user_roles` were blocked:
   ```
   INSERT households  → 42501 permission denied for table households
   UPDATE households   → 42501 permission denied for table households
   INSERT user_roles   → 42501 permission denied for table user_roles
   ```
   Cross-checked against `002_create_households_and_roles.sql`'s actual
   policy definitions (select-only for `authenticated` on both tables) —
   confirmed this was blocked at both the grant layer and the RLS layer,
   by design, not by accident.

2. **Migration 006 written, reviewed, and applied** — see
   `DECISIONS.md` and `VERIFICATION.md`.

3. **`server.js` wired to the authenticated-user path**:
   - `buildUserScopedClient()` — builds a fresh Supabase client per
     request, scoped to one user's own session (`persistSession: false`,
     `autoRefreshToken: false`), never the service-role key. Reused by
     `/register`, `/login`, and `/reset-password-complete`.
   - `ensureHouseholdAndRole(userClient, userId, email, logPrefix)` —
     idempotent: selects the user's own household/role first and only
     writes what's missing (claim the legacy default household, or insert
     a new one; insert the `household` role).
   - `/register` only reaches this on the branch where `signUp()` returns
     a session immediately (only if email confirmation is ever disabled
     later) — on the live path it redirects to the branded success state
     without attempting any write.
   - `/login` is the actually-reachable path: after `signInWithPassword`
     succeeds, calls `ensureHouseholdAndRole` before setting cookies and
     redirecting to `/dashboard`. On failure, redirects to
     `/login.html?error=setup_failed` instead of continuing to the
     dashboard in a broken state.

4. **First-login testing surfaced a second, follow-on permission issue**:
   login failed at the household-lookup step with `permission denied for
   table households`. Diagnosed as a missing table-level `SELECT` grant
   for `authenticated` on both `households` and `user_roles` — distinct
   from Migration 006's `INSERT`/`UPDATE` grants, and distinct from RLS
   (RLS policies existed and were correct; the query never got far enough
   to reach them). Confirmed via a live
   `information_schema.role_table_grants` query pasted into the
   conversation, which showed `SELECT` genuinely absent for both tables.

5. **Migration 007 written and reviewed**
   (`007_grant_authenticated_household_reads.sql`) — adds exactly:
   ```sql
   grant select on public.households to authenticated;
   grant select on public.user_roles to authenticated;
   ```
   Additive only; does not touch migrations 002 or 006. Applied — see
   `VERIFICATION.md` for the evidence and its limits (behavioral, not
   independently re-queried).

6. **Registration and login walkthrough attempted end to end** — see
   `VERIFICATION.md` for the graded results per step. Registration,
   login, household creation, and role creation all have direct log
   evidence. Email-delivery diagnosis and row-level SQL verification of
   the created rows remain open (see `VERIFICATION.md`, "Outstanding").

## Files changed

- `supabase/migrations/006_authenticated_household_self_service.sql` (new)
- `supabase/migrations/007_grant_authenticated_household_reads.sql` (new)
- `server.js` — `buildUserScopedClient`, `ensureHouseholdAndRole`,
  `/register` and `/login` wiring, `/reset-password-complete` refactored
  to reuse `buildUserScopedClient`, temporary debug logging.

## Database changes

Migration 006 — additive only, does not modify or replace anything in
migration 002:

```sql
grant insert, update on public.households to authenticated;
grant insert on public.user_roles to authenticated;
```

- **`households_insert_own`** (INSERT) — `auth_user_id = auth.uid() and
  lower(email) = lower(auth.jwt() ->> 'email')`
- **`households_claim_default`** (UPDATE) — `using (auth_user_id is null
  and email = 'default-household@homecallguard.internal')`, `with check
  (auth_user_id = auth.uid() and lower(email) = lower(auth.jwt() ->>
  'email'))`
- **`user_roles_insert_own_household_role`** (INSERT) — `auth_user_id =
  auth.uid() and role = 'household'`

Migration 007 — additive only, does not modify or replace anything in
migrations 002 or 006:

```sql
grant select on public.households to authenticated;
grant select on public.user_roles to authenticated;
```
