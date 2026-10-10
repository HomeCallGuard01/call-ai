# Twilio runtime subaccount migration: runbook (containment P6)

**Status (2026-10-11):** prepared by Agent 1. **Not executed.** Every step is a console or Railway change that only Andrew performs, and each needs his approval.
**Code it relies on** (branch `launch/ws1-launch-security`):
- `services/twilioClient.js`: the REST client uses `TWILIO_API_KEY_SID/SECRET` on `TWILIO_ACCOUNT_SID` when both are set.
- `services/config/twilioCredentials.js` and the `launchConfig` rules `twilio_rest_api_key`, `twilio_api_key_complete`, `twilio_runtime_not_parent`, `twilio_parent_declared` and `twilio_no_parent_secret_in_runtime`. Tested by `tests/agent1-launch-config-credentials.test.mjs`.

## What this achieves, and what it does not

| | |
|---|---|
| **Achieves** | **Before:** the master (parent) auth token sits in Railway. That one token reaches the whole Twilio account: billing, every number, settings, any future usage breaker and every subaccount. **After:** the backend holds only credentials for the **runtime subaccount**. The parent's credentials stay offline, plus the Twilio Functions service that runs the breaker (P7). |
| **Does NOT achieve** | `TWILIO_AUTH_TOKEN` must stay in Railway, because Twilio signs webhooks with the owning account's token. That token is a **full credential for the runtime subaccount**. A compromised backend can therefore still do anything inside that subaccount: answer calls, create calls, buy numbers, send SMS, and possibly change its own geo permissions (unverified, Twilio question Q-A3). This is why scenario (c) in the Agent 1 report stays a release blocker. |

## Before you start (preconditions)

1. **Approval** for a short production window. Signature validation switches tokens at the same moment the numbers move. Calls in that window get a 403 → Twilio fallback → `<Reject/>`: unbilled, and the caller hears busy. Pick a quiet time; there are ≤ 10 households.
2. **Staging first.** Today staging runs on the production Twilio account (number inventory 2026-09-27). Give staging **its own** subaccount using the same steps, and rehearse there.
3. **Inventory snapshot (read-only):** every number's SID, Voice URL, fallback URL, address and bundle; the TwiML App; the push credentials; existing usage triggers. Run `scripts/production/verify-twilio-config-readonly.mjs` with a restricted read key, or screenshot the console.
4. **Customers:** after the switch, each phone must **re-register** its Voice SDK identity with the new account (step 6). Plan to ask each cohort customer to open the app once.

## Steps (console = Twilio Console logged into the PARENT unless stated)

### 1. Parent-level settings, before the move
1. Billing: **auto-recharge OFF**. Keep the prepaid balance at the approved B (proposal: £25). This is P2.
2. Voice → Settings → **Geo permissions: every country OFF, including the United Kingdom** (HCG makes no outbound PSTN calls). Turn **High-risk special services numbers OFF**. This is P4.
3. Messaging → Settings → **Geo permissions: United Kingdom only** (P3).
4. Voice → Settings: **maximum call duration 4 hours** (P5; confirm it was never raised to 24 h).
5. Write down whether a subaccount can override inherited geo permissions. The console shows an "inherit from parent" setting on the subaccount's own page. **Ask Twilio (Q-A3)** whether the subaccount's own credentials can switch that off.

### 2. Create the runtime subaccount
1. Account → Subaccounts → **Create**: "HCG runtime (production)". Record its SID (`AC…`). This is the new `TWILIO_ACCOUNT_SID`.
2. Open the subaccount and confirm it inherits the voice and SMS geo permissions from step 1. Set inheritance ON if it is offered.
3. Record the subaccount's **auth token**. It becomes the new `TWILIO_AUTH_TOKEN` and is never the parent's.

### 3. Create resources inside the subaccount (switch the console to the subaccount)
1. **REST API key:** Account → API keys → Create, type **Standard**, named "hcg-backend-rest". Record `SK…` and the secret. They become `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`.
   - If **restricted API keys** are offered, prefer one limited to what the backend uses:
     - Calls read/update (Fortress termination, red-line)
     - IncomingPhoneNumbers read/create/update/delete
     - AvailablePhoneNumbers read
     - Messages create/read
     - Usage read, Balance read
   - Leave out Calls **create**, SIP, Applications and Keys.
   - (This does not help against a full compromise, because the auth token is also present; see above.)
2. **Voice SDK API key:** Standard, "hcg-voice-sdk". It becomes `TWILIO_VOICE_API_KEY_SID` / `TWILIO_VOICE_API_KEY_SECRET`.
3. **TwiML Bin** "hcg-reject": body exactly `scripts/production/twiml-bin-reject.xml` (`<Response><Reject/></Response>`). Its URL becomes `TWILIO_VOICE_FALLBACK_URL`.
4. **TwiML App** "hcg-voice-sdk":
   - Voice URL = `https://homecallguard.co.uk/voice-sdk-outbound-not-supported` (constant `<Reject/>`);
   - Voice **fallback** URL = the hcg-reject Bin.
   - It becomes `TWILIO_VOICE_TWIML_APP_SID`. Client-originated calls are never wanted; see Agent 1 report §5, path "client-originated".
5. **Push credentials:**
   - FCM (Android): upload the same FCM service-account JSON used today. It becomes `TWILIO_VOICE_PUSH_CREDENTIAL_SID`.
   - APNs VoIP (iOS): upload the same VoIP certificate or key. It becomes `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS`.
6. **Regulatory:** UK numbers carry an address and possibly a bundle. Check whether the transfer in step 4 needs the address or bundle to exist in the subaccount (Twilio "bundle copies"). If the console blocks the transfer, copy or create them here first. **Unverified.**

### 4. Move the numbers (window starts)
1. Phone Numbers → Manage → Active numbers (parent): for each HCG number → **Transfer to subaccount** → the runtime subaccount. Repeat for every number in the inventory.
2. After each transfer, in the subaccount, confirm on the number:
   - Voice URL = `https://homecallguard.co.uk/voice` (POST);
   - **Fallback URL = the hcg-reject Bin** (POST). This is also checklist C1, and it fixes existing numbers: provisioning sets it only on new purchases.

### 5. Railway (production service), straight after step 4
Set the following, then redeploy or restart:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | subaccount SID |
| `TWILIO_AUTH_TOKEN` | **subaccount** auth token |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | from 3.1 |
| `HCG_TWILIO_PARENT_ACCOUNT_SID` | the **parent** SID (identifier only; enables the master-in-runtime check) |
| `TWILIO_VOICE_API_KEY_SID` / `_SECRET`, `TWILIO_VOICE_TWIML_APP_SID`, `TWILIO_VOICE_PUSH_CREDENTIAL_SID`, `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS` | from 3.2–3.5 |
| `TWILIO_VOICE_FALLBACK_URL` | hcg-reject Bin URL |

- Do **not** set any `*TWILIO_PARENT_*TOKEN/SECRET` or `*TWILIO_MASTER_*` variable. Startup refuses to run if one is present.
- **Staging:** set its `PRODUCTION_TWILIO_ACCOUNT_SID` to the new production **subaccount** SID. Otherwise `provisioningGuard.onDedicatedNonProductionAccount` stops recognising that staging is on a different account.

**Window ends** when `node scripts/check-launch-config.js` (run with the Railway env) shows **0 fatal**. The warnings must no longer list `twilio_rest_api_key` or `twilio_parent_declared`.

### 6. Re-register every device
- Device registrations (bindings) belong to the old account. Each app fetches a fresh token from `/api/v1/voice/token` and registers on launch. **Ask every cohort customer to open the app once.**
- Then confirm in the Control Centre (delivery health / `voice_registered` events) that each household has registered since the switch.
- Until a household has registered again, its calls get `<Reject busy/>` (no registered app). That is unbilled, but the household is **unprotected**.

### 7. Take the master token out of circulation
1. In the **parent**: Account → API keys & tokens → **create a secondary auth token, promote it, then delete the old primary.** Every copy of the old master token (Railway history, laptops, scripts) is now dead.
2. Store the new parent token offline only (password manager). Nothing in Railway needs it.
3. Delete any old parent-level API keys that the backend used.

### 8. Verify (each item PASS / FAIL, recorded)

| # | Check | How | Cost |
|---|---|---|---|
| V1 | Launch config clean | `check-launch-config` on the Railway env: 0 fatal; no credential warnings | £0 |
| V2 | Then make it sticky | Set `HCG_TWILIO_SUBACCOUNT_REQUIRED=true` and redeploy. Missing API key or parent SID is now fatal | £0 |
| V3 | Signatures | Support phone → one HCG number. The call reaches the app (proves the subaccount token validates `/voice`) | pennies (needs approval: live call) |
| V4 | REST via API key | Admin → Fortress overview loads Twilio balance; run the lease-sweeper termination on the V3 call (or hang up from the admin hold) | £0 |
| V5 | Fallback | Stop the staging server, call its number → busy, and no charge on the call log | £0 (staging) |
| V6 | Parent unreachable from the runtime | With the runtime API key, `GET /Accounts/{parent}.json` → 401/403 | £0 |
| V7 | Old token dead | The old master token → 401 | £0 |
| V8 | Usage alerts | The `PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS` triggers now live **in the subaccount**. Their callbacks are signed by the subaccount token, which `/webhooks/provider-usage-alert` validates. Re-create them there and update the SIDs | £0 |

## Rollback
1. Transfer the numbers back to the parent.
2. Restore the previous Railway values. The old master token only works if step 7 has not been done; otherwise use the new parent token, temporarily and with an acknowledged warning.
3. Unset `HCG_TWILIO_SUBACCOUNT_REQUIRED`.
4. Devices re-register again (step 6).

## Questions for Twilio (add to `PROVIDER-QUESTIONS-DRAFT.md`)
- **Q-A1:** Do number transfers to a subaccount need the regulatory bundle or address copied first (UK local)?
- **Q-A2:** Do Voice SDK bindings survive a transfer? (We assume not.)
- **Q-A3:** Can a subaccount's own credentials change inherited voice/SMS geo permissions, create SIP Domains, or dial `sip:` URIs? Can the parent block those for a subaccount?
- **Q-A4:** Can Twilio apply an account- or subaccount-level **concurrent call limit**, inbound and SDK included?
