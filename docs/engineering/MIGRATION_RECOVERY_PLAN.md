# Migration Recovery Plan — supabase/migrations

**Status:** Executed against staging (`home-call-guard-staging`, ref `tigwgmayeuisrxjjykqd`) on 2026-07-30, with a follow-up fix (migration 022) applied and verified on staging on 2026-07-31 — see "Execution Outcome" and "Follow-up: migration 022" at the end of this document. Production (`psbzynxplxfbyrbdidmn`) has been read-only introspected only (twice — once for the `contacts` schema, once for the SECURITY DEFINER grant comparison); no migration, DDL, or write of any kind has been applied to it at any point in this whole exercise.
**Trigger:** Attempting to push the full migration set to the new staging project (`home-call-guard-staging`, ref `tigwgmayeuisrxjjykqd`) surfaced two real defects in `supabase/migrations/` that a from-scratch database exposes but production's own gradual, hand-applied history never did:

1. `public.contacts` has no `CREATE TABLE` anywhere in this repo — it was created via the Supabase Table Editor. Migration 003 assumes it already exists and fails on a fresh database.
2. `005_household_rls.sql` is a frozen draft that was never applied to production, but if pushed to a fresh database in numeric order it *would* run — and would then break migration 008 with `policy "contacts_select_own_household" already exists`, since 008 creates the same policy names without dropping them first.

Staging is currently paused at migrations 001–002 applied, 003 onward pending. **Nothing below has been executed. This is the plan for review.**

---

## 1. What migration 005 actually is

Not "invalid, should never have been committed." The SQL itself is correct, defensive (it drops whatever policies exist on `contacts` by inspecting `pg_policies` before recreating them, rather than assuming names), and reflects real, legitimate historical intent — Sprint 7's household-identity work. It belongs in the project's history.

It is **both superseded and obsolete**, in two different ways for its two independent halves:

- **Contacts RLS (superseded).** 008's own comment says this explicitly: *"mirrors the already-reviewed contacts policies drafted in 005_household_rls.sql (still frozen/unapplied) — same design, written fresh here rather than un-freezing that file."* 008 is the file that actually ran. 005's contacts half was replaced before it ever went live.
- **Calls RLS (obsolete).** `calls_select_own_household` — the one thing 005 defines that no later migration replaces — assumes a client reads `calls` directly with the signed-in user's own JWT (`authenticated` role, RLS-scoped). That's not how this app works: every read of `calls` goes through `server.js` via the service-role client (confirmed: `calls` has **zero** RLS policies on live production today, and 005 is the only file in this repo that ever defines one). The architecture this policy assumed never materialized, and the backend-API-only pattern the mobile app docs describe (`/api/v1/me/dashboard`, etc.) confirms that's still the model going forward. The policy isn't wrong, it's just unused by design.

**Practical conclusion, independent of the historical label:** regardless of how 005 is classified, it cannot be allowed to sit in the numerically-scanned migration path, because a mechanical "run every file in order" process — which is exactly what a fresh install, CI, or a new developer's first `supabase db push` is — will execute it and break 008. The fix must be structural, not a comment asking people not to run it.

---

## 2. Safest long-term strategy for a fresh install

**Design target:** a brand-new Supabase project should reach production-equivalent schema with nothing but `supabase link` + `supabase db push`, using zero tribal knowledge of which files are real, and zero manual STATUS-header archaeology. The `STATUS:` header convention is useful as a historical audit trail of what ran against the one production database — it is not, and was never meant to be, an executable instruction. Nothing enforces it; only filesystem presence and numeric order actually decide what a mechanical push does.

**Baseline migration(s).** Add `000_baseline_contacts_table.sql` (already drafted, not yet applied — see prior turn) as the one missing `CREATE TABLE`. This is the only genuine schema gap found. It should be checked for elsewhere too: a full audit of every migration for "ALTERs a table it never created" is worth doing once, but not blocking on right now — flagged as a followup, not a known second instance today.

**Migration ordering.** The existing 000→021 numeric sequence is otherwise sound and already matches real chronology/dependency order (verified: no other file ALTERs something before its CREATE). No broad renumbering is needed.

**Treatment of 005.** Relocate it out of the directory Supabase's CLI scans (e.g. `supabase/migrations/_superseded/005_household_rls.sql`), with its existing header kept and a note added pointing at 008 (contacts) and at this plan (calls). This is safe specifically *because* 005 has never been applied anywhere — no environment's migration-history table has a row claiming version 005 ran, so moving/renaming it doesn't rewrite a fact any real database depends on. That's a materially different situation from touching 013–015 or 019, which are genuinely applied and must never be edited in place.

**Treatment of the 019 rollback.** Same structural treatment as 005, for the same reason: it currently "works" only because everyone applying migrations knows by convention to skip it — the same footgun class as 005, just not yet hit. Move `019_rollback_subscription_event_ordering_guard.sql` to a dedicated, non-scanned rollbacks location (e.g. `supabase/migrations/_rollbacks/`), out of the forward-applied path, leaving `019_subscription_event_ordering_guard.sql` as the only "019" file in the live directory.

Worth flagging as its own small risk: today, two files in the live directory both carry the literal prefix `019_` (`019_rollback_...` and `019_subscription_...`). `supabase migration list` displays both as local version `"019"`. Whether `db push` would even tolerate two files sharing one version prefix has never actually been tested here — we stopped before reaching that point in the chain. Relocating the rollback file resolves this ambiguity structurally rather than needing to find out empirically.

**Treatment of migration 021.** Its blocker was never technical — 021 itself is additive-only, already PGlite-validated, and matches every existing security pattern in this codebase (narrow `SECURITY DEFINER` RPC, `service_role`-only grant, idempotent). The blocker was "no non-production place to apply and verify it," which standing up staging now resolves. Recommend: once verified on staging (per `STAGING_ENVIRONMENT_PLAN.md` §5–6), merge it into `main` for real (it currently exists only on the unmerged `sandbox/mobile-app-v1` branch and as an uncommitted copy in this worktree). Also write its paired rollback now, `021_rollback_household_activation_verified.sql` (the plan document already specifies the two-line `DROP FUNCTION` / `DROP COLUMN` needed), matching 019's precedent — cheap, low-risk, and consistent with "every migration ships its own rollback."

---

## 3. Repair vs. renumbering vs. squashing vs. new baseline

| Option | Verdict | Why |
|---|---|---|
| **New baseline migration** | **Use it** | Directly fixes the one real gap (missing `CREATE TABLE contacts`). Surgical, additive, low-risk. |
| **Targeted relocation of 005 / 019-rollback** | **Use it** | Structural, not cosmetic — makes "does this file execute" a filesystem fact instead of a documentation convention. Safe here specifically because neither has ever been applied anywhere. |
| **Migration repair** (`supabase migration repair`) | **Use narrowly, not as the fix** | Edits one database's remote history table — useful for reconciling a specific environment's drift (e.g. if 005 were ever mistakenly recorded against some dev DB), but doesn't fix the repo. Every fresh clone would still need the same manual incantation if 005 stayed in place relying on repair alone. Operational tool, not a structural one. |
| **Full renumbering** | **Don't** | The 000–021 sequence is already chronologically and dependency-correct once 005 and the 019-rollback are relocated. Renumbering everything else is disruptive (breaks every cross-reference to migration numbers in `RC1.md`, `KNOWN_ISSUES.md`, code comments, this plan itself) for no structural benefit. |
| **Squashing** | **Don't, not yet** | The migration files are also this project's audit trail — 015, 019, and 020 in particular carry incident-response detail actively cross-referenced by `KNOWN_ISSUES.md` and the staging plan. Squashing now would also bake still-unverified drafts (007, 009, 020, 021) into a single "ground truth" file before they've actually been proven against a real database via staging. Revisit only after the staging→production promotion process has run for a while and the confirmed-applied prefix has grown large enough that 20-odd files genuinely costs something (it doesn't today — applying all of them takes seconds). If done later, squash only the fully-verified prefix, never the unverified tail. |

---

## 4. Fresh clone / new-database test

After this recovery, the acceptance test for "is this actually fixed" is:

```
supabase projects create <anything>
supabase link --project-ref <that project>
supabase db push
```

should apply `000` through `021` (minus the relocated 005 and 019-rollback) cleanly, with zero errors and zero manual steps, and produce a schema identical to production's real current state for every column, constraint, index, policy, and grant already confirmed by direct introspection this session.

---

## 5. Recommended migration history after cleanup

**Live, scanned path** (`supabase/migrations/`):
```
000_baseline_contacts_table.sql
001_create_calls_table.sql
002_create_households_and_roles.sql
003_add_household_id_ownership.sql
004_backfill_default_household.sql
006_authenticated_household_self_service.sql
007_grant_authenticated_household_reads.sql
008_household_isolation_contacts.sql
009_service_role_minimum_app_privileges.sql
010_add_stripe_customer_id.sql
011_create_subscriptions_and_entitlements.sql
012_service_role_stripe_billing_privileges.sql
013_stripe_billing_rpc_functions.sql
014_claim_stripe_webhook_event_rpc.sql
015_fix_entitlement_expiry_subscription_match.sql
016_household_twilio_provisioning.sql
017_household_twilio_number_lifecycle.sql
018_service_role_contacts_update_delete.sql
019_subscription_event_ordering_guard.sql
020_anonymize_inactive_household.sql
021_household_activation_verified.sql
```

**Relocated, non-scanned** (kept for history/reference, out of the applied path):
```
supabase/migrations/_superseded/005_household_rls.sql
supabase/migrations/_rollbacks/019_rollback_subscription_event_ordering_guard.sql
supabase/migrations/_rollbacks/021_rollback_household_activation_verified.sql   (new, written alongside 021)
```

Note on verification before executing any of this: I'm highly confident Supabase's CLI only scans `supabase/migrations/*.sql` at the top level and ignores subdirectories, but this hasn't been empirically confirmed in this repo — the first step of executing this plan (not proposed to happen yet) should be a `supabase migration list`/dry-run check that the relocated files are genuinely invisible to the CLI before relying on that structurally.

---

## What this plan does not do

Doesn't touch staging, doesn't touch production, doesn't move or rename any file yet, doesn't apply migration 000 or 021 anywhere. Waiting for explicit approval before executing any part of it.

---

## Execution Outcome (2026-07-30)

Executed exactly as documented, against staging only, after explicit approval.

**File moves — as planned:**
- `005_household_rls.sql` → `supabase/migrations/_superseded/005_household_rls.sql`
- `019_rollback_subscription_event_ordering_guard.sql` → `supabase/migrations/_rollbacks/`
- `021_rollback_household_activation_verified.sql` written directly into `supabase/migrations/_rollbacks/` (per §5's recommended content), never placed in the live path
- `000_baseline_contacts_table.sql` and `021_household_activation_verified.sql` kept active, as planned

**CLI subdirectory-scanning assumption — confirmed correct.** `supabase migration list --linked` after the moves showed exactly `000, 001–004, 006–021` — no 005, no rollback files. The uncertainty flagged in §5 ("hasn't been empirically confirmed in this repo") is now resolved: `_superseded/` and `_rollbacks/` are genuinely invisible to the CLI.

**Push — one deviation from the plan, both benign.**
1. `supabase db push` initially refused with `LegacyDbPushMissingRemoteError`, because `000` sorts before the already-applied `001`/`002` on staging's remote history. This wasn't anticipated in the plan. Resolved with `--include-all`, which applied only the genuinely-missing migrations (`000`, `003`–`021`) — `001`/`002` were correctly left alone, not re-run.
2. `tests/migrations.pglite.test.mjs` needed two small updates to match the new file layout: removed its now-superseded stub `create table public.contacts (...)` (000 supersedes it — leaving the stub in would have made 000's `create table if not exists` a silent no-op with the wrong, incomplete schema), and removed the now-dead `SKIP` filename list (005 is no longer in the directory to skip). Both changes are mechanical, not behavioral — every existing assertion in that file still passes.

All 21 migrations (`000, 001–004, 006–021`) applied cleanly, zero errors, on the first `--include-all` attempt. No manual/ad-hoc patch was applied to any database at any point.

**Post-push verification — all planned checks passed:**
- Local and remote migration history match exactly (`supabase_migrations.schema_migrations` on staging contains exactly the 21 expected versions, nothing else)
- `public.contacts` schema matches production's authoritative shape column-for-column, including `household_id`
- All 7 expected application tables exist (`calls`, `contacts`, `entitlements`, `households`, `stripe_webhook_events`, `subscriptions`, `user_roles`), RLS enabled on all of them
- `contacts` has exactly its 4 intended policies (select/insert/update/delete-own-household); `calls` has **zero** policies, confirming 005 did not leak in (matches production exactly — 005 was never applied there either)
- `households.activation_verified_at` exists, nullable timestamptz
- `mark_household_activation_verified` exists, `SECURITY DEFINER`, body matches the source file exactly

**One check did not pass, and needs to be called out clearly: function execute grants are not what every migration in this project believes they are.**

Every `SECURITY DEFINER` RPC in this codebase (`set_household_stripe_customer_id`, `process_stripe_webhook_event`, `claim_stripe_webhook_event`, `assign_household_twilio_number` and its siblings, `anonymize_inactive_household`, `mark_household_activation_verified`, and even the `hcg_set_updated_at` trigger helper — 10 functions checked, all affected) ends with the same pattern: `revoke all on function ... from public; grant execute on function ... to service_role;`. On staging, every one of them still has **`EXECUTE` granted directly to `anon` and `authenticated`**, verified by direct query against `information_schema.role_routine_grants`.

Root cause: `revoke all ... from public` only revokes what was granted to the `PUBLIC` pseudo-role. Supabase's platform default privileges grant `EXECUTE` on new `public`-schema functions **directly** to `anon`/`authenticated`/`service_role` as named roles, not via `PUBLIC` — so the revoke never touches them. This is a real Supabase platform behavior, not a staging misconfiguration, meaning it very likely also affects production (unconfirmed — not checked this pass; production was intentionally not touched further).

This is exactly the class of gap `STAGING_ENVIRONMENT_PLAN.md` §5 exists to catch — its own schema-verification script explicitly checks for "grants: service_role only, no authenticated/anon/public" for this reason. That script wasn't built as a standing artifact this pass (the equivalent checks were run ad hoc via `supabase db query`); building it for real is now higher-priority than it was, since it would have caught this immediately and should catch it going forward. `tests/migrations.pglite.test.mjs` does not catch this either — PGlite's role stub doesn't replicate Supabase's default-privilege behavior, so its "authenticated role cannot execute X" assertions currently pass for the wrong reason (no default-privilege grant exists in PGlite to begin with). This is a real fidelity gap between the test harness and the platform it's standing in for, independent of anything specific to migration 021.

**Remaining risks / follow-up work, not done as part of this pass:**
1. ~~Write a new, forward migration...~~ **Done — see "Follow-up: migration 022" below.**
2. ~~Check whether production has the same exposure~~ **Done, separately approved and read-only** — production does **not** have this exposure; its `pg_default_acl` for public-schema functions never included `anon`/`authenticated` in the first place. Full comparison below.
3. ~~Build a general schema-verification script~~ **Done — `scripts/verify-security-definer-grants.js`**, generalized beyond 021 to every `SECURITY DEFINER` function, discovered dynamically rather than a hardcoded list.
4. ~~Migration 021 itself... still needs a real git commit~~ **Done** — committed to `main`, see commit history.

---

## Follow-up: migration 022 (2026-07-31)

### Production comparison

Read-only introspection of production (`psbzynxplxfbyrbdidmn`), explicitly approved separately from this plan, found production **was never exposed**. Every one of the same 10 `SECURITY DEFINER` functions has `proacl = {postgres=X/postgres,service_role=X/postgres}` there — no `anon`, no `authenticated`, no bare `PUBLIC`. Root cause confirmed directly via `pg_default_acl`: production's `postgres`-scoped default for `public`-schema functions is `{postgres=X/postgres}` only, while staging's (a project created 2026-07-30, versus production's much older creation date) was `{postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}`. Confirmed via Supabase's own documentation this is expected, documented platform behavior for new projects (not a regression) — https://supabase.com/docs/guides/api/securing-your-api — though widely enough considered an unsafe default that Supabase has said they intend to make it opt-in (see https://github.com/supabase/supabase/issues/43884). Production's clean state is best explained as predating whenever that default template was introduced, not deliberate hardening.

### Migration 022

`022_lock_down_security_definer_execute_grants.sql` — two parts:
1. An existence-checked `DO` block (`to_regprocedure`, so it's safe to run whether or not migration 021's function exists yet) that explicitly revokes `PUBLIC`/`anon`/`authenticated` and grants `service_role` on all 11 current functions.
2. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public, anon, authenticated, service_role` — matching Supabase's own documented recovery snippet, including revoking the default for `service_role` too (deliberate, fail-closed: every future RPC migration must now grant `service_role` explicitly, exactly as all 13 existing ones already do — nothing can work "by accident" via a platform default anymore).

**Applied to staging only**, approved explicitly, after staging-only scope was reconfirmed. Verified two ways: `scripts/verify-security-definer-grants.js` (new standing script, dynamic discovery via `pg_proc`, checks grants/`search_path`/owner per function plus `pg_default_acl` for the schema) reports all-clear; and a live, non-destructive call — `mark_household_activation_verified` with a nonexistent household UUID as `service_role` raised the function's own `P0001` business-logic exception (proves the call reached the function body), while the identical call as `authenticated` got `42501 permission denied` before the function body ever ran. No real data touched by either call (confirmed: the pre-existing `default-household@homecallguard.internal` fixture row's `stripe_customer_id` was unchanged after an earlier, separate no-op verification call against `set_household_stripe_customer_id`, which surfaced a minor, pre-existing, unrelated bug — see note below).

`tests/migrations.pglite.test.mjs` gained a matching dynamic check (same `pg_proc`-driven discovery, runs on every `npm test`) enforcing the same policy locally — deliberately complementary to the live script, not redundant: PGlite can catch a future migration that forgets its own grant lines, but can never reproduce a live project's default-ACL configuration, which only the live script can see.

Migration histories (`supabase migration list --linked`) match exactly, locally and remotely, after applying 022.

**Minor, unrelated finding surfaced while verifying:** `set_household_stripe_customer_id` (013) uses `select h.stripe_customer_id, true into v_existing, v_found from ... where h.id = p_household_id` — when zero rows match, plpgsql's `select into` sets `v_found` to `NULL`, not `false`, so `if not v_found then raise exception ...` never fires (`not NULL` is `NULL`, which is falsy in an `if`). The function silently no-ops (a zero-row `UPDATE`) for a nonexistent household instead of raising, unlike `mark_household_activation_verified`'s equivalent guard (021, uses plpgsql's `FOUND`, which is always `true`/`false`, never `NULL`) which works correctly. Pre-existing, unrelated to this session's work, not fixed — flagging only.

**Production:** not touched by 022 in any way. Applying migrations 021 and 022 to production remains a deliberate, separate, explicitly-controlled future change — not bundled into this staging fix.
