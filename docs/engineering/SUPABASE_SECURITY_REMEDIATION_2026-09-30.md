# Supabase Data API security remediation — 2026-09-30

Branch: `security/supabase-staging-remediation`. Migrations 057, 058 and 059
are **applied to staging** (`tigwgmayeuisrxjjykqd`) and **not applied to
production** (`psbzynxplxfbyrbdidmn`). The production change waits for
Andrew's explicit approval.

## How the projects were identified

Both refs come from `supabase projects list` (the org has exactly two projects):

| ref | name | created | env file |
|---|---|---|---|
| `tigwgmayeuisrxjjykqd` | home-call-guard-staging | 2026-07-30 | `.env.staging.local` |
| `psbzynxplxfbyrbdidmn` | home-call-guard | 2026-07-07 | `.env` |

Every production query ran inside `begin transaction read only … rollback`.
A deliberate `CREATE TABLE` sent through the same wrapper was rejected with
`25006 cannot execute CREATE TABLE in a read-only transaction`. Production
received anon GET probes only (no rows came back, and no writes were sent).

## Root cause

**The two projects have different platform default ACLs.** No migration
caused the difference. Supabase set a different default ACL template for
each project when it was created. From `pg_default_acl` for objects that
`postgres` creates in `public`:

| | staging | production |
|---|---|---|
| tables | `anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm` (ALL) | `anon=Dxtm, authenticated=Dxtm, service_role=Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN only) |
| sequences | `anon/authenticated/service_role=rwU` | `postgres` only |
| functions | fixed by 022 on both (`postgres=X` only) | same |

Migration 022 fixed this default for **functions** only. Nothing fixed it
for tables or sequences. Every migration that creates a table therefore
gives anon and authenticated **full** privileges on staging and **no**
SELECT/INSERT/UPDATE/DELETE on production. On staging, RLS was the only
barrier.

Migration 039 created `terms_acceptances` with no RLS and no revoke. Its
comment says there are "no grants at all on the table itself to
anon/authenticated", which is only true on production. The results:

- **Staging:** anon could SELECT/INSERT/UPDATE/DELETE the table through
  PostgREST using only the public anon key. The Security Advisor reported
  ERROR `rls_disabled_in_public`. Migration 057 closed this earlier today
  (2026-09-30 17:56Z).
- **Production:** RLS is **still disabled** on `terms_acceptances`, but no
  SIUD privilege exists, so PostgREST returns 42501. The Advisor lint only
  fires when anon/authenticated can SELECT, so production's Advisor shows
  nothing. That is why the two environments looked different in the Advisor.

Migration history: production has 000–046. Staging has 000–046, then 047,
051 and 057 (plus 058 and 059 from this work). Separately, staging has
drifted from its own history: the objects from the 050 number-lifecycle
sweep (`entitlement_expiry_warnings_sent`, `record_entitlement_expiry_warning_sent`, …)
and the forwarding-verification RPCs exist on staging with **no**
`schema_migrations` row. RLS policies are byte-identical on both projects.
There are no storage buckets, no storage policies, no Realtime publications,
and `pg_graphql` is not installed on either project. `safeupdate` is
preloaded for `authenticator` on both.

## Exposure

Application access traced from code: the web pages and the mobile app only
call Supabase Auth. Every table read or write goes through `supabaseAdmin`,
with one exception: `services/householdBootstrap.js`
`ensureHouseholdAndRole()` runs as **authenticated** through
`buildUserScopedClient()` and uses households (select, update
`auth_user_id,email`, insert `auth_user_id,email,status`) and user_roles
(select, insert `auth_user_id,role`). The file is byte-identical on all 175
branches that contain it.

| Who | Before remediation | Evidence |
|---|---|---|
| anon, staging, before 057 | Full read/write of `terms_acceptances` (8 rows) | 039 + staging default ACL; reproduced by the PGlite harness with 057–059 removed |
| anon, staging, after 057 | Privileges on 13 tables, but RLS returned `200 []` for everything. TRUNCATE held on 13 tables (RLS does not apply to TRUNCATE; PostgREST cannot issue TRUNCATE) | live GET probes; reachability matrix |
| anon, production | 42501 on all 14 tables. TRUNCATE/REFERENCES/TRIGGER/MAINTAIN held on 12 tables, including `terms_acceptances` (RLS off). Not reachable through PostgREST or any RPC | live GET probes; catalog |
| authenticated, both | Cross-household isolation holds (0 foreign rows in households, contacts, subscriptions, entitlements; calls and terms 42501). **However**, the table-wide INSERT on `households` (006) lets any signed-in user with no household create one through the Data API with **arbitrary columns**: `twilio_number` (not unique; `getHouseholdByTwilioNumber` returns the first match, so another customer's inbound calls could be misrouted), `activation_verified_at`, `delivery_verified_at`, `self_protecting`, `carrier_*` (bypasses the carrier gate). Entitlements cannot be written, so this does not give free service. | reproduced on staging inside a rolled-back transaction; production has the identical grant and policy |
| RPCs, both | All 19 (production) / 29 (staging) SECURITY DEFINER functions: `service_role` only, `search_path=""`. anon RPC calls return 42501 | catalog; live probes |

## Staging fix (applied)

| Migration | What it does |
|---|---|
| `057_terms_acceptances_enable_rls` (already applied) | RLS on; revoke anon/authenticated; service_role gets select+insert only (append-only evidence) |
| `058_revoke_default_table_privileges_anon_authenticated` | Default ACL: new tables and sequences grant nothing to anon/authenticated (service_role default left as-is) |
| `059_least_privilege_anon_authenticated_table_grants` | Revokes every anon/authenticated/PUBLIC privilege on every public relation, then re-grants only: households `SELECT` + column `INSERT(auth_user_id,email,status)`/`UPDATE(auth_user_id,email)`; user_roles `SELECT` + `INSERT(auth_user_id,role)`; contacts SIUD, subscriptions `SELECT`, entitlements `SELECT` (explicit 008/011 design, own-household RLS). RLS, policies and service_role are untouched |

Applied 2026-09-30T19:26:29Z (058) and 19:26:35Z (059) using
`supabase db query --linked -f` and then `supabase migration repair --status applied 058 059`.
The in-migration verification blocks passed. The pre-change ACL snapshots
are embedded in the per-project rollback files.

Verification on staging after the change:
- `node scripts/verify-table-grants.js`: all checks pass (it failed 5 checks before the change).
- Anon over HTTP: 42501 on GET for all 18 tables and views; 42501 on POST households, POST terms_acceptances, PATCH calls, DELETE contacts, and RPCs `record_terms_acceptance` and `anonymize_inactive_household` (all probes targeted the nil UUID).
- Authenticated (rolled-back transaction): the app's bootstrap insert and claim work. Setting `twilio_number` or `activation_verified_at`, updating its own `twilio_number`, and `user_roles role=admin` all return 42501. It sees only its own household. Contacts, subscriptions and entitlements return 0 foreign rows. calls, terms and TRUNCATE return 42501.
- Real app code over HTTP: a throwaway confirmed test user ran `ensureHouseholdAndRole()` twice (idempotent). It saw only its own household, and PATCH `twilio_number` returned 42501. service_role could read and write, and `record_terms_acceptance` succeeded. The user and its rows were then deleted, and residue was checked as 0.
- service_role (rolled-back transaction): reads households, calls, contacts, subscriptions, entitlements and terms; inserts contacts; runs `record_terms_acceptance` and `set_household_phone_number`. All succeeded.
- Security Advisor: only WARN `function_search_path_mutable` (`hcg_set_updated_at`) and `auth_leaked_password_protection` remain, identical on both projects. No ERRORs.
- `npm test`: `migrations.pglite` passes. 103 of 105 test files pass. The 2 failures are Android-native checks that need `mobile/node_modules`, which this worktree does not have. They are unrelated to this change.

## Regression protection

- `tests/migrations.pglite.test.mjs` now replays the whole chain under
  **staging's permissive default ACL** (the worst case). It asserts that anon
  has zero privileges, that authenticated grants match the table and column
  allowlist exactly, that the default ACL is clean, that a canary table
  created after migrations starts closed, that the bootstrap flow works, and
  that a privileged households insert returns 42501. Negative controls: with
  059 removed it fails 5 checks; with 058 removed, 3; with 057–059 removed, 22,
  including the original `terms_acceptances` anon exposure. The chain was
  also replayed under production's default ACL and passed.
- `scripts/verify-table-grants.js` checks the same policy against the linked
  live project. It is read-only (every query runs in a read-only
  transaction) and safe to run against production. Current production result:
  5 failures, listed under pre-deployment checks below.

## Production remediation — PREPARED, NOT APPLIED

**Status: remediation recommended.** Production is not exposed to anon today
(evidence above). Two things still need fixing:

1. RLS is disabled on `terms_acceptances`. A single future grant would expose it.
2. Any authenticated user can create a household through the Data API with arbitrary columns (routing and gate tampering).

Also recommended for parity: remove the unused TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
privileges from anon/authenticated, including from the default ACL.

**Exact migrations (in order):** `057_terms_acceptances_enable_rls.sql`,
`058_revoke_default_table_privileges_anon_authenticated.sql`,
`059_least_privilege_anon_authenticated_table_grants.sql`. Each runs in its
own transaction and ends with a self-verifying `DO` block.

**Expected impact:** no change for anon or the app. Specifically:

- `terms_acceptances` gains RLS. Writes still go through the SECURITY DEFINER RPC, which is owned by postgres and therefore unaffected.
- service_role gains SELECT/INSERT on `terms_acceptances`. It currently has neither; neither is used today; the grant allows audit reads.
- anon and authenticated lose unused Dxtm privileges.
- On `households`, authenticated INSERT/UPDATE become column-limited to exactly what `ensureHouseholdAndRole()` sends.

**Downtime:** none expected. Changes are ACL-only. `ENABLE ROW LEVEL SECURITY`
briefly takes an ACCESS EXCLUSIVE lock on the small `terms_acceptances`
table. Run with `lock_timeout` set so a busy lock fails fast rather than
queueing.

**Pre-deployment checks:**
1. From a worktree of this branch: `supabase link --project-ref psbzynxplxfbyrbdidmn`, then confirm that `supabase/.temp/project-ref` contains that ref.
2. `node scripts/verify-table-grants.js` should show exactly these 5 failures: RLS missing on `terms_acceptances`; anon Dxtm; authenticated extra grants; no column grants; table default ACL `anon=Dxtm,authenticated=Dxtm`. Anything else means production has drifted since 2026-09-30, so stop and re-snapshot.
3. `select version from supabase_migrations.schema_migrations where version >= '047'` should return no rows.
4. The deployed backend's `services/householdBootstrap.js` should be blob `8d49df0` (unchanged since 8b12816).

**Apply:** for each file, `{ echo "set lock_timeout = '5s';"; cat supabase/migrations/<file>; } > /tmp/apply.sql && supabase db query --linked -f /tmp/apply.sql`
(or paste into the SQL editor with the same prefix). This is the same
mechanism used on staging, apart from the `lock_timeout` prefix. Then run
`supabase migration repair --status applied 057 058 059 --linked`.

**Post-deployment verification:**
1. `node scripts/verify-table-grants.js` should report all checks passed.
2. Security Advisor should show no ERROR, and the same 2 WARNs as before.
3. Anon GET probes should return 42501, as today.
4. Log in on web and on mobile with an existing account. Register a new test account and confirm its household and user_role are created. Complete one checkout on the terms-acceptance path and confirm `record_terms_acceptance` inserted a row. Place a test call on a screened household to confirm the webhook routes it (service_role path, unaffected).

**Rollback (production-specific files; do not use the staging ones), in reverse order:**
`_rollbacks/059_rollback_…production.sql` → `_rollbacks/058_rollback_…production.sql` →
`_rollbacks/057_rollback_…production.sql`. Each restores the exact pre-change
ACL from the 2026-09-30 snapshot. The 059 and 057 rollbacks intentionally do
not give anon back access to `terms_acceptances`.

**Risks:**
- A future code path that writes other `households` columns as authenticated would get 42501 and would need an explicit column grant. Today no branch does this.
- The 059 revoke loop covers every public relation that exists when it runs, so a table added to production before this deploy is covered as well.
- Dashboard-made grants would reappear as drift. `verify-table-grants.js` detects them.

## Remaining items for Andrew

1. **Approve (or not) applying 057 → 058 → 059 to production** using the runbook above.
2. **Founder "default household"**: on both projects there is an unclaimed `default-household@homecallguard.internal` row (production: created 2026-07-13, active, has a Twilio number and phone number, 0 contacts, calls or entitlements). The `households_claim_default` policy lets any authenticated user claim it. PostgREST cannot do this, because every filtered UPDATE also needs the SELECT policy, and `safeupdate` blocks unfiltered updates. Raw SQL as authenticated can claim it (reproduced in a rolled-back transaction). Decide whether to drop the policy and whether to release that Twilio number (Decision 010).
3. The unused authenticated grants on contacts/subscriptions/entitlements (008/011) could be removed later.
4. Staging service_role still gets ALL on new tables by default; on production it gets only Dxtm. For full parity, a follow-up could align staging's service_role default so that a missing `grant … to service_role` fails on staging before it reaches production.
5. WARNs present on both projects: set `search_path` on `hcg_set_updated_at`; enable leaked-password protection (Auth setting).
6. Staging history drift: the 050 and forwarding-verification objects exist without `schema_migrations` rows.
