# Handover — Launch Fortress integration (Claude 1, 2026-10-03)

**Nothing was deployed, merged to main, or applied to any database. No provider was contacted or reconfigured.**

## 1. Branch
`integration/launch-fortress-2026-10-03` (pushed to `origin`; upstream deliberately NOT `main`).

## 2. Worktree
`/Users/ad/call-ai-launch-fortress` (`node_modules` → symlink to `/Users/ad/call-ai/node_modules`, git-excluded;
`mobile/node_modules` installed locally with `npm ci`, git-ignored).

## 3. Base commit
`origin/main` @ `eb43368` (Merge PR #44).

## 4. Exact final HEAD
The commit that adds this file (`git log -1`). Last code/test commit before the docs: `599b232`.

## 5. Clean / pushed
Clean and pushed at handover (verified after the push; see §29).

## 6. Branches integrated (12 merges, each `--no-ff`)
`fix/migration-safety-tooling` 4220d82 · `security/supabase-staging-remediation` 1576531 ·
`security/telephony-abuse-p0` 30cd799 (⊃ `security/voice-surface-p0` 7f0bae3) ·
`fix/nonprod-telephony-mutation-guard` b337438 (⊃ nonprod-provisioning-guard) ·
`fix/revenuecat-sandbox-environment-guard` f5a920e ·
`security/financial-containment-p0` 56bbd5e (⊃ financial-safety-hard-limits 30d454c ⊃ provider-neutral-billing-ledger 7ad12c9) ·
`feature/customer-allowance` 2f438d1 · `feature/customer-identity-carrier-abstraction` 4fa8008 ·
`feature/number-lifecycle-sweep` 8288292 (⊃ entitlement-guard) ·
`release/ios-1.0.2` cb710dd (⊃ call-delivery-resilience, android-call-delivery, ios-parity, ios-102-dynamic-pricing, forwarding-number fix) ·
`feature/admin-control-centre-v2` 7ac1d3a (⊃ #48) · `test/launch-gate-adversarial` 00b12f1.

## 7. Deliberately NOT integrated
`fix/process-endpoint-webhook-auth` (superseded by voice-p0 — verified); `feature/admin-business-control` & #48 (superseded by #51);
`docs/price-599-release-audit`, `wip/monitoring-allowance-financial-safety-2026-09-26` (046 collision, superseded by 056);
`architecture/voice-provider-portability` (post-launch); all `research/*` incl. `research/carrier-routing-v2` (evidence only; no POC);
`docs/*` branches; `feature/staging-safety-hardening` (overlaps the nonprod guard; for its owner); website/marketing tracks;
stale Aug–Sep mobile histories. Detail: `docs/integration/2026-10-03-INTEGRATION_GRAPH.md` §3.

## 8. Commit / ancestry summary
`c7fc248` pre-merge docs → 12 merges (`8cc3b22` … `e66baa0`) → integration commits:
`ddb756e` probe gaps PR-02/03/04/07/09 · `c7cee81` auth rate limits · `d699886` 066/067 numbered, 068 £ bridge, test runner ·
`e2e9b9b` allocation test · `0208fc5` one financial authority, atomic abuse concurrency, deliveryTrusted, integrated suite ·
`fe2026d` canonical entitlement (070) · `14934f1` real-Postgres races · `155c966` commercial validation, admin overview, honest customer state ·
`4f52e1a` FC contract bound to real Fortress · `438082d` stray-block fix + runner-aware tests · `599b232` date-independent 051 test · docs.

## 9. Migration reconciliation
`docs/integration/2026-10-03-MIGRATION_RECONCILIATION.md`. Rule: an applied migration keeps its identity.

## 10. Permanent proposed sequence (all DRAFT unless stated)
046 (prod+staging) · 047 (staging) · 048–050 burned · 051 (staging) · 052 (staging objects, history row missing) · 053 · 054 · 055 call_delivery_evidence ·
056 · 057–061 (staging) · 062 identity · 063 allowance · **064** call_delivery_events (was 060) · **065** household_iphone_carrier (was 061) ·
**066** telephony_abuse_shared_state (was provisional) · **067** financial_containment ledger (was provisional) · **068** allowance £ bridge (new) ·
**069** account_classification_history (was admin 055) · **070** stripe canonical entitlement (new). Pinned by `tests/migration-allocation.test.mjs`.

## 11. Major conflicts
`docs/integration/2026-10-03-CONFLICT_DECISIONS.md` (M4–M11 merge decisions, P1–P18 post-merge). Highlights: single signature verdict;
abuse financial port left unwired (Fortress is the one authority); 056 household burst made opt-in (victim lockout); 056 monitoring-slot leak fixed;
missing import (ReferenceError) restored; lifecycle sweep gated by environment guard; duplicate client-origin guard collapsed; unauthenticated
voicemail route guarded; admin "limits" table made truthful.

## 12. Final inbound-call pipeline
`docs/integration/2026-10-03-SAFETY_PIPELINE.md` — authenticity → integrity/replay → client-origin → household → incident (incl. Fortress kill/breaker)
→ hold → loop → caller velocity → household volume (flag only) → concurrency → identity defects → 056 DB admission → **Fortress global + household
reservation** → trust takes effect → monitoring decision → egress guard → `<Dial timeLimit>` → lease renewal → verified settlement → (actual reconciliation: not wired).

## 13. Financial invariants
I1 reserve-before-spend, I2 atomic (real PG 12-way), I3 leases, I4 provider timeLimit, I5 Σ worst case ≤ authorisation, I6 idempotency, I8 no early reset,
I9 no client can raise a limit — test-proven locally. **I7 actual cost: ledger logic proven, feed NOT wired.** **I10 fail-closed: bounded degraded
envelope (D3) — FC-6 fails in that mode.**

## 14. Fraud invariants
Destination policy precedes trust; full-E.164 trust; premium/070/076/087/09/STIR-fail never trusted; no outbound PSTN leg; loops refused; per-caller
velocity; household volume never refuses; concurrency claim atomic; replay; incident modes; provisioning single-flight/adopt. Process-local state (066 adapters not written).

## 15. Customer allowance
Authoritative = Fortress £ budget. Customer sees percentages (default source `fortress`); `callsContinue` / `trustedCallersContinue` honest for a trusted-only reserve.
Top-ups and admin adjustments credit the same £ atomically (068) with a margin cap at credit time. All values and copy are placeholders/DRAFT.

## 16. Account number
Permanent `HCG-` + serial + Luhn, server-generated, unique, never recycled, independent of number/provider, not a credential; forging refused by grants
and trigger; 60-way race on real PostgreSQL distinct. Shown on web dashboard and admin overview. Mobile UI not changed. Backfill not run.

## 17. Billing / entitlement
One canonical decision: stale rows never block; paid Stripe supersedes complimentary; no channel revokes another in-effect paid channel (support alerted);
RevenueCat replay/out-of-order cannot shorten access; sandbox never supersedes and is unfunded. Stripe dedupe at claim layer. No live store products created.

## 18. Carrier abstraction
Provider-neutral adapter + routing assignments (062) present; only `twilio` registered; no migration away from Twilio; no POC.

## 19. Admin
`GET /admin/api/fortress/overview` (requireAuth + requireAdmin, read-only, labelled "visibility only"). Safety-state changes remain audited DB functions.
Control-centre "limits" table reports integrated controls as "code present — verify", never "enforced".

## 20. Cost surfaces
`docs/integration/2026-10-03-COST_SURFACE_INVENTORY.md`.

## 21. Automated tests (exact)
Integrated: `npm test` (scripts/run-all-tests.mjs, every `tests/*.test.mjs`, offline dummy env, `FC_REALPG_MODULES` set):
**174 files, 174 passed, 0 failed; 7,603 checks ✓, 0 ✗.**
Baseline untouched `origin/main` eb43368, same environment: **105 files, 105 passed; 3,803 ✓, 0 ✗.**
(Earlier in the session the two Android tests failed on main only because `mobile/node_modules` was absent.)
Mobile `tsc --noEmit`: 0 errors. `eslint no-undef/no-redeclare/no-dupe-keys` on backend JS: 1 error, pre-existing on main (duplicate export key in `database/households.js`).

## 22. Real PostgreSQL concurrency (PostgreSQL 18.4 embedded, 12 connections, all migrations 046–070)
`financial-containment-realpg` 15/15; `launch-fortress-realpg` 8/8 (account numbers, routing claim, provisioning claim, £ top-up replay, top-ups racing authorisations).

## 23. Launch gate
`docs/integration/2026-10-03-LAUNCH_GATE_RESULT.md`. Probes 10 PASS / PR-07 FAIL (deliberate) / PR-11 FAIL (static grep; implemented). FC 6 PASS; FC-3 FAIL (model); FC-6 FAIL under D3 bounded.
Registry 0 PROVEN. `--enforce` exit 1. **GATE CLOSED.**

## 24. RED
R1 migrations unapplied · R2 no provider billing feed · R3 Twilio Console/credentials unevidenced · R4 HCG-unreachable behaviour · R5 commercial values ·
R6 abuse state process-local · R7 production signature must pass · R8 production apply order.

## 25. AMBER
Staging/provider proofs listed in the gate result §5 and the staging plan.

## 26. Commercial decisions for Andrew
Gate result §6 (D1–D9, minutes, top-ups, price, reserve scope, sandbox funding, copy, apply order).

## 27. NOT performed
No deploy; no merge to main; no PR; no migration applied (local PGlite / throwaway embedded PostgreSQL only); no production or staging read/write;
no Twilio/Stripe/RevenueCat/Supabase/Apple/Google/OpenAI change; no number bought/released; no call placed; no provider contacted; no branch or worktree deleted.

## 28. Recommended next step
Andrew decides D3, D1 (staging values), reserve scope and the production apply order; then execute
`docs/integration/2026-10-03-STAGING_VALIDATION_PLAN.md` on staging.

## 29. Resume commands
```
cd /Users/ad/call-ai-launch-fortress && git status && git log --oneline -5
npm test                                     # every tests/*.test.mjs
FC_REALPG_MODULES=<dir with embedded-postgres + pg> npm test -- realpg
FC_DEGRADED_MODE=bounded LAUNCH_GATE_FINANCIAL_ADAPTER=tests/launch-gate/adapters/fortress-pglite.mjs node tests/launch-gate/run.mjs
node tests/launch-gate/migration-inventory.mjs --min 046
```

## 30. Confirmation
No production, staging or provider change occurred. Secret scan of the branch diff and this file: see the commit message of this handover.
