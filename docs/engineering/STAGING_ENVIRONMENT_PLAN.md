# Staging Supabase Environment — Implementation Plan

**Status:** Proposed. Not started — no staging project created, no credentials issued, no DDL applied anywhere.
**Trigger:** While fixing RC1's top release blocker (migration 021 not applied), discovered there is no separate staging/sandbox Supabase project at all — only one real project (`psbzynxplxfbyrbdidmn`) exists anywhere in this codebase, used for both live customers and the "QA sandbox household" test data. That project must therefore be treated as production, full stop, even when a test only touches a QA-labelled row. This plan exists so migration 021 (and every migration after it) can be applied and verified somewhere real without that ambiguity.
**Do not execute any step below without separate, explicit approval.**

---

## 1. Create a separate Supabase staging project

- New Supabase project, same organisation, name clearly distinct (e.g. `home-call-guard-staging`) — never a name that could be confused with production in a dashboard list.
- Free tier is sufficient to start; revisit if staging needs to exercise anything load-sensitive later.
- Record: project ref, project URL, `anon` key, `service_role` key. Store these the same way production secrets are stored today (never committed — confirmed this whole engagement that no credential has ever appeared in git history).
- No data, schema, or auth users carry over from production. Staging starts empty.

## 2. Schema and migration deployment sequence

**Root cause to fix, not just work around:** every migration in this project has so far been applied by hand-pasting SQL into the Supabase SQL Editor. This exact mechanism has already caused two separate, independently-confirmed silent failures on this project:
- Migration 019's own header: two earlier attempts each "reported a successful commit... without the column or new function overload actually existing afterwards."
- Migration 016: independently verified working, then later found silently reverted with no infrastructure cause identified (`docs/engineering/016_017_migration_incident_notes.md`).

Manual SQL Editor application is the common thread in both. Recommend:

1. Install and link the Supabase CLI to the new staging project (`supabase init`, `supabase link --project-ref <staging-ref>`).
2. Apply migrations via `supabase db push` (or equivalent scripted `psql` execution against the staging connection string), never hand-pasted into a dashboard editor — this makes application scriptable, logged, and repeatable instead of a one-off manual act.
3. Apply migrations **001 through 021 in strict numeric order**, with one explicit exception: `019_rollback_subscription_event_ordering_guard.sql` is not part of the forward chain — its own header says so ("kept alongside 019 for reference only... only run this if 019 needs to be reversed"). Apply `019_subscription_event_ordering_guard.sql`, skip the rollback file, matching the existing, already-established convention in this repo.
4. Require the existing PGlite harness (`tests/migrations.pglite.test.mjs`) to pass locally before any migration is applied to staging — formalise this as a hard gate, not a courtesy check.
5. After every migration applies, run the schema-verification script from §5 immediately — "the command exited 0" is not sufficient evidence on its own, per both incidents above.

## 3. Required staging environment variables

A new `.env.staging` (never committed; `.env.staging.example` committed as a template, mirroring the existing `.env.example` convention):

| Variable | Staging value |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | The new staging project's own values — never production's |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe **test mode** keys and a test-mode webhook endpoint — never live keys |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | A separate Twilio subaccount if possible, so a staging bug can't purchase a real number or send a real SMS against the production Twilio account |
| `APP_URL` | The staging deployment's own URL (or `http://localhost:<port>` for local-only work) |
| `RESEND_API_KEY` | A low-risk/test key if Resend is ever actually wired up (currently unused in this codebase — see `KNOWN_ISSUES.md`) |

`mobile/.env.staging` similarly, with `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_ANON_KEY` pointed at the staging project and `EXPO_PUBLIC_API_BASE_URL` pointed at wherever the staging backend runs.

## 4. Safe creation of synthetic QA users and households

Since staging is a fully isolated project, every row in it is synthetic by definition — no email-prefix or notes-field convention is needed there the way it's been needed on the shared production project until now. Recommend seeding a small, fixed, repeatable set of fixture households on staging rather than ad hoc one-off rows:

- A fresh signup, no subscription
- Mid-setup: subscribed, Twilio number provisioned, activation not yet verified
- Fully active: subscribed, activated, real-shaped call history
- Cancelled/lapsed: subscription ended, entitlement expired
- A Virgin Media and a Sky household specifically, to exercise B4's two non-standard code paths

Separately, and regardless of staging: recommend a real `households.is_test_data boolean default false` column in a future migration, so the existing production QA-household convention (email prefix + free-text `notes`) becomes a queryable, enforceable flag instead of a manual convention — directly relevant given this exact ambiguity is what triggered this plan.

## 5. Testing migration 021 and the activation-verification endpoint on staging

**Schema verification (automated script, not manual dashboard inspection):**
```sql
-- column exists, correct type, nullable
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'households' and column_name = 'activation_verified_at';

-- function exists, is SECURITY DEFINER
select p.proname, p.prosecdef
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'mark_household_activation_verified';

-- grants: service_role only, no authenticated/anon/public
select grantee, privilege_type
from information_schema.role_routine_grants
where routine_name = 'mark_household_activation_verified';
```
Wrap this as a small repeatable script (e.g. `scripts/verify-migration-021.js`), not a one-off manual query — this is the automated-verification deliverable from the original request, scoped to run against whichever project's connection string it's pointed at (staging today, production later, same script both times).

**Functional/integration test**, against a seeded staging fixture household:
1. Insert a synthetic "recent call" row within the verification window → `POST /api/v1/activation/verify` → expect 200, `activation_verified_at` set.
2. Call again → expect the same timestamp returned unchanged (idempotency).
3. Insert a call *outside* the verification window on a fresh fixture household → expect verification correctly does **not** fire.
4. Call `mark_household_activation_verified` directly with a nonexistent household id → expect the function to raise, not silently succeed.
5. Attempt to call the RPC as the `authenticated` role (not `service_role`) → expect a permission error, confirming the grant restriction actually holds.

This becomes `tests/activation-verification.staging.test.mjs` (or a script runnable outside the Jest-style suite, since it needs real staging credentials, not PGlite) — recommend gating it behind an explicit env var (e.g. `STAGING_SUPABASE_URL` must be set) so it can never accidentally run against whatever `.env` happens to be loaded.

## 6. Promoting future migrations from staging to production

1. Migration file merged to `main` via normal PR review (unchanged from today).
2. Apply to staging via the CLI-based process in §2.
3. Run the §5 schema-verification script against staging — must pass.
4. Run the relevant functional/integration test against staging — must pass.
5. Only then apply the identical, unmodified SQL file to production, via the same CLI-based mechanism — never a hand-pasted variant "just for prod."
6. Immediately re-run the same schema-verification script against production. Do not treat "the apply command exited 0" as sufficient — this exact gap is what let migration 016 revert unnoticed and let 019 silently fail twice.
7. Record the production application in a running migration log (date, who, verification script output) — `KNOWN_ISSUES.md` and the sprint docs are the current de facto place this kind of record lives; formalising a dedicated `MIGRATION_LOG.md` is a reasonable small addition.
8. If a mistake is found after the fact, write a new forward migration to correct it — never hand-edit a migration that may already be applied somewhere, matching existing repo convention.

## 7. Preventing local/mobile sandbox code from accidentally reaching production

Concrete, low-cost safeguards:

- A startup assertion in `server.js`: if `NODE_ENV !== "production"` and `SUPABASE_URL` matches the known production project ref, refuse to boot unless an explicit `ALLOW_PRODUCTION_DB=true` override is set. Cheap, effective tripwire — turns "oops, pointed at prod" into a loud failure instead of a silent one.
- Separate `.env.staging.example` / keep `.env.example` as the production template, so nobody copies the wrong one out of habit (today there's only one template, which is itself part of the problem).
- Store the production project ref as a single named constant referenced by that assertion, not scattered/implicit.
- For the mobile app: local/dev Expo builds should default to the staging project once it exists; pointing a dev build at production should require a deliberate, separate `.env.production.local`-style override, never the default `.env`.
- This is somewhat self-enforcing once staging genuinely exists as a separate project — different URL, different keys, no shared credential can accidentally bridge the two — but the assertion above is still worth having as a second, explicit layer rather than relying on that alone.

## 8. Backup and rollback procedure before future production migrations

- Confirm the production Supabase project's current plan/tier and backup retention (Free tier has no automatic backups; paid tiers add daily backups and, higher still, point-in-time recovery) — this needs dashboard access to check and hasn't been confirmed in this pass.
- Before any production migration, take an explicit, timestamped manual backup (Supabase dashboard "Database backups," or `pg_dump` against the production connection string) regardless of the plan's automatic backup coverage — belt and braces, and it directly produces the artifact needed to actually roll back.
- Every migration should ship with its own rollback script from day one, reviewed alongside the forward migration — the existing `019_rollback_subscription_event_ordering_guard.sql` is the right precedent to follow, not the exception.
- Migration 021's own rollback, once needed, is simple and low-risk since the migration itself is purely additive:
  ```sql
  drop function if exists public.mark_household_activation_verified(uuid);
  alter table public.households drop column if exists activation_verified_at;
  ```
  Recommend committing this as `021_rollback_household_activation_verified.sql` alongside the forward migration, written now rather than reactively during a future incident.

---

## What this does not resolve yet

Migration 021 remains unapplied everywhere. It cannot be safely applied to the one existing Supabase project (that project is production), and there is nowhere else to put it until this plan is executed. This is now the actual blocking dependency ahead of the original release-blocker fix — recorded in `RC1_HANDOVER.md` and `KNOWN_ISSUES.md`.
