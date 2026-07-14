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

2. **Migration 006 written and reviewed** — see Database changes below.

3. **Migration 006 applied** in the Supabase SQL Editor (no DB execution
   tool is available in this environment — every migration in this
   project has been applied this way) and verified — see Verification
   below.

4. **`server.js` wired to the authenticated-user path**:
   - `buildUserScopedClient()` — builds a fresh Supabase client per
     request, scoped to one user's own session (`persistSession: false`,
     `autoRefreshToken: false`), never the service-role key. Reused by
     `/register`, `/login`, and `/reset-password-complete` (which already
     needed the identical pattern).
   - `ensureHouseholdAndRole(userClient, userId, email, logPrefix)` —
     idempotent: selects the user's own household/role first and only
     writes what's missing (claim the legacy default household, or insert
     a new one; insert the `household` role).
   - `/register` only reaches this on the branch where `signUp()` returns
     a session immediately (i.e. only if email confirmation is ever
     disabled later) — on the live path it redirects to the branded
     success state without attempting any write.
   - `/login` is the actually-reachable path: after `signInWithPassword`
     succeeds, calls `ensureHouseholdAndRole` before setting cookies and
     redirecting to `/dashboard`. On failure, redirects to
     `/login.html?error=setup_failed` instead of continuing to the
     dashboard in a broken state.

## Decisions

**Least privilege over service-role.** Chosen over fixing the (separately
discovered, invalid) `SUPABASE_SERVICE_ROLE_KEY` and routing registration
through `supabaseAdmin`. Explicit team preference, only acted on after the
service-role alternative was proven necessary-or-not with direct evidence
(the anon-key diagnosis above), not assumed.

**Household/role creation happens at first login, not at registration.**
Email confirmation is required and stays required for launch (explicitly
not disabled to make testing easier). `signUp()` never returns a session,
so there's no authenticated context to act under until the user confirms
and logs in. The write is idempotent, so it's safe on every login, not
just the first.

**`households_claim_default` narrowed to the specific legacy household.**
The original draft matched any household with `auth_user_id is null`.
Narrowed to also require `email = 'default-household@homecallguard.internal'`
(the one row created by migration 004), so no future unrelated unowned
household could ever be claimed by this policy.

**Both household-write policies require the JWT-verified email.** Without
this, a user could insert or claim a household naming themselves as owner
but carrying an arbitrary email address. `lower(email) = lower(auth.jwt()
->> 'email')` was added to both `households_insert_own` and
`households_claim_default` — the second only after a review pass caught
the asymmetry between the two.

**`role = 'household'` kept lowercase.** A claim was raised mid-sprint that
the constraint used uppercase values. Checked directly against
`002_create_households_and_roles.sql` rather than assumed — the deployed
constraint (`check (role in ('admin', 'support', 'household'))`) is
lowercase, matching the server-side insert. Proceeding with uppercase as
originally suggested would have made every first-login role creation fail
silently against the real constraint.

**Migration 005 stays frozen.** Out of scope for this sprint's goal (a
working, secure registration/login flow). Left in the repo as a reviewed
draft for the post-launch phase.

**Password policy, generator, eye-icon, passkeys, security testing —
deferred.** Captured in `docs/ENGINEERING_ROADMAP.md` as explicit
post-MVP/pre-public-launch work, so this sprint could stay scoped to a
working authentication flow.

## Files changed

- `supabase/migrations/006_authenticated_household_self_service.sql` (new)
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

## Verification

**Migration 006 — confirmed applied successfully.** Verified with:

```sql
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('households', 'user_roles')
  and grantee = 'authenticated';

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('households', 'user_roles')
order by tablename, policyname;
```

`pg_policies` result — 5 rows, all confirmed matching the migration exactly:

| Table | Policy | Cmd | qual | with_check |
|---|---|---|---|---|
| households | `households_select_own` | SELECT | `auth_user_id = auth.uid()` | — |
| households | `households_insert_own` | INSERT | — | `auth_user_id = auth.uid() AND lower(email) = lower(auth.jwt() ->> 'email')` |
| households | `households_claim_default` | UPDATE | `auth_user_id IS NULL AND email = 'default-household@homecallguard.internal'` | `auth_user_id = auth.uid() AND lower(email) = lower(auth.jwt() ->> 'email')` |
| user_roles | `user_roles_select_own` | SELECT | `auth_user_id = auth.uid()` | — |
| user_roles | `user_roles_insert_own_household_role` | INSERT | — | `auth_user_id = auth.uid() AND role = 'household'` |

No extra or unexpected policies. GRANTs for `authenticated` confirmed
present (INSERT/UPDATE on `households`, INSERT on `user_roles`, alongside
the pre-existing SELECT).

**`server.js` — smoke-tested, no regressions.** Syntax-checked
(`node -c server.js`); `/register.html` and `/login.html` still serve
`200`; `/dashboard-data` still returns live stats unaffected.

## Outstanding tests

**Pending — not yet completed or reported as of this document.** The
full first-login flow has not yet been walked through end to end:

1. Register a fresh test account at `/register.html`.
2. Confirm the account via the real confirmation email (requires a real
   inbox — can't be done by the assistant).
3. Log in at `/login.html`.
4. Expected server log sequence on that first login:
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
5. Confirm landing on `/dashboard`.
6. Log out and log back in a second time — expect `Household exists? true`
   and no creation lines, proving idempotency.

Do not mark this section complete until each step has actually been run
and the log output confirmed.

## Outcome

Migration 006 applied and verified successfully (grants + all 5 RLS
policies confirmed against live `pg_policies`/grant output).
`server.js` wired to the authenticated-user path and smoke-tested with no
regressions to unrelated routes. The authentication mechanism itself is
implemented; **end-to-end confirmation of a real registration through to
dashboard access is still outstanding** (see above).

## Next steps

1. Complete the outstanding end-to-end test walkthrough above.
2. Remove the temporary `[LOGIN]`/`[REGISTER]` debug logging once the flow
   is confirmed stable.
3. Post-launch: revisit `005_household_rls.sql` (contacts/calls RLS) and
   the dashboard-gating work deferred from this sprint.
4. Track password policy / generator / eye-icon / passkeys / security
   testing per `docs/ENGINEERING_ROADMAP.md`.
