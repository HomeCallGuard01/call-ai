# Support-verified Protected status (launch blocker B3): 2026-10-09

**Status: implemented and tested on `launch/controlled-launch-2026-10-09`. Not merged, not deployed. Migration 075 is NOT applied anywhere.**

## Why

LF-2 (migration 074) made `households.forwarding_proven_at` the **only** input to the protection gate. Nothing wrote it, so no customer could ever be shown Protected.

Twilio cannot tell a diverted call from a direct dial: `ForwardedFrom` is the Twilio number itself on 184 of 184 production calls. So for the controlled cohort, proof is recorded by support from an attended test call. It then rests on three things:
- evidence that the database checks;
- an authorised admin action;
- a permanent audit record.

## What was built

| Part | File |
|---|---|
| Migration 075: allows `forwarding_proof_method = 'support_verified'`; append-only `forwarding_proof_audit`; `hcg_record_support_forwarding_proof` / `hcg_clear_forwarding_proof` (SECURITY DEFINER; execute granted to `service_role` only) | `supabase/migrations/075_support_verified_forwarding_proof.sql` |
| Rollback (refuses while any support proof or audit row exists) | `supabase/migrations/_rollbacks/075_rollback_support_verified_forwarding_proof.sql` |
| DB wrapper (returns only the last 4 digits of any number) | `database/forwardingProof.js` |
| Admin API + page: `GET /admin/forwarding-proof`, `GET` and `POST /admin/api/households/:id/forwarding-proof`, `POST …/clear` | `routes/adminForwardingProof.js`, `admin-forwarding-proof.html`, mounted in `server.js` |
| Boot warning (recommended in production) when no support phone is configured | `services/config/launchConfig.js` (`support_verification_callers`) |
| Tests | `tests/migration-075-support-forwarding-proof.pglite.test.mjs` (36 checks); `tests/admin-forwarding-proof.test.mjs` (26 checks, end to end on the real SQL) |

## Evidence rules, enforced inside the database (cannot be bypassed by the API)

The proof is refused, and **nothing is written**, unless every condition holds:

1. The household exists and is not cancelled or deleted.
2. Its HCG number is `active`.
3. It is not already proven. Clearing first is a separate, audited action.
4. The evidence call is in `calls` **for this household**.
5. The call was **answered in the app** (`dial_call_status = 'completed'`).
6. The call is no older than the window: default 60 minutes, at most 240, set by `HCG_SUPPORT_VERIFICATION_MAX_AGE_MINUTES`. It must not be in the future.
7. The call came **from a designated support phone** (`HCG_SUPPORT_VERIFICATION_CALLERS`). That phone must not be the customer's mobile or the HCG number.
8. The operator attests the **last 4 digits of the customer's own mobile** they dialled, and these match `households.phone_number`.
9. The call happened on the **current** number: at or after the active primary routing assignment (062), when that time is known.
10. The call has **never been used as evidence before**. A unique index enforces this, even after a clear.

On success:
- `forwarding_proven_at` is set to the **evidence call's time**, not the click time. The gate's existing staleness logic therefore still voids the proof if the number is later replaced.
- One audit row records:
  - the actor (taken from the admin session; a body-supplied actor is ignored);
  - the reason;
  - the evidence SID;
  - masked digits only.

API layer, same shape as the Fortress controls:
- `requireAuth` + `requireAdmin`;
- JSON only (blocks cross-site forms);
- typed phrase `RECORD FORWARDING PROOF` / `CLEAR FORWARDING PROOF`;
- a reason of at least 10 characters;
- **off (503) until a support phone is configured**.

## Operator procedure (per customer, attended)

1. The customer sets up forwarding using the app's instructions and confirms it is on.
2. From the designated support phone, dial the **customer's own mobile number**, never the HCG number.
3. The call must arrive in the HCG app. The customer **answers in the app**, then ends the call.
4. Open `/admin/forwarding-proof?household=<id>`. Choose the call marked "eligible", enter the last 4 digits you dialled, and write who was present and what was seen. Type the phrase, then select Record.
5. Ask the customer to refresh. They now see Protected.
6. **Clear the proof** if the customer later turns forwarding off, changes SIM or carrier, or the number is replaced. A replacement number already voids it automatically.

## Residual risk (accepted for the cohort; replaced by the automatic verification call later)

- **The forwarded leg itself can't be proven.** An operator who dials the HCG number directly, then attests falsely, would create a false proof.
  - Mitigations: an attended procedure, a named actor in an append-only audit, the customer on the line, and digit attestation.
  - The automatic verification-call design (`2026-10-06-LF2-VERIFICATION-CALL-DESIGN.md`) removes this residual risk. It stays post-cohort.
- **Proof does not track later changes.** It confirms forwarding at one moment. If the customer later disables forwarding, the app keeps showing Protected until support clears it.
  - This is the same limitation the automatic design has.
  - The first-five runbook's weekly check should include "a call reached HCG in the last 7 days".

## Deploy notes

- Apply 075 after 074, in the same window. It is additive; old backends ignore it.
- Set `HCG_SUPPORT_VERIFICATION_CALLERS=+44…` (Andrew's support phone) in Railway. Without it, the action stays off and the boot log warns.
