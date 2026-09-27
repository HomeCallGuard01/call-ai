<!--
STATUS (2026-09-27): DESIGN PROPOSAL ONLY. No migration, no code change.
The number lifecycle (services/twilioProvisioning.js, twilio_number_quarantine,
migration 047) is owned by the P0 workstream; this is offered to that
workstream, not implemented here.
-->
# Recording failed Twilio number releases

## Problem

The business control dashboard's Reconciliation tab can only **infer** a failed provider release ("confirmed quarantine not released after 48h"). Today every failure in the release path is written to server logs and nowhere else. After a Railway redeploy or log rotation, the evidence is gone.

## What happens today (verified in `origin/main` code, 27 Sep 2026)

Two scheduled jobs run every 24h from server start (`server.js`).

**Path A: grace period expiry (`releaseExpiredTwilioNumber`)**
1. `release_household_twilio_number` RPC: detaches the number from the household.
2. `findTwilioIncomingNumberSid`: its failure is swallowed (`.catch(() => null)`).
3. `quarantineHouseholdTwilioNumber`: inserts the `twilio_number_quarantine` row.
4. Any exception is logged as `TWILIO NUMBER QUARANTINE FAILED` and dropped.

**Path B: confirmed quarantine release (`releaseQuarantinedTwilioNumber`)**
1. It looks up the SID if it isn't stored, then calls Twilio `incomingPhoneNumbers(sid).remove()`.
2. If the SID lookup returns **nothing**, the row is **marked released without anything being removed** (logged as a warning).
3. A Twilio error is logged as `TWILIO NUMBER QUARANTINE RELEASE FAILED`. The row stays unreleased and is retried every day, with no attempt count and no error stored.

### Failure modes that are invisible today

| # | Failure | Effect | Visible now? |
|---|---|---|---|
| F1 | Path A step 3 fails after step 1 succeeded | Number detached from the household **and** absent from quarantine, but still rented at Twilio | Only as "provider number unaccounted" in the new Reconciliation tab, with no cause |
| F2 | Path B Twilio `remove()` fails (auth, rate limit, number already ported…) | Retried daily indefinitely, rental keeps accruing | Only inferred after 48h |
| F3 | Path B SID lookup finds nothing (number formatting mismatch, number moved to another subaccount) | Row marked released while the number may still exist at Twilio | Only as "provider number unaccounted" |
| F4 | Path A SID lookup fails | Quarantine row has no SID; Path B must look it up later (F3 risk) | No |

The read-only production check on 27 Sep found **8 Twilio numbers held by no household and no open quarantine**. F1 and F3 are both plausible causes; so are staging or test numbers on the same account. There's no evidence either way today, which is the point of this proposal.

## Proposal

### 1. Append-only attempt log (new table, migration number assigned by P0 when written)

```sql
-- PROPOSAL — not a migration file.
create table public.twilio_number_release_attempts (
  id uuid primary key default gen_random_uuid(),
  quarantine_id uuid references public.twilio_number_quarantine(id) on delete set null,
  household_id uuid references public.households(id) on delete set null,
  twilio_number text not null,
  provider text not null default 'twilio',
  provider_sid text,
  phase text not null check (phase in ('grace_expiry_quarantine', 'provider_release')),
  outcome text not null check (outcome in ('succeeded', 'failed', 'not_found_at_provider')),
  error_code text,            -- provider error code / HTTP status only
  error_message text,         -- truncated to 300 chars; no credentials, no request bodies
  attempted_at timestamptz not null default now()
);
-- RLS on, no policies; writes only through a SECURITY DEFINER RPC granted to service_role:
-- record_twilio_number_release_attempt(p_quarantine_id, p_household_id, p_number, p_sid, p_phase, p_outcome, p_error_code, p_error_message)
```

Why a separate append-only table rather than columns on `twilio_number_quarantine`:
- **F1 happens before any quarantine row exists.**
- Daily retries need a history (attempt count, first/last failure), not a single overwritten field.
- The quarantine table's existing semantics stay untouched.

### 2. Code changes (P0-owned files)

- **Path A:** record `grace_expiry_quarantine` / `failed` in the catch block, with the number and household, especially when step 1 succeeded and step 3 failed (F1).
  - **DECISION REQUIRED (P0):** make detach + quarantine atomic, by quarantining first or doing both in one RPC, so F1 cannot happen at all.
- **Path B:** record every attempt:
  - `succeeded` after `remove()`;
  - `failed` with the error code and message in the catch block;
  - `not_found_at_provider` when the SID lookup is empty.
  - **DECISION REQUIRED (P0):** should `not_found_at_provider` still mark the quarantine row released? Safer: record it and leave the row unreleased for an admin to confirm, so a lookup mismatch can't hide a still-rented number (F3).
- **Recording must fail open:** a failure to write the attempt log never blocks or reverses a release. That matches the existing fail-open convention for diagnostics.

### 3. Dashboard consumption (business control, after the table exists)

The Reconciliation tab would read the latest attempt per quarantine and per number:

| New anomaly | Rule | Replaces |
|---|---|---|
| Provider release failed (**recorded**) | Latest `provider_release` outcome `failed`; shows the attempt count, first failure and last error | The inferred "confirmed quarantine not released" rule (kept as a fallback) |
| Number not found at provider on release | Outcome `not_found_at_provider` | — |
| Quarantine step failed after detach | `grace_expiry_quarantine` `failed` | Explains many "provider number unaccounted" rows |

Only a read is needed (`select … order by attempted_at desc`). It stays strictly observational.

### 4. Tests (for whoever implements it)

- pglite migration test: constraints; RLS denies anon and authenticated; the RPC is service_role only.
- Unit tests with injected fakes for both paths: each outcome is recorded; a recording failure doesn't change the release result; F1 is recorded with the number when the quarantine insert throws.
- Dashboard: the recorded failure beats the inferred one; `not_found` surfaces for verification.

## Open decisions

1. **Ownership and migration number:** P0 (number lifecycle). Not taken here, to avoid colliding with 047–050.
2. **Atomic detach + quarantine** (F1).
3. **`not_found_at_provider` handling** (F3).
4. **Verify the 8 unaccounted Twilio numbers** before any release, by checking whether each belongs to staging/testing. Nothing is released from the dashboard.
