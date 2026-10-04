# Soft-launch candidate — integration plan (2026-10-04)

Written before any merge. Final report: `2026-10-04-SOFT-LAUNCH-CANDIDATE-FINAL.md`.

## Verified starting state (git fetch 2026-10-04)

| Branch | Expected | Remote HEAD | Local worktree | Commits on 2011ab6 |
|---|---|---|---|---|
| integration/launch-fortress-2026-10-03 (base) | 2011ab6 | 2011ab6 | clean | — |
| research/provider-financial-containment | aaa43ba | aaa43ba | clean | 1 |
| finance/unit-economics-v1 | f6633ee | f6633ee | clean | 1 |
| feature/accounting-automation | 8e3d0bd | 8e3d0bd | clean | 2 |
| feature/customer-lifecycle-automation | d6f586a | d6f586a | clean | 1 |
| release/launch-readiness-2026-10-04 | 75ff4ac | 75ff4ac | clean | 1 |

Every input branches directly from 2011ab6; none is behind it. No new commits appeared on the base.

## Overlap inventory

77 changed paths across the five branches. Exactly one shared file: `server.js`.
Accounting and lifecycle each add one `app.use(...)` line after the same
`adminFortress` mount (adjacent-line textual conflict, no semantic overlap).

## Migration inventory

- Base allocation: 046–070 frozen in `tests/migration-allocation.test.mjs`
  (048–050 burned).
- Every local and remote ref was scanned. `071` is claimed only by
  `feature/accounting-automation` (`071_accounting_transactions.sql` + rollback).
  No other branch claims ≥071.
- Historic same-number collisions (044, 045, 046, 055, 058, 060, 061) exist
  only on older, un-integrated branches. They were reconciled by the 2026-10-03
  integration and do not affect ≥071.
- **Decision:** keep 071 for accounting. No renumbering is needed. Next free
  number after integration: 072.

## Method

Use `git merge --no-ff` per branch, in dependency order. This keeps each
workstream's original commits and SHAs, which preserves provenance. I am not
cherry-picking.

1. provider-financial-containment (docs + launch-gate registry)
2. unit-economics-v1 (assumption register, runtime defaults)
3. accounting-automation (071, flag-gated capture)
4. customer-lifecycle-automation (`server.js` conflict: keep both mounts)
5. launch-readiness (docs)
6. Integration fixes, one commit per concern (§6 of the brief).

Run the full suite after each merge. Baseline on untouched 2011ab6 with the
offline dummy env and real-PG modules: **178 files, 178 passed, 7,694 ✓, 0 ✗**.
