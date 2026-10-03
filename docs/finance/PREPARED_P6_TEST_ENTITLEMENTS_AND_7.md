# PREPARED, NOT EXECUTED — #5/#14 test classification and extension; #7 end-of-complimentary path

Prepared 2026-09-27 from read-only production reads. **No production write has been made.** Each step needs Andrew's explicit approval at the time it's run.

## Current production state (read 2026-09-27)

| # | Household | Number | Bought | Calls | Active entitlement | Classification | Pending release |
|---|---|---|---|---|---|---|---|
| 5 | 3192e94f | …494 (PN3c4e…) | 2026-08-31 (by a sandbox purchase) | 27 | admin_manual `complimentary`, ends **2026-10-07 19:26** | none (UNCLASSIFIED) | none |
| 14 | 9cb62adb | …063 (PN6804…) | 2026-09-23 | 15 | admin_manual `complimentary`, ends **2026-10-07 19:26** | none | none |
| 7 | ca819dbe | …653 (PN971d…) | 2026-09-07 | 0 (never registered) | admin_manual `complimentary` (F&F invite "Sister"), ends 2027-09-07 | `internal_test` (F&F invite) | none |

## Schema facts that shape the plan

- **`internal_test` is not an entitlement type.** `entitlements.entitlement_type` allows only `paid_subscription`, `free_trial`, `founding_offer`, `promotion`, `complimentary`, `partner` and `staff` (migration 011).
- The admin grant endpoint always writes `complimentary` / `admin_manual`.
- `internal_test` is a value of **`account_classifications.classification`** (migration 031). That is what both the dashboard's genuine-customer filter and P0's lifecycle sweep read (`TEST_CLASSIFICATIONS` sends 14-day pre-expiry warnings).
- So "classify as internal_test" means **one account_classifications row per household, plus a complimentary entitlement to 31 Dec 2026.**
- No admin endpoint writes `account_classifications`. Only the F&F invite path does. Step B is therefore a service-role SQL write.

## #5 and #14 — prepared change

**Step A: extend the entitlement** through the existing audited admin path, not SQL.
- Admin dashboard → household → *Grant complimentary*.
- Or `POST /admin/api/households/{id}/grant-complimentary` with:
  - `endsAt: "2026-12-31T23:59:59Z"`
  - `notes: "Andrew's HCG test device — ongoing production testing; review quarterly"`
- What the code does (`grantComplimentaryEntitlement` → `updateTwilioNumberForEntitlementChange(true)`):
  1. The current complimentary (ending 10-07) becomes `expired`. It is admin_manual/complimentary, so the grant is allowed and nothing is refused.
  2. A new `complimentary` / `admin_manual` row is inserted: active, `ends_at` 2026-12-31 23:59:59Z, with the note.
  3. `cancel_household_twilio_number_pending_release` runs. There is nothing pending, so it's a no-op.
  4. `ensureTwilioNumberProvisioned` → `shouldAttemptProvisioning` is false because the household already has a number. **No purchase, no Twilio call.**
  5. An admin action is recorded.

**Step B: classify.** Service-role SQL, run in the Supabase SQL editor for production. The guards refuse to write unless each prefix matches exactly one household holding the expected number:

```sql
begin;
do $$
declare r record; n int;
begin
  for r in select * from (values ('3192e94f','494'), ('9cb62adb','063')) v(prefix, suffix) loop
    select count(*) into n from public.households
      where id::text like r.prefix || '%' and right(twilio_number, 3) = r.suffix;
    if n <> 1 then raise exception 'expected exactly one household for % / …%, found %', r.prefix, r.suffix, n; end if;
  end loop;
end $$;

insert into public.account_classifications (household_id, classification, note, classified_by)
select id, 'internal_test', 'Andrew''s HCG test device — ongoing production testing; review quarterly', 'admin:andrew'
from public.households
where (id::text like '3192e94f%' and right(twilio_number, 3) = '494')
   or (id::text like '9cb62adb%' and right(twilio_number, 3) = '063')
on conflict (household_id) do nothing;

select left(household_id::text, 8), classification, note from public.account_classifications
where household_id::text like '3192e94f%' or household_id::text like '9cb62adb%';
-- expect 2 rows; then COMMIT (or ROLLBACK if not)
```

**Order:** A then B, both **before 2026-10-07 19:26 UTC**.

If nothing is done by then:
- the complimentary entitlements lapse;
- /voice stops protecting calls to those numbers (`getActiveEntitlement` finds nothing);
- production today **never starts a release on natural expiry**, so both numbers keep costing £0.87/month each;
- after P0's sweep (052) is deployed, it would propose `expire_lapsed_entitlement` + `schedule_release`, leading to quarantine and then release after confirmation.

| | Before | After A+B |
|---|---|---|
| Entitlement | complimentary, ends 10-07 | complimentary, ends 2026-12-31 (previous row `expired`) |
| Classification | UNCLASSIFIED (counts neither as genuine nor as test) | `internal_test` (excluded from customer KPIs; P0 sweep sends a 14-day pre-expiry warning around 17 Dec) |
| Number / cost | kept, £0.87/month each | unchanged: kept, £0.87/month each; review quarterly |

**Rollback:**
- A: *Revoke complimentary* (see #7 below for the consequence) or grant again with another date.
- B: `delete from account_classifications where household_id = … and classified_by = 'admin:andrew'`.

**DECISION REQUIRED (P0/schema):** should `internal_test` become a real `entitlement_type`, which needs a migration numbered in merge order? The classification table already does the job for reporting and the sweep, so this is optional.

## #7 — what happens if the complimentary is ended

Trigger: *Revoke complimentary* on ca819dbe (admin endpoint `/admin/api/households/{id}/revoke-complimentary`).

| Day | Event | Mechanism | Household state | Twilio |
|---|---|---|---|---|
| D | Revoke | `revokeComplimentaryEntitlement` → status `revoked`; then `updateTwilioNumberForEntitlementChange(false)` → `mark_household_twilio_number_pending_release(30 days)` (the 047-guarded version once 047 is deployed; there is no other entitlement, so the guard allows it) | no entitlement; number kept; `pending_release_at` = D+30; /voice stops protecting | billed |
| D → D+30 | Quiet period | a new entitlement (e.g. a re-grant) cancels the pending release (047 trigger / grant hook) | — | billed |
| D+30 (daily runner) | Grace expiry | `releaseExpiredTwilioNumber` → `release_household_twilio_number` (clears `households.twilio_number`) → `quarantineHouseholdTwilioNumber(… 'subscription_grace_expired')` | number removed from household; quarantine row, `deactivation_confirmed = false` | **still billed** |
| manual | Confirm deactivation | Admin `POST /admin/api/households/{id}/confirm-deactivation`. Policy: first confirm the person's phone no longer forwards to the number. Here the Sister never registered and has made 0 calls. | quarantine confirmed | billed |
| next daily run | Provider release | `releaseQuarantinedTwilioNumber` → `incomingPhoneNumbers(sid).remove()` → `markReleased` | CLOSED CLEANLY once the provider confirms (P0 052 records attempts) | **billing stops** |

Notes:
- Rental is charged on each 7th (the number was bought on 09-07); there's no mid-cycle refund.
  - Revoking by 2026-10-06 → quarantine around 11-05 → released before the 11-07 renewal. That pays the 10-07 rental only and saves about £0.87 × 10 = **£8.69** up to the current end date of 2027-09-07.
  - Revoking later slips by one month for every month missed.
- Leaving it alone: £0.87/month until 2027-09-07, and **production today does nothing even then** (natural expiry never starts a release) until P0's sweep is deployed.
- The classification row (`internal_test`) is unaffected by revoking, and the household still exists. The F&F invite remains in history.
- **DECISION REQUIRED (Andrew):** revoke #7 now (recommended if the Sister is not going to set up; before 10-06 for the saving above), or keep it and tell her.
