# Repository Hygiene and Cleanup Plan (PLAN ONLY, nothing deleted)

**Inspected:** 2026-10-03, read-only (`git worktree list`, `git for-each-ref`, `git status` in each worktree, `gh pr list`). **No branch, worktree, file, stash or PR was deleted, closed, moved or modified.** Every action below needs Andrew's approval. Before removing any worktree, check that it has no uncommitted work and that no live session is using it. See the memory note on worktree safety: sibling sessions use `/Users/ad/call-ai-*`.

## 1. In-flight: DO NOT TOUCH

These were being actively edited by other sessions on 2026-10-03 (uncommitted changes present):

| worktree | branch | dirty files |
|---|---|---|
| /Users/ad/call-ai-customer-allowance | feature/customer-allowance | 11 |
| /Users/ad/call-ai-customer-identity | feature/customer-identity-carrier-abstraction | 10 |
| /Users/ad/call-ai-financial-containment-p0 | security/financial-containment-p0 | 2 |
| /Users/ad/call-ai-telephony-abuse-p0 | security/telephony-abuse-p0 | 2 |
| /Users/ad/call-ai-carrier-routing-v2 | research/carrier-routing-v2 | 2 |

## 2. Primary checkout (`/Users/ad/call-ai`)

- It is on **`p0-batch1-carrier-policy-quarantine` 91f9577, which is fully merged** (0 ahead, 66 behind main). The primary checkout is therefore sitting on a stale branch.
- `M tests/checkout-confirmation.test.mjs`: an uncommitted 2-line change of unknown provenance. **Plan:** show the diff to Andrew and either commit it to a named branch or discard it **on his instruction only**. Do not stash it: the stash list is shared across all worktrees.
- `?? android-search-tmp/` (11 MB): looks like a scratch extraction. **Plan:** confirm, then move it outside the repo or add it to `.gitignore`.
- `?? marketing/` (91 MB): marketing assets, including Play Store screenshots referenced in memory (`marketing/play-store/final`). **Plan:** do **not** delete. Decide whether to version it (Git LFS) or keep it outside the repo.
- **Plan:** after the above, switch the primary checkout to `main` so new worktrees start from a sane base.
- `node_modules` in the primary checkout is the shared install that sibling worktrees symlink to. **Do not remove it.** Note: deleting it breaks every symlinked worktree's tests.

## 3. Fully merged branches (0 commits ahead of origin/main): candidates to delete locally

`p0-batch1-carrier-policy-quarantine` (primary checkout, see §2), `p0-batch1-carrier-gate-continuation`, `fix/p0-safety-subscription-and-duration`, `integration/p0-launch-hardening`, `release/android-rc-launch-hardening`, `integrate/transcription-no-overlap`, `feature/android-landline-launch`, `feature/genuine-sale-notification`, `feature/go-download-landing`, `feature/go-landing-final` (**memory says keep intact**; deployed content), `feature/mobile-landline-coming-soon`, `feature/mobile-ui-brand-upgrade`, `feature/onboarding-passive-verification`, `feature/trusted-contacts-bulk-management`, `fix/android-v11-lockscreen-notification-visibility`, `fix/customer-dashboard-copy-pricing`, `fix/household-phone-number-json-body`, `fix/web-call-forwarding-activation`, `merge/protection-engine-to-main`, `pr24-comment-fix-local`, `redesign/homepage-simplification`, `release/call-routing-fix`, `sandbox/twilio-addresssid-fix`, `sandbox/twilio-bundlesid-fix`, `sandbox/v1.5-registration-auth`, `audit/dashboard-cleanup`.

**Plan:** delete only after (a) Andrew approves and (b) the worktree attached to each one is clean and removed. Several have worktrees (e.g. `/Users/ad/call-ai-go-final`, `/Users/ad/call-ai-android-landline-launch`). `fix/transcription-no-overlap` shows 4 "ahead" by SHA, but its content landed via `integrate/transcription-no-overlap` (main contains the efficiency and hang-up-flush tests). Verify by diff before treating it as merged.

## 4. Superseded branches and PRs

| item | superseded by | plan |
|---|---|---|
| PR #48 `feature/admin-business-control-observational` | Draft PR #51 (contains it) | Close #48 when #51 is integrated |
| `feature/admin-business-control` e5a1e5f | #51 | Archive tag, then delete |
| `fix/process-endpoint-webhook-auth` e2895f1 (no PR) | security/voice-surface-p0 (`twilioSignatureGuard` on /process) | Archive tag, then delete after voice-p0 merges |
| `fix/terms-acceptances-rls`, `fix/staging-default-table-privileges` | security/supabase-staging-remediation (contains both) | Delete after it merges |
| `feature/nonprod-provisioning-guard` (3 unpushed commits) | fix/nonprod-telephony-mutation-guard (contains it) | Push or tag first (it has local-only commits), then delete |
| `incident/…triage`, `p0/call-delivery-resilience`, `readiness/android-call-delivery`, `readiness/ios-parity`, `feature/ios-102-dynamic-pricing` | release/ios-1.0.2 (contains all of them) | Keep until the iOS release is integrated; they are pushed reference points |
| `docs/price-599-release-audit` | release/ios-1.0.2 lineage (holds an obsolete `058_call_delivery_events`) | Keep as an audit record. Never integrate its migrations |
| `feature/provider-neutral-billing-ledger` | 30d454c and the WS-FIN successor | Delete after the Finance merge |
| `fix/number-lifecycle-entitlement-guard` (PR #45) | feature/number-lifecycle-sweep (PR #49, contains it) | Close #45 in favour of #49 at integration, or merge #45 first. Same result |
| `wip/monitoring-allowance-financial-safety-2026-09-26` (local only) | 056 | Tag `archive/…` and keep. Never integrate (046 collision) |
| `preserve/*`, `checkpoint/*`, `v1-working-backup` | — | **Keep.** Deliberate preservation points |
| `docs/revenuecat-sandbox-handoff` (2 unpushed) | — | **Push** (local-only commits are at risk) |

## 5. Older open PRs (#28–#39, opened 2026-09-12 to 09-16)

PRs #28, #29, #31, #32, #33, #34, #35, #36, #37 and #39 are 3+ weeks old with stale bases. Several features they introduce appear on main through integration branches. For example, main has `tests/call-delivery-ringback.test.mjs`, `tests/voice-client-reachability-integration.test.mjs` and `tests/activity-terminated-by-system.test.mjs`. But the files they touch differ from main today, because main has moved on, so **supersession is not proven**. **Plan:** a per-PR review that diffs each PR's intent against main, then closes it with a pointer to the commit that landed it, or rebases it. PR #2 (`sandbox/mobile-app-v1`, RC1) is **frozen and must never merge without explicit approval**, and its stale MMI code must be fixed first (memory).

## 6. Duplicate implementations to collapse at integration

1. Client-origin `/voice` guard: voice-p0 (inline `From.startsWith("client:")`) and readiness (`services/voiceWebhookGuards.isVoiceSdkClientOriginated`).
2. Per-household stream/call caps: voice-p0 `costCaps` and 30d454c `safetyConfig` / `callAdmission`.
3. Spend guards: the ledger branch's `spendGuard` / `companySpendProtection` (recommend-only) and 30d454c's `admit_call` (enforcing).
4. Migration uniqueness checks: `tests/migration-number-uniqueness.test.mjs` (30d454c lineage), `scripts/check-migration-numbering.js` (PR #46), and this branch's PR-10 / inventory. Keep one per-tree test plus the cross-branch inventory.
5. Rate limiters: readiness `householdRateLimit` and whatever WS-FRAUD adds.

## 7. Generated artefacts and environment dependencies

- **`node_modules` symlinks** in worktrees point at `/Users/ad/call-ai/node_modules`. `.gitignore`'s `node_modules/` does ignore them (verified in this worktree). Never `git add -A` without checking.
- **The test suite needs env:** a test that requires the Supabase client at module load fails with `supabaseUrl is required` when there is no `.env`. Run with dummy `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`. Recommendation: make every test set dummy env itself, as several already do. A test must never pick up a real `.env`.
- **Mobile-dependent tests:** `android-full-screen-intent-permission` and `android-incoming-call-notification-visibility` need `mobile/node_modules` (and expo for prebuild). They fail in any worktree without a mobile install. Since `npm test` chains with `&&`, they **stop the whole suite at test 92 of 105** (13 later tests never run). Recommendation: the step-0 test runner should run all tests, report each, and mark env-dependent tests as SKIP-with-reason rather than abort.
- **The macOS toolchain has no `timeout` binary and ships bash 3** (no `mapfile`). Scripts must not assume GNU tools.
- **Twilio provisioning module warning at import time** ("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN is not set"): harmless in tests.
- Large binaries tracked or untracked: `HCG phone number.jpeg` at the repo root (tracked), and `marketing/` (untracked, 91 MB).
