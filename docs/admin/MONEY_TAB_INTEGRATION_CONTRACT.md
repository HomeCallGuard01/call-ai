<!--
STATUS (2026-09-29): dashboard side built and tested on feature/admin-control-centre-v2.
Nothing on feature/provider-neutral-billing-ledger was changed or merged.
-->
# Money tab ← financial safety: integration contract

The Money tab's **Spend safety** section reads Pricing Safety's `runSpendMonitor()` result (`services/finance/spendMonitor.js`, ledger branch `7ad12c9`) through one adapter: `services/businessControl/financialSafetyAdapter.js`.

## What Finance needs to add (one file)

`services/finance/latestSpendMonitorResult.js`:

```js
// Returns the most recent runSpendMonitor() result, exactly as returned
// (ok, asOf, alerts, protection, metrics), or null if it has never run.
async function getLatestSpendMonitorResult() { /* read wherever the scheduled run persists it */ }
module.exports = { getLatestSpendMonitorResult };
```

Where the scheduled run persists its result is Finance's decision. `FINANCIAL_SAFETY_CONTROLS.md` step 2 already persists `protection` and `sentKeys` between runs. The dashboard never runs the monitor itself, because a page view must not trigger alerts.

## What the dashboard guarantees

| Situation | Money shows |
|---|---|
| Provider file absent (today) | **Not connected**, with the reason. No amounts. |
| Provider throws, or `MONITOR_LOAD_FAILED` | "Cost data could not be loaded — spend is unobserved, not zero". The level is kept. |
| Result older than 30h (`maxDataAgeHours`), no timestamp, or `COST_DATA_STALE`/`COST_DATA_MISSING` | **STALE DATA**. Figures are shown with their age; no month-end projection. |
| Fresh | Level (NORMAL / WATCH / ALERT / EMERGENCY) and reasons; today, month to date, projected month-end (ESTIMATED, linear); spend by component; trusted vs monitored call cost vs number rental; unallocated as its own line; highest-cost households with projected contribution; recommended actions labelled "not executed". |

Rules:
- Unpriced items are counted and never summed as £0.
- A non-GBP result is never shown as £.
- The dashboard never runs an action.

**Evidence:** `tests/fixtures/spend-monitor-results.sample.json` is the real output of `runSpendMonitor()` at `7ad12c9` (fresh, stale ingestion, load failure). The adapter's trusted, monitored and rental split reconciles exactly to the monitor's household-attributed total. `tests/money-tab-contract.test.mjs` re-runs against the live module once it's merged.

## Still from the existing Finance read model

- MRR and paying customers come from Stripe, genuine customers only; test mode is refused.
- The P&L is read from the 051 views when `BUSINESS_FINANCE_LEDGER_VIEWS=enabled`.
