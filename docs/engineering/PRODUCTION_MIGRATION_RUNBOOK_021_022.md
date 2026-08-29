# Production Migration Runbook — Migrations 021 & 022

**Status: EXECUTED — 2026-08-02.** Both migrations applied to production (`psbzynxplxfbyrbdidmn`) following the corrected §4 sequence below. See "Execution Outcome" at the end of this document for the full record and post-deployment verification evidence.
**Scope:** Apply exactly `021_household_activation_verified.sql` and `022_lock_down_security_definer_execute_grants.sql` to production. Nothing else. Both are already applied to and verified on staging (`tigwgmayeuisrxjjykqd`) — see `docs/engineering/MIGRATION_RECOVERY_PLAN.md`.

## ⚠️ Critical correction (2026-08-02) — §4's execution sequence is unsafe as originally written

This runbook originally assumed `supabase db push` against production would cleanly apply just `021` then `022`, "since nothing is being inserted before an already-applied migration." That assumption is **wrong**, confirmed live via `supabase db push --linked --dry-run` against production: the `supabase_migrations.schema_migrations` tracking table **does not exist on production at all** (`relation "supabase_migrations.schema_migrations" does not exist`) — consistent with production never once having been touched by the Supabase CLI (every migration to date was hand-pasted into the SQL Editor, which never populates that table). A plain `db push` therefore treats **all 22 local migration files as unapplied** and would attempt to replay `000` through `022` in full — not just the intended two.

This is not merely a bookkeeping inconvenience. Replaying `000_baseline_contacts_table.sql` would (harmlessly) no-op its `create table if not exists`, but its two `create policy "Allow development select"` / `"Allow development insert"` statements are **not** guarded by `drop policy if exists` and are not currently present on production (confirmed live: `contacts` currently has exactly the 4 `*_own_household` policies from migration 008, nothing else). Replaying `000` would recreate these two permissive, unrestricted, `anon`-scoped policies (`using (true)` / `with check (true)`) on the live `contacts` table — real customer data — for the window between `000` committing and `008` committing (each migration file is its own transaction) later in the same `db push` run. That window is real, live exposure of all contacts data to anonymous read/insert, however brief.

**Required fix, added to §4 below:** repair production's tracking table first, marking `000`–`020` (everything except `005`, never applied anywhere, and `021`/`022`, the two migrations actually being deployed) as applied via `supabase migration repair --status applied <versions...> --linked` — this only writes rows to the tracking table, it does not execute any migration SQL. Confirmed via `--dry-run` afterward that this correctly narrows the push to just `021` and `022` before running it for real. See the corrected §4.

Also confirmed live, same session: production's 10 existing `SECURITY DEFINER` functions are still exactly as documented (`service_role`-only, safe `search_path`, `postgres`-owned, fail-closed default ACL) — 022 remains a provable no-op there. Production `households` currently has 9 rows.

---

## 1. What each migration changes

### Migration 021 — `household_activation_verified`

- **New column:** `households.activation_verified_at timestamptz`, nullable, no default. Existing rows get `NULL` — the correct "not yet verified" state for every current household.
- **New RPC:** `mark_household_activation_verified(p_household_id uuid) returns timestamptz` — `SECURITY DEFINER`, `search_path = ''`. Idempotent by design: sets the timestamp only if currently `NULL`, returns the existing value unchanged on a second call, raises an exception for a nonexistent household id rather than silently no-opping (uses plpgsql's `FOUND`, confirmed to work correctly, unlike the unrelated pre-existing bug in `set_household_stripe_customer_id` noted in `MIGRATION_RECOVERY_PLAN.md`).
- **Permissions (as written in 021 itself):** `revoke all ... from public; grant execute ... to service_role;`. Note: production's `pg_default_acl` for public-schema functions was already confirmed clean (`{postgres=X/postgres}` only, no anon/authenticated) — unlike staging, 021 alone would already leave this function correctly locked down on production even before 022 runs. 022 is being deployed in the same change as permanent, codified policy and defense-in-depth, not because 021 alone would leave production exposed.
- **Expected application impact:** unblocks `POST /api/v1/activation/verify` from 500ing the first time it detects a real qualifying call (the RC1 top release blocker — see `docs/mobile-app/RC1_HANDOVER.md` §7/§12). Dashboard's `activationVerifiedAt` starts reading real values instead of always `null`/`undefined`. **No effect on any currently-shipped web functionality** — this column and RPC are only read/written by the not-yet-released mobile app's endpoints.

### Migration 022 — `lock_down_security_definer_execute_grants`

- **Function permission changes:** existence-checked, explicit `revoke`/`grant` on the same 11 functions (the 10 pre-existing plus 021's new one), enforcing `service_role`-only `EXECUTE`.
- **`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public`:** revokes the default `EXECUTE` grant on future functions from `public`, `anon`, `authenticated`, **and `service_role`** — fail-closed, matching Supabase's own documented recovery pattern.
- **Expected impact on existing RPCs: none, functionally.** Production's 10 pre-existing functions already have exactly `{postgres, service_role}` — confirmed by direct introspection on 2026-07-31 (see `MIGRATION_RECOVERY_PLAN.md`'s production comparison). Every `revoke`/`grant` statement 022 runs against them is a **provable no-op** on production specifically (revoking a privilege never held, granting one already held). This is unlike staging, where the same migration made a real, observable change.
- **Expected impact on future RPCs:** any new `SECURITY DEFINER` function created after 022 must include its own explicit `grant execute ... to service_role`, or it becomes inaccessible to the backend and fails loudly in testing (`permission denied for function X`) — a permanent convention change, already followed by all 13 existing RPC migrations without exception.

---

## 2. Additive / non-destructive / reversible / idempotent

| | 021 | 022 |
|---|---|---|
| **Additive** | Yes — new nullable column, new function. | Not schema-additive; adds restrictions, not objects. |
| **Non-destructive** | Yes — no data deleted, no existing column touched. | Yes — no data touched, no objects dropped. |
| **Reversible** | Yes — `supabase/migrations/_rollbacks/021_rollback_household_activation_verified.sql` exists (drops the function, then the column). Reversible cleanly **only while no real `activation_verified_at` value has been recorded yet** — once real mobile customers exist, rolling back would permanently discard that data. Not a current concern (mobile app isn't live), but the risk changes character after launch. | Yes — `supabase/migrations/_rollbacks/022_rollback_lock_down_security_definer_execute_grants.sql`, written as part of preparing this runbook (did not exist before; drafted now, not applied anywhere). Re-grants `anon`/`authenticated` on the 11 functions and reverses the default-privilege change. Reversing this recreates the original exposure — only run it if 022 itself is found to be wrong, not as a casual undo. |
| **Idempotent** | Yes — `add column if not exists`, `create or replace function`. Confirmed by direct re-run testing this session (staging, and locally in PGlite twice). | Yes — existence-checked `DO` block, `REVOKE`/`GRANT` are no-ops when already in the target state, `ALTER DEFAULT PRIVILEGES ... REVOKE` of an absent entry is a no-op. Confirmed by direct re-run testing (re-applied a second time locally with zero errors). |

---

## 3. Production pre-flight checklist

- [ ] **Current project health** — last confirmed `ACTIVE_HEALTHY`, `eu-west-2`, Postgres `17.6.1.141`, via `supabase projects list` (org-level, no linking) on 2026-07-31, immediately before writing this runbook. **Re-run `supabase projects list` again immediately before execution** — this is a point-in-time snapshot, not a live guarantee.
- [ ] **Linked project verification** — confirm `supabase/.temp/project-ref` is currently **staging** (`tigwgmayeuisrxjjykqd`), not production, right up until the deliberate `supabase link --project-ref psbzynxplxfbyrbdidmn` step in the execution sequence below. Do not link early "just to check something" — every production touch in this runbook should be an intentional, logged step.
- [x] **Backup/snapshot strategy — resolved 2026-08-02.** `supabase backups list --project-ref psbzynxplxfbyrbdidmn` (read-only, no linking required) confirms automatic daily physical backups, 8 days of history, most recent within the last 24h. `pitr_enabled: false` (no point-in-time recovery — not available on this tier), but daily coverage exists and is current. Recommend triggering one additional manual backup immediately before execution anyway, per §8's "belt and braces" guidance — cheap and non-destructive.
- [ ] **Migration history verification** — **do not assume remote ends at `020`.** Confirmed 2026-08-02: production's `supabase_migrations.schema_migrations` tracking table does not exist at all (production has never been touched by CLI-based migration tooling). `supabase migration list --linked` will show every local version with an empty remote column. This must be resolved via `migration repair` (§4 steps 6–8) before pushing anything — see the critical correction at the top of this document.
- [ ] **Pending schema drift** — this project has direct, documented precedent (`docs/engineering/016_017_migration_incident_notes.md`, referenced in `KNOWN_ISSUES.md`) for "migration list says applied" not matching live reality. Before applying 021, explicitly re-confirm (read-only) that `households.activation_verified_at` and `mark_household_activation_verified` do **not** already exist on production — expected, but verify rather than assume.
- [ ] **Function inventory** — re-run the exact `pg_proc`/`pg_get_function_identity_arguments` query used on 2026-07-31 (captured in `MIGRATION_RECOVERY_PLAN.md`) and diff against that snapshot: still exactly 10 `SECURITY DEFINER` functions, same signatures, same owner (`postgres`).
- [ ] **Privilege inventory** — re-run `node scripts/verify-security-definer-grants.js` while linked to production, **before** applying anything, as a pre-check. It is expected to report the 10 existing functions already clean (`service_role`-only) and only fail on `mark_household_activation_verified` not existing yet — confirming the starting state matches what this runbook assumes.
- [ ] **Active users / operational considerations** — production is live with real registered customers and active Stripe subscriptions (confirmed, `docs/releases/2026-07-18_RC1.md`). Neither migration is expected to lock tables meaningfully or interrupt connections (see §8). **The mobile app is not yet released** — no store submission, no TestFlight/Play distribution, no public build exists yet (`RC1_HANDOVER.md` §10/§12) — so migration 021's real-world trigger (a genuine customer completing mobile activation) cannot occur yet regardless of deployment timing, which further lowers urgency and risk. Recommend a low-traffic window as standard practice anyway, though neither migration is expected to produce any observable effect for existing web customers.

---

## 4. Execution sequence

1. Confirm separate, explicit approval for **this specific execution**, not just this runbook's preparation.
2. Resolve the backup/snapshot gap (§3) — confirmed 2026-08-02: production has automatic daily physical backups (`supabase backups list --project-ref psbzynxplxfbyrbdidmn`), most recent within the last 24h. No PITR. Recommend triggering one more immediately before execution anyway, belt and braces, since it's a cheap, non-destructive action.
3. `supabase link --project-ref psbzynxplxfbyrbdidmn`
4. `cat supabase/.temp/project-ref` — confirm the output is exactly `psbzynxplxfbyrbdidmn`.
5. `supabase migration list --linked` — **expect every version to show an empty remote column** (confirmed 2026-08-02 — the tracking table doesn't exist on production yet). This is expected, not an error condition; do not proceed past this step assuming remote already ends at `020`.
6. **Repair the tracking table before pushing anything:** `supabase migration repair --status applied 000 001 002 003 004 006 007 008 009 010 011 012 013 014 015 016 017 018 019 020 --linked` — marks these 20 already-live migrations as applied without executing any of their SQL. Do not include `005` (never applied anywhere) or `021`/`022` (the two actually being deployed).
7. `supabase migration list --linked` again — confirm remote now shows `000`–`004`, `006`–`020` matching local, with only `021`/`022` remaining unapplied.
8. `supabase db push --linked --dry-run` — confirm the output lists **only** `021_household_activation_verified.sql` and `022_lock_down_security_definer_execute_grants.sql`. Do not proceed if it lists anything else.
9. Read-only re-verification per the pending-schema-drift and privilege-inventory checklist items above.
10. `supabase db push --linked` — applies `021` then `022`, in that order, in one pass.
11. Immediately proceed to post-deployment verification (§5) — do not consider the deploy complete until every item there passes.
12. `supabase link --project-ref tigwgmayeuisrxjjykqd` — relink back to staging once verification is complete, returning the repo to its normal working state.

---

## 5. Post-deployment verification checklist

- [ ] **Migration history** — `supabase migration list --linked` shows `021` and `022` with matching local/remote versions; nothing else changed.
- [ ] **`activation_verified_at` exists** — `information_schema.columns` check against `public.households`, same query used on staging.
- [ ] **`mark_household_activation_verified` works** — the identical safe, non-destructive check already proven on staging: call as `service_role` with a nonexistent household UUID, expect the function's own `P0001` "does not exist" exception (proves it reached the function body); call as `authenticated`, expect `42501 permission denied` before the function body runs. Zero real household/subscription/billing data touched by either call.
- [ ] **Every `SECURITY DEFINER` function** — run `node scripts/verify-security-definer-grants.js` while linked to production; must report **"All checks passed."** This single run covers: no `PUBLIC`/`anon`/`authenticated` EXECUTE, `service_role` EXECUTE present, safe `search_path`, correct owner, across all 11 functions dynamically discovered (not a hardcoded list).
- [ ] **`pg_default_acl` corrected** — covered by the same script's default-ACL section; confirms the `postgres`-scoped default for public functions is `{postgres=X/postgres}` only, matching the pre-existing state this project already had (022 should be a provable no-op here on production, per §1).
- [ ] **Service-role backend operations still function** — beyond the safe RPC call above, monitor production logs/error tracking for a short window after deploy for any unexpected `permission denied` errors from existing service-role flows (Stripe webhook processing, Twilio provisioning). Passive monitoring, not an active test — per this session's standing instruction not to invoke real billing/Twilio operations merely to test permissions.

---

## 6. Rollback strategy

- **021:** `supabase/migrations/_rollbacks/021_rollback_household_activation_verified.sql` — drops `mark_household_activation_verified`, then drops `activation_verified_at`. Safe today (no real data recorded yet, mobile app unreleased); re-assess this specific safety judgment if rollback is ever needed after mobile launch, since real customer activation timestamps would be permanently lost.
- **022:** `supabase/migrations/_rollbacks/022_rollback_lock_down_security_definer_execute_grants.sql` — written as part of preparing this runbook (did not exist before today). Re-grants `anon`/`authenticated` on all 11 functions and restores the permissive default privileges. **Reversing 022 recreates the exposure it exists to close** — only appropriate if 022 itself is found to be wrong (e.g., an unexpected application break traced to it), not as a routine undo.
- **General:** per this project's own established convention (`STAGING_ENVIRONMENT_PLAN.md` §6, and 019's own precedent), if a mistake is found after the fact, prefer writing a new forward-fixing migration over re-running a rollback where avoidable — rollbacks exist as a genuine safety net, not the default response to a minor issue.

---

## 7. Operational risk classification

**Low.**

- Both migrations already verified end-to-end on staging, byte-identical SQL, identical target schema.
- 021 is purely additive (nullable column, new function) — no existing behavior can regress.
- 022 is a **provable no-op on production's current actual grant state**, confirmed by direct introspection before this runbook was written — it changes nothing observable on production, it only codifies and future-proofs what production already has.
- No destructive statements in either file (confirmed by the same destructive-statement review methodology used for the full migration set in `MIGRATION_RECOVERY_PLAN.md`).
- Both idempotent — a partial failure or accidental re-run is not harmful.
- Full automated test suite, the dedicated PGlite security-definer check, and the live staging verification all passed already.
- Residual risk is procedural (e.g., human error linking to the wrong project mid-sequence), not in the SQL itself — mitigated by the explicit, ordered checklist above.

---

## 8. User-visible impact and expected downtime

**None expected.** `ALTER TABLE ... ADD COLUMN` for a nullable column with no default is a metadata-only change in Postgres — it does not rewrite the table and takes a near-instantaneous lock. No connection interruption. No functional change visible to any current web customer: activation verification is a mobile-only feature not yet released, and 022 only removes `anon`/`authenticated` access that nothing in the current, shipped application ever used (the backend has always gone through `service_role` exclusively for these RPCs).

---

## 9. Timing relative to first public mobile release

**Before.** This is the actual precondition identified in `RC1_HANDOVER.md`'s own top blocker: `POST /api/v1/activation/verify` will 500 on the very first real customer who completes activation until 021 is live on production — there is no safe way to ship the mobile app to real users, or even progress to a wider internal beta that could produce a genuine qualifying call, without it. 022 should ship in the same change as 021, not deferred to a later pass: it's already fully verified as a no-op-on-production hardening change with no incremental risk from bundling it, and shipping the complete, defense-in-depth fix together is simpler to reason about than a window where 021 is live without 022 formally codifying its access policy.

---

## 10. Stop for approval

Executed 2026-08-02 — see below. This section is kept for the historical record of the approval gate this runbook enforced before that point.

---

## Execution Outcome (2026-08-02)

Executed exactly per the corrected §4, after explicit, separate approval for this specific execution (a written go/no-go report, then a final pre-flight re-verification, then the exact confirmation phrase "EXECUTE PRODUCTION MIGRATION").

**Pre-flight, same session, immediately before execution:**
- `supabase projects list`: production still `ACTIVE_HEALTHY`, unchanged.
- `supabase backups list --project-ref psbzynxplxfbyrbdidmn`: automatic daily backup confirmed, most recent ~11h old at time of execution, 8 days retained. No additional manual backup was requested.
- Confirmed linked project ref via two independent methods: `supabase/.temp/project-ref` and `supabase projects list`'s own `linked: true` flag — both `psbzynxplxfbyrbdidmn`.
- Confirmed no uncommitted changes under `supabase/migrations/` or `scripts/` (`git status`/`git diff --stat` against `HEAD`, both empty for those paths) — only this runbook document itself was locally modified, which `db push` never reads.
- `supabase migration repair --status applied 000 001 002 003 004 006 007 008 009 010 011 012 013 014 015 016 017 018 019 020 --linked` — ran successfully. Verified immediately after that this touched only the tracking table: `households.activation_verified_at` still did not exist, row count still 9, unchanged.
- `supabase db push --linked --dry-run` (twice — once right after repair, once immediately before the real push) — both times listed exactly `021_household_activation_verified.sql` and `022_lock_down_security_definer_execute_grants.sql`, nothing else.

**Execution:**
```
supabase db push --linked
```
Output: `Applying migration 021_household_activation_verified.sql... Applying migration 022_lock_down_security_definer_execute_grants.sql...` — completed with no errors.

**Post-deployment verification — all passed:**
- `supabase migration list --linked`: local and remote match exactly for all 21 versions (`000`–`004`, `006`–`022`).
- `households.activation_verified_at` exists; all 9 existing rows have `NULL` (no existing data touched).
- `mark_household_activation_verified` called as `service_role` with a nonexistent household UUID → raised the function's own business-logic exception (proves it reached the function body; zero real data touched by the call).
- Same RPC called as `anon` → `permission denied for function mark_household_activation_verified`, confirming the grant lockdown holds for the newly-added function too.
- `node scripts/verify-security-definer-grants.js`, run correctly from this worktree (linked to production) — **all checks passed** across all 11 `SECURITY DEFINER` functions (10 pre-existing + the new one): no `PUBLIC`/`anon`/`authenticated` `EXECUTE` on any of them, `service_role` has `EXECUTE` on all, safe `search_path`, correct `postgres` ownership, and the schema's default privileges for future functions confirmed fail-closed.
- One process note, corrected in the moment rather than left wrong: the first attempt at this same script was run from the `sandbox/mobile-app-v1` worktree, which was linked to *staging* at the time — its "all checks passed" output was genuine but was re-verifying staging, not production. Re-run correctly from this (production-linked) worktree immediately after, with the same clean result.

**Relinked back to staging** (`tigwgmayeuisrxjjykqd`) once verification completed, per this runbook's own standing discipline.

**No user-visible impact observed or expected** — matches §8's prediction exactly; nothing in the currently-shipped web application references either migration's changes.
