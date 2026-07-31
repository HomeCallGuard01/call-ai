# Production Migration Runbook — Migrations 021 & 022

**Status:** Proposed. Not executed. No linking, no SQL, no changes have been made to production (`psbzynxplxfbyrbdidmn`) as part of preparing this document — only an org-level project listing (`supabase projects list`), which does not link to or touch any project's database.
**Scope:** Apply exactly `021_household_activation_verified.sql` and `022_lock_down_security_definer_execute_grants.sql` to production. Nothing else. Both are already applied to and verified on staging (`tigwgmayeuisrxjjykqd`) — see `docs/engineering/MIGRATION_RECOVERY_PLAN.md`.
**Do not execute any step below without separate, explicit approval, per this project's established convention for launch-critical/architectural work.**

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
- [ ] **Backup/snapshot strategy — currently unconfirmed, must be resolved first.** `docs/engineering/STAGING_ENVIRONMENT_PLAN.md` §8 flagged this and it has never been checked: production's Supabase plan/tier and backup retention (Free tier has no automatic backups; paid tiers add daily backups, higher tiers add point-in-time recovery) needs dashboard access to confirm. **Action required before execution:** check the Supabase dashboard's Database → Backups page for the production project. If no automatic backup exists, take an explicit manual backup (dashboard "Database backups" button, or `pg_dump` against the production connection string) immediately before running anything below, regardless of how low-risk these two migrations are assessed to be — belt and braces, per §8's own recommendation.
- [ ] **Migration history verification** — after linking (execution time only), `supabase migration list --linked` must show production's remote history ending at `020`, with `021` and `022` present locally but not yet remotely. Confirm no unexpected extra versions and no `005` (should never appear — it was never applied here either, confirmed by `calls` having zero RLS policies on production this session).
- [ ] **Pending schema drift** — this project has direct, documented precedent (`docs/engineering/016_017_migration_incident_notes.md`, referenced in `KNOWN_ISSUES.md`) for "migration list says applied" not matching live reality. Before applying 021, explicitly re-confirm (read-only) that `households.activation_verified_at` and `mark_household_activation_verified` do **not** already exist on production — expected, but verify rather than assume.
- [ ] **Function inventory** — re-run the exact `pg_proc`/`pg_get_function_identity_arguments` query used on 2026-07-31 (captured in `MIGRATION_RECOVERY_PLAN.md`) and diff against that snapshot: still exactly 10 `SECURITY DEFINER` functions, same signatures, same owner (`postgres`).
- [ ] **Privilege inventory** — re-run `node scripts/verify-security-definer-grants.js` while linked to production, **before** applying anything, as a pre-check. It is expected to report the 10 existing functions already clean (`service_role`-only) and only fail on `mark_household_activation_verified` not existing yet — confirming the starting state matches what this runbook assumes.
- [ ] **Active users / operational considerations** — production is live with real registered customers and active Stripe subscriptions (confirmed, `docs/releases/2026-07-18_RC1.md`). Neither migration is expected to lock tables meaningfully or interrupt connections (see §8). **The mobile app is not yet released** — no store submission, no TestFlight/Play distribution, no public build exists yet (`RC1_HANDOVER.md` §10/§12) — so migration 021's real-world trigger (a genuine customer completing mobile activation) cannot occur yet regardless of deployment timing, which further lowers urgency and risk. Recommend a low-traffic window as standard practice anyway, though neither migration is expected to produce any observable effect for existing web customers.

---

## 4. Execution sequence

1. Confirm separate, explicit approval for **this specific execution**, not just this runbook's preparation.
2. Resolve the backup/snapshot gap (§3) — confirm automatic coverage or take a manual backup.
3. `supabase link --project-ref psbzynxplxfbyrbdidmn`
4. `cat supabase/.temp/project-ref` — confirm the output is exactly `psbzynxplxfbyrbdidmn`.
5. `supabase migration list --linked` — confirm remote history ends at `020`; `021`/`022` absent remotely.
6. Read-only re-verification per the pending-schema-drift and privilege-inventory checklist items above.
7. `supabase db push` — applies `021` then `022`, in that order, in one pass. (No `--include-all` needed here, unlike staging's `000` case — nothing is being inserted before an already-applied migration; `021`/`022` are simply the next two in sequence.)
8. Immediately proceed to post-deployment verification (§5) — do not consider the deploy complete until every item there passes.
9. `supabase link --project-ref tigwgmayeuisrxjjykqd` — relink back to staging once verification is complete, returning the repo to its normal working state.

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

Nothing in this runbook has been executed. Waiting for explicit approval to proceed with §4's execution sequence — including separate confirmation that the backup/snapshot gap in §3 has been resolved first.
