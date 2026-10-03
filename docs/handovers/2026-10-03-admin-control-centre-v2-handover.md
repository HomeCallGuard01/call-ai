<!--
STATUS (2026-10-03): HANDOVER. Development on this branch is STOPPED pending the
workstream reorganisation. Draft PR #51, not merged, not deployed, no migration applied.
-->
# Handover: `feature/admin-control-centre-v2` (Admin Control Centre)

**Date:** 2026-10-03
**Draft PR:** #51 — https://github.com/HomeCallGuard01/call-ai/pull/51 (not merged)
**Code HEAD at handover:** `7189eee2f82d2ba4f694072df856b72d68f34c9e`. This file is committed on top of it, docs only.

## Corrections to the earlier summary

Three points in the summary I was given do not match the repository:

- **Carrier-policy / quarantine P0 work was not done on this branch.** It is on `p0-batch1-carrier-policy-quarantine` (`2ad4c7c`, `91f9577`, 12 Sep), which is already fully contained in `main`. Its PR #30 is closed. This branch only *carries* that code because it is based on `main`.
- **No Security P0 review was performed** for this branch. It remains open item 1 on PR #51's "Do not merge until" checklist.
- **The head commit is `7189eee`**, not `7189ee`.

## 1. Branch and worktree

- **Branch:** `feature/admin-control-centre-v2`
- **Worktree:** `/Users/ad/call-ai-control-centre-v2`

The primary checkout `/Users/ad/call-ai` is on `p0-batch1-carrier-policy-quarantine` (`91f9577`), 0 commits ahead of `origin/main`. It also holds changes that were **not made by this workstream**. They were left untouched and not committed:

- `tests/checkout-confirmation.test.mjs` is modified. One label is changed and there is a stray `;1` at the end of the file, which looks accidental.
- `marketing/` (~91 MB of review screenshots) and `android-search-tmp/` (~11 MB) are untracked.

These stay on disk but are not preserved in git. Their owner should decide what to do with them.

## 2. HEAD and base

- **HEAD:** `7189eee2f82d2ba4f694072df856b72d68f34c9e`
- **Base:** `origin/main` `eb43368` (the merge-base)
- 24 commits ahead, 0 behind.

## 3. Clean status

The worktree was clean (0 changes) at handover, before this file was added. There is no `.env` in the worktree.

## 4. Pushed status

`origin/feature/admin-control-centre-v2` matched local `7189eee` at handover. This handover file is committed and pushed to the same branch.

## 5. Implementation summary

The branch adds an admin-only, read-only dashboard at `/admin/business` with five tabs:

| Tab | What it contains |
|---|---|
| **Overview** | "Needs your attention" (grouped and de-duplicated by household) and 13 checks, each with a stated colour rule |
| **Customers** | Health table with a Genuine / Unclassified / Test badge on every row; payment history; audited classification (needs 055) |
| **Numbers** | Lifecycle reconciliation (canonical `services/numberLifecycle/state.js`); provider number inventory in 9 categories with masked numbers; a release-review **prototype, not wired** (the final button is permanently disabled) |
| **Money** | Finance with provenance on every line; genuine MRR from live Stripe only (test mode refused); spend-safety adapter (shows **Not connected** until Finance ships `latestSpendMonitorResult.js`); marketing; website funnel |
| **Operations** | **Usage & cost safety** (new in v5); call activity; system health; admin tools; monthly due-diligence snapshot (schema 1.1); launch readiness |

### Important files and modules

- **Services:** `services/businessControl/`: `usageSafety`, `selectAll`, `definitions`, `controlOverview`, `numberInventory`, `numberReconciliation`, `financialOverview`, `financialReadModel`, `financialSafetyAdapter`, `stripeRevenue`, `dueDiligenceSnapshot`, `subscriptionOverview`, `campaignPerformance`, `lifecycleTimeline`, `fixedCostSettings`.
- **Number lifecycle:** `services/numberLifecycle/state.js`, `releaseReadiness.js`.
- **Classification:** `services/accountClassificationChanges.js`.
- **Routes:** `routes/adminBusinessControl.js` (7 GET routes) and `routes/adminClassification.js`, mounted by 4 lines in `server.js`.
- **Page:** `admin-business.html`.
- **Fixes to existing modules:** `services/businessMetrics/twilioCosts.js` (Twilio spend understated about 20×), `services/businessMetrics/callStats.js` (pagination).

### Write paths

The only write path is the classification workflow. It refuses to write until migration 055 exists.

### Fixes worth knowing about

- **Supabase/PostgREST 1,000-row cap:**
  - Every dashboard `calls` read now goes through `selectAll.js`, which pages with `.range()` and reports `truncated` when it stops early.
  - This covers usage, the due-diligence snapshot, Finance minutes, Numbers "last inbound call" and `callStats.js` (the final fix, `7189eee`).
  - Before this, any time window with more than 1,000 rows was silently undercounted.
- **"Monitored minutes" vs "unknown-caller call minutes":** Finance used to label unknown-caller *call duration* as "monitored minutes". These are now separate figures:
  - **monitored minutes** = how long monitoring ran (`monitored_duration_seconds`);
  - **unknown-caller call minutes** = the call duration of unknown callers, i.e. inbound telephony (`duration_seconds`).

### Security behaviour introduced by this branch

- New routes require `requireAuth` + `requireAdmin`.
- Every data-derived string is HTML-escaped. An unescaped `utm_source` XSS was removed.
- Caller numbers are masked to the last 3 digits; provider numbers are masked in the inventory.
- The snapshot refuses to produce output if it would contain an email, phone number or identifier.
- **No carrier-policy behaviour is introduced.** That lives in `main`'s `services/providerPolicy.js`.

### Controls this branch adds

**None that are enforced.** The branch is visibility only. Its "Limits in this build" table reports each control as one of:

- enforced
- alert only
- dashboard only
- provider default
- not implemented
- "code present — verify" (for limit modules that later land but whose configuration the dashboard cannot read)

Tests pin these statements to `server.js` and `mediaStreamHandler.js`.

## 6. Migrations and conflicts

**Introduced:** `supabase/migrations/055_account_classification_history.sql` and `_rollbacks/055_rollback_account_classification_history.sql`.

- Not applied anywhere.
- Tested in PGlite.
- No existing migration was modified.

### Numbering conflicts across remote branches

| Number | Conflict |
|---|---|
| **055** | `055_account_classification_history` (this branch) vs `055_call_delivery_evidence` on `p0/call-delivery-resilience`, `readiness/android-call-delivery`, `readiness/ios-parity` and `release/ios-1.0.2` |
| 060 | `060_call_delivery_events` (readiness/ios branches) vs `060_revoke_unused_authenticated_grants_and_pin_trigger_search_path` (`security/supabase-staging-remediation`, already applied on staging) |
| 061 | `061_household_iphone_carrier` (readiness/ios branches) vs `061_global_default_revoke_function_execute_from_public` (security, already applied on staging) |
| 046 | Local-only `wip/monitoring-allowance-financial-safety-2026-09-26` `046_monitoring_usage_and_financial_safety` vs `main`'s `046_voice_client_registration_history` |

The sequence 047, 051, 052, 053, 054, 056 and 057–059 has no other clashes.

### Resolution options (NOT applied; 055 deliberately not renumbered)

- **055:**
  - **(a)** Renumber this branch's 055 to the next free number. This is the cheapest option: it has never been applied anywhere, and four branches already carry the other 055.
  - **(b)** Renumber `call_delivery_evidence` instead.
  - **(c)** Assign all numbers centrally at integration time.
- **060/061:** the readiness/ios branches should renumber, because the security migrations are already applied on staging.
- **046:** retire the wip draft. Migration 056 supersedes it.

## 7. Tests and results

All tests were run locally with a dummy environment pointing at an unreachable `127.0.0.1:9`. No production or staging access was involved.

### Relevant suites

Each was run as `env -i PATH=… HOME=… NODE_ENV=test SUPABASE_URL=http://127.0.0.1:9 SUPABASE_ANON_KEY=x SUPABASE_SERVICE_ROLE_KEY=x node tests/<name>.test.mjs`. Every one exited 0 with zero ✗:

| Suite | Checks passed |
|---|---|
| `usage-safety` | 69 |
| `business-control` | 163 |
| `business-control-centre` | 118 |
| `business-metrics` | 73 |
| `due-diligence-snapshot` | 27 |
| `money-tab-contract` | 25 |
| `number-lifecycle-state` | 75 |
| `safe-release-review` | 30 |
| `account-classification-workflow` | 29 |
| `admin-business-statements` | 8 |
| `admin-business-auth` | 94 |
| `admin-dashboard` | 31 |
| `dashboard-consolidation` | 56 |
| `migrations.pglite` | 235 |

### Full suite

Every file in the `npm test` script, run one at a time with the same dummy environment: **112 files pass, 2 fail.**

The 2 failures are **known environmental failures**, not genuine ones:

- `tests/android-full-screen-intent-permission.test.mjs`
- `tests/android-incoming-call-notification-visibility.test.mjs`

Both need `mobile/node_modules` (including `@twilio`), which is absent in this worktree; they fail with ENOENT on `lstat`. Both also failed identically at the baseline taken before any of this work.

**Genuine failures: none.**

## 8. Overlap with the new workstreams

| Workstream | Overlapping branch | Shared files | Recommendation |
|---|---|---|---|
| Admin risk dashboard | PR #48 (`feature/admin-business-control-observational`), #47, #49 | #48: 13 files (its commits are contained in this branch). #47: `database/adminMetrics.js`, `routes/adminBusiness.js` | **Retain this branch as source of truth.** It supersedes #48. #47 and #49 should consume `services/numberLifecycle/state.js` (14/14 parity fixture) |
| Telephony fraud / abuse | `security/voice-surface-p0` | `server.js` (different areas), `package.json` | **Security P0 is the source of truth for enforcement.** This branch only reports it. When `costCaps.js` lands, the per-household-streams row shows "Code present — verify" |
| Financial containment / hard limits | `feature/financial-safety-hard-limits`, `feature/provider-neutral-billing-ledger` | `server.js`, `package.json`, `tests/migrations.pglite.test.mjs` | **Hard limits are owned there.** See the note below the table |
| Customer allowance / billing | `fix/revenuecat-sandbox-environment-guard` (#50); allowance code in hard-limits | none | **No allowance is implemented here.** The dashboard only sums minutes. The allowance workstream should expose per-household allowance state for the dashboard to read |
| Customer identity / carrier abstraction | `feature/website-carrier-cancellation-v2` (#39), readiness/ios branches | `server.js`, `package.json`, `tests/migrations.pglite.test.mjs` | **No logic overlap.** This branch reads `households` and `account_classifications` only. Expect a rebase if the household model changes |
| Carrier / routing research | `research/telephony-trusted-bypass`, `architecture/voice-provider-portability` | none | **No overlap.** Number inventory should later read through the provider seam |

**Hard limits and this branch:** if `feature/financial-safety-hard-limits` merges, its `<Dial timeLimit>` makes `tests/usage-safety.test.mjs` fail **by design**, forcing the "Call length" row to be updated. The Money spend-safety adapter expects Finance to add `services/finance/latestSpendMonitorResult.js`.

**`package.json`** overlaps on every branch only because each one appends to the single-line `test` script. That is a trivial merge.

**Likely superseded:** PR #48, and the Money "Spend safety" placeholder once the hard-limits/ledger work lands.

## 9. Launch-safety controls actually enforced

This branch adds no enforcement. The code it carries from `main` enforces only:

- **Live monitoring per call, 30 min** (`MONITORING_MAX_DURATION_MINUTES`). Monitoring stops; the call continues and is still billed.
- **Simultaneous monitoring streams, 200 for the whole server** (`MEDIA_STREAM_MAX_CONCURRENT_STREAMS`). Refused streams are not recorded.
- **Forwarding-loop check.** When the customer sets the number safe calls should ring, a number that would loop back is rejected.
- **One HCG number per household.** A provisioning race guard prevents double-provisioning.
- **Carrier compatibility gate.** Unverified or incompatible networks are stopped before payment.

## 10. Launch-safety gaps

| Risk | Status |
|---|---|
| Premium / high-cost destinations | **Not implemented** |
| International destinations | **Not implemented.** Warning SMS can go to any number; this is an open finding on `main` |
| Trusted-contact bypass | **Not implemented.** Known contacts skip monitoring by design; spoofed caller ID is not detected |
| Repeated / looped calling | **Alert only.** E-mails at 20 unknown calls per day and 3 calls in 10 min. Only the forwarding-loop check above is enforced |
| Excessive provisioning | **Partly enforced.** One number per household; nothing limits purchases across many households |
| Multiple-account abuse | **Not implemented** |
| Simultaneous / concurrent cost exposure | **Partial.** Only the 200-stream whole-server monitoring cap. Nothing per household, and no limit on call legs |
| Exhausted customer allowance | **Not implemented.** No allowance exists |
| Global business-wide spend exposure | **Not implemented.** No £ ceiling |

**HCG has no hard financial cap in this code.** Call length is bounded only by Twilio's 4-hour `<Dial>` default.

## 11. Unresolved decisions and dependencies

1. How to resolve the 055 clash, and whether to apply 055 at all.
2. Renumbering 060/061 on the readiness/ios branches.
3. Whether to close #48 as superseded, or merge it first and rebase.
4. Merge order relative to Security P0 and hard limits.
5. Who provides `latestSpendMonitorResult.js` for Money's spend safety.
6. Timing of the reconciliation consolidation (#47 / #49); the plan is in `docs/admin/RECONCILIATION_CONSOLIDATION_PLAN.md`.
7. Production-data validation; see `docs/admin/PRODUCTION_DATA_REQUIRED.md`.
8. The open PR #51 checklist items, including the Security P0 review, which has **not** been done.
9. Out of scope here and owned by other workstreams: a call-duration limit, an estimated AI £ cost and the hard caps.

## 12. Recommended future integration order

1. Security P0.
2. Central migration numbering.
3. Financial containment / hard limits, plus the ledger.
4. Customer allowance / billing.
5. This dashboard (PR #51), rebased, with its "Limits in this build" table re-checked against the merged code.
6. Lifecycle #47 / #49.
7. Identity / carrier.
8. Final launch-gate validation, including the production-data checks.

## 13. Nothing merged, deployed or applied

- Nothing was merged or deployed.
- No migration was applied.
- Production and staging were neither queried nor changed by this work.
- Migration 055 was not renumbered.
- `main` was not modified.

## 14. Safe to close

**Yes.** All work is committed and pushed (code at `7189eee`, PR #51, plus this handover file). The only local-only files were throwaway scratch items. The synthetic layout preview is committed at `docs/admin/previews/usage-safety-SYNTHETIC-FIXTURE.png`; it shows fixture data, not real data.

The uncommitted files in `/Users/ad/call-ai` listed in section 1 are not this workstream's. They remain on disk but are not saved in git.

## Related documents

- `docs/admin/BUSINESS_CONTROL_DASHBOARD.md` (v2–v5 design and change log)
- `docs/admin/PRODUCTION_DATA_REQUIRED.md`
- `docs/admin/RECONCILIATION_CONSOLIDATION_PLAN.md`
- `docs/admin/MONEY_TAB_INTEGRATION_CONTRACT.md`
- `docs/admin/ACQUISITION_READINESS_REVIEW.md`
- `docs/admin/STAGING_NUMBERS_ON_PRODUCTION_TWILIO.md`
