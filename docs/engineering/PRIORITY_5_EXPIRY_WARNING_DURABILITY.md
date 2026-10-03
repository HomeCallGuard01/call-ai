# Priority 5: is the 14-day expiry warning durable enough for the dashboard? (confirmed 2026-09-27)

**Confirmation only — no new code required.** Tonight's own directive: "the safe launch baseline is ops-visible warning 14 days before internal_test/reviewer entitlement expiry. Ensure that warning is visible/durable enough for the admin dashboard to surface later."

## What already exists (built earlier tonight, Step 2)

- `entitlement_expiry_warnings_sent` (migration 052): one row per entitlement that has been warned about, with `household_id`, `entitlement_id`, `sent_at`. Idempotent by construction (`ON CONFLICT DO NOTHING` on the primary key), indexed on `household_id`.
- The sweep's default behaviour (`services/numberLifecycleSweepRunner.js`, no `notifyExpiryWarning` injected in production): a `sendCriticalAlert('test_membership_expiring_soon', ...)` ops email, then `recordEntitlementExpiryWarningSent`.

## The gap this confirms is closed

`sendCriticalAlert` itself (`services/alerting.js`) is **purely ephemeral** — a single outbound email via Resend, in-memory 30-minute rate-limiting only, no database write, no persistence of any kind. If the warning table didn't exist, the *only* record of a 14-day warning ever having fired would be whatever's sitting in an inbox — exactly the "depend solely on ephemeral evidence" failure mode this session has been closing all night for other parts of this same feature (Railway logs, migration tracking labels, etc.).

`entitlement_expiry_warnings_sent` is that durable record. It is fully joinable for a future dashboard panel without any new column or migration:

```sql
select w.household_id, w.entitlement_id, w.sent_at,
       e.ends_at, ac.classification
from entitlement_expiry_warnings_sent w
join entitlements e on e.id = w.entitlement_id
left join account_classifications ac on ac.household_id = w.household_id
order by w.sent_at desc;
```

— gives "which memberships were warned, when, what their classification is, and when they actually expire," everything a dashboard panel would need, entirely from data that already exists.

## What's still a real, separate gap (not this one)

The *email itself* is still the only immediately-actionable notification — nothing pages/blocks on it, and if `Resend_API_Key` is unconfigured the alert silently no-ops (logged, not thrown — `services/alerting.js`'s own established fail-open convention). That's a genuine, pre-existing characteristic of `sendCriticalAlert` used identically by every other critical alert in this codebase, not something Step 2 introduced or should fix unilaterally.

## Recommended follow-up (not built tonight, out of scope — Dashboard owns the UI)

`docs/engineering/TOMORROW_INTEGRATION_PLAN.md`'s Stage 3 already flags extending `services/adminNumberLifecycleReconciliation.js` (PR #47) to surface `twilio_release_last_attempt_at`/`_last_error`/`_attempt_count` once migration 052 is live. The identical follow-up applies to `entitlement_expiry_warnings_sent` — add it to that same Stage 3 extension rather than treating it as a separate piece of work, since both are "durable evidence migration 052 added, now needs a dashboard panel."

## Conclusion

Priority 5 is satisfied by what was already built as part of Step 2. No code change needed — this file exists so that conclusion is documented rather than left implicit.
