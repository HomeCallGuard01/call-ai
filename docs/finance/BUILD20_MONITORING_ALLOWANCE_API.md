# Build 20: monitored-allowance data contract

Backend: branch `feature/financial-safety-hard-limits` (not deployed). Nothing in the mobile app has been changed. This is what Build 20 can consume once the backend and migration 056 ship.

## Where it appears

| Endpoint | Field |
|---|---|
| `GET /api/v1/me/dashboard` (mobile) | `monitoringAllowance` (top level) |
| `GET /dashboard-data` (web) | `monitoringAllowance` |
| Activity items (`activity[]` / `recentCalls[]`) | `monitoringStatus` per call |

`stats.callsScreened` now counts only unknown calls that were **actually monitored**.

## `monitoringAllowance` (version 1)

```json
{
  "version": 1,
  "planCode": "standard",
  "allowanceMinutes": 100,
  "enforced": true,
  "warningPoints": [75, 90, 100],
  "periodStartsAt": "2026-09-12T09:00:00.000Z",
  "resetsAt": "2026-10-12T09:00:00.000Z",
  "callsContinue": true,
  "usedMinutes": 42,
  "remainingMinutes": 58,
  "usedPercent": 42,
  "remainingPercent": 58,
  "overAllowance": false,
  "state": "available",
  "monitoringActive": true,
  "lastWarningPoint": null
}
```

| Field | Meaning |
|---|---|
| `usedMinutes` / `remainingMinutes` | Whole minutes. Used rounds **down**, so remaining rounds up, in the customer's favour. Limits are enforced on exact seconds. |
| `usedPercent` | 0–100, capped |
| `allowanceMinutes` | Includes any future top-up for the period |
| `resetsAt` | End of the current billing period: Stripe period end, store renewal expiry, or monthly anniversary for complimentary |
| `enforced` | `false` means the allowance is measured and shown, but monitoring does **not** stop at 100%. It's the default until Andrew approves the commercial allowance. |
| `lastWarningPoint` | Highest warning point already reached this period (75, 90 or 100), or `null`. Each point is claimed once per period server-side, so the app can show "you've used 75%" once. |
| `callsContinue` | Always `true`. The allowance never blocks calls. |

## `state` values

| State | Meaning | `monitoringActive` |
|---|---|---|
| `available` | Under the first warning point; unknown calls are monitored | `true` |
| `low` | At or over 75% or 90% (or over 100% when not enforced); still monitored | `true` |
| `exhausted` | Allowance used, **enforced**. New unknown calls connect **without monitoring** until `resetsAt`. | `false` |
| `paused` | An internal safety limit or kill switch has stopped monitoring. Calls still connect. | `false` |
| `unavailable` | Usage couldn't be read. The app must **not** claim active monitoring. All usage numbers are `null`. | `null` |

Rule for the app: show "monitoring unknown callers" or "protected" **only** when `monitoringActive === true`.

## Per-call `monitoringStatus`

| Value | Meaning |
|---|---|
| `null` | Trusted contact (never monitored by design), or a call logged before 056 |
| `monitored` | Monitored |
| `not_monitored_allowance_exhausted` | Connected unmonitored: allowance used |
| `not_monitored_safety_limit` | Connected unmonitored: an internal limit |
| `not_monitored_unavailable` | Connected unmonitored: the safety check couldn't run |
| `not_monitored_no_entitlement` | Connected unmonitored: no active membership |
| `monitoring_stopped_allowance_exhausted` | Monitoring stopped part-way (allowance reached during the call); the call continued |
| `monitoring_stopped_safety_limit` | Monitoring stopped part-way (a safety limit); the call continued |

## Wording

Customer-facing wording is **not** defined here (product decision). Example structure only: "Monitoring this month · 42 of 100 minutes used · 58 minutes remaining · resets 12 Oct".

## Compatibility

- The field is additive.
- Build 19 ignores it: it has no allowance UI.
- Because `enforced` defaults to `false`, enabling metering alone never makes Build 19 show "protected" while monitoring is off.

> **Warning:** Before enforcement is switched on, a build that understands `state: "exhausted"` must be live. Otherwise older apps will keep showing protection that has stopped.
