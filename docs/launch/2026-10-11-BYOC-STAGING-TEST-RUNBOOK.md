# Magrathea → Twilio BYOC: staging test runbook (2026-10-11)

**Status:** FOR APPROVAL. Nothing in this runbook has been done. No console, account, Magrathea or Twilio change has been made, nothing was bought, and no call was placed.

**Branch:** `launch/ws6-magrathea-byoc` (code: `docs/launch/2026-10-11-AGENT2-BYOC-REPORT.md`).

**Approval cap:** **£2.00** in total (Twilio + Magrathea), plus the test SIM's own forwarding tariff if S2 is run.

**Who does what:**
- Andrew does every console, Magrathea and handset step.
- Claude reads logs and records the evidence only after each GO.

## 0. Prerequisites (all required)

| # | Item | Why |
|---|---|---|
| P1 | Written answers to **T1, T4, T14, T15, T19** (Twilio) and **M7, M8, M21** (Magrathea) from `PROVIDER-QUESTIONS-DRAFT.md`, or Andrew accepts running without them | T1 = leg stacking; T4 = `<Reject>` £0 on BYOC; T14 = `To`/`From` format; T15 = signing token for a subaccount; T19 = whether numbers must exist in Twilio; M7 = can a DDI target an FQDN (`S:…@<domain>`); M8 = digest auth; M21 = `/number/*` access |
| P2 | Andrew's GO for: (a) creating an isolated Twilio subaccount and BYOC trunk; (b) retargeting the **trial DDI 0330 088 4327** from the E-SIP VM to the trunk; (c) the six attended calls | Each one is an account change or a cost |
| P3 | Staging backend deployed from this branch, with the env in §2. Migration 078 applied to **staging only** (only needed for test S0) | Code under test |
| P4 | The staging handset (iPhone or Motorola) signed in to a **staging** household with a registered app | Delivery target |
| P5 | The E-SIP VM `159.65.27.229` services **stopped**, and Magrathea's written confirmation of the DDI's current target | So the DDI has exactly one target |

## 1. Twilio console (isolated subaccount; Andrew)

Staging shares the production Twilio account. So BYOC goes on a **new, isolated subaccount**, never on the parent account.

1. **Console → Admin → Subaccounts → Create subaccount** named `hcg-byoc-staging`.
   - Record its `AC…` SID and auth token. They go into Railway **staging** only.
2. In the subaccount, turn things off:
   - **Voice → Settings → Geo permissions:** untick **every** country (outbound off).
   - **Messaging → Settings → Geo permissions:** untick every country (no SMS).
   - **Phone Numbers:** buy **none**.
3. **Voice → Manage → IP Access Control Lists → Create** `magrathea-signalling`. Add Magrathea's documented signalling IPs, each as `/32`:
   - `87.238.72.129`, `87.238.72.130`, `87.238.73.129`, `87.238.73.130`, `213.166.3.129`, `213.166.3.130`;
   - plus `87.238.73.155` and `213.166.3.70`, which were seen in the trial INVITEs. Confirm them with Magrathea (M8) first.
   - Media (`213.166.4.128/26`) is not part of the ACL.
4. **Credential List:** create one **only if** Magrathea confirms it can answer a 407 digest challenge (M8).
   - Without one, any Magrathea customer on those shared IPs could reach the domain (BYOC report R3).
   - `/voice` rejects an unknown `To` (unbilled if T4 holds).
5. **Elastic SIP Trunking is NOT used.** Go to **Voice → Manage → BYOC Trunks → Create**:
   - Friendly name `hcg-byoc-staging`.
   - **Voice URL** `https://<staging backend host>/voice`, `HTTP POST`.
   - **Voice Fallback URL** = the existing `<Reject/>` TwiML Bin URL.
   - **Status Callback URL** `https://<staging backend host>/call-status`, `HTTP POST`.
   - **Connection Policy: none.** No outbound route can exist.
   - Record the `BY…` SID.
6. **SIP Domain (termination):** create `hcg-byoc-staging.sip.ie1.twilio.com` (the IE1 region; T18 if unavailable).
   - Attach the ACL from step 3 (and the Credential List from step 4, if any).
   - Bind the domain to the BYOC trunk from step 5.
   - Secure Media: **off** (the Magrathea trial is UDP/RTP only).
7. Number registration: if Twilio's answer to T19 says BYOC numbers must exist as resources, follow it. Otherwise skip.
8. **Usage trigger on the subaccount:** Voice, `usage-category totalprice`, trigger value **$2.00**, recurring daily, callback = the email alert.
   - It only notifies, about once a minute. It does not stop live calls.

## 2. Staging backend environment (Railway staging; Andrew)

```
TWILIO_BYOC_ACCOUNT_SID=<AC… of hcg-byoc-staging>
TWILIO_BYOC_AUTH_TOKEN=<its auth token>
TWILIO_BYOC_TRUNK_SID=<BY… from §1.5>          # documentation only
TWILIO_WEBHOOK_ALLOWED_HOSTS=<staging host, if not APP_URL's host>
# NUMBER_PROVIDER stays UNSET for S1–S6. Set NUMBER_PROVIDER=magrathea only for S0.
```

**Boot check:**
- `check-launch-config` must show no `byoc_twilio_account_pair` finding.
- The startup log must show no `TWILIO WEBHOOK REFUSED` when S1 rings.

**Staging household:**
- Set its `households.twilio_number` to `+443300884327` (the trial DDI). Use **either** an admin SQL update on **staging**, recording the previous value, **or** S0 below.
- Add Andrew's iPhone as a trusted contact in **national** form (`07…`) on one household, and in E.164 on another, to prove S1's matching.

**S0 (optional, needs 078 on staging):**
1. Insert the DDI into inventory: `insert into public.number_inventory (e164_number, channel_limit, notes) values ('+443300884327', 2, 'trial DDI');`
2. Set `NUMBER_PROVIDER=magrathea`.
3. Trigger provisioning for a fresh staging household with a production-provenance test entitlement, through the admin retry.
4. **Expect:** the DDI is assigned, there is no Twilio purchase, and the log shows `NUMBER INVENTORY (magrathea) ASSIGNED`.
5. Then unset `NUMBER_PROVIDER`.

## 3. Magrathea routing (Andrew; ticket LKV-51353-279)

`/number/*` REST returns 401 (M21), so routing is changed **by Magrathea support or the MAGIC portal, not by HCG code**.

1. Ask Magrathea for the DDI's current target and record it (R6).
2. Ask them to set **target 1** of `03300884327` to `S:443300884327@hcg-byoc-staging.sip.ie1.twilio.com` (UDP).
   - If an FQDN target is unsupported (M7), **STOP**. Twilio BYOC identifies the trunk by the termination domain, so an IP-only target cannot work.
3. No target 2 (no failover to a paid leg).
4. Get written confirmation of the change and its time.

## 4. Six attended calls (Andrew places them; each ≤ 60 s)

The trial DDI has a **2-channel** limit. `timeLimit` comes from the Fortress/admission decision (≤ 60 s for the staging test profile; set `SAFETY_MAX_CALL_MINUTES=1` on staging for the window).

| # | Call | Expected app result | Expected Twilio evidence (subaccount) | Proves |
|---|---|---|---|---|
| S1 | Andrew's iPhone dials 0330 088 4327 directly. Answer in the app, talk 30 s | Rings the staging app. The caller matches the trusted contact (national and E.164 rows): "Known contact → bypass AI" | Parent BYOC leg **in the subaccount**, plus a `<Client>` child leg. Log line `INBOUND NUMBERS CANONICALISED` names the fields/forms (e.g. `From: uk_national`). `twilioVerified=true` | Delivery; `To`/`From` format (T14); signature with the subaccount token (T15); latency |
| S2 | Test SIM (O2/VF pay-monthly) with `**21*03300884327#` gets a call from the iPhone. Answer | Rings the app | Is `ForwardedFrom` present on the webhook? Record it (masked) | T13 (Diversion visibility on BYOC) |
| S3 | iPhone with caller ID withheld (`#31#`) | Unknown caller → monitored path (Media Stream via Twilio, unchanged) | `From` = `anonymous` or a withheld form; never trusted | Withheld handling |
| S4 | Temporarily clear the staging household's `twilio_number` (record it), then dial | `<Reject>`; app does not ring | Call `price` = 0 or absent; status `busy`/`failed`; no child leg | T4 (`<Reject>` £0 on BYOC) |
| S5 | Dial; let the app ring 20 s; do not answer | `<Dial timeout>` expires | Parent leg duration and `price` for an unanswered ring | Ringing billed on the parent? (T3) |
| S6 | Dial; answer; caller hangs up after 10 s | Normal | Parent and child `price` / `duration` | Per-second vs per-started-minute billing (T3) |

**Stop rules (any one → abort, restore, suspend):**
- an unexpected leg or price line;
- a call longer than 70 s;
- an INVITE source outside the ACL;
- any outbound attempt;
- the usage trigger firing;
- `webhook_unexpected_account` or `TWILIO WEBHOOK REFUSED` on S1.

## 5. Billing evidence to collect (48 h after the window)

| Leg | Where | Expected (list price; NPC) |
|---|---|---|
| BYOC termination (parent) | Subaccount → Monitor → Calls → each `CA…` → `price`; Usage → `calls-byoc`/`trunking-termination` style categories | $0.0040/min (£0.00302) |
| SIP interface (stacking?) | Same call; any separate SIP usage category | $0 **or** $0.0040/min (T1) |
| Voice SDK child leg | Child `CA…` `price`; usage `calls-client` | $0 (as on hosted numbers) **or** $0.0040/min (T2) |
| Media Stream (S3 only) | usage `calls-media-stream` (name as shown) | $0.0044/min |
| `<Reject>` (S4) | Call `price` | $0 (T4) |
| Magrathea inbound | Magrathea CDR export (M22) / MAGIC balance before and after | £0 |

**Worst case inside the cap:**
- 6 calls × ≤ 2 started minutes × the fully stacked £0.00907/min ≈ **£0.11**, plus S3 monitoring (≤ £0.02).
- If both trial channels were held open for the whole one-hour window at the stacked rate: ≈ **£1.09**.
- **£2 cap.**

## 6. Rollback (same day; Andrew)

1. Ask Magrathea to restore the DDI's recorded target, or remove it (written confirmation).
2. In Twilio, either **suspend** the `hcg-byoc-staging` subaccount (Admin → Subaccounts → Suspend), or delete the BYOC trunk and SIP domain. Close the subaccount after the 48 h billing read.
3. Railway staging: delete `TWILIO_BYOC_ACCOUNT_SID`, `TWILIO_BYOC_AUTH_TOKEN`, `TWILIO_BYOC_TRUNK_SID` and `NUMBER_PROVIDER`, and restore `SAFETY_MAX_CALL_MINUTES`.
4. Staging DB:
   - restore the household's `twilio_number`;
   - if S0 ran, run `update public.number_inventory set status='available', household_id=null where e164_number='+443300884327';`;
   - optionally run `_rollbacks/078_rollback_number_inventory.sql`.
5. Test SIM: `##21#`.

**Code rollback:** none is needed. With no BYOC env and `NUMBER_PROVIDER` unset, the branch behaves exactly like the launch tip. Twilio-hosted webhooks are already E.164, and the normaliser passes them through unchanged.

## 7. Not covered by this test

These require production volume or written answers:
- an account-wide Magrathea channel cap (M5);
- Magrathea free inbound at volume (M2);
- whether rentals count towards the £100 minimum (M1);
- Twilio number-price renewal (T12).
