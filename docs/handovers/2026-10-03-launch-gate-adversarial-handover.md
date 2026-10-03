# Handover: Launch Gate / Adversarial Integration Preparation (Claude 6)

**Date:** 2026-10-03
**Role:** independent launch-safety reviewer. I did not interfere with the other workstreams (WS-FIN Financial Fortress, WS-FRAUD Telephony Fraud Fortress, WS-BILL Customer Allowance/Billing, WS-ID Customer Identity/Carrier Abstraction, WS-CARR Carrier/Routing research).

## 0. Bottom line

**GATE: CLOSED.** On `origin/main` eb43368, **0 of 30 adversarial scenarios are PROVEN** (18 FAIL, 5 UNPROVEN, 7 PARTIAL). Of the 77 controls, 0 are PROVEN (31 FAIL, 19 UNPROVEN, 27 PARTIAL). Ten executable probes demonstrate concrete gaps on main. Unmerged branches close five of them (verified by running the probes on exported snapshots of those branches). Five further probes (PR-03, PR-04, PR-07, PR-09, PR-11) are closed by no branch yet.

The single largest structural finding is that on main **nothing bounds the duration or concurrency of the billable PSTN leg**. The 30-minute cap stops monitoring only. There is no `<Dial timeLimit>`, no per-household concurrency cap, no global ceiling, no breaker and no kill switch. Also, `/media-stream` lets an unauthenticated WebSocket choose the SMS destination.

## 1. Branch / worktree / state

| item | value |
|---|---|
| branch | `test/launch-gate-adversarial` |
| worktree | `/Users/ad/call-ai-launch-gate` (path verified free and not a symlink before creation) |
| base | `origin/main` eb43368 |
| HEAD | see `git log -1` on the branch (this commit) |
| pushed | yes, `origin/test/launch-gate-adversarial` |
| clean | yes after commit (the `node_modules` symlink to the primary checkout's install is git-ignored) |
| files changed | new files only: `tests/launch-gate/**`, `tests/launch-gate-framework.test.mjs`, `docs/launch-gate/*.md`, this handover. **No application code, package.json, migration or config touched.** |

package.json was deliberately left alone. Its one-line `test` script conflicts with 19 unmerged branches, and adding a 20th would make integration worse. Integration step 0 proposes fixing that once.

## 2. Migration collision inventory

The full table, applied status and evidence are in **`docs/launch-gate/MIGRATION_INVENTORY.md`**. To regenerate it: `node tests/launch-gate/migration-inventory.mjs --min 046`.

| # | collision | applied | recommended eventual resolution (proposal; nothing renumbered or applied) |
|---|---|---|---|
| 046 | `046_voice_client_registration_history` (main) vs `046_monitoring_usage_and_financial_safety` (local wip branch) | main's 046: production + staging (production history repaired 2026-09-27) | Keep main's. Retire the wip file (superseded by 056) |
| 055 | `055_call_delivery_evidence` (delivery/iOS lineage) vs `055_account_classification_history` (#51) | neither | Renumber both, or keep delivery's at 055 if it integrates first. Proposed 062 and 066+ |
| 058 | `058_revoke_default_table_privileges…` (security) vs `058_call_delivery_events` (dynamic-pricing / price-audit branches) | security's 058: **staging** | Keep security's. The other is an obsolete early copy (became 060 on the readiness branches) |
| 060 | `060_revoke_unused_authenticated_grants…` (security) vs `060_call_delivery_events` (readiness/iOS) | security's 060: **staging** | Keep security's. Renumber delivery events (proposed 063) |
| 061 | `061_global_default_revoke_function_execute…` (security) vs `061_household_iphone_carrier` (iOS) | security's 061: **staging** | Keep security's. Renumber iPhone carrier (proposed 064) |
| 048–050 | burned numbers (earlier drafts). Staging has 050/052 objects with **no history row** | — | Never reuse. The 052 history repair awaits approval |

**Rule applied:** a number applied in any environment keeps its file, and unapplied drafts move.

**Additional finding:** production is at 046. Applying the 057–061 production runbook before 047–056 creates out-of-order history (the `--include-all` / `LegacyDbPushMissingRemoteError` class of problem). This needs a decision from Andrew (`INTEGRATION_PLAN.md` §5). My recommendation is option (b): apply 057–061 now for security and record the accepted drift.

## 3. Launch-gate matrix

The full matrix is in **`docs/launch-gate/LAUNCH_GATE_MATRIX.md`**. It is generated from `tests/launch-gate/registry.mjs`, which covers areas A–I (77 controls) plus scenarios S1–S30, each with precondition, action, expected safe result, maximum exposure, mode, evidence required, owner and status.

Area summary (main):

| area | FAIL | key items |
|---|---|---|
| A Security | A1 webhook auth, A2 replay, A8 rate limits, A10 client-origin | voice-p0 fixes A1, A10 and part of A2 (stream token) |
| B Financial | **B1–B8 and B11 all FAIL** | 30d454c addresses B1, B3–B7 (wired, 056 unapplied, partial fail-open on DB timeout) |
| C Fraud | C3 trusted spoof/tail match, C6 pumping, C7 orphan numbers, C8 multi-account, C9 SMS destination | C1/C2/C4/C5 are PARTIAL **only because main has no PSTN leg at all** (PR-05) |
| D Billing | D7 sandbox separation, D11 expiry mid-call | PR #50 skips provisioning for sandbox but still grants entitlement |
| E Identity | E1 no account number, E2 routing tied to a mutable twilio_number, E4 no history | WS-ID in flight |
| F Delivery | none FAIL; F1/F6/F7 UNPROVEN (device-verified evidence missing) | |
| G Continuity | G5 master token, G6 no auto-shutdown | |
| H CX | H8 (no account number) | H4–H6 UNPROVEN (no allowance on main) |
| I Ops | I1 in-memory audit log, I4 no emergency control, I6 migration collisions | |

**Strictness applied:** nothing is PROVEN. No main control yet has a passing automated test *of the enforced control* or a recorded manual execution. Stripe signature and dedupe are implemented but untested, so they are PARTIAL. Alerts, dashboards, monitoring stop, provider assumptions, design docs and code inspection are mechanically rejected as PROVEN evidence by the self-test.

## 4. Automated tests created

| artefact | what it does |
|---|---|
| `tests/launch-gate/probes.mjs` | 12 probes, both behavioural (calling real modules with fakes) and static, run against the current tree |
| `tests/launch-gate/financial-contract.mjs` | 8 adversarial contract checks: zero allowance; 10 concurrent calls with 45 s left; duplicate events ×5 including concurrent; 18 malformed or overflow inputs; negative usage credit; store outage fail-closed; global ceiling; burst breaker |
| `tests/launch-gate/adapters/{reference,naive}-model.mjs` | Show the contract is satisfiable (reference passes 8/8) and discriminating (naive fails 7/8) |
| `tests/launch-gate/migration-inventory.mjs` | Read-only cross-branch collision tool. Exits 1 on any collision |
| `tests/launch-gate/run.mjs` | Gate runner: report, `--enforce` (CI exit code), `--markdown`, `--json`. Binds the contract via `LAUNCH_GATE_FINANCIAL_ADAPTER` |
| `tests/launch-gate-framework.test.mjs` | 299-check self-test: registry integrity, PROVEN-evidence rules, combine semantics, reference resolution, migration helper logic, contract discrimination |

## 5. Test results (2026-10-03, this worktree, offline, dummy env)

- **Framework self-test:** 299/299 pass. A mutation check (forging B1 to PROVEN with code-inspection evidence) is correctly rejected.
- **Gate runner on main:** `GATE: CLOSED`. `--enforce` exits 1, as expected.

| probe | main | voice-surface-p0 | revenuecat-guard | financial-safety-hard-limits |
|---|---|---|---|---|
| PR-01 webhook signature enforced | FAIL | **PASS** | FAIL | FAIL |
| PR-02 /media-stream identity/SMS not client-supplied | FAIL | **PASS** | FAIL | FAIL |
| PR-03 no cross-country trusted tail match (+1 770… ≡ 07700…) | FAIL | FAIL | FAIL | FAIL |
| PR-04 premium/070/087 rejected as destination | FAIL | FAIL | FAIL | FAIL |
| PR-05 no outbound PSTN leg | PASS | PASS | PASS | PASS |
| PR-06 `<Dial timeLimit>` | FAIL | FAIL | FAIL | **PASS** |
| PR-07 orphan number released when assign throws | FAIL | FAIL | FAIL | FAIL |
| PR-08 RevenueCat provisioning gated on environment | FAIL | FAIL | **PASS** | FAIL |
| PR-09 indexed household lookup (no full-table scan) | FAIL | FAIL | FAIL | FAIL |
| PR-10 migration numbers unique in tree | PASS | PASS | PASS | PASS |
| PR-11 rate limits on unauthenticated auth endpoints | FAIL | FAIL | FAIL | FAIL |
| PR-12 server-side emergency stop | FAIL | FAIL | FAIL | **PASS** |

The branch columns come from `git archive` snapshots in the scratchpad. No checkout was done and no other worktree was touched.

- **Financial contract:** UNPROVEN on every branch, because it is not yet bound to the real implementation. That binding is integration step 12.
- **Baseline app suite on main** (each of the 105 files run individually with dummy Supabase env): **103 pass, 2 fail** (`android-full-screen-intent-permission`, `android-incoming-call-notification-visibility`). Both need `mobile/node_modules` and expo, which this worktree does not have. That is environmental, not a code regression. Via `npm test`'s `&&` chain, the first of them aborts the suite at test 92 of 105.

## 6. Manual tests required

`docs/launch-gate/ADVERSARIAL_TEST_SPEC.md` §5 has 17 specifications (M-01…M-17). Each defines its procedure, pass criterion and the evidence it must record: date, operator, environment and artefacts. They must run on staging only, never production. Those needing Andrew or a provider console:
- **M-11** Twilio credential, geo-permission and usage-trigger export (S20/C10/G5).
- **M-02/M-12** RevenueCat/TestFlight sandbox.
- **M-03/M-05/M-10** call-generator drills on staging.
- **M-14** device matrix.

## 7. Branch dependency graph

See `INTEGRATION_PLAN.md` §1–2. The key containment facts:
- terms-rls ⊂ staging-default-privileges ⊂ **supabase-staging-remediation**
- nonprod-provisioning-guard ⊂ **nonprod-telephony-mutation-guard**
- billing-ledger ⊂ **30d454c** (= financial-safety-hard-limits = customer-allowance = financial-containment-p0 base)
- incident ⊂ call-delivery-resilience ⊂ android-call-delivery ⊂ ios-parity ⊂ **release/ios-1.0.2** ⊃ ios-102-dynamic-pricing
- entitlement-guard ⊂ **number-lifecycle-sweep**
- #48 observational ⊂ **#51 admin-control-centre-v2**
- WS-FRAUD's `security/telephony-abuse-p0` is built on **voice-surface-p0**, so security and fraud are one lineage.

## 8. Predicted merge conflicts

From a sequential `git merge-tree` dry run (object-only) of steps 2→10:
- **Clean:** supabase-remediation, voice-p0, revenuecat-guard, migration-tooling.
- **Conflicting:**
  - nonprod-guard: package.json.
  - Finance: package.json, **server.js**, **mediaStreamHandler.js**.
  - number-lifecycle: package.json, server.js, **twilioProvisioning.js**, migrations test.
  - ios-1.0.2: package.json, server.js.
  - #51: package.json, server.js, migrations test.

**Semantic conflicts git won't flag:**
1. The 055/060/061 duplicate migrations.
2. Duplicate per-household caps (voice-p0 `costCaps` vs 30d454c `safetyConfig`/`callAdmission`).
3. The client-origin guard implemented twice.
4. Spend guard: recommend-only (ledger) vs enforcing (056).
5. Rate limiters.
6. Finance admission "unsigned ⇒ admitted, uncounted" must become unreachable after voice-p0.

## 9. Proposed integration order (NOT authorised)

0. Gate prep: replace the package.json test line with a runner, and freeze the migration allocation.
1. migration-safety-tooling (#46).
2. supabase-staging-remediation.
3. voice-surface-p0 → telephony-abuse-p0 (WS-FRAUD).
4. nonprod-telephony-mutation-guard.
5. revenuecat-sandbox-guard (#50).
6. Financial Fortress, then Customer Allowance (consecutive; same base).
7. Customer Identity. Swap with 6b if allowance keys to the account number.
8. number-lifecycle-sweep (#45 + #49).
9. release/ios-1.0.2 lineage (after renumbering).
10. admin-control-centre-v2 (#51; renumber its 055).
11. carrier-dependent changes.
12. Launch-gate validation on the integrated tree, with the contract bound to the real admission on pglite (two processes) and then staging.

**Do not integrate:** process-endpoint-webhook-auth, admin-business-control e5a1e5f / #48, ios-102-dynamic-pricing / price-599-audit (standalone), the wip 046 branch.

## 10. Current known launch blockers (main)

1. **Unbounded PSTN leg:** no `timeLimit`, no per-household concurrency cap, no global ceiling, no breaker, no kill switch (B1, B3–B6, G6, I4). Modelled exposure from `feature/provider-neutral-billing-ledger:docs/finance/FINANCIAL_SAFETY_CONTROLS.md:53-58`: £225.32/day per 10-channel household flood, and a £2,323.87/day company monitoring ceiling at the 200-stream cap. These are modelled, not measured.
2. **Unauthenticated `/media-stream`** chooses the SMS to/from numbers and drives AI cost (A1, C9, S20). It is probably live in production (memory: catastrophic risk review 2026-10-01). voice-p0 fixes it but is **not deployed**.
3. **Twilio HTTP webhooks unsigned** (`/voice` shadow; `/process`, `/call-delivery-failed`, `/call-status`, `/red-line-terminate` none). Forged `/call-delivery-failed` can write duration and delivery evidence for any CallSid and trigger alert emails.
4. **Unentitled households still connected at HCG cost**; no expiry re-check mid-call (B11, D11).
5. **RevenueCat sandbox ⇒ real entitlement and real number**; no RevenueCat replay or ordering protection (D7, A2).
6. **Orphaned numbers** when the DB assign fails after purchase, repeatable up to 5× per household (PR-07, C7).
7. **Trusted bypass on caller ID**, with last-10-digit matching that lets foreign numbers match UK contacts (PR-03, C3).
8. **No rate limiting** on registration/auth endpoints; no multi-account limits (A8, C8).
9. **Master Twilio token in the backend**; no provider-config evidence for geo, usage triggers or auto-recharge (A7, G5, C10).
10. **Migration collisions and production apply-order decision** (I6).
11. **Routing lookup is a full-table `select("*")`.** It will silently miss households once the table exceeds the API row cap (Supabase default 1000; inferred, not load-tested) (PR-09).
12. **No durable audit trail** for admin and safety actions (I1).

Existing blockers held by other records (memory; not re-verified here): Play Billing compliance for Android in-app Stripe; the screened-call quality launch gate; the landline delivery hold; £5.99 not approved (code shows £4.99).

## 11. Evidence required before unrestricted launch

For **every** scenario S1–S30, and every control marked as a launch blocker, the item must reach PROVEN in the registry with strong evidence:
- (a) Probes PR-01…PR-12 PASS on the **integrated** tree, with each static probe backed by its named behavioural or manual test.
- (b) FC-1…FC-8 PASS with the adapter bound to the real admission, allowance and ledger code on pglite with all migrations, **across two Node processes**, then on staging.
- (c) M-01…M-17 executed on staging and recorded with date, operator, environment and artefacts.
- (d) Dated provider-config exports: Twilio scoped API key, GB-only voice and SMS geo, usage triggers that **suspend**, auto-recharge off; Stripe/RevenueCat environment separation.
- (e) Production migration history verified read-only (with authorisation) to match the frozen allocation.
- (f) `node tests/launch-gate/run.mjs --enforce` exits 0.

## 12. Repository cleanup plan

The plan is in `docs/launch-gate/REPO_HYGIENE.md`. **Nothing was deleted.** Highlights:
- The primary checkout sits on a fully merged branch, with an unexplained 2-line edit to `tests/checkout-confirmation.test.mjs` and untracked `android-search-tmp/` (11 MB) and `marketing/` (91 MB).
- 26 fully merged local branches.
- Superseded items: #48, e5a1e5f, e2895f1, terms-rls / staging-default-privs, nonprod-provisioning-guard (3 local-only commits: push or tag first), the wip 046 branch.
- `docs/revenuecat-sandbox-handoff` has 2 unpushed commits.
- PRs #28–#39 are stale and need per-PR review. Supersession is not proven.
- 5 duplicate implementations to collapse.
- Test environment dependencies: dummy Supabase env, `mobile/node_modules`, macOS bash 3 with no `timeout`.

## 13. Confirmations

- **No merge, rebase, cherry-pick or push to any branch other than `test/launch-gate-adversarial`.**
- **No deploy.** No production or staging database query or migration. No provider (Twilio/Stripe/RevenueCat/Apple/Railway/Supabase) access or configuration change.
- **No other session's worktree was modified.** Their state was read with `git status` / `git log` only. Branch content was read via `git show`, `git diff`, `git merge-tree` and `git archive` into the scratchpad. `merge-tree` / `commit-tree` wrote only unreferenced objects. No refs were created except this branch.
- **No migration renumbered or applied.** No branch, PR, worktree, stash or file deleted or closed.
- **Secrets scan** of this branch's added files: no keys, tokens or credentials. The only credential-like strings are dummy placeholders (`launch-gate-dummy`, `https://launch-gate-dummy.invalid`) and the documented test value pattern.

**STOPPED after handover.** Integration requires explicit authorisation from Andrew, once the in-flight workstreams declare their branches final.
