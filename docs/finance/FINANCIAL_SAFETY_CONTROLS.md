# Financial safety controls (provider-neutral)

> **2026-09-30:** superseded as the top-level design by `FINANCIAL_SAFETY_ARCHITECTURE.md`. That design adds enforced Layer A (allowance) and Layer B (hard admission) controls on branch `feature/financial-safety-hard-limits`. This document still describes the ledger-side monitor those layers reuse.

Status 2026-09-28: **built and tested locally; not wired, not scheduled, not deployed.** No customer-facing limit, price or term is changed or implied. The £4.99 price is unchanged.

Commercial premise (Twilio Support, 2026-09): when a PSTN call reaches an HCG number, the incoming PSTN leg stays active and billable for the whole connected call, including when it is bridged to the app with `<Dial><Client>`. **Trusted calls are not free.** Every control below treats trusted minutes as real cost.

## Components

| Module | Job | Enforces? |
|---|---|---|
| `services/finance/householdCosts.js` | Month-to-date cost per household from ledger rows:<br>• by component (number, inbound trusted / unknown / unclassified, app leg, outbound, streams, TTS, SMS, transcription, other);<br>• minutes: trusted / unknown / monitored / unmonitored-unknown;<br>• peak concurrent calls and longest call;<br>• quality split (actual / allocated / estimated / manual) plus UNKNOWN item count;<br>• month-end projection;<br>• contribution at £4.99 per channel. | No |
| `services/finance/spendAnomaly.js` | Anomalies relative to HCG's own history:<br>• missing or stale cost data (**fail-safe: unobserved ≠ £0**);<br>• company spend spike vs the trailing 14-day median;<br>• first appearance of a cost category (CRITICAL for `app_leg`, `outbound_voice`, `channel_capacity` or `platform_fee`, which break model assumptions);<br>• household cost outliers vs the median;<br>• simultaneous-call floods;<br>• call bursts (forwarding loop or flood). | No |
| `services/finance/spendGuard.js` (existing) | Fixed thresholds: numbers vs entitled households, daily spend, monthly budget, AI, SMS volume and failed-SMS fees, household daily and monthly minutes, long calls. | No |
| `services/finance/companySpendProtection.js` | One company level: NORMAL, WATCH, ALERT or EMERGENCY. It uses hysteresis and emits recommended actions. See the invariants below. | **Never.** Recommends only. |
| `services/finance/spendMonitor.js` | One evaluation: load, accumulate, guard, anomalies, protection, then alert. Each new CRITICAL is sent once per day per (code, household) through `services/alerting.js`. An undelivered or rate-limited alert is retried on the next run. It returns dashboard metrics. A load failure produces ALERT plus `MONITOR_LOAD_FAILED`. | No |
| `database/financialLedger.js` `loadSpendMonitorData` | Paged, read-only loader:<br>• 051 ledger rows;<br>• linked calls (to tell trusted from unknown);<br>• entitled-household count;<br>• newest ledger write. | No |
| `services/finance/exposureModel.js` + `scripts/exposure-report.js` | Worst-case per-household and company exposure for any carrier quote, under the controls on main today vs the proposed controls. | No |
| `scripts/spend-monitor.js` | CLI with two sources:<br>• `--source=ledger`, which needs 051;<br>• `--source=provider-dry-run`, which builds the ledger rows in memory from provider records and works before 051.<br>Read-only. Alerts only with `--send-alerts`. | No |

## Invariants (tested in `tests/financial-safety.test.mjs`)

- **No component blocks, rejects, or shortens a call, or changes a customer limit.**
  - Call-path actions are recommendations with status `recommendation_requires_approval` unless Andrew lists them in `approvedActions`.
  - Even then they are only marked for their owner (P0/product) to execute.
- **Missing or stale cost data never counts as zero.**
  - It raises the level to ALERT at least.
  - It can't, on its own, cause EMERGENCY or a call-path recommendation.
  - The level can't step down while data is unobserved.
- **Amounts stay honest.**
  - Currencies are never mixed; USD transcription is converted only with an explicit rate.
  - UNKNOWN (unpriced) items are counted, never summed as £0.
  - Unallocated cost stays company-level and is never spread across customers.
- **Escalation is immediate; de-escalation is gradual.** The level drops one step after 2 consecutive clean evaluations.
- **A heavy-trusted-usage household is flagged `HOUSEHOLD_PROJECTED_LOSS` for internal fair-use review only.** Nothing customer-facing happens.

## Protection levels and recommended actions

| Level | Trigger (defaults; DECISION REQUIRED) | Actions (none executed) |
|---|---|---|
| NORMAL | Nothing abnormal | None |
| WATCH | Any WARNING | Review the dashboard |
| ALERT | Any CRITICAL, or cost data missing or stale | Page the operator, check the provider console, investigate flagged households, fix ingestion. For a CALL_BURST or ≥ 5 concurrent calls: recommend `reject_burst_source`. |
| EMERGENCY | Today ≥ max(£25, £0.75 × entitled households); or month-to-date ≥ max(£250, £6 × entitled) | All of the above. Recommend `pause_new_monitoring_flagged`, scoped to flagged households; it saves streams and AI, not the inbound leg, and the customer must be told. `provider_number_suspension` is human-only, as a last resort. |

`reject_burst_source` targets the caller ID(s) that drive a burst, and a first-verb `<Reject>` is unbilled. It's the only lever that stops **inbound-leg** cost in an attack without touching the household's genuine callers. Monitoring reductions don't stop inbound-leg cost.

## Worst-case exposure (Twilio, confirmed rates; `node scripts/exposure-report.js`)

£4.99 after VAT and a 15% store fee = **£3.53/month** of revenue per household.

| Scenario | main today / day | main today / 30 d | proposed* / day |
|---|---|---|---|
| 1 line, trusted calls 24 h | £10.88 | £326.51 | £10.88 |
| Same, if Twilio starts billing the app leg at list | £15.43 | £463.02 | £15.43 |
| 1 line, back-to-back unknown calls (maximum monitoring) | £22.53 | £675.95 | £12.91 |
| 10-channel flood direct to the HCG number | £225.32 | £6,759.50 | £45.65 (capped at 4 channels) |
| 100-channel flood | £2,253.17 | £67,595 | £45.65 |
| Company monitoring ceiling (stream cap) | £2,323.87 (200 streams) | £69,716 | £232.39 (20 streams) |

*Proposed = the unmerged allowance branch (4 calls per household, £2/day monitoring ceiling, 20 global streams) plus `<Dial timeLimit=120>`. Not approved, not live.

- On main, **inbound-leg cost has no per-household or company bound**. It scales with the number of simultaneous calls.
- The proposed controls bound a flood per household, but not company-wide across many households.
- A genuine single line is physically bounded at about £10.88/day (trusted) or £22.53/day (unknown).

Genuine heavy households (15% monitored):

| Usage | Cost / month | Contribution / month |
|---|---|---|
| 0.5 h/day | £9.72 | −£6.18 |
| 1 h/day | £18.56 | −£15.03 |
| 2 h/day | £36.26 | −£32.72 |

Break-even is about 264 minutes a month (store) or about 293 (Stripe); see `UNIT_ECONOMICS_AND_PROVIDER_REQUIREMENTS.md`.

## Wiring sequence (each step needs approval)

1. **Now, no approval needed to run, read-only:**
   - `node scripts/exposure-report.js`
   - `node scripts/spend-monitor.js --source=provider-dry-run` against production; not run by Claude on 2026-09-28 because the production read was not permitted in-session.
2. **After 051 is in production and ingestion runs daily:**
   - schedule `runSpendMonitor({ load: () => loadSpendMonitorData({ since }), sendCriticalAlert })`, e.g. hourly, with state persisted between runs (two small fields: `protection` and `sentKeys`);
   - the dashboard reads `metrics`.
3. **Provider-side, independent of HCG code (Andrew):**
   - Twilio Usage Triggers on daily and monthly `totalprice`;
   - OpenAI project budget.
   - These still work when HCG itself is down.
4. **Call path (P0/product; separate approvals):**
   - `<Dial timeLimit>`;
   - per-household concurrent-call limit;
   - `reject_burst_source`;
   - the allowance branch.
