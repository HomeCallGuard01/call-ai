Document: Launch Readiness Checklist — Mobile App V1 + Production Migrations 021/022
Status: Preparation only. Nothing in this document has been scheduled or executed against production.
Last Updated: 2026-07-31
Owner: Andrew Deane

---

# Launch Readiness Checklist

Legend: ✅ Complete — 🟡 Pending (actionable, not yet done) — 🔴 Blocked (cannot proceed until something outside this checklist resolves)

Every item below is evidence-based against this session's work, `docs/mobile-app/RC1_HANDOVER.md`, `docs/launch/KNOWN_ISSUES.md`, `docs/engineering/STAGING_ENVIRONMENT_PLAN.md`, and `docs/engineering/PRODUCTION_MIGRATION_RUNBOOK_021_022.md`. Nothing here is scheduled — this is the list of what remains before the runbook can be executed.

---

## 1. Mobile application validation against staging — 🟡 Pending

- Mobile app code lives on branch `sandbox/mobile-app-v1` (checked out at `/Users/ad/call-ai-sandbox-mobile-app-v1`, currently at commit `cb61962`), not merged to `main`.
- No `mobile/.env.staging` exists yet. `STAGING_ENVIRONMENT_PLAN.md` §3 (staging environment variables, including `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_ANON_KEY` for the mobile app) is still marked not done.
- Every screen verified in `RC1_HANDOVER.md` §5 was captured via `expo start --web` + Playwright against whatever backend existed at the time (pre-staging) — **the mobile app has never been run against the staging project at all**, with or without migrations 021/022 present.
- **Action needed:** create `mobile/.env.staging` pointed at `tigwgmayeuisrxjjykqd`, run the app (ideally on a real device or simulator — see item 2's related gap in `RC1_HANDOVER.md` §12.2, not just the web-preview substitute again), and re-verify the 20-screen set against real staging data with 021/022 applied.

## 2. End-to-end phone call using a real phone — 🔴 Blocked

- Requires a real, carrier-forwardable Twilio number to dial the activation code against.
- **Blocked by `KNOWN_ISSUES.md` Severity 1: "UK number purchase requires a registered Twilio Address."** No registered office address has been confirmed (`public/terms.html` §1 still reads `[REGISTERED OFFICE ADDRESS TO BE CONFIRMED]`), so no Twilio `Address` object exists, so **no real UK number can be purchased in any environment** — staging or production — until that business decision is made.
- Also currently unmet: staging has no Twilio credentials configured at all (`STAGING_ENVIRONMENT_PLAN.md` §3 recommends a separate Twilio subaccount for staging; not started).
- `RC1_HANDOVER.md` §11 manual test plan step 10 explicitly documents this was never performed, for what was then a different blocking reason (migration 021 missing). That specific reason is now resolved on staging — this one is not, and is a business/administrative blocker, not an engineering one.

## 3. Activation flow verification — 🔴 Blocked (mixed — see breakdown)

- **RPC/schema level: ✅ Complete.** `mark_household_activation_verified` verified directly against staging this session — correct idempotent behavior, correct `service_role`-only access (proven via a live, non-destructive call), correct denial for `authenticated`.
- **Full user-facing flow (mobile app → real call → B5 detects and advances → dashboard reflects "Protected"): 🔴 Blocked.** Same root cause as item 2 — cannot exercise the real path without a real, dialable number.
- Overall status shown as Blocked because the item as commonly understood ("activation flow verification") means the full flow, not just the database layer underneath it.

## 4. Dashboard verification — 🟡 Pending

- **Web dashboard:** no functional change expected or introduced by 021 (mobile-only) or 022 (confirmed no-op against production's actual grant state); full automated web test suite passes (`npm test`, exit 0). Low risk, but not explicitly re-screenshotted against staging post-022 — recommend a quick manual pass, not because a defect is expected, but because it's cheap and this project has repeated, hard-won precedent (016's silent revert) for not assuming "should be fine" without a direct look.
- **Mobile dashboard (C1 Home, protected vs. not-entitled states):** only ever visually verified via the web-preview substitute, against a pre-staging backend (`RC1_HANDOVER.md` §5). Not yet re-verified against staging with 021 present. Depends on item 1.

## 5. Stripe billing verification — 🟡 Pending

- **Schema/RPC level: ✅ Complete.** Migrations 010–015, 019 all applied and tested on staging (PGlite smoke tests + live schema verification this session); full test suite passes.
- **Live Stripe Sandbox checkout → webhook → entitlement flow, run specifically against staging: not yet done.** Requires Stripe test-mode keys and a test-mode webhook endpoint configured for staging (`STAGING_ENVIRONMENT_PLAN.md` §3, not started).
- Context: this exact flow *was* verified live, end-to-end, against **production** during the original RC1 pass (`docs/releases/2026-07-18_RC1.md`) — the underlying billing logic has real-world proof. What's outstanding is re-confirming it specifically on the now-separate staging project, for parity before staging becomes the standard pre-production gate.

## 6. Twilio provisioning verification — 🔴 Blocked

- **Schema/RPC level: ✅ Complete.** Migrations 016/017 applied and tested on staging.
- **Live provisioning (a real Twilio purchase attempt) against staging: blocked** by the same UK Address gap as item 2, plus staging Twilio credentials not yet configured (§3).
- Independent of the Address blocker: `KNOWN_ISSUES.md` records that migration 016's functions were previously found, verified, and then **silently reverted** on production with no root cause ever identified, and explicitly states "no previously-verified database change in this project can be assumed to still be in place without re-checking." Recommend a live functional re-verification of 016/017 (not just schema presence) before relying on them for a real launch, independent of when the Address blocker resolves.

## 7. Production backup confirmation — 🟡 Pending

- Explicitly flagged, unresolved, in both `PRODUCTION_MIGRATION_RUNBOOK_021_022.md` §3 and originally `STAGING_ENVIRONMENT_PLAN.md` §8. Production's Supabase plan tier and backup/point-in-time-recovery coverage has never been confirmed — needs dashboard access.
- **Action needed:** check the Supabase dashboard's Database → Backups page for `psbzynxplxfbyrbdidmn`. If no automatic daily backup exists, take an explicit manual backup immediately before running the production migration runbook, regardless of the runbook's own Low risk classification.

## 8. Production pre-flight verification from the runbook — 🟡 Pending

- Correctly not yet run. `PRODUCTION_MIGRATION_RUNBOOK_021_022.md` §3's live checks (function inventory, privilege inventory, migration history, schema-drift re-check) are designed to be executed at deployment time — running them now would just be a stale snapshot by the time deployment actually happens. Nothing blocks these; they're intentionally deferred to the execution sequence itself.

## 9. Go / No-Go approval checklist — 🟡 Pending

Proposed gate — every item must be true before requesting execution approval for the production runbook:

- [ ] Items 1–7 above are ✅ Complete (item 2/3/6's phone-call-dependent pieces may reasonably be deferred past initial production migration — see the note under "Timing" below — but must be an explicit decision, not a silent gap).
- [ ] Item 8 (pre-flight) has been run within the same session as execution, not from a stale earlier check.
- [ ] Backup coverage (item 7) confirmed or a fresh manual backup exists.
- [ ] No open, unresolved Severity 1 item in `KNOWN_ISSUES.md` blocks the specific migrations being deployed (021/022 themselves are not blocked by the Twilio Address issue — that only blocks the *real-phone* verification items, not the schema/permission changes).
- [ ] Explicit, separate approval given for the specific execution (not just this checklist or the runbook's preparation).

**Not yet satisfied** — awaiting items above.

## 10. Production deployment sequence — 🟡 Pending

- Fully specified in `PRODUCTION_MIGRATION_RUNBOOK_021_022.md` §4. **Not scheduled, not executed**, per this task's explicit instruction. Will not be run without separate, explicit approval at that time.

## 11. Post-deployment verification — 🟡 Pending

- Fully specified in `PRODUCTION_MIGRATION_RUNBOOK_021_022.md` §5. Not yet run — deployment has not happened.

## 12. Rollback criteria — ✅ Complete (drafted; pending your review/approval like everything else here)

Rollback **scripts** already exist and are committed: `supabase/migrations/_rollbacks/021_rollback_household_activation_verified.sql` and `.../022_rollback_lock_down_security_definer_execute_grants.sql`. Explicit **trigger criteria** for when to use them, drafted now:

**Roll back if, after production deployment:**
- `node scripts/verify-security-definer-grants.js` reports any failure when run against production.
- `information_schema.columns` shows `households.activation_verified_at` missing, or `mark_household_activation_verified` missing/incorrect (deployment didn't actually apply cleanly — matches this project's own precedent for "exited 0 ≠ actually applied," e.g. migration 016).
- Any existing service-role backend flow (Stripe webhook processing, Twilio provisioning, any currently-shipped route) begins returning `permission denied` errors traceable to 021/022, observed via production logs/error tracking in the post-deployment monitoring window.
- `supabase migration list --linked` shows anything unexpected beyond exactly `021` and `022` newly applied.

**Do not roll back for:**
- `activation_verified_at` remaining `NULL` for all real households — expected and correct, since the mobile app isn't publicly released yet and nothing will set it for a while.
- Any Twilio/Stripe-related pre-existing issue already tracked in `KNOWN_ISSUES.md` (e.g., the UK Address blocker) — unrelated to 021/022, not a regression they caused.

**Timing note:** rolling back 021 is clean and lossless *only* before real mobile customers exist. Once the mobile app is publicly released and real `activation_verified_at` values start being recorded, rolling back 021 would permanently discard that data — the criteria above should be re-reviewed at that point, not assumed to still apply unchanged.

Rollback is never automatic — invoking either script requires the same explicit approval as forward deployment.

---

## Summary

| # | Item | Status |
|---|---|---|
| 1 | Mobile application validation against staging | 🟡 Pending |
| 2 | End-to-end phone call using a real phone | 🔴 Blocked (Twilio UK Address) |
| 3 | Activation flow verification | 🔴 Blocked (RPC layer ✅, full flow blocked) |
| 4 | Dashboard verification | 🟡 Pending |
| 5 | Stripe billing verification | 🟡 Pending |
| 6 | Twilio provisioning verification | 🔴 Blocked (Twilio UK Address + revert precedent) |
| 7 | Production backup confirmation | 🟡 Pending |
| 8 | Production pre-flight verification (runbook) | 🟡 Pending (by design — deferred to execution time) |
| 9 | Go / No-Go approval checklist | 🟡 Pending |
| 10 | Production deployment sequence | 🟡 Pending — not scheduled |
| 11 | Post-deployment verification | 🟡 Pending |
| 12 | Rollback criteria | ✅ Complete (drafted, awaiting your sign-off) |

**The single common blocker across items 2, 3, and 6 is the same one: no registered office address → no Twilio Address object → no real UK number in any environment.** Resolving that one open business decision unblocks three of the twelve items at once. Everything else is either already done at the schema/RPC level or is straightforward, unstarted setup work (staging env vars for the mobile app, Stripe/Twilio staging credentials, a backup check) with no external dependency.

Nothing in this document has been scheduled or executed. This file is written but not yet committed — let me know if you'd like it committed.
