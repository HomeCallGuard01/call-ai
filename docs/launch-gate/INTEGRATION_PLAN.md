# Integration Plan (PREPARED, NOT AUTHORISED)

**Status:** this plan was prepared on 2026-10-03 from read-only inspection. **Nothing has been merged.** Integration starts only when Andrew explicitly authorises it, and only after the in-flight workstreams declare their branches finished. Do not integrate a branch just because it appears or moves.

Evidence used: `git merge-base --is-ancestor` containment, `git merge-tree --write-tree` pairwise and sequential dry runs (object-only, no refs touched), file-overlap counts, and the migration inventory (`MIGRATION_INVENTORY.md`).

## 1. Lineages: which branch heads actually need integrating

Containment (`A ⊂ B` means B already contains every commit of A):

| lineage | integrate this head | it already contains | notes |
|---|---|---|---|
| DB security | `security/supabase-staging-remediation` 1576531 | fix/terms-acceptances-rls ⊂ fix/staging-default-table-privileges ⊂ it | 057–061 applied on **staging**; the production runbook awaits approval |
| Voice/webhook security | `security/voice-surface-p0` 7f0bae3, **or its successor `security/telephony-abuse-p0` (WS-FRAUD, in flight)** | — | Its /process guard supersedes `fix/process-endpoint-webhook-auth` e2895f1 (PR not opened). Verify on integration, then drop e2895f1 |
| Non-prod environment guard | `fix/nonprod-telephony-mutation-guard` b337438 | feature/nonprod-provisioning-guard ⊂ it | |
| RevenueCat sandbox | `fix/revenuecat-sandbox-environment-guard` f5a920e (PR #50) | — | + migration 053 |
| Finance | **successor of 30d454c**: `security/financial-containment-p0` (WS-FIN, in flight) / `feature/customer-allowance` (WS-BILL, in flight) | feature/provider-neutral-billing-ledger ⊂ feature/financial-safety-hard-limits (= 30d454c) | 051 staging-applied; 056 applied nowhere |
| Number lifecycle | `feature/number-lifecycle-sweep` 8288292 (PR #49) | fix/number-lifecycle-entitlement-guard (PR #45) ⊂ it | 047 staging-applied; 052 staging objects with no history row; 054 |
| Call delivery / iOS | `release/ios-1.0.2` cb710dd | incident triage ⊂ p0/call-delivery-resilience ⊂ readiness/android-call-delivery ⊂ readiness/ios-parity ⊂ it; feature/ios-102-dynamic-pricing ⊂ it | Holds the 055/060/061 draft collisions |
| Identity | `feature/customer-identity-carrier-abstraction` (WS-ID, in flight; currently = main + uncommitted work) | — | |
| Admin | `feature/admin-control-centre-v2` 7ac1d3a (Draft PR #51) | feature/admin-business-control-observational (PR #48) ⊂ it | #51 supersedes #48 and the e5a1e5f business-control line. Holds the 055 collision |
| Migration tooling | `fix/migration-safety-tooling` 4220d82 (PR #46) | — | Clean merge. Bring it in early: its drift checks are needed during integration |
| Research / docs | research/commercial-network-viability, research/carrier-routing-v2 (in flight), docs/acquisition-readiness | — | Docs only. Merge them or leave them as reference; they are not launch-gating |

## 2. Branch dependency graph

```
origin/main eb43368
 ├─► [0] gate prep: test-runner refactor + frozen migration allocation   (needs authorisation)
 ├─► [1] fix/migration-safety-tooling (PR #46)                            clean
 ├─► [2] security/supabase-staging-remediation (057–061)                  clean
 ├─► [3] security/voice-surface-p0 ─► security/telephony-abuse-p0 (WS-FRAUD successor)
 │        │   closes PR-01, PR-02 (webhook auth, /media-stream token, SMS caps, client-origin)
 │        └─► (WS-FRAUD adds: rate limits, destination validation, exact-E.164 trust, orphan release?)
 ├─► [4] fix/nonprod-telephony-mutation-guard ─► [5] fix/revenuecat-sandbox-environment-guard (053)
 ├─► [6] provider-neutral-billing-ledger ⊂ 30d454c ─► WS-FIN financial-containment-p0 (051, 056)
 │                                                 └─► WS-BILL customer-allowance (same base: consecutive)
 ├─► [7] WS-ID customer identity / carrier abstraction
 │        (households.js, routing lookup PR-09, number history; conflicts with [8] on households/twilioProvisioning)
 ├─► [8] number-lifecycle-entitlement-guard ⊂ number-lifecycle-sweep (047, 052, 054)
 ├─► [9] incident ⊂ call-delivery-resilience ⊂ android-call-delivery ⊂ ios-parity ⊂ release/ios-1.0.2
 │        (renumber 055/060/061 → 062–064 first)
 ├─► [10] admin-control-centre-v2 (#51; renumber its 055)
 ├─► [11] carrier-dependent changes (carrier-routing-v2 POCs, landline) — only after the WS-CARR decisions
 └─► [12] launch-gate validation on the integrated tree (this branch's framework)
```

## 3. Proposed integration order and why

The rough order in the brief was security → migrations → financial → fraud → identity → allowance → admin → carrier → gate. After inspecting the code I propose these changes to it:

| step | branch | why here |
|---|---|---|
| 0 | **Gate prep** (one small commit on the integration branch): replace the single-line `"test"` script in package.json with a runner that reads a manifest or globs `tests/*.test.mjs`. Freeze the migration allocation. | package.json conflicts with **19 of 28** unmerged branches. Every pairwise merge in the dry run conflicts on it. Fixing it once removes the most common conflict |
| 1 | fix/migration-safety-tooling | Clean. Its numbering and drift checks are needed while integrating |
| 2 | security/supabase-staging-remediation | SQL plus tests only, clean, and already the state of staging. The code merge is independent of the **production** apply decision (see §5) |
| 3 | voice-surface-p0 → telephony-abuse-p0 | **Security foundation.** The Fraud Fortress branch is built *on* voice-p0, so "security" and "fraud" are one lineage, not two separate steps. It must land before Finance because Finance's admission control trusts `/voice` request authenticity (30d454c `callAdmission.js:124-126` admits unsigned requests uncounted) |
| 4–5 | nonprod mutation guard; RevenueCat sandbox guard | Small and independent; they close PR-08 and the environment side of C7. Merge before Finance so 053 precedes 056 numerically |
| 6 | Financial Fortress, then Customer Allowance | Same base (30d454c), so they must be consecutive. Allowance needs Finance's 056 schema. **Resolve the duplicate cap implementations here** (§4) |
| 7 | Customer Identity | Independent of Finance in code. It must precede the number lifecycle, because both rewrite `households.js` and `twilioProvisioning.js`, and the lifecycle sweep should operate on the *new* identity/number model rather than be rebased twice. **Decision point:** if Allowance keys usage to the new account number, swap 6b and 7 |
| 8 | number-lifecycle-sweep (#45 + #49) | Conflicts with nonprod-guard and Identity on `twilioProvisioning.js`. It goes after both |
| 9 | release/ios-1.0.2 lineage | Largest mobile surface. Renumber 055/060/061 first. Its client-origin `/voice` guard duplicates voice-p0's (§4) |
| 10 | admin-control-centre-v2 | Read models over everything above. It must read the final schema (ledger, allowance, identity) |
| 11 | carrier-dependent changes | Gated by WS-CARR research outcomes (trusted-bypass hybrid, POC1/POC2) |
| 12 | Launch-gate validation | Re-run `tests/launch-gate/run.mjs` on the integrated tree and bind `LAUNCH_GATE_FINANCIAL_ADAPTER` to the real admission and allowance code (on pglite with all migrations, then staging). Execute the manual specs |

**Do not integrate:** `fix/process-endpoint-webhook-auth` (superseded by voice-p0), `feature/admin-business-control` e5a1e5f and PR #48 (superseded by #51), `feature/ios-102-dynamic-pricing` and `docs/price-599-release-audit` (contained in release/ios-1.0.2; the latter holds an obsolete `058_call_delivery_events`), or `wip/monitoring-allowance-financial-safety-2026-09-26` (the 046 draft, superseded by 056).

## 4. Predicted merge conflicts

Textual conflicts, from the sequential dry run of steps 2→10 on top of main:

| merging | conflicts with what's already integrated |
|---|---|
| supabase-remediation | clean |
| voice-surface-p0 | clean |
| nonprod-telephony-mutation-guard | package.json |
| revenuecat-sandbox-guard | clean |
| financial-safety-hard-limits (30d454c) | package.json, **server.js**, **services/liveMonitoring/mediaStreamHandler.js** |
| number-lifecycle-sweep | package.json, server.js, **services/twilioProvisioning.js**, tests/migrations.pglite.test.mjs |
| release/ios-1.0.2 | package.json, server.js |
| admin-control-centre-v2 | package.json, server.js, tests/migrations.pglite.test.mjs |
| migration-safety-tooling | clean |

Hot files, by number of unmerged branches touching them: package.json 19, server.js 12, tests/migrations.pglite.test.mjs 10, routes/mobileApi.js 8, database/calls.js 6, services/callRouting.js 5, services/twilioProvisioning.js 5, services/alerting.js 5, services/liveMonitoring/mediaStreamHandler.js 4. `database/households.js` is touched by the two number-lifecycle branches and will be touched by WS-ID.

**Semantic conflicts that git will not show (most important):**
1. **Migration numbers.** 055, 060 and 061 each have two different files that both merge "cleanly" because the filenames differ. Both are then applied by pglite, in lexicographic order. Resolve them using `MIGRATION_INVENTORY.md`.
2. **Duplicate cost caps.** voice-p0 adds `costCaps` (2 streams per household, SMS 3 per day / 30 per hour, transcription caps). 30d454c adds `safetyConfig` (3 calls per household, 2 monitored streams per household, £ caps) plus `callAdmission`. Two independent counters for the same thing will diverge. **One admission authority must own each limit.** Recommendation: Finance's DB-backed admission is authoritative, and voice-p0's in-memory caps stay only as a per-instance backstop.
3. **Duplicate client-origin `/voice` guard.** It exists in voice-p0 *and* readiness/ios-parity (`server.js:763`). Keep one.
4. **Rate limiting.** readiness/android-call-delivery adds `middleware/householdRateLimit.js` (authenticated routes). WS-FRAUD may add IP-level limits. Unify them.
5. **Admission and webhook authenticity.** Once voice-p0 enforces signatures, 30d454c's "unsigned ⇒ admitted, not counted" branch should become unreachable. Add a test.
6. **Spend guard.** The ledger branch's `spendGuard.js` / `companySpendProtection.js` is recommend-only, while 30d454c's `admit_call` enforces. Do not wire both.
7. **Test harness.** `tests/helpers/fakeSupabase.mjs` is touched by 5 delivery-lineage branches. Check that the Finance and Identity tests still use a compatible fake.

## 5. Migration apply order (separate from code merge order)

Production is at **046**. Staging has 047, 051, 057–061 (and orphan 050/052 objects). If 057–061 are applied to production per the runbook **before** 047–056, production history jumps over unapplied lower numbers. The Supabase CLI then refuses later pushes without `--include-all` (the `LegacyDbPushMissingRemoteError` seen on 2026-09-27). That is exactly the drift class behind the 046 repair.

**Decision required (Andrew), before any production apply.** Choose one:
- (a) Apply in number order: 047 → 051 → 052 → 053 → 054 → 056 → 057–061, then the renumbered 062+. This delays the RLS hardening until Finance is ready.
- (b) Apply 057–061 now for security and consciously accept `--include-all` later, recording the decision in `STAGING_TO_PRODUCTION_MIGRATION_PROCESS.md`.
- (c) Apply 057–061 now via the tracked CLI, and **apply the earlier ones only after they are renumbered above 061**. 047/051 are already applied on staging under their numbers, so this would create staging/production numbering divergence. Not recommended.

The launch-gate recommendation is **(b)**: the RLS exposure is a live security risk and the drift is manageable if it is documented. This is a recommendation only.

## 6. Preconditions for authorising integration

- [ ] Each in-flight workstream (WS-FIN, WS-FRAUD, WS-BILL, WS-ID, WS-CARR) declares its branch final, pushed and handed over.
- [ ] Migration allocation in `MIGRATION_INVENTORY.md` frozen and approved.
- [ ] Production apply-order decision (§5) recorded.
- [ ] Step 0 test-runner refactor approved.
- [ ] Integration happens on a fresh `integration/launch-<date>` branch, never on main and never in another session's worktree.
- [ ] After every step: full suite + `node tests/launch-gate-framework.test.mjs` + `node tests/launch-gate/run.mjs` and the migration inventory. Record the deltas in the integration log.
