# Handover: soft-launch candidate integration (2026-10-04)

| | |
|---|---|
| Branch | `integration/soft-launch-candidate-2026-10-04` (new) |
| Worktree | `/Users/ad/call-ai-soft-launch-candidate` (`node_modules` → symlink to the primary checkout's shared install; `mobile/node_modules` cloned from the launch-fortress worktree; both git-ignored) |
| Base | `integration/launch-fortress-2026-10-03` @ `2011ab6` (verified as the remote HEAD on 2026-10-04) |
| Last code commit | `1a4fa71 (tests run here; e60b8db after it only edits .env.example)` |
| Branch tip | the commit that adds this handover and the final report (its SHA is given in the final response and in `git log -1`) |
| Pushed | `origin/integration/soft-launch-candidate-2026-10-04` (see the final response) |
| Uncommitted | nothing |

**Deployments: none. DB changes: none.** Production Supabase was *read* only: `select` queries and an auth GET, for the investigation the user requested. **Provider changes: none. Store changes: none. Customer communications: none. Emails or notifications sent: none.**

## Commits incorporated (merge --no-ff; original SHAs preserved)

| Workstream | Head | Commits |
|---|---|---|
| research/provider-financial-containment | aaa43ba | aaa43ba |
| finance/unit-economics-v1 | f6633ee | f6633ee |
| feature/accounting-automation | 8e3d0bd | 7969559, 8e3d0bd |
| feature/customer-lifecycle-automation | d6f586a | d6f586a |
| release/launch-readiness-2026-10-04 | 75ff4ac | 75ff4ac |

**Conflict resolved:** `server.js`. Accounting and lifecycle each added one `app.use(...)` after the `adminFortress` mount; both were kept. Nothing else conflicted.

**Migration renumbering:** none. 071 was verified free across all refs and kept. **072 is new** (`072_operational_events.sql` + rollback, DRAFT). The next free number is 073.

## Integration commits (on top of the merges)

| SHA | What |
|---|---|
| cf9505c | integration plan + pre-merge inventory |
| 31a2926, 0d27c92 | SMS: fail closed; explicit authorisation only; adversarial tests (T7) |
| 07c7dca | `<Reject/>` on voice-route errors / no household; `/process` disabled; egress guard requires bounded `<Dial timeLimit>`; `voiceFallbackUrl` for new numbers (T4, T9) |
| 2511c70 | verified usage alert latches the Fortress kill switch (T11) |
| 4bd94af, 3ad5e65 | launch-required environment schema; production/staging refuse to start unsafe; legacy validator a tested subset |
| bb4d461 | Stripe `subscription.deleted` loop after deletion (F-03) |
| 2d087b9 | canonical protection on every customer surface + mobile Account tab (F-02, P-1…P-5) |
| b5acb56 | accounting capture bounded, never an entitlement authority; real-PG posting concurrency |
| cf9adb7 | dashboard reads the register; duplicate-rate drift test (D19) |
| 7222e58 | quarantine £ exposure from the register (B9) |
| df2c1d0 | 066 cross-instance number-purchase claim wired; race tests |
| 9ed7c3c | launch-gate PR-07 / PR-11 probes corrected (stale) |
| 0e1b3cc | commercial-figure inventory (§7) |
| cb17123 | one genuine-paying classifier; non-production store grants can never buy a number or show as "Paying" |
| a8827c2 | operational event + notification framework (072 DRAFT, delivery OFF) |
| 1a4fa71 | read-only investigation of the 28 Sep account |
| e60b8db | `.env.example`: OPS_NOTIFY_* (all off) |

## Tests (exact)

Offline dummy environment, `FC_REALPG_MODULES` = embedded PostgreSQL 18 (cloned into the session scratchpad), and cloned `mobile/node_modules`.

| Run | Result |
|---|---|
| Base 2011ab6 | 178/178 files · ✓7,694 · ✗0 |
| After merges 4a90763 | 187/187 · ✓8,411 · ✗0 |
| Final code HEAD | **197/197 files · ✓8,716 · ✗0 (real-PG: accounting 9, financial-containment 15, launch-fortress 10)** |
| Mobile `tsc --noEmit` | 0 errors |
| Launch gate (Fortress adapter) | PR-01…12 PASS; FC: 7 PASS, FC-3 FAIL (pre-existing units mismatch, identical on base; documented); GATE CLOSED |

**Skipped:** none. Both real-PG suites ran, and the Android manifest tests ran.

**Pre-existing / environmental:** without the dummy environment, 9 files fail on `supabaseUrl is required`. Without `mobile/node_modules`, 4 files fail. Both conditions are identical on base.

## Files changed

See `git diff --stat 2011ab6..HEAD`. Main new modules:
- `services/config/launchConfig.js`, `scripts/check-launch-config.js`
- `services/containment/providerUsageAlert.js`
- `services/lifecycle/canonicalProtection.js`, `services/stripeDeletedHousehold.js`
- `services/commercial/commercialStatus.js`
- `services/opsEvents/*`, `routes/adminOpsEvents.js`
- migration 072

## Safe to close?

**Yes.** The worktree is clean and pushed, and nothing is running. Keep the worktree until Andrew has reviewed. Other worktrees and branches were untouched.
