Document: Sprint 8 Decisions
Version: 2.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): Sprint 8

---

# Sprint 8 — Decisions

**Least privilege over service-role.** Chosen over fixing the (separately
discovered, invalid) `SUPABASE_SERVICE_ROLE_KEY` and routing registration
through `supabaseAdmin`. Explicit team preference, only acted on after the
service-role alternative was proven necessary-or-not with direct evidence
(the anon-key diagnosis in `WORKLOG.md`), not assumed.

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

**Migration 007: a missing GRANT is not the same problem as missing RLS,
and fixing it doesn't touch RLS at all.** First-login testing failed with
`permission denied for table households` — proven (by matching error text
against an earlier, already-proven `anon`-role precedent, and by a live
`information_schema.role_table_grants` query) to be a missing table-level
`SELECT` grant for `authenticated`, not a policy problem — the RLS
policies from migrations 002/006 were already correct and were never
reached. The fix (Migration 007) adds only `grant select ... to
authenticated` on both tables. This was confirmed, before applying it, to
be incapable of weakening the existing RLS model: grants and RLS are
independent layers, `authenticated` is not a `BYPASSRLS` role, so every
row returned is still filtered by `auth_user_id = auth.uid()` regardless
of the grant.
