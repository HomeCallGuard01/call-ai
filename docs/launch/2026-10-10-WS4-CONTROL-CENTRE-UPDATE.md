# WS4 — Financial Control Centre update (2026-10-10)

Branch `launch/ws4-payments-ops`. Admin-only, read-only. Nothing here writes,
enforces, contacts a customer or calls a provider. Nothing is deployed by this
change.

## What the page now shows

`/admin/financial-control` (routes/adminFinancialControl.js → admin-financial-control.html).

**Top banner: Fortress global status** (from the existing `/admin/api/fortress/overview`):
kill switch, global breaker (with reason), enforcement mode, £ authorised in the
last 24 h against the daily cap and in the last hour against the hourly cap (with %),
committed £ in the last 24 h, active calls, reserved and worst-case £. Red when
the kill switch is on or the breaker is open; amber at 80% or more of either cap;
if the overview fails to load, an explicit "Fortress global status unavailable"
banner (unknown is never shown as "normal"). The window is a rolling 24 h
(`fc_window_sums`), not a calendar day.

**Legend ("How to read this page")** covers estimated vs actual cost, the billing
delay, the reserves, the protection rule, the allowance states, and the rule
that "—" never means zero.

**Totals**: customers, net revenue, estimated cost, actual cost (with "N of M
customers" coverage), attributable cost, margin (actual and projected),
protected, not protected, held, at hard ceiling, and top-ups (enabled/disabled).

**Per customer** (one row per household):

| Column | Field (`GET /admin/api/financial/customer-profitability`) | Source |
|---|---|---|
| Account (+ channel, price, grandfathered) | `accountNumber`, `channel`, `priceLabel`, `grandfathered` | WS2 profitability |
| Protection (+ blockers) | `protection {stage, label, protected, blockers[], attention[]}` | `deriveActivationState` over `loadLifecycleSnapshots` |
| Allowance state | `allowance.state` (normal … hard_ceiling, held) | WS2 `snapshotState` (mirrors 076) |
| Net revenue | `revenue.netGbp` | WS2 |
| Estimated cost | `cost.estimatedGbp` = Fortress committed + reserved (`committedGbp`, `reservedGbp`) | `fc_budget_accounts` |
| Actual cost | `cost.actualGbp` + `cost.actualBasis` (`provider_actual` / `not_available`) | `fc_budget_accounts.actual_gbp` |
| Margin (actual · projected) | `margin.*` | WS2 (uses max(estimate, actual)) |
| Budget left (of budget, % used) | `allowance.remainingGbp`, `budgetGbp`, `usedPercent` | WS2 |
| Trusted reserve | `allowance.trustedReserveRemainingGbp` | 076 delivery reserve |
| Unknown-caller reserve | `allowance.unknownReserveRemainingGbp` | 076 unscreened reserve |
| Top-up credit | `allowance.topUpsGbp` (+ "top-ups disabled" when off) | `allowance_credits` |
| Alerts | `alerts [{severity, title, at, source}]` (red first) | flags, protection stage, delivery attention, UNSEEN ops events |

The remaining panels (heavy users, provider reconciliation, Fortress household
table, signals, new customers, customer problems, advisory recommendations) are
unchanged.

## Rules kept

- Unknown is `null` and renders "—" or "unknown"; never £0, never "protected".
  - Actual cost with no recorded provider actual → `null` + `not_available` → "not yet available".
  - No budget account this period → allowance state and reserves `null` (WS2's
    model returns "normal" in that case; the adapter overrides it to unknown).
  - Household with no lifecycle snapshot, or the lifecycle load fails → `protection: null`
    → "unknown"; protected/not-protected totals become `null`.
  - An inconsistent snapshot fails closed to `ambiguous` (not protected).
- Contract version unchanged (`ws2-profitability-v1`); every new field is additive.
- Page: textContent only (tests assert no innerHTML/outerHTML, hostile strings
  stay literal), one inline script, inline style, same strict CSP, GET only.

## Data loads (route `routes/adminFinance.js`)

One request = the existing WS2 profitability load, plus in parallel:

1. `database/lifecycleSnapshot.js loadLifecycleSnapshots` — the same batched,
   `selectAll`-paginated loader the admin Control Centre and exception queue use
   (no new heavy query);
2. unseen `ops_events` (`seen_at is null`), paginated with
   `services/businessControl/selectAll`.

Each is optional and isolated: on failure it is logged, reported in
`sources.lifecycle` / `sources.opsEvents` as `unavailable`, and the
profitability rows still render. Both loaders are injectable for tests.

## Top-ups

`ALLOWANCE_TOPUPS_ENABLED` stays default **off** (unchanged; `.env` template
test asserts `false`). The response carries `topUps {enabled, status}` from
`env.ALLOWANCE_TOPUPS_ENABLED === 'true'`; the page shows "disabled" in the
totals, the legend and each customer's top-up cell. Nothing was enabled.

## Known gaps

1. **No provider-actuals feed in production.** Nothing calls
   `fc_record_provider_actual`, so `actual_gbp` stays 0 and every customer shows
   "not yet available". When a feed lands, rows switch to `provider_actual`
   automatically. A household with genuinely £0 usage AND a feed would still show
   "not yet available" (0 is indistinguishable from "none recorded" in the
   column); fixing that needs a per-account "actuals reconciled through" marker.
2. **Delivery health is not loaded in bulk** (`sources.deliveryHealth:
   not_loaded_in_bulk`). Delivery alerts come from the snapshot's evidence
   (app-registration history, `reconnect_needed`/`awaiting_app` stages) and from
   `customer_needs_attention` ops events. A per-household delivery-health
   UNREACHABLE/SUSPECT state is visible only on the household detail pages.
3. **Provider reconciliation panel** still reports unavailable (WS2 finding 2).
4. **Fortress "today"** is a rolling 24 h window, not a calendar day.
5. **Allowance state** is WS2's deterministic snapshot (no live worst cases),
   not a live call to `fortress_household_allowance_state` (076) per household.
6. Profitability lists at most 500 households per request (existing WS2 limit);
   the lifecycle loader stops at 50,000 rows and reports `lifecycleTruncated`.
7. Requires migrations 067/076 (budget accounts, reserves) and 072 (ops events)
   to be applied for full data; without them the corresponding fields are
   unknown, not zero.

## Tests

- `tests/financial-control-contract.test.mjs` — real router + adapter with
  fixtures: protected, forwarding_unconfirmed (not protected), held (on_hold +
  state held), hard_ceiling, actual available vs not available, no budget
  account, no snapshot, seen vs unseen ops events, totals, top-ups disabled,
  loader failure → unknown, route stays read-only.
- `tests/admin-financial-control.test.mjs` — page view model and render: new
  columns and values, legend, banner (normal/near-cap/kill switch/unavailable),
  top-ups disabled, hostile strings stay text, no innerHTML.
