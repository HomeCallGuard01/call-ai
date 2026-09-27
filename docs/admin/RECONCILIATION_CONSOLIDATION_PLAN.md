<!--
STATUS (2026-09-27): plan only. Nothing in P0's or Finance's branches was
modified. Evidence is from a read-only run of all four engines against the
same production data on 2026-09-27.
-->
# Consolidating number-lifecycle reconciliation: one definition, many views

## The problem

Four implementations now calculate the "truth" about subscriptions, entitlements and numbers:

| # | Where | Owner | Purpose | Scope |
|---|---|---|---|---|
| A | `services/adminNumberLifecycleReconciliation.js`, PR #47 | P0 | Admin API: per-household anomalies | Households; status counts **genuine + unclassified only** |
| B | `services/numberLifecycleSweep.js`, PR #49 (on #45) | P0 | Daily sweep that **acts** (schedule release, expire, alert) | Households |
| C | `services/businessControl/numberReconciliation.js` + `numberInventory.js`, PR #48 / `feature/admin-control-centre-v2` | Dashboard | Dashboard Reconciliation / Overview | Households **and** the provider's own number list |
| D | `services/ledger/numberCostReport.js`, ledger branch | Finance | Number cost and anomalies | Provider numbers × production **and staging** households |

## Evidence: same production data, different answers (read-only run, 27 Sep 2026)

| Household / number | C (dashboard) | A (#47) | B (#49 sweep) | D (Finance) |
|---|---|---|---|---|
| `e10c267b` number, no membership ever | No entitlement, number retained | Same | `schedule_release` | Number without entitlement, outside lifecycle |
| `6555f0f4` reviewer, cancelled, number retained | Same (**counted**) | Same but **excluded from status** (non-genuine) | `schedule_release` | Same |
| `466123fa` quarantine awaiting confirmation | Awaiting confirmation | **Not detected** (only confirmed-unreleased) | — | Quarantine age (warning at 45 days) |
| `30f01a7a` entitled, own number in quarantine | Entitled without number + awaiting confirmation. Now also **"quarantined while entitled"** (added after this run) | Entitled, no number | — | **CRITICAL** quarantined number of entitled household |
| `ccae29b4` reviewer, entitled, no number | Entitled without number | Same but **excluded from status** | — | Entitled household without number |
| 7 numbers on a dev ngrok voice URL | Staging/dev (voice URL evidence) | **Not visible** | **Not visible** | Staging (from the staging database) |
| 1 number with no voice URL | Orphan | **Not visible** | **Not visible** | Orphan, with recent inbound calls checked |
| Overall status | ACTION REQUIRED, **13** items | ACTION REQUIRED, **2** anomalies | — | 2 critical + warnings |

The engines agree on the core lifecycle rules. They differ on:
1. **Scope:** #47 ignores non-genuine households in its status. Yet those numbers cost money.
2. **Quarantine states:** unconfirmed quarantines are missed by #47.
3. **Provider inventory:** only C and D compare with what Twilio actually bills.
4. **Grace periods:** C waits 48h for the daily job and 1h for provisioning; #47 has no grace; B has its own 14-day expiry window.
5. **Staging evidence:** C uses voice-URL hosts; D reads the staging database.

## Target design: one shared definition, three consumers

```
services/numberLifecycle/state.js      ← ONE module, owned by P0
  - entitlement predicates: isCurrentlyEntitled, isUpcomingEntitlement,
    blocksNumberRelease (mirrors migration 047 exactly — already duplicated in A, B, C, D)
  - deriveHouseholdLifecycleState(household, entitlements, subscriptions, quarantine, now)
      → { membership, holdsNumber, releaseState, quarantineState, … }
  - ANOMALIES catalogue: code, severity, label, grace rule
      (union of A, B, C and D, with one agreed severity/grace per code)
  - detectHouseholdAnomalies(state, now) → anomalies (no classification filter)

services/numberLifecycle/providerInventory.js   ← shared, number-centric
  - buildNumberInventory(providerNumbers, households, quarantine, evidence, now)
      evidence = voice-URL host (production-visible) + optional staging
      household list (Finance's cross-environment view)

Consumers (no rules of their own):
  #47 admin API ─┐
  #49 sweep     ─┼─ read state + anomalies; the sweep alone maps anomalies → ACTIONS
  dashboard     ─┤  (Overview, Reconciliation, number inventory: presentation only)
  Finance cost  ─┘  (overlays £ per number from the ledger; no lifecycle rules)
```

**Rules:**
- **Classification is a presentation filter, never an input to anomaly detection.** A reviewer's number costs the same as a customer's. Views may split by class; status counts include everything that costs money.
- **One place for grace periods:** 1h provisioning, 48h after a due release (daily job), 45/90-day quarantine escalation.
- **Only the sweep acts.** The dashboard and admin API are read-only.

## Migration path (no one modifies another's branch)

| Step | Who | What |
|---|---|---|
| 1 | P0 | Merge #45 (047) → #47 → #49 as planned. |
| 2 | P0 | Extract the shared module from #47/#49, adopting the union catalogue in the table below. |
| 3 | Dashboard | Rebase #48/v2 onto it. `numberReconciliation.js` becomes a thin adapter; `numberInventory.js` moves to the shared module (or stays, calling shared predicates). |
| 4 | Finance | `numberCostReport.js` calls the shared inventory and adds cost. The staging-household input stays optional. |
| 5 | All | One parity test: the fixed fixture set produces identical anomaly codes from the admin API, the dashboard and the sweep's alert list. |

### Union anomaly catalogue (proposed; P0 to confirm)

| Code | Source | Severity | Grace |
|---|---|---|---|
| ACTIVE_OR_UPCOMING_WITHOUT_NUMBER | A, C, D | action | 1h unless provisioning failed |
| NO_ENTITLEMENT_NUMBER_RETAINED (outside lifecycle) | A, B, C, D | action | — |
| ENTITLED_BUT_PENDING_RELEASE (#8) | A, B, C | action | — |
| RELEASE_OVERDUE | B, C | action | 48h |
| PROVISIONING_FAILED | A, B | action | — |
| QUARANTINE_AWAITING_CONFIRMATION | C, D (age) | watch → action at 45 days, critical at 90 | 45/90 days |
| QUARANTINE_CONFIRMED_NOT_RELEASED | A, B, C | action | 48h |
| QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD | D, C | critical | — |
| RECORDED_RELEASE_FAILURE (P0 052 columns) | B (writes), C (reads) | action | — |
| PROVIDER_NUMBER_UNACCOUNTED: orphan / staging | C, D | action / amber | — |
| MARKED_RELEASED_STILL_AT_PROVIDER | C | action | — |
| HOUSEHOLD_NUMBER_MISSING_AT_PROVIDER | C | action | — |
| VOICE_URL_NOT_PRODUCTION (production household) | C | action | — |
| DUPLICATE_ASSIGNMENT | D | action | — |
| APP_NEVER_REGISTERED / DELIVERY_NEVER_CONFIRMED | C | watch | — |

## DECISION REQUIRED

1. **P0:** adopt "classification never filters anomalies". #47 currently excludes non-genuine households from its status.
2. **P0:** ownership and location of the shared module, and the grace-period values above.
3. **Finance + Dashboard:** source of staging evidence. Voice-URL host works from production alone; the staging-database join is more complete but needs staging credentials in whatever runs it.
4. **Sequencing of #48:** merge #48 as-is (the observational view, clearly labelled) and converge after #47/#49, or hold #48 until the shared module exists? **Recommended:** merge #48 after #47, then do step 3 as a follow-up. The dashboard is read-only, so a temporary difference is visible but causes no harm.
