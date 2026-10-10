# Twilio usage breaker: deployment runbook (containment P7)

**Status (2026-10-11):** prepared by Agent 1. **Not deployed.** It needs the subaccount migration first (`2026-10-11-TWILIO-SUBACCOUNT-MIGRATION-RUNBOOK.md`) and Andrew's approval for each console step.

**Code:** `twilio-functions/usage-breaker/functions/suspend-runtime-subaccount.protected.js`.
- It suspends **only** `HCG_RUNTIME_SUBACCOUNT_SID`, for allowlisted triggers only, and never the parent.
- It is idempotent.
- **New (Agent 1):** after suspending, it also **ends the subaccount's live calls**. Suspension alone leaves them running.
- Tests: `tests/twilio-usage-breaker.test.mjs`.

## Limits: do not present the breaker as a hard cap
1. **Triggers fire on booked usage, polled about once a minute.** Call usage is believed to be booked when a call **ends**. A long call in progress may therefore not move a `totalprice` trigger until it finishes, up to 4 hours later.
2. **It stops new calls and now hangs up live ones, but only once it fires.** Whether the parent can update calls in a **suspended** subaccount is unverified (V4).
3. **Triggers that live in the subaccount can be deleted** by anyone holding the subaccount's credentials, which includes a compromised backend. Only parent-located triggers resist that, and it is unverified that they count subaccount usage (V1).
4. **The breaker is a backstop.** The primary bound is the Fortress application caps. The provider bounds are the prepaid balance (P2) and the 4-hour maximum call duration (P5).

## 1. Create the Functions service, in the PARENT account
1. Console (parent) → Functions and Assets → Services → **Create service**: `hcg-usage-breaker`.
2. Add two Functions:
   - `/suspend-runtime-subaccount`: paste `suspend-runtime-subaccount.protected.js`, visibility **Protected**;
   - `/suspend-runtime-subaccount-verified`: paste `suspend-runtime-subaccount-verified.js`, visibility **Public**. It verifies signatures itself; see §2.
   - Alternatively, use `twilio serverless:deploy` from `twilio-functions/usage-breaker` on Andrew's machine, with parent credentials that are never committed.
3. Environment variables (service settings):

| Variable | Value |
|---|---|
| `HCG_RUNTIME_SUBACCOUNT_SID` | runtime subaccount `AC…` |
| `HCG_BREAKER_TRIGGER_SIDS` | comma-separated `UT…` SIDs, filled in after step 2 |
| `HCG_RUNTIME_SUBACCOUNT_AUTH_TOKEN` | the runtime subaccount's auth token (verified variant only; rotate together with Railway) |
| `HCG_BREAKER_HANGUP_LIVE_CALLS` | `true` (default) |
| `HCG_BREAKER_HANGUP_BEFORE_SUSPEND` | `false` initially; set `true` if V4 shows a suspended account's calls can't be modified |
| `HCG_BREAKER_MAX_HANGUPS` | `200` (one invocation; 10 s Function limit) |

4. Enable "Add my Twilio credentials (ACCOUNT_SID) and (AUTH_TOKEN) to ENV". `context.getTwilioClient()` uses them, and they never leave Twilio.
5. **Deploy.** Record the Function URL.

## 2. Create the usage triggers
Proposed values, for approval. They sit **above** the Fortress application caps (£4/h, £15/day at ≤ 10 households), so the breaker fires only when application containment has failed:

| Trigger | Category | Recurring | Value | Why |
|---|---|---|---|---|
| T-day-£ | `totalprice` | daily | £20 | Fortress' daily cap is £15. More than £20 booked means HCG's own controls failed |
| T-inbound-min | `calls-inbound` (minutes) | daily | 1,500 min | About 10× the expected cohort daily volume |
| T-sms | `sms` (count) | daily | 60 | Warning SMS are rare. Pumping or abuse shows here first, and is booked quickly |
| T-client | `calls-client` (minutes) | daily | 1,500 min | Voice SDK legs, including client-originated |

### Where the triggers live, and which Function they call (design decided 2026-10-11)

**The defect (found by staging infra):**
- A trigger created **in the runtime subaccount** almost certainly signs its callback with the **subaccount's** auth token.
- A `protected` Function in the parent accepts only **parent**-signed requests.
- That pairing would answer 401, and the breaker would never fire.

**What Twilio's documentation says (read 2026-10-11):**
- **Usage Triggers** (`/docs/usage/api/usage-trigger`) do not say whether a parent trigger counts subaccount usage. They do not say which token signs the callback. They are "evaluated … about once a minute".
- **Usage Records** (`/docs/usage/api/usage-record`) include subaccounts by default: `IncludeSubaccounts` defaults to `true`, "usage from the master account and all its subaccounts".
- So parent-level aggregation is plausible for triggers but **NEEDS-TWILIO-CONFIRMATION (Q-B1)**. Which token signs a subaccount trigger's callback is also **NEEDS-TWILIO-CONFIRMATION (Q-B2)**.

**Chosen design: deploy both Functions and use the verified one by default.**
- **`/suspend-runtime-subaccount-verified`** (`suspend-runtime-subaccount-verified.js`, public visibility):
  - checks `X-Twilio-Signature` itself, in constant time, against an allowlist: the parent token (`context.AUTH_TOKEN`) and the runtime subaccount token (`HCG_RUNTIME_SUBACCOUNT_AUTH_TOKEN`, a service env var);
  - requires the body's `AccountSid` to be the account whose token verified;
  - then makes exactly the protected variant's decision (allowlisted trigger SIDs, configured target, never the parent);
  - unsigned, forged or tampered requests get 403 and touch nothing.
  - **Tests:** both signature sources accepted; unsigned, forged key, tampered parameter, wrong URL, account mismatch and empty token all refused (`tests/twilio-usage-breaker.test.mjs`).
  - **Residual risk:** whoever holds the subaccount token (a compromised backend) can forge a call, but it can only **suspend** HCG and end its calls. That fails safe.
- **`/suspend-runtime-subaccount`** (protected): kept for triggers that live in the **parent**, if Q-B1 is confirmed. Those triggers are the only ones a compromised backend cannot delete.

**Steps:**
1. Add the service env var `HCG_RUNTIME_SUBACCOUNT_AUTH_TOKEN` = the runtime subaccount's auth token. It is already in Railway, so this adds no new exposure. **Rotate it here whenever it is rotated in Railway**, or the verified Function will refuse that subaccount's callbacks.
2. Create the triggers **in the runtime subaccount**, with callback = `https://<service-domain>/suspend-runtime-subaccount-verified`, method POST.
   - Use the **exact** URL: no query string, no custom domain. The signature covers the URL.
3. **Also** create the same triggers **in the parent**, with callback = the protected Function. If Q-B1 turns out true, they fire even if an attacker deletes the subaccount triggers.
4. V1/V2 below show which of the two actually fires.

Callback URL = the Function URL, method POST. Put each trigger's `UT…` SID into `HCG_BREAKER_TRIGGER_SIDS` and redeploy.

## 3. Test on STAGING (its own subaccount), with no new spend

| # | Test | How | Expected | Cost |
|---|---|---|---|---|
| V1 | Parent trigger sees subaccount usage? (Q-B1) | In the parent, create `totalprice`, Recurring = **alltime**, value **below** the staging subaccount's existing all-time usage, callback = Function. Wait 2–3 min | Function log "suspended …", or nothing (then V1 = no) | £0 (fires on existing usage) |
| V2 | Subaccount trigger → **verified** Function | The same trigger, created in the staging subaccount with callback = `/…-verified` | Function log "suspended". A 403 `bad_signature` means the callback is not signed with the subaccount token (Q-B2): record which token it uses | £0 |
| V2b | Subaccount trigger → protected Function (to document the defect) | Optional: point a second test trigger at the protected Function | Expect 401 | £0 |
| V3 | Suspension effective | Staging subaccount status = suspended. Call the staging number from a phone | Not connected. No charge on HCG's side (confirm on the call log) | caller's own call |
| V4 | Live calls ended | **Needs approval (live call):** start a staging call to the app, then fire the trigger | Function log `ended=1`. The call drops within about 1 min | pennies |
| V5 | Restore | Console: reactivate the staging subaccount; delete the test triggers | Account active; calls work again | £0 |

Only after V1–V5 pass on staging: repeat steps 1–2 for production, with **no test fire on production**. Production's first fire is a real incident.

## 4. When it fires in production
1. **Critical alert.** The trigger's own email/console notification goes to Andrew, plus the Twilio Function log.
2. Every HCG call fails, so callers hear the number as unavailable. The app's WS3 banners must tell customers that protection is **paused**: never show "Protected" while suspended.
3. Investigate:
   - the Control Centre;
   - the Twilio usage and call logs;
   - whether the cause is a runaway (bug) or an attack (compromise → rotate the subaccount token and API keys before reactivating).
4. **Reactivate manually** in the parent console (Subaccounts → the runtime → Activate). The breaker never reactivates by itself.

## 5. Rollback
Delete the triggers, or remove their SIDs from `HCG_BREAKER_TRIGGER_SIDS`. The Function then ignores them (`unknown_trigger`).
