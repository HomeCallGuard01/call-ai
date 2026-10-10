# Agent 1: security and financial containment report (2026-10-11)

- **Branch:** `launch/ws1-launch-security`, from `af46b8e`. Local commits only. Nothing pushed, merged or deployed.
- **No production systems touched:** no Twilio, OpenAI, Supabase or Stripe API call, no console change, no live call.
- **Not edited:** `server.js`, `services/telephony/**`, `services/numberProviders/**`, `routes/billing.js`, `mobile/**`, phone utilities.

## 1. Verdict

**RELEASE BLOCKER: Twilio exposure under a full server or credential compromise has no provider-enforced bound.**
- This holds under Level 1 (P1–P7), and under Level 2 (Magrathea channel caps) on its own.
- Every other scenario is bounded:
  - normal operation: by the HCG application;
  - backend down: by Twilio's `<Reject/>` fallback plus `timeLimit` (the latter still undemonstrated);
  - OpenAI: by the project hard limit.
- What closes the blocker is in §4.3.

## 2. What changed (commit `65b75a3`)

| Area | Change | Test |
|---|---|---|
| T1 endpoint audit | New static guard over every **cost-capable** surface:<br>(A) every paid primitive — `calls.create` (none allowed), `calls(sid).update`, `messages.create`, `incomingPhoneNumbers.create`, OpenAI clients and requests, Resend/Supabase mail, Twilio key/account management — may only appear in reviewed modules; a new call site fails.<br>(B) every HTTP route whose handler reaches a cost entry point must be listed with its guard (14 routes). Every Twilio-facing route must be signature-verified. `/media-stream` is token-authorised; stream tokens are issued only in signed `/voice`.<br>(C) outbound structure.<br>(D) OpenAI call sites. | `tests/agent1-cost-surface-guards.test.mjs` (68 checks) |
| T2 credential isolation | `services/config/twilioCredentials.js` (pure; shared with `twilioClient.js`, so the report can't disagree with the client). New `launchConfig` rules:<br>• `twilio_rest_api_key`: warns on an auth-token REST client.<br>• `twilio_parent_declared`: warns if `HCG_TWILIO_PARENT_ACCOUNT_SID` is unset.<br>• Both become **fatal** once `HCG_TWILIO_SUBACCOUNT_REQUIRED=true`.<br>• `twilio_api_key_complete` (fatal): half a key pair silently falls back to the auth token, and a non-`SK` SID is refused.<br>• `twilio_runtime_not_parent` (fatal): `TWILIO_ACCOUNT_SID` equal to the parent, or a malformed parent SID.<br>• `twilio_no_parent_secret_in_runtime` (forbidden): any `*TWILIO_PARENT_*`/`*MASTER_*` token or secret.<br>`TWILIO_AUTH_TOKEN` stays required, because it is the signing token. The env template and its test are updated. | `tests/agent1-launch-config-credentials.test.mjs` (29), `ws1-env-template`, `launch-config-safety` |
| T6 OpenAI | `openai_project_key` (recommended in production): the key must be `sk-proj-`/`sk-svcacct-`, or a legacy key plus `OPENAI_PROJECT_ID=proj_…`. Static checks: paid OpenAI calls exist only in:<br>• `/process`: signed, `aiAuthorized`, and dormant unless `PROCESS_ROUTE_ENABLED`, which is fatal in production;<br>• `transcribeChunk`: media stream only (token plus Fortress);<br>• the health check: free `models.list` only. | as T1/T2 |
| P7 breaker | (1) After suspending, the Function **ends the subaccount's live calls** (in-progress, ringing, queued):<br>• bounded to 200 per invocation, run in parallel;<br>• failures are counted, never thrown;<br>• optional hang-up → suspend → hang-up order.<br>(2) **Signature defect fixed** (found by staging infra): a subaccount-located trigger signs its callback with the subaccount token, and the parent's *protected* Function would 401 it. New public `suspend-runtime-subaccount-verified.js`:<br>• checks `X-Twilio-Signature` itself, constant time, against an allowlist {parent token, runtime-subaccount token};<br>• requires the body's `AccountSid` to match the account whose token signed;<br>• then applies the same trigger allowlist and decision as the protected variant;<br>• 403 on unsigned, forged, tampered, wrong-URL or account-mismatch requests.<br>The protected variant is kept for parent-located triggers. **NEEDS-TWILIO-CONFIRMATION:**<br>• Q-B1: do parent triggers count subaccount usage? The Usage Records API does by default (`IncludeSubaccounts=true`); the trigger docs are silent.<br>• Q-B2: which token signs a subaccount trigger's callback?<br>Staging V1/V2 settle both at £0. | `tests/twilio-usage-breaker.test.mjs` (+16) |
| T4/T5/T8 | Flood, trusted-spoof and outage scenarios priced against the Fortress worst cases (details below). | `tests/agent1-abuse-and-outage-exposure.test.mjs` (22) |
| T7 | Worst-case model `services/containment/worstCaseExposure.js` and `scripts/agent1-worst-case-exposure.js`. | `tests/agent1-worst-case-exposure.test.mjs` (31) |

**Scenarios covered by `agent1-abuse-and-outage-exposure`:**
- One caller redialling one household 50 times: 8 connected, then refused (unbilled) for 15 min.
- 6 simultaneous calls from one caller: 2 live.
- 100 callers to one household: 3 live, so at most £0.74, and never above the £0.85 household ceiling.
- One caller fanning out: 5 households, then refused everywhere.
- 200 callers across 10 households: 30 live, with the cohort bounded by Fortress at ≤ £8.50 fresh.
- Spoofed trusted CLI:
  - it skips monitoring (cheaper per minute);
  - it draws on the capped trusted reserve, which sizes `timeLimit`;
  - the bypass is suspended after 4 calls in 10 min, and per-caller concurrency still applies.
- Fortress unreachable or hanging → refused, even when `bounded` mode is requested in production.
- An "allowed" answer with no time limit → refused.
- New numbers carry the `<Reject/>` fallback, and the fallback warning fires when it is unset.
- No registered app → `<Reject busy/>` before any reservation, greeting or stream.
- Unknown callers are monitored by default.

**Already covered, not duplicated:**
- `twilio-duration-bounds`: every `<Dial>` has a `timeLimit`, no transfer verbs, and all action handlers are terminal.
- `destination-cost-policy`: premium, international and HCG numbers are refused for every paid purpose.
- `telephony-abuse-attacks`: self-loop, two-number loop and multi-household loop → `<Reject>`.
- `fortress-server-death-exposure`: per-household I5 on the real SQL.

**Findings, not fixed because the files belong to other agents:**
- **F-A1 (low):** `services/phone.js` says HCG's own numbers are refused as trusted contacts at creation, but `isValidContactNumber` checks the number class only. No cost results: at call time, an HCG number as caller is rejected before trust or Fortress run (`telephony-abuse-controls` ORDER test). The owner should either fix the comment or add the check.
- **F-A2 (design, cost):** Voice access tokens carry an **outgoing grant** (`voiceAccessToken.js`, `outgoingApplicationSid`). With HCG alive, client-originated calls are rejected. Under compromise this path is uncapped (§4.2). Proposal: incoming-only tokens (needs a device test) and a TwiML App pointing at a `<Reject/>` Bin.
- **F-A3 (international trusted contacts):** allowed by design, as caller-ID matchers only. They are never dialled or messaged: the only `<Dial>` is the household `<Client>`, and there is no `calls.create`.

## 3. Per-customer limits, confirmed

| Limit | Value | Enforced by |
|---|---|---|
| Concurrent calls per household / per caller / global | 3 / 2 / 200 | Abuse layer (`abuseConfig.js`) |
| Repeat-call burst | 8 per 5 min per caller → 15 min cooldown | Abuse layer |
| Fan-out | 5 households per hour per caller → 60 min cooldown | Abuse layer |
| Trusted bypass | suspended after 4 calls per 10 min, or a household flood | Abuse layer |
| Per-call duration | `timeLimit` from headroom; `max_call_seconds` 14,400; monitoring 1,800 s | Fortress + Twilio |
| Daily auto-hold | £5 per household per 24 h | Fortress |
| Global caps (≤ 10 households) | £4/h, £15/day, £40 live worst case, 20 active calls, £2/day unattributed, 10 number purchases/day | Fortress, with a latching breaker that ends calls |

All of these are application controls, and they are lost if the server is compromised.

## 4. Worst-case exposure, ≤ 10 customers (recommended policy)

Produced by `node scripts/agent1-worst-case-exposure.js`, with these rates (£/min):
- **Invoiced:** inbound £0.007558; Media Stream £0.003329.
- **List prices:** SDK £0.00316; BYOC, SIP and SDK on BYOC £0.00302 each.
- **Estimated:** Whisper £0.00474.

| Scenario | £/hour | £/day | One-off / per 4 h wave | Provider-bounded? |
|---|---|---|---|---|
| (a) Normal, Fortress enforcing | 4.00 | 15.00 | live worst case ≤ 40 | No: **application-bounded** |
| (b) Backend down, `<Reject/>` fallback set | 0.00 | 0.00 | tail ≤ 40 (calls already live) | Yes (Reject unanswered; `timeLimit` backstop undemonstrated) |
| (b′) Backend down, no fallback, 1,000 attempts/h | 7.56 | 181.39 | — | **No** (scales with attempts) |
| (c) Server compromised, 10 concurrent | 6.43 | 154.34 | 25.72 | **No** |
| (c) 100 concurrent | 64.31 | 1,543.39 | 257.23 | **No** |
| (c) 1,000 concurrent | 643.08 | 15,433.92 | 2,572.32 | **No**, linear in attacker concurrency |
| (d) P8, 2 ch × 10 numbers: unstacked / +SDK / stacked / stacked+monitored | 3.62 / 7.25 / 10.87 / 20.55 | 86.98 / 173.95 / 260.93 / 493.32 | — | Yes, **Magrathea legs only** |
| (d) P8, 4 ch × 10 numbers | 7.25 / 14.50 / 21.74 / 41.11 | 173.95 / 347.90 / 521.86 / 986.63 | — | Magrathea legs only |
| (d) P8, 10 ch × 10 numbers | 18.12 / 36.24 / 54.36 / 102.77 | 434.88 / 869.76 / 1,304.64 / 2,466.58 | — | Magrathea legs only |
| (d) P8 under compromise (indicative £0.05 per channel-minute: extra streams, recording or transcription per answered channel), 2 / 4 / 10 ch | 60 / 120 / 300 | 1,440 / 2,880 / 7,200 | — | Magrathea legs only |
| (d) P8 with an account-wide cap of 4 channels (M5, unconfirmed), stacked | 2.17 | 52.19 | — | Yes, if Magrathea confirms |
| (e) OpenAI, project hard limit $15/month | ≤ 5.69 | ≤ 12.46 (= month) | — | Yes (HTTP 429; small overshoot) |

### 4.1 Why (c) is unbounded on Level 1
1. **The runtime holds the subaccount auth token.** It must, because it is the webhook signing token, and it is also a full subaccount credential.
2. **An attacker can therefore answer any number of inbound calls,** each lasting up to 4 hours.
3. **Suspension (P7) and a zero balance (P2) do not end calls already live.** This is Twilio-confirmed.
4. **Usage is believed to be booked at call end.** If so, neither the prepaid balance nor a `totalprice` trigger reacts to a wave of calls until those calls finish.
5. **The P7 change helps only after it fires.** The breaker now hangs up live calls once triggered, but firing still depends on booked usage.

### 4.2 Level 2: does Magrathea cap every billable leg? (lead requirement)

| Leg | Channel-capped? | Control that closes it | Blocker |
|---|---|---|---|
| (1) Inbound BYOC leg, Magrathea → Twilio | **Yes**, per number (2/4/10); account-wide only if M5 is confirmed | — | — |
| (2) `<Dial><Client>` child leg and Media Stream(s) | **Yes, through the parent.** They end when the parent ends (Twilio `<Dial>` semantics; not observed on HCG). A compromised server can add up to 4 streams, recording or transcription per channel, a finite multiplier | — | — |
| (3a) Client-originated SDK calls (outgoing grant / TwiML App; stolen token, or self-minted tokens using the Voice API key in the runtime) | **No** | Incoming-only tokens + `<Reject/>` TwiML App. A full subaccount compromise can still bridge client↔client calls; **only Twilio can cap that** | **YES** |
| (3b) Legacy Twilio-owned numbers still in the account (10 today) | **No** | Release them all once households have moved to Magrathea DDIs | **YES** until released |
| (3c) Outbound PSTN (`<Dial><Number>`, REST `calls.create`) | **No.** No code path exists (structural test); geo-limited only | Outbound geo all off including UK, high-risk off, set on the parent. Twilio must confirm the subaccount cannot override (Q-A3) | **YES** until confirmed |
| (3d) SIP interface / SIP Domain, `<Dial><Sip>`, `sip:` REST calls | **No.** No code path exists | Twilio must block it for the subaccount (Q-A3); no documented self-serve control | **YES** until confirmed |
| (3e) Calls continuing after transfer | n/a | HCG never transfers: no `<Refer>`, `<Enqueue>`, `<Conference>` or `<Redirect>` (tests). Magrathea has no REFER | — |
| Number purchases / SMS by a compromised server | prepaid-bounded (discrete requests) | P2, P3, P7 | — |

### 4.3 What closes the blocker (one of these)
1. **Twilio, in writing:**
   - an account or subaccount **concurrency or spend limit they enforce on calls in progress**, or the overrun bound on live calls at zero balance; **and**
   - that parent-set geo and SIP restrictions **cannot be changed by the subaccount** (Q-A3, Q-A4).
2. **Level 2 (P8) plus all of the following:**
   - every Twilio number released;
   - **account-wide** Magrathea channel cap confirmed (M5);
   - incoming-only Voice tokens and a `<Reject/>` TwiML App;
   - outbound geo all off, non-overridable;
   - SIP egress and SIP Domains blocked by Twilio.

   Even then, the client↔client SDK path needs Twilio (point 1).
3. **Andrew explicitly accepts the residual compromise risk for ≤ 10 customers.** In practice it is bounded by detection: Control Centre, Twilio alerts, Twilio fraud monitoring, the P7 hang-up. That is a business decision, not a cap.

## 5. Console steps for Andrew (none executed)
1. **OpenAI (P1):** create a dedicated project "HCG production". Set the project **hard spend limit** (proposal $15/month, sized above genuine cohort demand) and an organisation limit. Create a project key (`sk-proj-…`) and put it in Railway as `OPENAI_API_KEY`.
2. **Twilio parent:**
   - auto-recharge OFF, balance £25 (P2);
   - SMS geo UK only (P3);
   - voice geo all off including UK, high-risk off (P4);
   - 4 h maximum duration (P5).
3. **`<Reject/>` TwiML Bin.** Set it as the **fallback URL on every existing number** and on the TwiML App.
4. **Subaccount migration (P6):** `2026-10-11-TWILIO-SUBACCOUNT-MIGRATION-RUNBOOK.md`.
5. **Usage breaker (P7):** `2026-10-11-USAGE-BREAKER-DEPLOY-RUNBOOK.md`. Deploy both Functions; set `HCG_RUNTIME_SUBACCOUNT_AUTH_TOKEN` in the Functions service; create triggers in the subaccount (→ verified Function) **and** in the parent (→ protected Function). Test on staging first (V1–V5; V1–V3 cost £0).
6. **Send the Twilio questions:** Q-A1…Q-A4 (migration runbook) and Q-B1/Q-B2 (breaker runbook), plus the existing draft (zero-balance overrun, usage booking time, `<Reject>` billed £0).

## 6. Approvals needed
- **A1:** blocker route: §4.3 option 1, 2 or 3.
- **A2:** console steps §5.1–5.3.
- **A3:** subaccount migration window, including asking cohort customers to reopen the app.
- **A4:** breaker trigger values (£20/day, 1,500 inbound min, 60 SMS, 1,500 client min) and the staging tests V1–V5. V4 needs one live call, costing pennies.
- **A5:** F-A2 incoming-only tokens. This needs the mobile/telephony owner and a device test.
- **A6:** sending the Twilio questions.

## 7. Full suite
Inert env, no `STRIPE_SECRET_KEY`. **249 files, 248 passed** (✓10549 ✗1). Only `android-full-screen-intent-permission` fails, the known baseline failure (symlinked `node_modules`). Baseline before this work: 245 files, 244 passed.
