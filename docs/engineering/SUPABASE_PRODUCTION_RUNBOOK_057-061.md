# Production remediation runbook — Supabase migrations 057–061

**Status: PREPARED, NOT APPLIED. Awaiting Andrew's explicit approval.**
Target: production `psbzynxplxfbyrbdidmn`. All five migrations are applied and
verified on staging `tigwgmayeuisrxjjykqd`. Nothing here has been run against
production; production was read-only throughout the audit.

This supersedes the single-migration production section in
`SUPABASE_SECURITY_REMEDIATION_2026-09-30.md` by adding 060 and 061.

## What each migration does and why it is required

| # | File | Why required | Prod impact |
|---|---|---|---|
| 057 | `057_terms_acceptances_enable_rls.sql` | RLS is **off** on `terms_acceptances` in production. One accidental future grant would expose consent records. Enables RLS, revokes anon/authenticated, gives service_role SELECT+INSERT only (append-only evidence). | None for anon/app; writes use the SECURITY DEFINER RPC (owner-run, RLS-exempt). service_role gains SELECT/INSERT it does not use today. |
| 058 | `058_revoke_default_table_privileges_anon_authenticated.sql` | Production's default ACL still hands new tables TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to anon/authenticated. Future tables start partly open. Revokes those defaults (service_role default kept). | None today; affects only tables created after it. |
| 059 | `059_least_privilege_anon_authenticated_table_grants.sql` | Any signed-in user can `INSERT`/`UPDATE` **arbitrary `households` columns** via the Data API (twilio_number, activation/carrier flags). Revokes every anon/authenticated/PUBLIC table privilege, re-grants only the least-privilege set, column-scopes households INSERT/UPDATE to what `ensureHouseholdAndRole()` writes. | No change for anon or app; closes the arbitrary-column hole. |
| 060 | `060_revoke_unused_authenticated_grants_and_pin_trigger_search_path.sql` | Unused authenticated grants on contacts/subscriptions/entitlements (008/011) let a user write their own trusted contacts past backend validation; `hcg_set_updated_at` has a mutable search_path (Advisor WARN) and is anon-executable. Revokes the grants; pins `search_path=''`; revokes PUBLIC/anon/authenticated EXECUTE. | None for app (those tables are service-role-only in code); clears the Advisor WARN; trigger keeps firing (permission-checked only at CREATE TRIGGER time). |
| 061 | `061_global_default_revoke_function_execute_from_public.sql` | 022's per-schema `REVOKE EXECUTE … FROM public` is a no-op against PostgreSQL's built-in global default, so a future `SECURITY DEFINER` function that forgets its revoke line would be anon-callable. Applies the **global** `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM public`. | None today (every current RPC revokes PUBLIC explicitly); affects only functions created afterwards. |

Apply **in numeric order: 057 → 058 → 059 → 060 → 061.** Each is its own
transaction and ends with a self-verifying `DO` block that raises (aborting that
transaction) if its post-state is wrong.

## Preflight (read-only; do all before applying anything)

1. **Point at production, confirm it:** from a worktree of
   `security/supabase-staging-remediation`:
   `supabase link --project-ref psbzynxplxfbyrbdidmn`, then
   `cat supabase/.temp/project-ref` → must print `psbzynxplxfbyrbdidmn`.
2. **Migration history:**
   `select version from supabase_migrations.schema_migrations where version >= '047'`
   → expect **no rows** (production is at 046; 047/051/057–061 are not there).
3. **Expected failing baseline:** `node scripts/verify-table-grants.js` should
   report exactly these failures (anything else = drift, stop and re-snapshot):
   RLS missing on `terms_acceptances`; anon holds Dxtm; authenticated has extra
   grants; no column grants; table default ACL `anon=Dxtm,authenticated=Dxtm`.
   `node scripts/verify-security-definer-grants.js` should **pass** already.
4. **ACL fingerprint (drift guard):** run `scripts/sql/acl_fingerprint.sql`
   inside `begin transaction read only; … rollback;`. Expected production value
   from 2026-09-30T20:13Z: **`7529d825e53f459c4763d74ea0c3be85` (n=68)**. If it
   differs, production changed since this runbook — re-review before applying.
5. **Deployed code check:** the running backend's `services/householdBootstrap.js`
   should be blob `8d49df0`. 059 column-scopes exactly what that file writes;
   a different bootstrap would need its grants re-checked.
6. **Backup:** confirm Supabase PITR/daily backup is enabled for the project
   (Dashboard → Database → Backups). These are ACL-only changes (no data), but
   take/verify a backup point immediately before, per policy.

## Apply (production)

For each file, prefix a short lock timeout so an unexpected busy lock fails fast
rather than queueing behind traffic:

```
for f in 057_terms_acceptances_enable_rls \
         058_revoke_default_table_privileges_anon_authenticated \
         059_least_privilege_anon_authenticated_table_grants \
         060_revoke_unused_authenticated_grants_and_pin_trigger_search_path \
         061_global_default_revoke_function_execute_from_public; do
  { echo "set lock_timeout = '5s';"; cat "supabase/migrations/$f.sql"; } > /tmp/apply.sql
  supabase db query --linked -f /tmp/apply.sql    # STOP if this errors
done
supabase migration repair --status applied 057 058 059 060 061 --linked
```

(Or paste each file, with the `set lock_timeout` prefix, into the SQL editor.)
This is the exact mechanism used on staging apart from the lock-timeout prefix.
If any file errors, **stop** — its transaction rolled back on its own; do not
proceed to the next number.

## Post-deployment verification

1. `node scripts/verify-table-grants.js` → all checks pass.
2. `node scripts/verify-security-definer-grants.js` → all checks pass.
3. `set -a; source <prod env>; set +a; node scripts/probe-anon-data-api.js`
   → every table/view 401/42501; 0 storage buckets. (GET-only, limit=0; safe.)
4. Security Advisor (`supabase db advisors --linked --type security`) → no ERROR;
   `function_search_path_mutable` gone; only `auth_leaked_password_protection`
   WARN remains (a separate Auth toggle).
5. Re-run the ACL fingerprint; record the new production value.

## Application smoke tests (production, real accounts)

- Web + mobile: log in with an existing account → dashboard loads.
- Register a new test account → its household and `user_roles` row are created
  (`ensureHouseholdAndRole` path, exercises the 059 column grants).
- Complete one checkout on the terms-acceptance path → a `terms_acceptances`
  row is inserted (057 service_role RPC path).
- Add/edit a trusted contact in the app → succeeds (service-role path; 060 only
  removed the unused *direct* authenticated grant).
- Place one test call to a monitored number → it routes and connects
  (service-role call path; unaffected by any of these).

## Security tests (production)

- As an authenticated user via raw Data API: inserting a household with
  `twilio_number`/`activation_verified_at`, or updating own `twilio_number`, or
  inserting `user_roles.role='admin'` → all 42501.
- anon GET on every table → 42501 (covered by step 3).

## Rollback (production-specific files; reverse order)

Each restores the exact pre-change ACL captured from the 2026-09-30 read-only
snapshot. **Use the `.production.sql` variants where they exist — not the
staging ones** (the projects started from different ACLs):

| Undo | File |
|---|---|
| 061 | `_rollbacks/061_rollback_global_default_revoke_function_execute_from_public.sql` |
| 060 | `_rollbacks/060_rollback_revoke_unused_authenticated_grants_and_pin_trigger_search_path.sql` |
| 059 | `_rollbacks/059_rollback_least_privilege_anon_authenticated_table_grants.production.sql` |
| 058 | `_rollbacks/058_rollback_revoke_default_table_privileges_anon_authenticated.production.sql` |
| 057 | `_rollbacks/057_rollback_terms_acceptances_enable_rls.production.sql` |

Roll back only the migrations that caused a problem, in reverse order. The 057
and 059 rollbacks deliberately do **not** restore anon access to
`terms_acceptances` — they return the table to its (still-safe) pre-change state
without re-opening anything. After any rollback, run step 1–2 of verification to
confirm the restored state, then `supabase migration repair --status reverted <n>`.

## Abort criteria

Stop and roll back the current migration (and do not continue the sequence) if:

- any migration's own `DO` verification block raises (its transaction already
  rolled back — investigate before retrying);
- `lock_timeout` fires on 057's `ENABLE ROW LEVEL SECURITY` (retry in a quieter
  window; everything else is ACL-only and lock-light);
- the preflight ACL fingerprint did not match `7529d825e53f459c4763d74ea0c3be85`
  (production drifted — re-review);
- any application smoke test regresses (login, register/bootstrap, checkout,
  contact add, or call routing) — roll back the just-applied migration and
  diagnose before proceeding.

## Expected impact / downtime

No downtime expected. Every change is ACL/metadata only except 057's
`ENABLE ROW LEVEL SECURITY`, which briefly takes an ACCESS EXCLUSIVE lock on the
small `terms_acceptances` table — bounded by `lock_timeout`. No data is read,
written, or migrated.
