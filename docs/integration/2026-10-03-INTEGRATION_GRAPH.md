# Integration graph — Launch Fortress (2026-10-03)

**Integration branch:** `integration/launch-fortress-2026-10-03`
**Worktree:** `/Users/ad/call-ai-launch-fortress`
**Base:** `origin/main` @ `eb43368` (Merge PR #44, privacy transcript redaction)

Written **before** any merge, from read-only inspection: `git merge-base --is-ancestor`
containment between every local branch and every candidate head, `git cherry` patch-equivalence
against `origin/main`, per-branch `git diff --stat`, and each workstream's handover.
Every branch listed below is based on `origin/main` @ `eb43368` (0 commits behind) unless stated.

No other worktree was modified. All source worktrees (`call-ai-financial-containment-p0`,
`-telephony-abuse-p0`, `-customer-allowance`, `-customer-identity`, `-launch-gate`,
`-control-centre-v2`, `-voice-security`) had 0 uncommitted changes when inspected.

## 1. Containment (ancestry) facts

`A ⊂ B` = every commit of A is already in B. Merging B therefore brings A; A is **not** merged separately.

```
origin/main eb43368
├── security/voice-surface-p0 7f0bae3 ⊂ security/telephony-abuse-p0 30cd799
├── feature/provider-neutral-billing-ledger 7ad12c9 ⊂ feature/financial-safety-hard-limits 30d454c
│       30d454c ⊂ security/financial-containment-p0 56bbd5e
│       30d454c ⊂ feature/customer-allowance 2f438d1          (siblings: same base, no containment between them)
├── fix/terms-acceptances-rls ⊂ fix/staging-default-table-privileges ⊂ security/supabase-staging-remediation 1576531
├── feature/nonprod-provisioning-guard 251407f (local only) ⊂ fix/nonprod-telephony-mutation-guard b337438
├── fix/number-lifecycle-entitlement-guard f234733 ⊂ feature/number-lifecycle-sweep 8288292
├── incident/2026-09-28-incoming-call-triage ⊂ p0/call-delivery-resilience 4f47df2
│       ⊂ readiness/android-call-delivery f276f40 ⊂ readiness/ios-parity eab9caa ⊂ release/ios-1.0.2 cb710dd
│       also ⊂ release/ios-1.0.2: feature/ios-102-dynamic-pricing, fix/forwarding-number-api,
│       preserve/forwarding-number-api-wip-2026-09-30, release/android-consolidated, website/homepage-declutter
├── feature/admin-business-control-observational (#48), fix/admin-business-tab-statements ⊂ feature/admin-control-centre-v2 7ac1d3a
├── feature/customer-identity-carrier-abstraction 4fa8008 (standalone)
├── fix/revenuecat-sandbox-environment-guard f5a920e (standalone, PR #50)
├── fix/migration-safety-tooling 4220d82 (standalone, PR #46, docs + scripts)
├── test/launch-gate-adversarial 00b12f1 (standalone, new files only)
└── research/carrier-routing-v2 db157dc (standalone, research only)
```

Already on `origin/main` under different SHAs (rebased; `git cherry` shows the content landed via
`integration/p0-launch-hardening` f03c691 / PR #24 etc.): `fix/transcription-no-overlap`
(84e6159, 8d5e439 → main e56e776, 744d8cf), `fix/voice-client-reachability-model` (3f2d54f → main 9f767a7).

## 2. Per-branch record (integration candidates)

| Branch | HEAD | Base / parent | Purpose | Supersedes | Superseded by | Migrations | Main overlapping files | New tests | Prod behaviour? | Integrate? |
|---|---|---|---|---|---|---|---|---|---|---|
| `fix/migration-safety-tooling` | 4220d82 | main | migration drift / duplicate-number scripts + process doc | — | — | none | none | 0 (scripts) | no | **yes** (step 1) |
| `security/supabase-staging-remediation` | 1576531 | main | RLS on terms_acceptances; default-ACL and grant hardening | terms-rls, staging-default-table-privileges | — | 057–061 (**staging-applied**) | `tests/migrations.pglite.test.mjs` | 0 new files (209 lines in migrations test) | DB only | **yes** (step 2) |
| `security/voice-surface-p0` | 7f0bae3 | main | Twilio signature enforcement, `/media-stream` stream tokens, client-origin guard, per-household cost caps | `fix/process-endpoint-webhook-auth` (to verify) | telephony-abuse-p0 (contains it) | none | server.js, mediaStreamHandler.js, package.json | 2 | yes | **via telephony-abuse-p0** |
| `security/telephony-abuse-p0` | 30cd799 | voice-surface-p0 | ordered inbound screening, number policy, loop/velocity/concurrency, replay, egress guard, incident mode, provisioning guard | voice-surface-p0 | — | provisional `PROVISIONAL_telephony_abuse_controls.sql` (unnumbered) | server.js, mediaStreamHandler.js, twilioProvisioning.js, mobileApi.js, package.json, 5 source-string tests | 4 (+2 from voice-p0) | yes | **yes** (step 3) |
| `fix/nonprod-telephony-mutation-guard` | b337438 | main | non-production can never purchase/release production numbers or run prod lifecycle jobs | nonprod-provisioning-guard | — | none | server.js, twilioProvisioning.js, package.json | 2 | yes | **yes** (step 4) |
| `fix/revenuecat-sandbox-environment-guard` | f5a920e | main | RevenueCat sandbox purchases never provision a real number; environment column | — | — | 053 (unapplied) | mobileApi.js, database/billing.js, revenuecatWebhook.js | 0 new (156 lines in existing) | yes | **yes** (step 5) |
| `feature/provider-neutral-billing-ledger` | 7ad12c9 | main | provider-neutral ledger, spend monitor (recommend-only) | — | 30d454c | 051 (**staging-applied**) | — | 7 | partly | **via financial-containment-p0** |
| `feature/financial-safety-hard-limits` | 30d454c | ledger | 056: monitored-minute allowance, hard admission (concurrency, floods, loops, £ ceilings), `<Dial timeLimit>` | — | financial-containment-p0, customer-allowance | 051, 056 (unapplied) | server.js, mediaStreamHandler.js, package.json | 11 | yes | **via financial-containment-p0** |
| `security/financial-containment-p0` | 56bbd5e | 30d454c | Financial Fortress: reserve-before-spend, leases, sweeper, provider backstop, global breaker, fc ledger, SMS/AI/number-purchase gates | 30d454c | — | provisional `supabase/provisional/financial_containment_authorization_ledger.sql` | server.js, smsBudget.js, twilioProvisioning.js, package.json | 16 (5 new in its own 3 commits) | yes | **yes** (step 6) |
| `feature/customer-allowance` | 2f438d1 | 30d454c | customer allowance read model, warnings, top-ups, refunds, margin guard, plan sync | — | — | 063 (draft) | server.js, mobileApi.js, billing.js, upload.html, mobile UI, package.json | 15 (4 new in its own commits) | yes (flags off) | **yes** (step 7, immediately after Fortress: shared base) |
| `feature/customer-identity-carrier-abstraction` | 4fa8008 | main | permanent HCG account number, routing assignments, provider adapter, dry-run migration planner | — | — | 062 (provisional) | server.js, mobileApi.js, admin routes, upload.html, migrations test | 2 | display only (inert until 062) | **yes** (step 8) |
| `feature/number-lifecycle-sweep` | 8288292 | main | 047 entitlement guard (no release while entitled), daily reconciliation sweep + scheduler | entitlement-guard | — | 047 (**staging-applied**), 052 (staging objects, no history row), 054 | server.js, twilioProvisioning.js, households.js, migrations test | 6 | yes | **yes** (step 9) |
| `release/ios-1.0.2` | cb710dd | main | call-delivery resilience/health, invite SID fix, device readiness, delivery telemetry, client-origin `/voice` guard, per-household rate limits, iPhone path + carrier fix, channel pricing display, giffgaff/Three forwarding fix, iOS 1.0.2 version | p0/call-delivery-resilience, readiness/android-call-delivery, readiness/ios-parity, ios-102-dynamic-pricing, fix/forwarding-number-api | — | 055, 060, 061 (**all unapplied; 060/061 collide with staging-applied security files**) | server.js, mobileApi.js, billing.js, callRouting.js, providerPolicy.js, upload.html, mobile/*, package.json | 15 | yes | **yes** (step 10) — whole lineage in one merge, after renumbering |
| `feature/admin-control-centre-v2` | 7ac1d3a | main | admin business control centre (observability), selectAll pagination, Twilio cost fix, classification workflow | #48 observational, admin-business-tab-statements, (e5a1e5f line) | — | 055 (unapplied, collides) | server.js, migrations test, package.json | 9 | read-only + one audited write | **yes** (step 11) |
| `test/launch-gate-adversarial` | 00b12f1 | main | independent judge: registry, probes, financial contract, migration inventory, gate runner | — | — | none | none (new files only) | 1 (+ framework) | no | **yes** (step 12) |
| `research/carrier-routing-v2` | db157dc | main | carrier/routing research, legs economics, POC 1 spec | — | — | none | none | 0 (`research/**` has its own .mjs tests) | no | **no** — referenced as evidence only (§4) |

## 3. Branches deliberately NOT integrated

| Branch | Reason |
|---|---|
| `fix/process-endpoint-webhook-auth` e2895f1 | Superseded by voice-surface-p0's `/process` signature guard (launch-gate INTEGRATION_PLAN §1). Verified after merge (see CONFLICT_DECISIONS). |
| `feature/admin-business-control` e5a1e5f, `feature/admin-business-control-observational` (#48) | Superseded by `feature/admin-control-centre-v2` (#51) per its handover. #48 is contained in #51. |
| `feature/ios-102-dynamic-pricing`, `docs/price-599-release-audit` | First is contained in release/ios-1.0.2. The audit branch carries an obsolete `058_call_delivery_events.sql` and is docs/audit material; £5.99 is not an engineering decision. |
| `wip/monitoring-allowance-financial-safety-2026-09-26` | Its `046_monitoring_usage_and_financial_safety.sql` collides with main's applied 046 and is superseded by 056. |
| `architecture/voice-provider-portability` 4f913c1 | Memory: "merge after launch hardening"; identity branch already provides the number-provider adapter seam. Not launch-critical; avoids a large server.js seam change. |
| `research/carrier-routing-v2`, `research/commercial-network-viability`, `research/telephony-trusted-bypass`, `research/landline-poc` | Research/evidence only. No POC is authorised. Referenced by SHA. |
| `docs/acquisition-readiness`, `docs/revenuecat-sandbox-handoff` | Docs only, not launch-gating; the latter has 2 unpushed commits owned by another session. |
| `feature/staging-safety-hardening` a57891e | Overlaps `fix/nonprod-telephony-mutation-guard` (whose doc relates the two); rollback files for 037/038 only. Not merged; flagged for the owner. |
| `website/launch-ready-homepage`, `feature/website-professional-redesign`, `redesign/*`, `feature/go-*`, `release/android-v10`, `release/v10-landline-coming-soon` | Website/marketing tracks; not safety. The landline delivery HOLD forbids promoting landline. |
| Stale mobile histories (`fix/apple-*`, `fix/pushkit-*`, `fix/entitlement-timing-race*`, `sandbox/*`, `rc1/*`, `checkpoint/*`, `preserve/mobile-onboarding-*`, `fix/ios-marketing-version-1.0.1`, `fix/voice-sdk-registration-reporting`, `feature/audio-diagnostics-*`, `fix/activity-status-*`, `feature/carrier-onboarding-consent-gate`, `fix/mobile-activation-and-protection-state`, `integration/mobile-app-onboarding`, etc.) | 67–92 commits "ahead" because they predate the mobile/backend history consolidation; last touched Aug–mid Sep; their content reached main or was abandoned. Not launch-candidate material. |
| `fix/transcription-no-overlap`, `fix/voice-client-reachability-model` | Already on main (rebased SHAs). |

## 4. Research inputs used as constraints only

`research/carrier-routing-v2` @ db157dc: trusted calls avoid HCG variable cost only if the decision is
taken before the call reaches an HCG-paid platform; REFER/302 is never the trusted-cost lever; Telnyx
cheapens but does not remove legs. Consequence for this integration: **trusted calls remain an
HCG-paid inbound leg today and therefore must be inside the Financial Fortress budget**, never exempt.
No POC 1 / POC 2, no provider contact.

## 5. Proposed merge sequence (git order)

Chosen so every ancestor arrives exactly once and the shared 30d454c base is merged once:

1. `fix/migration-safety-tooling` (clean, docs/scripts)
2. `security/supabase-staging-remediation` (057–061, applied on staging → numbers fixed)
3. `security/telephony-abuse-p0` (brings voice-surface-p0)
4. `fix/nonprod-telephony-mutation-guard` (brings nonprod-provisioning-guard)
5. `fix/revenuecat-sandbox-environment-guard` (053)
6. `security/financial-containment-p0` (brings ledger + 30d454c; 051, 056, provisional fc ledger)
7. `feature/customer-allowance` (only its 3 commits beyond 30d454c are new)
8. `feature/customer-identity-carrier-abstraction`
9. `feature/number-lifecycle-sweep` (047/052/054)
10. `release/ios-1.0.2` (whole delivery/iOS lineage)
11. `feature/admin-control-centre-v2`
12. `test/launch-gate-adversarial`
13. Integration commits: migration renumbering, one safety pipeline, Fortress port wiring,
    allowance→£ budget bridge, entitlement canonicalisation, identity/admin wiring, tests, docs.

Security precedes Finance deliberately: Finance's 056 admission admits unsigned requests uncounted
(`callAdmission.js`), which is only safe once the signature guard rejects them first.

## 6. Hot files (touched by ≥ 2 integrated heads, excluding the shared 30d454c base)

`server.js` (8), `package.json` (8), `tests/migrations.pglite.test.mjs` (6), `routes/mobileApi.js` (6),
`services/twilioProvisioning.js` (4), `upload.html` (3), `services/liveMonitoring/mediaStreamHandler.js` (3),
`database/calls.js` (3), `tests/subscription-enforcement-voice-gate.test.mjs` (3),
`tests/voice-client-reachability-integration.test.mjs` (3), `tests/live-monitoring-transcription-efficiency.test.mjs` (3).
