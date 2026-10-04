# Provider financial containment: final audit (LEVEL 4)

**Date:** 2026-10-04
**Branch:** `research/provider-financial-containment`, based on `integration/launch-fortress-2026-10-03` @ `2011ab6`.
**Supersedes:** the working list in `2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT.md`. That file stays as the record of what was known before this audit.
**Companion:** `2026-10-04-TWILIO_CONTAINMENT_CHECKLIST.md` lists the exact Console steps. They have **not** been executed.

**Scope of this work**
- No provider account was read, changed or contacted.
- No call was placed, no number was bought or released, nothing was deployed.
- Sources: the repository at `2011ab6`, and public official documentation read on 2026-10-04 (URLs in §9).
- Provider documentation changes. Every **UNKNOWN** below means the documentation is silent or contradictory, and Andrew must get a written answer before relying on it.

> **The rule used throughout:** an alert is not a limit, and a dashboard is not a limit. A control counts as a **HARD PROVIDER LIMIT** only if the provider itself refuses the billable activity, whatever HCG code does and whatever HCG's servers do.

---

## 0. Verdict

| Question | Answer |
|---|---|
| Can Twilio, as currently documented, put a hard £ ceiling on HCG's account? | **No.** Twilio states: *"There is no maximum spend limit setting."* It offers alerts (usage triggers, low-balance emails) and one balance-driven suspension. Suspension lets in-progress calls finish, lets queued SMS go out, and can leave the balance negative by an **undocumented** amount. |
| What is the maximum loss HCG can **guarantee** with Twilio today? | **None. It is unbounded.** The backend holds the **master** Auth Token (`services/twilioClient.js:8-10`). With it, anyone can re-enable outbound voice geo permissions through the API, repoint the TwiML App, buy numbers, mint new API keys, and rotate the token silently. The auto-recharge state is unverified. No usage trigger exists. |
| What is the best bound Twilio can offer after the checklist and the architecture changes? | **A conditional bound:** prepaid balance **B** + post-suspension overrun **O** + number rental already committed. **O is not documented.** It becomes a guaranteeable number only if Twilio answers Q1–Q4 in §7 in writing. |
| OpenAI? | **Can be hard-bounded now** (new since July 2026). An organisation hard spend limit and a project hard spend limit, both monthly, return HTTP 429. There is a *"small"* undocumented overshoot. A prepaid balance with auto-reload off is a second stop. Neither is evidenced as configured. |
| Launch gate | **LEVEL 4 stays RED.** No Twilio control is evidenced. No hard ceiling exists until the written answers arrive. HCG must not be described as financially protected against credential compromise. |

---

## 1. HCG's provider cost surfaces (code at `2011ab6`)

Every place HCG causes provider-billed cost or holds a provider credential. "HCG bound" is the application limit that applies when the code is honest and running. None of these limits binds a holder of the credential.

### 1.1 Twilio

| # | Surface | Code | HCG bound (APPLICATION LIMIT) | Unbounded if… |
|---|---|---|---|---|
| T1 | Inbound PSTN leg on HCG numbers (answered calls) | `/voice` → `<Dial><Client>` (`server.js:462-463`) | Fortress reservation; `<Dial timeLimit = min(admission.maxCallSeconds, containment.timeLimitSeconds)>` (`server.js:1203`), max 14 400 s (mig 067 `max_call_seconds` CHECK 60–14400); lease sweeper ends calls (`services/containment/twilioCallControl.js:44`) | the TwiML is produced outside this path (see T9) or the credential is stolen |
| T2 | Voice SDK `<Client>` leg | same `<Dial>` | same timeLimit | — |
| T3 | Media Streams (`<Start><Stream>`) | `server.js:572-574` | monitoring capped at 30 min (`monitoringLimit.js:14`); 200 concurrent streams, 2 per household | — |
| T4 | Calls arriving while HCG is unreachable | number has `voiceUrl` only (`twilioProvisioning.js:59-67`) | **none**: there is no `voiceFallbackUrl` | always. Twilio answers with "an application error has occurred" and bills the connection. Each call is short, but there is no limit on how many calls |
| T5 | Number purchase | `incomingPhoneNumbers.create` (`twilioProvisioning.js:256`) | 5 attempts per household; abuse velocity 10/h and 40/day (**process-local**); Fortress `global_number_purchases_per_day` = 10 (DB); environment guard; adopt-before-buy; UK geographic only, ≤ £1.50 | the credential is stolen |
| T6 | Number rental (recurring) | — | lifecycle quarantine and release (manual confirmation) | numbers are still billed while the account is suspended (Twilio) |
| T7 | SMS warnings | `smsWarning.js:46` via `guardSmsClient` → `smsBudget` → containment | UK mobile only, ≤ £0.05; 3 per household per day and 30/h globally (process-local); 056 claim (5/30/company); Fortress `authorizeSpend('sms')` | the credential is stolen; **also: if the 056 claim throws, the SMS is sent anyway** (`services/usage/smsBudget.js:53-55`). Fortress has already authorised it, so it is still bounded |
| T8 | Outbound PSTN | **none.** There is no `calls.create`, `<Number>`, `<Sip>` or `<Conference>`; the egress guard rewrites these to `<Reject>` (`services/abuse/twimlEgressGuard.js:23-25`) | structural | the credential is stolen (REST `calls.create`, or the TwiML App repointed) |
| T9 | `/process` `<Dial>` with **no timeLimit and no reservation** | `server.js:1577` | dormant: nothing emits `<Gather action=/process>`; signature-guarded | a future change revives it; the call then runs to Twilio's 4 h default |
| T10 | Voice SDK outgoing grant | `services/voiceAccessToken.js:77-81` (`outgoingApplicationSid`, TTL 3600 s) | `/voice` rejects client-originated calls (`server.js:1039-1042`) | the TwiML App Voice URL is changed. It is set in the Console, not in code, and is **unverified** |
| T11 | Usage alert receiver | `/webhooks/provider-usage-alert` (`server.js:1401-1428`) | records an `emergency` intervention. **It does not trip the Fortress breaker or suspend anything** | — |
| T12 | Free reads (`calls.fetch`, `usage.records`, `balance.fetch`, `monitor.alerts`) | various | — | — |

### 1.2 Twilio credentials held by HCG

| Credential | Where | Power |
|---|---|---|
| `TWILIO_ACCOUNT_SID` + **`TWILIO_AUTH_TOKEN` (master, main account)** | the only REST client (`services/twilioClient.js:9`); webhook signature validation (`services/twilioWebhookAuth.js:41-47`) | **Everything.** Buy and release numbers, `calls.create`, change voice geo permissions (API), repoint TwiML Apps and numbers, create Standard/Restricted keys, create and close subaccounts, delete usage triggers, rotate the token with `SuppressEmailNotification` |
| `TWILIO_VOICE_API_KEY_SID/SECRET` (key type unverified; Twilio requires Standard or Main to mint SDK tokens) | `services/voiceAccessToken.js` | A Standard key reaches every resource except Accounts and Keys, including `calls.create`, number purchase, Applications and (UNKNOWN) Dialing Permissions |

There are no subaccounts. Staging and development have bought numbers on the production account (`docs/admin/STAGING_NUMBERS_ON_PRODUCTION_TWILIO.md`).

### 1.3 OpenAI

| Surface | Code | HCG bound |
|---|---|---|
| Whisper `audio.transcriptions.create` (`whisper-1`) per speech segment | `services/liveMonitoring/transcribeChunk.js:57-71` | only while monitoring (30 min per call); 45 requests per household per minute; 2 700 per household per day and 6 000/h (process-local); monitoring £ caps (£1.50/day, £5/period per household, max(£30, 0.3n)/day globally). **No per-request £ authorisation** |
| `chat.completions` `gpt-4o-mini` in `/process` | `server.js:1505` | dormant; `authorizeSpend('ai')`; **no `max_tokens`** |
| Credential | `OPENAI_API_KEY` (`server.js:314`), project key, cannot read costs | — |

There is no Realtime API, no OpenAI TTS and no other AI vendor in the code.

### 1.4 Other metered providers (outside the Twilio/OpenAI scope; listed for completeness)

| Provider | Exposure | Note |
|---|---|---|
| Resend (alert emails, allowance emails off by default) | per-email plan overage | alerts throttled to 1 per type per 30 min (process-local) |
| Supabase (auth emails) | SMTP provider limits | the existing doc's item 13 remains open |
| Stripe / RevenueCat | per-transaction fees | bounded by sales |
| Railway (hosting) | usage-billed compute | **not audited here.** Railway's own usage limits, if configured, would take HCG offline. That is safe only once T4 (the fallback) is fixed |

---

## 2. Twilio controls, classified

| # | Control | Classification | What it really does | Can a stolen credential undo it? |
|---|---|---|---|---|
| 1 | Account spend limit / hard cap | **NOT AVAILABLE** | *"There is no maximum spend limit setting."* | — |
| 2 | Prepaid balance reaching zero → suspension | **HARD PROVIDER LIMIT, leaky** | Blocks new usage, including inbound calls (error 10003) and API requests. **In-progress calls continue and the balance goes negative.** Already-sent SMS process. Charges can be delayed. The Fraud Response Guide says Twilio *"does not often suspend right at zero balance"* → the trigger point is **UNKNOWN** | Only by adding funds (Console or card). Auto-recharge appears to be Console-only (UNKNOWN via API) |
| 3 | Auto-recharge | removes control 2 | Refills up to the configured amount (old docs: $10 minimum, $2 000 maximum per refill). No documented limit on refills per day | Probably Console-only (UNKNOWN). **Must be OFF.** It cannot be disabled on accounts with a support plan or short codes |
| 4 | Invoiced (post-pay) billing | removes control 2 | Needs a $12k/yr commitment; *"do not carry a balance"* | — |
| 5 | Low-balance email | **ALERT ONLY** | $5 default, configurable | — |
| 6 | Usage Triggers (`totalprice`, `calls-outbound`, `phonenumbers`, …) | **ALERT ONLY** | Evaluated *"about once a minute"*; fire once per period; retried 3× on 5xx; data lag unspecified; `calls` excludes Client/SIP; `totalprice` ≠ the sum of categories | **Yes.** Any credential that can reach Usage can delete them (UNKNOWN for Standard keys, likely yes) |
| 7 | Trigger → webhook → suspend **subaccount** (Twilio's documented circuit breaker) | **APPLICATION LIMIT on a provider action** | Turns an alert into a stop, after latency of about 1 min plus data lag plus webhook time. **In-progress calls are not ended by suspension**; the webhook must also complete them | Depends on where the triggers and the suspending credential live (§5) |
| 8 | Main account suspension via API | **NOT AVAILABLE** | Main can be suspended only by Support, or closed irreversibly in the Console | — |
| 9 | Subaccounts | isolation of **credentials and numbers only** | *"One Twilio balance for all subaccounts."* No per-subaccount spend limit (**NOT AVAILABLE**). Parent can suspend or close a subaccount. Subaccount credentials cannot reach the parent | Subaccount credentials can suspend their own subaccount. Whether they can **reactivate** it, or change their own geo inheritance, is **UNKNOWN** |
| 10 | Voice geo permissions (per country; low-risk / high-risk special services / high-risk toll fraud) | **HARD PROVIDER LIMIT on outbound** | Blocks REST `calls.create` (21215), `<Dial>` (13227) and SIP trunking (32205). Outbound only; does nothing for inbound or Streams. Special-services lists carry *"no guarantee for … completeness"*. Voice SDK `<Dial><Number>` is covered by inference (it is a `<Dial>` PSTN leg) | **Yes, via the API** (`voice.twilio.com/v1/DialingPermissions/BulkCountryUpdates`), by the master token, Main keys, and probably Standard keys. **Not** by Restricted keys (no such permission exists). Changes appear in Monitor Events (detect only) |
| 11 | Twilio's own blocked-prefix list | **HARD PROVIDER LIMIT** | Not user-overridable | No |
| 12 | SMS (Messaging) geo permissions | **HARD PROVIDER LIMIT, API-proof** | *"can not be changed programmatically via the API for security reasons."* Console only, Owner/Admin. UK-domestic SMS abuse is still possible within the balance | **No** (only a Console login, which is 2FA-protected) |
| 13 | SMS Pumping Protection | HARD but probabilistic | Temporary blocks; bypassable per message with `RiskCheck=disable` | **Yes** (per message) |
| 14 | Outbound calls per second (1 CPS default) | **HARD rate limit, not a spend limit** | Concurrency is unlimited, so about 3 600 new outbound calls/h | No (raised by Twilio on request) |
| 15 | Per-call maximum duration | **HARD PROVIDER LIMIT: 4 h** | Default and maximum unless the "24-Hour Maximum Call Duration" setting is enabled | Setting is in the Console; whether the API can change it is **UNKNOWN** |
| 16 | `<Dial timeLimit>` | **HARD PROVIDER LIMIT** once emitted (Twilio ends the leg) | HCG computes it (T1) | TwiML authored by a thief has none |
| 17 | Voice fallback URL → static TwiML Bin `<Reject/>` | **HARD PROVIDER behaviour** once configured | Calls during an HCG outage are rejected without being answered, so they are not billed (the `<Reject>` billing rule) | Yes (`incomingPhoneNumbers.update`) with the master token or a Standard key; not with a Restricted key lacking `active-numbers/update` |
| 18 | Restricted API keys | **HARD, credential-scoped** | Allow-list; calls read/update without `calls/create`; no `phone-numbers/active-numbers/create`; no Dialing Permissions; TwiML Apps **read only**. **Public Beta** (Sep 2024); GA status **UNKNOWN**. **Cannot mint Voice SDK tokens** | — |
| 19 | Standard API keys | partial | No Accounts or Keys access. Everything else (calls, numbers, apps, probably geo) is allowed | — |
| 20 | Auth Token rotation (secondary → promote) | operational | Validate webhooks against both tokens around promotion. **A thief can rotate silently** (`SuppressEmailNotification`) | — |
| 21 | Webhook SharedKeys (sign webhooks without the Auth Token) | **UNKNOWN** | Public Beta (page modified 2 Oct 2026); which products it covers (Voice? Media Streams?) is undocumented | — |
| 22 | Public Key Client Validation (makes the Auth Token invalid for REST) | **NOT AVAILABLE** on HCG's plan | Enterprise/Security Edition only | — |
| 23 | REST API IP allowlist | **NOT AVAILABLE** | — | — |
| 24 | Console 2FA | mandatory (Console only) | Does not affect API credentials | — |
| 25 | Number-purchase restriction (account level) | **NOT AVAILABLE** (no documented count limit). The UK regulatory bundle does not slow a thief, because the existing approved bundle is reusable | — | — |
| 26 | Usage Records / Call `price` / balance API | **visibility only** | No latency SLA; `price` is populated after completion and covers connectivity only (Streams excluded) | — |
| 27 | Organizations | **NOT AVAILABLE** for spend | *"Billing is independent of the organization."* | — |
| 28 | Twilio fraud monitoring and suspension | **discretionary** | *"may suspend"*; *"no automated system can catch everything"* | — |
| 29 | Liability for fraudulent usage | **customer pays** | ToS §2.2/§2.3/§3.3 (16 Jul 2026): solely responsible for all use; fees non-refundable; no fraud-refund policy documented | — |

**There are only three provider-enforced stops that a stolen API credential cannot loosen:** SMS geo permissions (12), Twilio's blocked prefixes (11), and the balance stop *if* auto-recharge is Console-only (2+3, UNKNOWN). Voice geo (10), fallback URLs (17), TwiML App URLs and usage triggers can all be undone through the API by the credential HCG's backend holds today.

---

## 3. OpenAI controls, classified

| Control | Classification | Note |
|---|---|---|
| Organisation hard spend limit ("Enforce a hard limit") | **HARD PROVIDER LIMIT** | 429 `organization_spend_limit_exceeded`. **Monthly only.** *"Recorded spend can slightly exceed"*; the overshoot is not bounded. Shipped July 2026 |
| Project hard spend limit | **HARD PROVIDER LIMIT** | 429 `project_spend_limit_exceeded`; same caveats |
| Spend alerts / legacy soft "budget" | **ALERT ONLY** | Traffic continues. `PROVIDER_SPEND_PROTECTION.md` control #5 ("OpenAI budget stops requests at the limit") is true **only** when hard enforcement is on |
| Prepaid balance at zero | **HARD PROVIDER LIMIT, leaky** | `credit_balance_exhausted`; *"Do not rely on the prepaid balance as an instantaneous spending cutoff"*; the balance can go negative |
| Auto-reload | removes the balance stop | **On by default at setup.** A monthly reload limit caps purchases, not usage |
| Tier monthly usage limit | HARD, but **OpenAI-controlled** | Rises automatically; not HCG's control |
| Project rate limits (RPM/RPD/TPM, audio MB/min) | HARD on rate, not spend | Owner-only |
| Daily/hourly spend limit | **NOT AVAILABLE** | — |
| Project-scoped keys, restricted permissions, max key lifetime, IP allowlist | HARD, credential-scoped | A project key cannot change spend limits (those are Admin API or Owner only) |
| Admin API key | — | Can **remove** spend limits. Must never be on a runtime server |
| Usage / Costs API | visibility only | Admin key; costs at 1-day granularity; latency undocumented |
| Leaked-key auto-disable | best effort | Keys found publicly are disabled; charges remain the customer's |

**What OpenAI exposure can be guaranteed:** `min(project hard limit, org hard limit)` per calendar month plus an undocumented "slight" overshoot, provided that:
1. Both hard limits are evidenced as `enforcement.status = enforcing`.
2. Auto-reload is off, or capped with a monthly reload limit.
3. No Admin key is held by HCG's runtime.

A stolen project key cannot raise the limit.

**Product consequence:** when the limit is hit, transcription returns 429 and monitoring goes blind. Calls are still delivered (the app fails open without transcription). Andrew must decide the limit knowing that.

---

## 4. Maximum exposure, scenario by scenario

Notation:
- **B** = prepaid Twilio balance.
- **O** = post-suspension overrun (in-progress calls plus delayed charges).
- **R** = monthly rental of numbers held.
- Public list prices are in USD (twilio.com/en-us/voice/pricing/gb). The HCG account bills in GBP.

Relevant rates:

| Rate | USD |
|---|---|
| Inbound local | $0.0100/min |
| Client | $0.0040/min |
| Streams | $0.0044/min |
| UK premium | $1.0479/min |
| UK personal | $0.5577/min |
| Local number rental | $3.50/month |

| Threat | Today (unverified config) | After the Console checklist only (master token still in the backend) | After the checklist + §5 architecture + written answers |
|---|---|---|---|
| HCG application compromised / env vars stolen (= master token) | **Unbounded** | **Unbounded.** The thief re-enables voice geo via the API, places premium/IRSF calls at 1 CPS (no concurrency cap); each runs up to 4 h. If voice charges post only at call end (**UNKNOWN**), the balance falls only when calls finish, so suspension comes late | Thief gets **subaccount** credentials only. Bound = B + O + R, **if** Q1–Q4 are answered favourably. Otherwise still not guaranteeable |
| Twilio master credential stolen from elsewhere | Unbounded | Unbounded, except the balance stop if auto-recharge is OFF and Console-only. O is unknown | The master token is offline (password manager / hardware). Theft then requires Console + 2FA compromise. Bound = B + O, not otherwise guaranteeable |
| Routing loop | No PSTN leg exists (T8), so no loop **cost** on Twilio | same | same |
| Mass number purchases | Fortress 10/day (app). Thief: unbounded count; each purchase debits B (first-month charge assumed at purchase: **UNKNOWN**); rental continues during suspension | ≈ B / rental-per-number numbers, then suspension; R accrues until released | Backend key has no `active-numbers/create` (Restricted). Purchase needs an offline credential. **Effectively closed** |
| Premium / international voice | No PSTN leg; voice geo "all off" (memory 2026-09-30, **unverified**); API-reversible | Geo off (evidenced) but API-reversible | Restricted backend key cannot call or change geo. The SDK Standard key **can** (§5 residual) |
| SMS abuse | App caps; SMS geo **unverified** | GB only (**API-proof**). UK SMS bounded by B. Throughput is per number | same, plus the backend key may keep `messages/create` (needed); balance-bound |
| API abuse (inbound flood to HCG numbers) | Fortress rejects (`<Reject>` is unbilled); answered calls bounded by timeLimit | same | same |
| Provider configuration error (e.g. 24 h duration on, fallback mis-set) | per-call ≤ 4 h (24 h if enabled) | 4 h, evidenced | same |
| HCG servers fail | **Every inbound call answered with an error and billed** (no fallback); in-progress calls run to their `timeLimit` (Twilio-enforced) | Fallback `<Reject>` Bin → unbilled; in-progress ≤ timeLimit | same |
| OpenAI key stolen / runaway transcription | No hard limit evidenced: unbounded up to tier/balance (auto-reload default ON) | Org + project hard limits: monthly limit + slight overshoot | same |

**Worked illustration of why O matters (inference, not a Twilio statement).**
- A thief with the master token re-enables GB high-risk special services and starts one premium call per second.
- After 10 minutes, 600 calls are live. If each runs 4 h at $1.0479/min, the committed cost is about **600 × 240 × $1.05 ≈ $151 000**.
- If Twilio debits voice only at call completion, a £50 balance does not reach zero until the first of those calls ends.
- Suspension stops new calls, not those 600. Twilio's fraud systems *may* intervene; nothing obliges them to.

This is the reason the balance alone is not a guarantee, and Q1–Q3 are the decisive questions.

---

## 5. Target architecture for the best achievable Twilio containment (proposal; nothing implemented)

1. **Production subaccount** (and a separate staging subaccount). Move HCG numbers into it, using main credentials, offline, in a planned window: number configuration must be re-checked after transfer.
2. **The main Auth Token and Main keys are kept offline.** They are never in Railway or any `.env`. Rotate the main token once production runs on subaccount credentials.
3. **Backend credentials inside the subaccount:**
   - **(a) Restricted key** for REST: `voice/calls/read|update`, `messaging/messages/create`, `phone-numbers/active-numbers/read|list` and (lifecycle) `delete`, `usage records/read`. It has **no** `calls/create` and **no** `active-numbers/create`. Number purchase moves to an offline, operator-run path, or a separately held key (decision).
   - **(b) Standard key** used **only** to sign Voice SDK tokens. It is unavoidable: Restricted keys cannot mint them. This is the main residual: it can still call REST.
   - **(c) Subaccount Auth Token** for webhook signature validation, until Webhook SharedKeys are confirmed for Voice and Streams. This is a second residual: it is full subaccount power.
4. **Voice geo inheritance from the main account ON**, with the main account set to all-off. Whether subaccount credentials can switch inheritance off is **Q5**. If they can, the residual in (b) and (c) includes premium dialling until suspension.
5. **Independent circuit breaker:**
   - Usage triggers are created on the subaccount: `calls-outbound` count ≥ 1 daily (HCG never dials out, so any outbound call is an incident), `totalprice` daily and monthly, and `phonenumbers` count.
   - They call back a **separate minimal service**, not the HCG backend. That service holds only what it needs to set the subaccount `Status=suspended` and complete in-progress calls.
   - Twilio emails the owner as well.
   - Whether triggers on the *main* account see subaccount usage, so that they cannot be deleted by subaccount credentials, is **Q6**.
6. **Prepaid balance with auto-recharge OFF**, topped up manually to a deliberately small B (for example 2–3 weeks of expected spend). Number rental continues during suspension, so watch R.
7. **24-hour duration OFF; fallback `<Reject/>` Bin on every number; TwiML App Voice URL = HCG `/voice`.** Evidence each, dated.
8. **The application already enforces levels 1–3** (Fortress). This architecture turns LEVEL 4 from "unbounded" into "B + O + R, with O pending written answers".

**Code changes this would later require** (not done here; listed for the integration owner):
- Use API-key auth in `services/twilioClient.js`.
- Set `voiceFallbackUrl` (and `statusCallback`) in `buildIncomingPhoneNumberParams`.
- Have the provider-usage-alert receiver also trip the Fortress kill switch (T11). That is an application stop, still worth having.
- Give `/process` a timeLimit, or remove it (T9).
- Make the egress guard require `timeLimit` on every `<Dial>`.
- Fail closed when the 056 SMS claim throws (T7).
- Move the process-local counters (purchase velocity, SMS, transcription) to the DB, or accept the Fortress DB caps as authoritative.

---

## 6. Better containment elsewhere? (from existing research only; no contact made)

| Provider | What existing research and documentation show | Containment value vs Twilio |
|---|---|---|
| **Magrathea** (`research/carrier-routing-v2` sources) | Outbound is **prepaid only** (£250 minimum top-up); restricted outbound tariffs (≤3p/min or ≤15p/min destinations); 10 concurrent channels per number; inbound to geographic numbers free; PSTN forwarding needs a chargeable account with minutes "deducted in real-time from a prepaid account" | **Better on paper:** real-time prepaid deduction plus tariff-level destination restriction plus a per-number channel cap. Needs confirmation of the overrun behaviour and whether the restrictions are API-changeable |
| **Telnyx** | Channel billing caps inbound concurrency (calls above the count rejected "User Busy"). Outbound Voice Profiles have `daily_spend_limit` (+ `_enabled`), `max_destination_rate` and `concurrent_call_limit` (API reference, 2026-10-04 search) | **Better primitives** (a per-profile daily spend stop on outbound; a destination price ceiling). They are API-settable, so a stolen API key can raise them. They cover outbound, not inbound/Streams. Whether the spend limit stops in-progress calls is unknown |
| **aql** | Only the unanswered questionnaire (per-SIM credit limits, default bars). **No email sent** (per instruction) | UNKNOWN |

Conclusion: an alternative carrier could offer better **outbound** containment primitives. None documented removes the core problem: a credential that can change the limit is a credential that can remove it. A move would be a post-launch decision, not a LEVEL 4 fix.

---

## 7. Questions that need Twilio's written confirmation (drafted; NOT sent)

| # | Question | Why it matters |
|---|---|---|
| Q1 | On a pay-as-you-go account with auto-recharge off, at exactly what balance is the project suspended (at $0, or at a negative threshold; your Fraud Response Guide says you "do not often suspend right at zero balance")? What is the largest negative balance the account can reach? | O |
| Q2 | Are voice call charges debited from the balance in real time during a call, or only when the call completes? Are in-progress calls ever ended when the balance reaches the suspension point? | O, the §4 illustration |
| Q3 | Can any account-level hard spending limit, credit limit, concurrent-call limit or outbound-call block be applied to our account or a subaccount, by Support if not self-serve? | A real ceiling |
| Q4 | Can auto-recharge, the 24-Hour Maximum Call Duration setting, or the account balance/payment method be changed through any REST API, or only in the Console? | Whether a stolen API credential can remove the balance stop |
| Q5 | Can a subaccount's own Auth Token or Standard API key (a) change its `DialingPermissionsInheritance`, (b) call `BulkCountryUpdates`, (c) reactivate the subaccount after it is suspended? | The subaccount isolation design |
| Q6 | Do usage triggers created on the main account evaluate usage of its subaccounts? | Triggers that subaccount credentials cannot delete |
| Q7 | When a subaccount is suspended, are inbound calls to its numbers rejected without charge (error 10003), and are queued SMS still sent? | The circuit breaker's effect |
| Q8 | Are Restricted API Keys generally available, or still Public Beta? Are there plans to let them mint Voice SDK access tokens? | Removing the Standard-key residual |
| Q9 | Do Webhook SharedKeys cover Programmable Voice webhooks and Media Streams WebSocket signatures? | Removing the Auth Token from the backend |
| Q10 | Do voice geographic permissions apply to `<Dial><Number>` legs initiated from a Voice SDK client via a TwiML App? Does the GB high-risk special-services group cover all of 09x, 087x, 084x, 070, 076 and 118xxx? | Completeness of the outbound block |
| Q11 | Is an inbound call that receives `<Reject>` from a voice fallback URL (TwiML Bin) billed? | The T4 fix |
| Q12 | What is Twilio's policy on charges caused by stolen credentials or toll fraud: any credit or cap once reported? | Residual liability |

(This replaces the six questions in the earlier doc; Q1–Q6 there map to Q1/Q3, Q2-related, Q7, Q8, Q10 and §2 row 16 here.)

---

## 8. Pass criterion for LEVEL 4 (unchanged in spirit; made exact)

LEVEL 4 may move from RED to AMBER when all of the following hold:
1. Every item in `2026-10-04-TWILIO_CONTAINMENT_CHECKLIST.md` §A–§F has dated evidence (screenshot or export) committed under `docs/security/evidence/`, with no secrets.
2. OpenAI org and project hard limits are evidenced as enforcing, and auto-reload is evidenced off or capped.
3. Written Twilio answers to Q1–Q4 exist.
4. Andrew records the numeric residual he accepts: "maximum loss with a stolen backend credential = £B + £O + £R; with a stolen master credential = …".

LEVEL 4 may move to GREEN only after the §5 architecture (subaccount, master token offline, Restricted key, independent breaker) is in place and drilled on staging, including a suspension drill.

---

## 9. Sources (official; read 2026-10-04)

**Twilio, help center** (support.twilio.com / help.twilio.com articles):
- 49507358452635 (payment types, "no maximum spend limit setting")
- 223183248 (balance reaches zero)
- 223135487 (billing; in-progress calls, negative balance, delayed charges)
- 223183088 (numbers billed while suspended)
- 223135647 (invoicing)
- 55716599619227 (low-balance alerts)
- 55716593773979, 55716606268699, 223135607 (auto-recharge)
- 55716593836315 (usage notifications)
- 223132387 (usage-trigger circuit breaker)
- 223180228 (voice geo permissions; messaging geo not API-changeable)
- 48142236921371 (special-services groups)
- 40868960307995 (CPS)
- 223132607, 223132427 (application error billed)
- 4403990577435 (UK surcharges)

**Twilio, docs:**
- /docs/usage/api/usage-trigger
- /docs/usage/api/usage-record
- /docs/iam/api/subaccounts
- /docs/iam/api/account
- /docs/iam/api-keys
- /docs/iam/api-keys/restricted-api-keys
- /docs/iam/api-keys/key-resource-v1
- Restricted-key permission PDFs (Voice, Numbers, Messaging)
- /docs/iam/api/authtoken
- /docs/iam/api/secondary_authtoken
- /docs/usage/security
- /docs/usage/webhooks/webhook-shared-keys
- /docs/usage/webhooks/webhooks-connection-overrides
- /docs/iam/pkcv
- /docs/iam/access-tokens
- /docs/voice/sdks
- /docs/voice/twiml/dial
- /docs/voice/twiml/stream
- /docs/voice/api/call-resource
- /docs/phone-numbers/api/incomingphonenumber-resource
- /docs/sip-trunking/voice-dialing-geographic-permissions
- /docs/voice/api/dialingpermissions-bulkcountryupdate-resource
- /docs/voice/api/dialingpermissions-settings-resource
- /docs/messaging/guides/sms-geo-permissions
- /docs/messaging/features/sms-pumping-protection-programmable-messaging
- /docs/usage/fraud-response-guide (+ /contain, /engage)
- /docs/api/errors/10003, 11200, 30450
- /docs/iam/organizations
- /docs/glossary/what-is-toll-fraud

**Twilio, other:**
- twilio.com/en-us/legal/tos (16 Jul 2026)
- twilio.com/en-us/voice/pricing/gb
- changelogs: UK regulatory bundles (May 2024), Restricted keys (Sep 2024), configurable call limits (Aug 2021)

**OpenAI:**
- developers.openai.com/api/docs/guides/spend-limits
- …/guides/admin-apis
- …/guides/rate-limits
- …/guides/rbac
- …/guides/realtime-conversations
- Admin API reference (spend_limit, rate_limits, usage, costs)
- help.openai.com 8264644 (prepaid billing), 9186755 (projects; contains the legacy soft-limit wording), 6614457 (limit errors), 8867743 (key permissions), 5112595 (key safety), 8304786 (leaked keys)
- community.openai.com announcement, 23 Jul 2026 (hard spend limits)

**Telnyx:** developers.telnyx.com API reference for outbound voice profiles (`daily_spend_limit`, `max_destination_rate`, `concurrent_call_limit`); support articles 1130678 and 8428806 (channel billing), as recorded on `research/carrier-routing-v2`.

**Fetch limitations:**
- help.twilio.com and help.openai.com sit behind Cloudflare, so they were read through Zendesk JSON or a text renderer of the same official article.
- The Twilio GB high-risk prefix list needs a login and was not read.
- Some Twilio docs pages were read as summaries; quotes marked as such in the research notes are near-verbatim.
