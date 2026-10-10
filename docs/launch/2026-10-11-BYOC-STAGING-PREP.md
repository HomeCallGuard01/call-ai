# Magrathea → Twilio BYOC: staging validation prep (2026-10-11)

**Status: PREPARATION ONLY.**
- No provider was contacted. No Twilio or Magrathea account, console or API was used. No call was made. Nothing was bought or deployed.
- The scripts are written and unit-tested against a stubbed client (`tests/byoc-setup-script.test.mjs`, 47 checks). **`--apply` has never been run.**
- Branch `launch/ws8-byoc-staging-infra`, from launch tip `af46b8e`.

**Inputs:**
- `research/business-decision-2026-10-10`: `MAGRATHEA-TWILIO-BYOC-INVESTIGATION.md` (§1 config, §7 test) and `PROVIDER-QUESTIONS-DRAFT.md` (T#, M#).
- `docs/launch/2026-10-10-CONTAINMENT-DESIGN-AND-BLOCKERS.md` (P8, C-2).
- The trial evidence in `/Users/ad/call-ai-magrathea-trial` (`sip_identity.py`, `MAGRATHEA-LIVE-CALL-EVIDENCE.md`, `MAGRATHEA-FIRST-LIVE-CALL.md`).
- WS6 env names: `/Users/ad/call-ai-ws6-magrathea-byoc` (`services/telephony/twilioAccounts.js`, `services/config/launchConfig.js`).

**Labels:** **DOC** means an official Twilio doc (URL and modified date in §g). **EVID** means HCG's own trial evidence. **IND** means inferred. **NPC** means it needs provider confirmation.

## 0. What changed versus the investigation (read first)

1. **The app can probably only ring if staging runs entirely in the BYOC subaccount (IND, new question T23).**
   - A Voice SDK access token carries an Account SID (`sub`) and an API key (`iss`). `<Dial><Client>` reaches identities registered under the account that runs the TwiML. So a call arriving on a BYOC trunk in subaccount B is unlikely to ring an app that registered with the shared production account.
   - WS6's two-account mode (`TWILIO_BYOC_ACCOUNT_SID`) therefore covers **webhooks only**.
   - **Recommended: Mode A.** For the test window, the staging server runs on the subaccount:
     - `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are the subaccount's;
     - the subaccount gets its own Voice API key, TwiML App and push credential;
     - the handset signs out and in again.
   - Mode B (two accounts) only proves `<Reject>` and number formats. See §c.
2. **Point Magrathea at the Dublin edge FQDN `hcg-byoc-staging.sip.dublin.twilio.com`.**
   - Twilio's "Sending SIP" page lists localized URIs as **edge locations** (`.sip.dublin.twilio.com`). The BYOC page shows a `.sip.ie1.twilio.com` form, which may imply resources in the IE1 *region* (T18).
   - The Dublin edge keeps the account in US1, where all HCG resources are.
   - The scripts take `--edge` if Twilio says otherwise.
3. **Twilio documents no API to register BYOC phone numbers** (T19).
   - The trunk's `VoiceUrl` handles every called number, so setup step S8 is a no-op. Only the Magrathea target matters.
4. **TwiML Bins have no public API.** The `<Reject/>` fallback bin is a Console step (§b4). Setup refuses any fallback that isn't a `handler.twilio.com/twiml/EH…` URL.
5. **The breaker path has a signature catch.**
   - A Usage Trigger in the subaccount is signed with the **subaccount's** token.
   - Mode A: staging `/webhooks/provider-usage-alert` validates with `TWILIO_AUTH_TOKEN` (= the subaccount's), so it **works** and latches the staging kill switch.
   - The parent-account breaker Function (`352c810`, *protected*) would validate with the **parent's** token, so it would probably reject subaccount triggers.
   - Not needed for this attended test. It is a gap to fix before P6/P7 in production (owner: Claude, code).
6. **Suspension needs parent credentials.** In-progress calls survive it (DOC).
   - Teardown therefore deletes the trunk and domain with the subaccount's credentials.
   - Suspension is a separate step that needs the parent's credentials, ideally done in the Console.

## a. Magrathea request (draft; Andrew sends; reply on LKV-51353-279)

> **Subject:** Re: LKV-51353-279: please route trial DDI 0330 088 4327 to our Twilio SIP endpoint for a short test
>
> Hi Ben,
>
> We'd like to run a short, attended test (6 calls, under an hour) routing our trial number to a third-party SIP platform (Twilio), before deciding on a live account. Could you please:
>
> 1. **Change the target** of **0330 088 4327** from `S:443300884327@159.65.27.229` to:
>    **`S:+443300884327@hcg-byoc-staging.sip.dublin.twilio.com`** (UDP or TCP, port 5060; no TLS for this test).
>    - That hostname resolves to 3–4 Twilio Dublin IPs, currently `54.171.127.192–195` (54.171.127.192/30). Twilio advises sending to the hostname, not the IPs, because there are no static IPs in this region.
>    - **If your platform can only target an IP:** please set targets 1–3 to `S:+443300884327@54.171.127.192`, `…@54.171.127.193` and `…@54.171.127.194`, with your normal 20 s failover. Tell us which you used.
>    - We'd like the Request-URI/`To` user as **`+443300884327`** (E.164). If that isn't possible, `443300884327` as today is fine. Please tell us which will be sent.
> 2. **Source IPs:** confirm the signalling source addresses we should allow-list at Twilio.
>    - We plan to allow your six handbook SIP proxies: `87.238.72.129`, `87.238.72.130`, `87.238.73.129`, `87.238.73.130`, `213.166.3.129`, `213.166.3.130`. We've seen INVITEs from `.72.129`, `.73.129` and `.73.130`.
>    - Do INVITEs ever come from anywhere else (for example the /26 subnets in the handbook)?
>    - Are these addresses shared with other customers' traffic?
>    - Can your platform answer a 407 digest challenge?
> 3. **Channels:**
>    - Please confirm the trial number stays capped at **2 concurrent channels**.
>    - What is the per-number limit on a live account?
>    - Is there, or can there be, an **account-wide** concurrent-call cap we can set?
>    - What does the caller hear when a cap is reached?
> 4. **Trial vs live:**
>    - Is routing a trial number to a third-party SIP platform allowed on the trial account?
>    - If not, what would a live account need (KYC, contract term)?
>    - Does the **£100/month minimum** include number rentals and usage, or is it in addition?
> 5. **Timing:**
>    - Please make the change at a time we agree (we'll be watching). Confirm **in writing** when it is live.
>    - Then confirm again when we ask you to remove it. The rollback target is **no target / deactivated**, not our old server.
>    - Once you confirm the number no longer targets `159.65.27.229`, we'll delete that test server.
> 6. Could you send the CDRs (duration and debit) for the test calls afterwards?
>
> Many thanks, Andrew

**Notes for Andrew:**
- Item 1 is the only change requested. Items 2–4 are M5/M7/M8/M9 from the questions draft; send that draft in the same reply, or this shorter one.
- A **new geographic DDI** works the same way: replace the number in both places. It needs a number order (a purchase, so a separate approval).
- The trial DDI is 03 (national-rate). Some MNOs price forwarding to 03 differently from 01/02 (C6 in the investigation).

## b. Console route (if Andrew prefers the Console to the script)

Do these in order. Items marked ⚙ can instead be done by `twilio-byoc-setup.mjs --apply`.

1. **Create the subaccount.** Console → Admin → Account management → Subaccounts → *Create* → name **`hcg-byoc-staging`**.
   - Record the `AC…` SID.
   - Its auth token is shown under the subaccount's API keys & tokens. Keep it in a password manager and never paste it into a chat.
   - Script alternative: `--step subaccount`. It needs the **parent** token in a shell, so the Console is preferred.
2. **Switch the Console into the subaccount** (account switcher, top left). Everything below is done **inside** it.
3. **Check the guard-rails in the subaccount:**
   - Voice → Settings → **Geo permissions**: every outbound country off, or inheritance from the parent with the parent all-off;
   - Messaging → Geo permissions: UK only or none;
   - no phone numbers;
   - Voice → Settings: the **4-hour maximum call duration** is not raised;
   - auto-recharge is on the parent and shared (DOC: one balance). Confirm it is still OFF.
4. **Create the TwiML Bin.** Runtime → TwiML Bins → *Create* → name `hcg-byoc-reject` → body `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`. Copy its URL (`https://handler.twilio.com/twiml/EH…`).
5. ⚙ **Create the IP ACL.** Voice → Manage → IP access control lists → *Create* `hcg-byoc-staging-magrathea-signalling`. Add the six /32 entries:

   | IP | Evidence | Needs Magrathea confirmation |
   |---|---|---|
   | 87.238.72.129 | handbook + live calls 2, 4 | no |
   | 87.238.73.129 | handbook + live call 1 | no |
   | 87.238.73.130 | handbook + live withheld call | no |
   | 87.238.72.130 | handbook only | **yes** |
   | 213.166.3.129 | handbook only | **yes** |
   | 213.166.3.130 | handbook only | **yes** |

   - The /26 subnets (`87.238.72.128/26`, `87.238.73.128/26`, `87.238.77.128/26`, `213.166.2.128/26`, `213.166.3.128/26`, `213.166.4.128/26`) go in **only if** Magrathea says INVITEs can come from them (`--include-subnets`).
   - Media from `213.166.4.x` is not affected by this ACL.
6. ⚙ **Create the BYOC trunk.** Voice → Manage → BYOC Trunks → *Create* `hcg-byoc-staging-trunk`:
   - A call comes in: Webhook `https://<staging APP_URL>/voice`, POST;
   - Primary handler fails: the TwiML Bin URL from step 4, POST;
   - Call status changes: `https://<staging APP_URL>/call-status`, POST;
   - CNAM lookup off;
   - **Origination Connection Policy: leave empty** (no outbound).
7. ⚙ **Create the SIP domain.** Voice → Manage → SIP domains → *Create* `hcg-byoc-staging.sip.twilio.com`:
   - Voice configuration: attach the **BYOC trunk** (or select this domain as the trunk's *Termination SIP Domain*);
   - Call control → IP access control lists: `hcg-byoc-staging-magrathea-signalling`;
   - no credential list unless Magrathea can answer 407;
   - SIP registration off; emergency calling off; Secure media off.
8. ⚙ **Create the TwiML App** `hcg-byoc-staging-sdk`, with Voice URL `https://<staging APP_URL>/voice-sdk-outbound-not-supported` (POST).
9. **Voice SDK credentials in the subaccount (Console only, because they hold secrets):**
   - API key (Standard) `hcg-byoc-staging-voice`; save the secret once.
   - Push credential (Android FCM v1 service-account JSON, `hcg-byoc-staging-fcm`).
   - An APNs credential only if the iPhone is used.
10. ⚙ **Create the usage triggers** (subaccount; callback `https://<staging APP_URL>/webhooks/provider-usage-alert`, POST):
    - `totalprice` price ≥ **1.00** daily;
    - `totalprice` price ≥ **2.00** monthly;
    - `calls` count ≥ **12** daily.
11. **Verify (read-only), whichever route was used:** `node scripts/byoc/twilio-byoc-verify.mjs --expect-account AC<sub> --production-account AC<parent> --app-url https://<staging> --fallback-url https://handler.twilio.com/twiml/EH…`. Expect all checks to PASS.

**Script route (after GO; dry run first, always):**
```
export TWILIO_BYOC_ACCOUNT_SID=AC<sub>  TWILIO_BYOC_AUTH_TOKEN=<sub token>  PRODUCTION_TWILIO_ACCOUNT_SID=AC<parent>
node scripts/byoc/twilio-byoc-setup.mjs --app-url https://<staging> --fallback-url https://handler.twilio.com/twiml/EH…            # DRY RUN
node scripts/byoc/twilio-byoc-setup.mjs --app-url … --fallback-url … --apply --expect-account AC<sub> --confirm APPLY-BYOC-<last6>
node scripts/byoc/twilio-byoc-verify.mjs  --app-url … --fallback-url … --expect-account AC<sub>
```

**Refusals built into the script:**
- no `--expect-account`;
- the SID equals the production or parent SID;
- the production SID is unknown;
- the credentials don't match;
- a wrong confirmation token;
- Twilio reports a **main** account, a name other than `hcg-byoc-staging`, or a status other than active;
- **any hosted number** in the subaccount;
- non-https URLs, or a `homecallguard.co.uk` or `*.railway.app` host;
- a fallback that isn't a TwiML Bin.

It never prints a token. It is idempotent: it finds each resource by name and corrects drift with an update, never deleting.

## c. Staging server env for the BYOC window

Use the existing `scripts/staging/staging.env.template` and `start-staging-server.sh` unchanged (Supabase staging, Stripe test, `NUMBER_PROVISIONING_MODE=fake`, no `.env`).

The server must run code that includes **WS6** (`launch/ws6-magrathea-byoc`: `ukNumber.toE164` normalisation of `To`/`From`, so `443300884327` and national `07…` callers resolve; `twilioAccounts.js`). Then override:

**Mode A (recommended): the whole staging server runs on the subaccount for the window**
```
TWILIO_ACCOUNT_SID=AC<hcg-byoc-staging>          # webhooks signed + AccountSid checked against this
TWILIO_AUTH_TOKEN=<subaccount auth token>
TWILIO_API_KEY_SID=SK<key in subaccount>          # optional scoped REST key (352c810), else auth token is used
TWILIO_API_KEY_SECRET=<…>
TWILIO_VOICE_API_KEY_SID=SK<hcg-byoc-staging-voice>
TWILIO_VOICE_API_KEY_SECRET=<…>
TWILIO_VOICE_TWIML_APP_SID=AP<hcg-byoc-staging-sdk>
TWILIO_VOICE_PUSH_CREDENTIAL_SID=CR<hcg-byoc-staging-fcm>
# TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS=CR<…>     # only if the iPhone is used
PRODUCTION_TWILIO_ACCOUNT_SID=AC<parent>          # provisioningGuard: proves a dedicated non-production account
TWILIO_BYOC_TRUNK_SID=BY<hcg-byoc-staging-trunk>  # WS6 launchConfig: documentation/rollback record
TWILIO_VOICE_FALLBACK_URL=https://handler.twilio.com/twiml/EH<reject bin>
TWILIO_BYOC_ACCOUNT_SID=                          # LEAVE EMPTY in Mode A (same as primary ⇒ WS6 flags same_as_primary_account)
TWILIO_BYOC_AUTH_TOKEN=
NUMBER_PROVISIONING_MODE=fake                     # unchanged; staging must never buy/release
PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS=UT<daily totalprice 1.00>   # the trigger that latches the staging kill switch
```
- Plus a **staging DB row**: the test household's `twilio_number = +443300884327` (staging household `ffc4cfe1`; a staging write, needs GO). Insert it **after** call S4.
- `NUMBER_PROVIDER` stays unset (default). WS6 forbids `magrathea` in production and allows it in staging; no provisioning happens in fake mode.
- The tester's handset signs out and in on the staging app, so it gets a token from the subaccount.
- **Afterwards, restore** the shared-account values and sign in again.

**Mode B (WS6 two accounts; only if Mode A can't be prepared):** keep the shared `TWILIO_*` values and set `TWILIO_BYOC_ACCOUNT_SID=AC<sub>` and `TWILIO_BYOC_AUTH_TOKEN=<sub token>`.
- `/voice` accepts and verifies the BYOC webhooks.
- `<Dial><Client>` is **expected not to ring** (IND, T23), so only S4 and the `To`/`From` format capture are meaningful.
- The REST client cannot end BYOC calls (WS6's documented limitation).
- The trigger callback would be refused, because `/webhooks/provider-usage-alert` checks only `TWILIO_AUTH_TOKEN`.

**Shell for the scripts only** (not the server): `TWILIO_BYOC_ACCOUNT_SID`, `TWILIO_BYOC_AUTH_TOKEN` and `PRODUCTION_TWILIO_ACCOUNT_SID`. Add `BYOC_PARENT_ACCOUNT_SID` and `BYOC_PARENT_AUTH_TOKEN` only for `--step subaccount|suspend`, and unset them straight after.

## d. Six-call validation script (attended; window ≤ 45 min; £2 cap)

**Preconditions:**
- §b11 verify passes.
- The staging server is START on Mode A and its logs are being watched.
- Magrathea has confirmed the target in writing.
- Staging Fortress profile is small.
- The tester's mobile is a **trusted contact** of the test household. This keeps S1/S5/S6 off Media Streams, so the call legs show cleanly.

**Before S4:** take a usage snapshot:
```
node scripts/byoc/twilio-byoc-verify.mjs --expect-account AC<sub> --calls --since <today>
```
It should be empty, because the subaccount is new.

| # | Call | Expected Twilio Call log (subaccount) | Billing evidence it settles |
|---|---|---|---|
| **S4** (first, before the household row exists) | Tester dials 0330 088 4327 | **1** Call: `direction=inbound`, `to` = `+443300884327` or `443300884327` (record which), `status` = busy/failed/canceled, `duration=0`. **No child** | `price` 0 → `<Reject>` unbilled on BYOC (**T4**); `To` format (**T14/M9**) |
| — | Insert the household row (GO) | — | — |
| **S1** | Tester (trusted) dials the DDI; app answers; talk 30 s; tester hangs up | **2** Calls: parent `inbound` `completed` ≈ 32–35 s; child `outbound-dial`, `to=client:<identity>`, `completed` ≈ 30 s, `parentCallSid` = parent | Parent `price` = BYOC receive only, or + SIP interface; child `price` 0 or $0.004/min; day usage categories (**T1/T2: leg stacking**); post-dial delay by stopwatch (R1) |
| **S6** | Trusted; answered; tester hangs up after 10 s | Parent ≈ 12 s, child ≈ 10 s | Price for 10 s = 1 full minute → per-started-minute; prorated → per-second (**T3**) |
| **S5** | Trusted; app rings 20 s, not answered | Parent ≈ 20–22 s; child `no-answer`, duration 0 | Parent price > 0 → ringing time billed on the BYOC leg (**T3/T5**) |
| **S2** | Forwarded call: Motorola (Lebara; CFU proven to this DDI in Magrathea Test 4) `**21*03300884327#`; iPhone calls the Motorola; app answers 20 s; then `##21#` | Parent `inbound`, `forwardedFrom` populated or empty (evidence prints it masked); child as S1 | `ForwardedFrom` on BYOC (**T13**). Expected empty, because BYOC discards custom headers (DOC) and Diversion mapping is undocumented |
| **S3** | Withheld (`#31#` prefix) from a non-trusted phone; app answers 30 s | Parent `from` = anonymous (record the exact value); child as S1; **Media Stream** usage appears | Withheld handling; Stream billing (`calls-media-stream-minutes`) and OpenAI on the monitored path |

**Evidence collection:**
- **T+1 h and T+48 h:** `twilio-byoc-verify.mjs --calls --since <date> --until <date+2>`. It lists every Call (SID, parent, direction, masked numbers, status, duration, `price`/`priceUnit`) and every non-zero usage category.
- Watch these categories: `calls-inbound`, `calls-sip-inbound`, `programmablevoiceconn-sip-inbound`, `calls-client`, `programmablevoiceconn-clientsdk`, `calls-media-stream-minutes`, `pstnconnectivity-inbound`, and any new BYOC category.
- Also collect the staging server logs for the webhook parameters (field names and forms only), the Magrathea CDRs (M22), and the parent invoice line items at month end.
- **Leg stacking is settled** when S1's parent and child prices plus the day's categories show which of {BYOC, SIP interface, SDK} bill. Because the subaccount is new and isolated, all its usage is attributable to these calls.

**£ bound (stacked worst rate £0.00907/min; monitored +£0.00333 Stream + ~£0.0047 Whisper):**
- **Expected:** 5 answered or ringing calls × ≤ 2 started minutes × £0.00907, plus S3's stream and AI, is about **£0.10**. S4 £0 (T4). Magrathea inbound £0 (EVID, written). No Twilio number rental, since there are no hosted numbers.
- **Hard worst case:** 2 trial channels busy for the whole **45-minute** window, all monitored: Twilio 2 × 45 × £0.0124 = **£1.12**, plus OpenAI 2 × 45 × £0.0047 = **£0.42**, is **£1.54 ≤ £2 cap**.
  - It is bounded by Magrathea's 2-channel cap, `<Dial timeLimit>`, the staging Fortress, and the staging OpenAI project limit.
  - A 60-minute window would be £2.05, so **keep the window at 45 minutes**.
- The usage trigger (daily `totalprice` ≥ £1.00) latches the staging kill switch about 1 minute after the threshold (DOC: evaluated "about once a minute").

**Stop rules.** If any of these happens, **stop calling, ask Magrathea to remove the target, and run teardown (§e)**:
1. any Call or usage line not predicted above (an unexpected leg or category, or a price on S4);
2. any call longer than **70 s** of talk (`timeLimit` not holding);
3. any Call whose `to` is not the trial DDI, or any call outside the attended slots (it means someone else can reach the trunk);
4. any `outbound`/`outbound-api` Call in the subaccount;
5. the subaccount's cumulative `totalprice` ≥ **£1.00** (trigger) or **£2** at any check;
6. a trusted caller treated as unknown (normalisation failure, R4);
7. the 45-minute window expiring.

## e. Rollback

**Order matters: stop inbound first, then delete.**

1. **Re-point the DDI.** Ask Magrathea to set 0330 088 4327 to **no target / deactivated**, and get **written** confirmation. This is the only step that stops new calls reaching Twilio. HCG has no REST access (`/number/*` → 401, M21). Never re-point to `159.65.27.229` unless the E-SIP VM is deliberately kept.
2. **Teardown (subaccount credentials):**
   ```
   node scripts/byoc/twilio-byoc-teardown.mjs                       # DRY RUN
   node scripts/byoc/twilio-byoc-teardown.mjs --apply --expect-account AC<sub> --magrathea-repointed "<date + ticket ref>" --confirm TEARDOWN-BYOC-<last6>
   ```
   - It deletes **only** what setup created, found by exact name: triggers prefixed `hcg-byoc-staging`, the domain-ACL mapping, the domain `hcg-byoc-staging.sip.twilio.com`, the trunk, the ACL and the TwiML App.
   - It refuses without the Magrathea confirmation.
   - The Console equivalent is to delete the same items in reverse order of §b.
3. **Suspend the subaccount.** In the Console (Subaccounts → `hcg-byoc-staging` → Suspend), or `twilio-byoc-teardown.mjs --step suspend --apply --expect-parent AC<parent> --expect-account AC<sub> --confirm SUSPEND-BYOC-<last6>` with the parent token in the shell only for that command.
   - **Live calls do not end on suspension** (DOC). Check the Calls log, and end any in-progress call first (Console → call → Hang up).
   - **Do not close** until the T+48 h evidence and the invoice lines are exported, because closing is irreversible (DOC).
4. **Restore the staging server** to the shared-account env. Remove the household row `+443300884327`. Sign out and in on the handset.
5. **Emergency (live abuse during the window):**
   - First, the staging kill switch (Fortress), which ends live calls via the REST client in Mode A.
   - Then the Magrathea re-point (step 1).
   - Then the trunk's Voice URL to the `<Reject/>` bin: an update in the Console takes effect for new calls at once.

## f. Dependencies and approvals

| # | Item | Owner | Lead time | Blocks |
|---|---|---|---|---|
| 1 | GO for the C-2 BYOC staging test, **£2 cap**, 45-min attended window | **Andrew** | minutes | everything |
| 2 | Send the Magrathea request (§a), plus optional M-questions | **Andrew** (send) / **Magrathea** (reply) | send now; reply 1–3 working days (Ben previously answered within a day) | 9 |
| 3 | Send the Twilio questions T1, T3, T4, T13–T15, T18, T19, plus **new T23**: "Can `<Dial><Client>` on a BYOC call in subaccount B ring an identity whose token was minted with an API key of account A?" | **Andrew** / **Twilio** | 1–5 working days | Not blocking. The test answers T1/T3/T4/T13/T14 empirically; T18/T23 shape Mode A |
| 4 | Create the subaccount `hcg-byoc-staging` (Console §b1) and record its SID | **Andrew** | 5 min | 5–8 |
| 5 | Console in the subaccount: guard-rails (§b3), `<Reject/>` TwiML Bin (§b4), Voice API key and FCM push credential (§b9; needs a fresh Firebase service-account key) | **Andrew** | 20–40 min | 6, 7 |
| 6 | `twilio-byoc-setup.mjs` dry run, then `--apply`, then verify (or Console §b5–b10) | **Claude** after GO (or Andrew) | 10 min | 9 |
| 7 | Staging build including WS6 (normalisation + accounts) on the launch candidate; start Mode A; `check-launch-config` START | **Claude** (needs WS6 committed and its tests green) | 30–60 min | 10 |
| 8 | Staging DB: household row for `+443300884327`, inserted after S4 | **Claude** after GO | 5 min | S1–S3, S5, S6 |
| 9 | Magrathea re-targets the DDI at an agreed time, with written confirmation | **Magrathea** | ~1 working day after the request | 10 |
| 10 | Run S4 → S1 → S6 → S5 → S2 → S3 (Motorola, iPhone, a withheld phone) | **Andrew** dials / **Claude** watches the logs and Call log | 45 min | 11 |
| 11 | Evidence at T+1 h and T+48 h; Magrathea CDRs; a leg-stacking verdict written up | **Claude** (reads) / **Magrathea** (CDRs) | 48 h | the D-R1 decision |
| 12 | Rollback: Magrathea re-point → teardown → suspend → restore staging env | **Magrathea** / **Claude** / **Andrew** (suspend) | ~1 day (Magrathea) + 15 min | — |
| 13 | E-SIP VM teardown (`~/hcg-magrathea-trial/teardown-do.sh`), unblocked by Magrathea confirming the DDI no longer targets `159.65.27.229` (item 9) | **Andrew** GO / **Claude** | 10 min | stops the DigitalOcean spend |
| 14 | Before production P6/P7: the breaker Function must verify triggers signed by the runtime subaccount, not only the parent token (§0.5) | **Claude** (code) / **Andrew** (deploy) | 0.5 day | not this test |

**Critical path:** 1 → 2 → 9, about 1–3 working days, dominated by Magrathea. Items 4–8 (about 1.5 h) run in parallel while waiting.

## g. Sources (Twilio docs read 2026-10-10/11; "modified" = the page's dateModified)

| Topic | URL | Modified |
|---|---|---|
| BYOC guide: trunk, termination domain, ACL/credentials, CIDR ranges, failover, no static IPs in IE1 | https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc | 2026-08-24 |
| ByocTrunk API (`VoiceUrl`, `VoiceFallbackUrl`, `StatusCallbackUrl`, `ConnectionPolicySid`, `CnamLookupEnabled`) | https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc/api/byoctrunk-resource | 2026-06-22 |
| SIP Domain API (`ByocTrunkSid`, `Secure`, `SipRegistration`, `EmergencyCallingEnabled`) | https://www.twilio.com/docs/voice/sip/api/sip-domain-resource | 2026-06-22 |
| SIP IpAddress (`CidrPrefixLength`, ≤ 100 per ACL) | https://www.twilio.com/docs/voice/sip/api/sip-ipaddress-resource | 2026-06-22 |
| Localized edge URIs (`.sip.dublin.twilio.com`); BYOC custom headers discarded | https://www.twilio.com/docs/voice/api/sending-sip | 2026-10-08 |
| Dublin signalling 54.171.127.192/30, ports 5060/5061, media 168.86.128.0/18, RTP 10000–60000 | https://www.twilio.com/docs/sip-trunking/ip-addresses | 2026-03-09 |
| Subaccounts: create/list, suspend/close, in-progress calls don't end, closed is permanent, parent credentials needed | https://www.twilio.com/docs/iam/api/subaccounts | 2026-09-15 |
| Usage Triggers: params, `recurring`, `trigger_by`, about once a minute | https://www.twilio.com/docs/usage/api/usage-trigger | 2026-07-31 |
| Usage categories (no BYOC-specific category listed) | https://www.twilio.com/docs/usage/api/usage-record | 2026-09-08 |
| Webhook signature = HMAC-SHA1 with the account auth token (subaccounts not mentioned) | https://www.twilio.com/docs/usage/webhooks/webhooks-security | 2026-08-13 |
| Voice SDK access token `sub` = Account SID, `iss` = API key (T23 inference) | https://www.twilio.com/docs/voice/sdks | read 2026-10-11 |

## h. Files

- `scripts/byoc/lib/byoc-config.mjs`: names, Magrathea and Twilio IPs (with evidence and confirmation flags), plan, safety checks, redaction.
- `scripts/byoc/lib/byoc-ops.mjs`: idempotent apply, scoped teardown, read-only verify and evidence.
- `scripts/byoc/twilio-byoc-setup.mjs`, `twilio-byoc-teardown.mjs`, `twilio-byoc-verify.mjs`: the CLIs (dry run by default).
- `tests/byoc-setup-script.test.mjs`: 47 checks against a stubbed client.
