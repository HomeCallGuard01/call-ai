# Magrathea → Twilio BYOC: inbound investigation (2026-10-10)

**Status:** research and drafting only.
- No provider was contacted. No Twilio, Magrathea, Supabase or HCG API was called. No call was made and nothing was configured.
- Code was read in this worktree (`18a8903`).
- Twilio documentation was read on **2026-10-10**.

**Labels:**
- **CONFIRMED:** an official doc, or HCG's own test or invoice.
- **INDICATIVE:** inferred, third-party, or an older document.
- **NPC:** needs provider confirmation. Each NPC item maps to a question in `PROVIDER-QUESTIONS-DRAFT.md`, shown as T# (Twilio) or M# (Magrathea).

**FX:** $1 = £0.756 (implied by HCG's invoices).

## 0. Summary

1. **BYOC inbound works mechanically for HCG with no app change** (CONFIRMED in outline). The flow is: carrier → Twilio *Termination SIP Domain* on a BYOC trunk (IP ACL and/or credentials) → the trunk's **`VoiceUrl`** webhook → TwiML. So the existing `/voice` → `<Dial><Client>` path can be reused, and the trunk, not the number, holds the webhook.
2. **New fact: the custom SIP headers on BYOC INVITEs are discarded** and never reach the webhook (CONFIRMED, Twilio "Sending SIP" doc). No Twilio doc says that `Diversion` maps to `ForwardedFrom` on BYOC (NPC, T13).
   - **So pure BYOC very probably cannot give HCG the forwarding line.** Pooling, and passive proof that a customer has forwarded, need an HCG SIP edge.
   - An edge → Twilio **SIP Domain** path *does* pass `X-` headers as `SipHeader_X-…` (CONFIRMED). The edge can therefore relay `Diversion` as an `X-` header.
3. **Price as published** (CONFIRMED, GB page "current as of August 2026"):
   - BYOC receive $0.0040, SIP interface $0.0040, browser/app $0.0040, Media Streams $0.0044, local number **$3.50/month**.
   - **Stacking is not stated anywhere** (NPC, T1). Per minute: BYOC only £0.00302; plus SDK £0.00605; all three £0.00907. Today's hosted-number rate is £0.00756.
4. **Spend controls are unchanged from today:**
   - there is no hard cap;
   - a UsageTrigger is evaluated "about once a minute" and only notifies;
   - a suspended subaccount's in-progress calls "will not end";
   - at zero balance, live calls finish and the balance goes negative.

   All four are CONFIRMED. **The only provider-enforced bound in this design is Magrathea's channel limit.** It is per number (10 live, 2 trial), so it bounds a single household. It **does not bound the account** unless Magrathea offers an account-wide cap (NPC, M5).
5. **Minimal variant (no edge): about 7–11 person-days.** It needs a new Magrathea number per household and each customer to re-enter `**21*`.
   - **Code changes are small.** They are number normalisation, the AccountSid and signature-token set, a Magrathea number-provider adapter, and per-provider lookup, quarantine and release.
   - **Variant with an edge: about 25–40 person-days.** It is needed only for Diversion checks, pooling, an account-wide concurrency cap, or removing Media Streams.
6. **Recommendation:** do not build. First, send the questions. Then, if Andrew approves, run the cost-bounded staging test (§7): **expected < £0.15; hard worst case about £1.10** for a one-hour window on the 2-channel trial number.

## 1. How Twilio BYOC works for inbound

| # | Fact | Label | Source |
|---|---|---|---|
| 1.1 | A BYOC trunk holds a **Termination SIP Domain** (`{name}.sip.twilio.com`, with regional forms such as `.sip.ie1.twilio.com`). The carrier "should point their SIP traffic to a SIP Termination Domain URI" | CONFIRMED | [BYOC guide](https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc) |
| 1.2 | The domain needs at least one authentication scheme: an **IP Access Control List** and/or a **Credential List**. If both are set, both are enforced. Twilio "highly recommend[s]" credentials, because IP ACLs alone do not protect against some attacks. Credential checks use a 407 challenge | CONFIRMED | BYOC guide; [Sending SIP](https://www.twilio.com/docs/voice/api/sending-sip) |
| 1.3 | **Routing is per trunk, not per number.** The trunk's authentication finds the trunk, and its configured URL is called. The trunk has `VoiceUrl`/`VoiceMethod`, `VoiceFallbackUrl`, `StatusCallbackUrl` and `ConnectionPolicySid` | CONFIRMED (BYOC guide; ByocTrunks API field list via search) | BYOC guide |
| 1.4 | The Origination Connection Policy is for **outbound** only. A trunk without one has no BYOC outbound route | CONFIRMED (doc); "no other outbound path" is NPC (T20) | BYOC guide |
| 1.5 | Whether BYOC numbers must exist in Twilio as phone-number resources, or a regulatory bundle is needed: **not documented**. The 2020 launch blog says numbers stay with the carrier, with no porting | INDICATIVE / NPC (T19) | [BYOC blog, 2020-04-30](https://www.twilio.com/en-us/blog/products/bring-your-own-carrier) |
| 1.6 | Each region resolves to 3–4 IPs. Do not peg to one IP; fail over 4 s after no response. Static IPs need Interconnect and are **not available in IE1**. Secure Media (TLS/SRTP) is a toggle on termination | CONFIRMED | BYOC guide |
| 1.7 | **Webhook:** the same TwiML request parameters as any call (`CallSid`, `AccountSid`, `From`, `To`, `CallStatus`, `Direction`, `ForwardedFrom`, `CallerName`, `ParentCallSid`, `CallToken`). `ForwardedFrom` is set only if the upstream carrier passes forwarding information | CONFIRMED (parameter list); BYOC population NPC | [TwiML: Twilio's request](https://www.twilio.com/docs/voice/twiml) |
| 1.8 | **SIP headers:** for Programmable Voice SIP (SIP Domains), `X-` headers arrive as `SipHeader_X-name`, and non-`X-` headers are not read. **"Custom headers in SIP INVITEs from BYOC trunks … Twilio doesn't pass those headers to your webhook; they're discarded."** | **CONFIRMED** (page modified 2026-10-08) | [Sending SIP](https://www.twilio.com/docs/voice/api/sending-sip); [SIP and TwiML](https://www.twilio.com/docs/voice/api/sip-twiml) |
| 1.9 | `Diversion`, `History-Info`, `P-Asserted-Identity`: **no Twilio page says whether they reach the webhook** on BYOC or SIP-domain calls | NPC (T13) | as above |
| 1.10 | **Signature:** "Twilio signs all HTTP requests to your app with an `X-Twilio-Signature`", hashed with "your account auth token". Subaccount behaviour and BYOC are not stated. **INDICATIVE:** the signing token is the owning (sub)account's | CONFIRMED / NPC (T15) | [Webhooks security](https://www.twilio.com/docs/usage/webhooks/webhooks-security) |
| 1.11 | **Number formats:** Magrathea sends Request-URI user `443300884327` (no `+`), `To: <sip:+443300884327@…>`, and **`From` in national `07…` form** (HCG evidence). How Twilio renders `To`/`From` for BYOC is undocumented | CONFIRMED (Magrathea side) / NPC (T14, M9) | MAGRATHEA-LIVE-CALL-EVIDENCE §1–2 |
| 1.12 | **Limits:** the pricing page shows 1 CPS free, up to 30 provisionable (outbound context). No inbound BYOC concurrency limit is documented | INDICATIVE / NPC (T17) | [GB pricing](https://www.twilio.com/en-us/voice/pricing/gb) |

### Configuration steps (for later; none performed)

1. Create an **isolated Twilio subaccount** for BYOC. Do not use the shared production/staging account (see the memory note: staging shares the production account).
2. Create an IP ACL holding Magrathea's signalling ranges.
   - The trial E-SIP allowlist covers 12 Magrathea ranges (signalling seen from `87.238.72.129`, `87.238.73.129/.130`; reuse that list).
   - Media comes from `213.166.4.128/26`. Media is not part of the Twilio ACL, but SRTP/RTP must flow.
   - Add a Credential List only if Magrathea can answer a 407 (M8).
3. Create a Termination SIP Domain (`hcg-byoc-…sip.ie1.twilio.com`, or the US1/Dublin edge; T18), attach the ACL, and turn on Secure Media only if Magrathea's `E:` TLS target works (M7).
4. Create the BYOC trunk:
   - `VoiceUrl = https://<backend>/voice` (POST);
   - `VoiceFallbackUrl` = a static `<Reject/>`;
   - `StatusCallbackUrl = /call-status`;
   - **no ConnectionPolicySid** (no outbound).
5. At Magrathea, set each number's target 1 to `S:<number>@<termination domain>`. FQDN support is NPC (M7). Optionally set target 2 to a fail-safe; see §5 R6.
6. Register the numbers as Twilio resources if Twilio requires it (T19).

## 2. Pricing as published, and the per-call legs

**Twilio GB page (read 2026-10-10, "current as of August 2026"):**

| Item | List price |
|---|---|
| Local inbound | $0.0100 |
| BYOC receive | $0.0040 |
| SIP interface receive | $0.0040 |
| Browser/app receive | $0.0040 |
| Media Streams | $0.0044 |
| Polly neural | $0.0032/100 chars |
| Local number | $3.50/month |
| Mobile number | $2.50/month |
| Recording | $0.0025 (unused) |

- Billing increment and ringing are **not stated**.
- HCG's invoices show per-started-minute billing on hosted numbers and **£0 on the Client leg** (CONFIRMED for PV only).

| Leg for one trusted BYOC call delivered `<Dial><Client>` | Rate £/min | Label |
|---|---|---|
| BYOC termination (parent) | 0.00302 | CONFIRMED price; billing basis NPC (T3) |
| "SIP interface" on top of BYOC | 0 or 0.00302 | **NPC (T1)**. Agent 6's stacking concern |
| Voice SDK child leg | 0 (as invoiced on PV) or 0.00302 | **NPC (T1–T2)** |
| **Total** | **0.00302 / 0.00605 / 0.00907** | vs today 0.00756 |
| Unknown callers add: Media Stream 0.00333 + Whisper ~0.0047 + Polly £0.0006 per use | — | CONFIRMED (stream list); Whisper estimated |
| Magrathea inbound | £0 | CONFIRMED (written, trial scale; volume M2) |
| Number | Magrathea £0.50/month vs Twilio £0.87 invoiced / $3.50 (£2.65) list | CONFIRMED / NPC (T12) |

**Saving per minute versus today:**
- **+£0.00454** (BYOC only);
- **+£0.00151** (BYOC + SDK);
- **−£0.00151** (all three stack: more expensive than today).

Against these sits the Magrathea £100/month minimum (NPC whether rentals count, M1).

## 3. Minimal variant: no HCG SIP edge

**Topology:** customer `**21*` → a dedicated **Magrathea number per household** → Twilio BYOC trunk → `/voice` → `<Dial timeLimit><Client>`, unchanged.

### 3.1 Change list

| # | Change | Where | Person-days |
|---|---|---|---|
| C1 | **Normalise numbers** at the `/voice`, `/process`, `/call-delivery-failed` and `/call-status` entry. Parse `To`, which may be `+44…`, `44…` or a SIP URI, to E.164 before `getHouseholdByTwilioNumber`. Convert `From`/`Caller` from national `07…`/`01…` to `+44…` before abuse checks, the trusted full-E.164 match and caller display. Withheld = `anonymous` → treated as withheld. **Without this, trusted contacts silently fail to match** | `server.js:1088,1154,1536,1760`; a new helper | 1–1.5 |
| C2 | **Webhook integrity:** `webhookIntegrity.js:70` rejects any `AccountSid` other than HCG's. Allow the BYOC subaccount SID. Signature validation must use that subaccount's auth token: `createTwilioWebhookGuard` currently takes one `TWILIO_AUTH_TOKEN`, so make it a keyed set chosen by `AccountSid` | `services/abuse/webhookIntegrity.js`, `services/twilioWebhookAuth.js`, `server.js:951` | 1 |
| C3 | **Magrathea number-provider adapter:** `provisionNumber` (allocate from NTSAPI), `configureInboundRoute` (`number/set` target), `releaseNumber` (`DEAC`), `fetchNumberStatus`. Capabilities `null` where unverified. Blocked on REST `/number/*` 401 (M21) | `services/telephony/numberProviders/magrathea.js` + `registry.js` | 2–3 |
| C4 | **Per-provider number lifecycle:** the household number column (`twilio_number`, used as the E.164 key), quarantine and release runner (`twilioNumberReleaseRunner.js`, `twilioQuarantine.js`) and `twilioProvisioning.js` assume Twilio APIs. Branch on provider. Reuse `routing_assignments` (migration 062, PROVISIONAL, unapplied). This needs a migration with a new number, owned by Andrew's migration inventory | database + services | 1.5–2 |
| C5 | **Cost model:** the Fortress per-minute reservation rates and the Financial Control Centre's reconciliation must know BYOC rates and usage categories, initially pessimistic at £0.00907 until T1 is answered | containment config | 0.5–1 |
| C6 | **Customer surfaces:** the activation instructions show the new number. Re-forwarding prompt for existing households. A provider-policy check that the customer's MNO can forward to the chosen range (03 vs 01/02) | mobile/web copy, `providerPolicy.js` | 0.5–1 |
| C7 | **Twilio and Magrathea configuration** (§1 steps), runbook, rollback | console/runbook | 0.5 |
| C8 | Tests: unit tests for normalisation and integrity; staging test (§7) | tests | 1 |
| | **Total** | | **≈ 7–11 person-days** (Agent 3 said 5–8; this adds C2 and C4, found in code) |

**Unchanged:** the app and Voice SDK; push; the Fortress logic; the egress guard; Media Streams monitoring; `timeLimit`; the SDK-origin `<Reject>` (`From` on BYOC is never `client:`).

### 3.2 Customer re-forwarding and migration

- **Twilio-hosted numbers cannot be put on a BYOC trunk** (INDICATIVE: BYOC carries the carrier's own numbers). Either:
  - every household gets a **new Magrathea number** and re-enters `**21*<new>#`; or
  - the Twilio numbers are ported to Magrathea (M20, plus Twilio port-out). That is slow and uncertain.
- **Plan:**
  1. New signups go on Magrathea only, behind a provider flag.
  2. Existing households (about 0 genuine paying customers; the memory note records 10 numbers left) get a guided re-forward with a support-verified proof (075).
  3. The old Twilio number keeps routing to `/voice` for a **30-day grace period**. During it, lookup accepts either number, so a missed re-forward never drops calls.
  4. After the grace period, the old number is released through the existing quarantine.
- **Doing this now is cheapest.** Every later customer needs a guided re-forward.

### 3.3 What the minimal variant does **not** give

- No forwarding line (§1.8). No pooling. No account-wide concurrency cap.
- Media Streams remain.
- Twilio has no spend cap, and the master-token risk is unchanged. **It is a margin change, not a containment change.**

## 4. Variant with an HCG SIP edge (only if needed)

**Topology:** Magrathea → **HCG edge** (Kamailio/FreeSWITCH or drachtio + rtpengine; 2 nodes) → Twilio **SIP Domain** (IP ACL = the edge only) → `/voice` → `<Client>`.

**Needed only for:**
- **(a)** reading `Diversion` as a passive forwarding check (LF-2) or for pooling (C′). The edge relays it as `X-HCG-Diversion` and the webhook reads `SipHeader_X-HCG-Diversion` (CONFIRMED to pass on SIP Domains);
- **(b)** an **account-wide concurrency cap** HCG enforces itself;
- **(c)** forking RTP locally to drop Media Streams;
- **(d)** pooling numbers.

**Billing:** SIP interface $0.004 plus the SDK leg (T1) instead of BYOC. The same stacking question applies.

**Effort:** edge 20–35 person-days (Agent 3) plus the C1–C8 items that still apply (about 4–6), less BYOC configuration.
- **≈ 25–40 person-days.**
- Pooling adds 8–12.

**Operations:**
- HA: Magrathea's 3 targets with 20 s failover help (MAGRATHEA-TRIAL-PLAN §5).
- 24/7 ownership of a SIP service.

**Choose the edge only if:** T13 says `Diversion` is not exposed on BYOC **and** Diversion or pooling is wanted, **or** M5 says no account-wide channel cap exists and Andrew wants a hard concurrency bound.

## 5. Risks

| # | Risk | Assessment |
|---|---|---|
| R1 | **Double hop latency** | The carrier divert → Magrathea → Twilio adds one SIP hop and possibly a UK→IE/US transit. INDICATIVE: +50–300 ms post-dial delay, and media relayed through Twilio's edge (no extra RTP hop for the Client leg). Use IE1 or Dublin termination. Measure in §7 |
| R2 | **Stacked billing makes BYOC dearer than today** | Possible (§2). Do not build before T1 |
| R3 | **Shared Magrathea source IPs** | If Magrathea's signalling IPs also carry other customers' traffic (M8), anyone on Magrathea could send INVITEs to HCG's termination domain. `/voice` would `<Reject>` an unknown `To` (£0, assuming T4), but every accepted call bills. Use credentials if M8 allows; otherwise rely on the To-lookup reject plus Fortress |
| R4 | **Lost trust matching** | `From` in national format (C1). A missed normalisation turns every trusted call into a monitored unknown call: more cost, and a worse experience |
| R5 | **No Diversion** | Accept it for the minimal variant; it is the reason for the edge |
| R6 | **Magrathea or Twilio outage** | A single target means total outage. Target 2 could be a Twilio-hosted fallback number. A PSTN leg costs money and needs a loop check, so that is a deliberate design decision, not a default |
| R7 | **Calls in progress outlive limits** | Twilio (suspension, zero balance) and Magrathea (prepaid) both let live calls finish (CONFIRMED). The per-call bound remains `<Dial timeLimit>`, which is documented but not yet demonstrated on HCG |
| R8 | **Customer re-forwarding failure** | Mitigated by the dual-number grace period and support-verified proof |
| R9 | **Regulatory or contract** | The £100/month minimum and its term (M1). A 999/Schedule 5 question (M19) |

### 5.1 Magrathea channel limits as a provider-enforced spend bound

**Worst-case Twilio spend = channels × 60 min/h × £/min,** with every channel busy for the whole period (an adversarial or runaway case). The bound holds **only per number** unless Magrathea confirms an account-wide cap (M5). With per-number channels, the account bound is Σ channels: about 10 × N at 10/number.

Per-minute rates used:
- unstacked = £0.00302 (BYOC only);
- +SDK = £0.00605;
- stacked = £0.00907 (BYOC + SIP + SDK);
- stacked + monitored = £0.01710 (adds the Stream at £0.00333 and Whisper at £0.0047; Whisper is OpenAI, which HCG can hard-cap separately).

| Channels | Unstacked £/h · £/day · £/30d | +SDK £/h · £/day · £/30d | **Stacked** £/h · £/day · £/30d | Stacked + monitored £/h · £/day |
|---|---|---|---|---|
| 2 | 0.36 · 8.71 · 261 | 0.73 · 17.42 · 523 | **1.09 · 26.13 · 784** | 2.05 · 49.24 |
| 4 | 0.73 · 17.42 · 523 | 1.45 · 34.84 · 1,045 | **2.18 · 52.25 · 1,568** | 4.10 · 98.49 |
| 10 | 1.81 · 43.55 · 1,306 | 3.63 · 87.09 · 2,613 | **5.44 · 130.64 · 3,919** | 10.26 · 246.22 |
| *Today PV, for reference: no cap at all* | 10 ch equivalent: 4.54/h · 108.86/day | | | |

**What the table means:**
- A 2-channel account-wide cap would turn "unbounded" into **≤ about £26/day** of Twilio voice even if every leg stacks. That is the strongest provider-side bound available on any Twilio design.
- At 10 channels **per number**, it bounds one household (about £130/day worst case), not the business.
- **Fortress per-household budgets and `timeLimit` stay the primary limits.** The channel cap is the backstop for when HCG itself is dead.
- **Trade-off:** an account cap set too low makes legitimate concurrent calls overflow (M6: what the caller hears). Agent 2 sizes the need at about 26–43 channels at 1,000 subscribers.

## 6. Confidence and unknowns

- **High:** the BYOC mechanics (§1.1–1.4, 1.6); custom headers discarded on BYOC (1.8); list prices; no spend cap; suspension and zero-balance behaviour; the Magrathea facts (written answers and live calls).
- **Medium:** the change list and effort (±40%; derived from the code at `server.js`, `webhookIntegrity.js` and the number-provider seam).
- **Low:** the economics, until T1, T2 and T12 are answered.

**Key unknowns:**

| Unknown | Question |
|---|---|
| Leg stacking | T1 |
| SDK leg billing | T2 |
| Ringing and per-second billing | T3 |
| `<Reject>` billed £0 on BYOC | T4 |
| Diversion → `ForwardedFrom` on BYOC | T13 |
| `To`/`From` formats | T14, M9 |
| Signing token for a subaccount | T15 |
| Number registration | T19 |
| Magrathea FQDN/TLS target and digest auth | M7–M8 |
| Account-wide channel cap | M5 |
| Minimum composition | M1 |
| Free inbound at volume | M2 |
| Number porting | M20 |
| Magrathea REST access | M21 |

## 7. Cost-bounded staging test (FOR APPROVAL; not scheduled)

**Prerequisites:**
- Answers to T1, T4, T14, T19, M7 and M21.
- Andrew's GO for each of the following: creating an isolated Twilio subaccount and BYOC trunk; retargeting the **trial DDI 0330 088 4327** away from the E-SIP VM; the test calls.

**Setup:**
- **One number:** the trial DDI, which has a **2-channel cap**.
- **Twilio side:** an isolated subaccount with **no phone numbers** and **no origination policy**. Geo permissions are off and there is no SMS.
- **Webhook:** the staging backend `/voice`, with C1/C2 behind a flag, or a minimal TwiML Bin `<Dial timeout="20" timeLimit="60"><Client>staging-test</Client></Dial>` that logs parameters through `StatusCallbackUrl`.
- **Test handset:** the staging iPhone or Motorola.

| # | Call (attended, ≤ 60 s each) | What it shows |
|---|---|---|
| S1 | Direct dial from the tester's phone, answered on the app for 30 s | Delivery; `To`/`From` formats; latency; legs |
| S2 | Forwarded call (CFU from an O2/VF test SIM), answered | `ForwardedFrom` populated? (T13) |
| S3 | Withheld caller | Anonymous handling |
| S4 | Called number not mapped, so `/voice` returns `<Reject>` | £0 on BYOC (T4) |
| S5 | App rings 20 s, unanswered | Is ringing billed on the parent leg? |
| S6 | Answered, caller hangs up after 10 s | Billing basis: per second or per minute |

**After 48 h:**
- Read the subaccount's Call resources (`price` per parent and child leg) and usage records.
- Magrathea CDRs (M22).
- Then restore the DDI target and suspend/close the subaccount.

**£ bound:**
- **Expected < £0.15.** 6 calls × ≤ 2 started minutes × the stacked £0.00907, plus Magrathea £0.
- **Hard worst case ≈ £1.10.** Both trial channels busy for the whole one-hour window at the stacked rate (§5.1), because `timeLimit` 60 s and the 2-channel cap bound it.
- Plus the test SIM's own forwarding tariff (£5–10 SIM, already in the business-decision plan).
- **Approval cap requested: £2.**

**Stop rules:** any unexpected leg or price line; any call longer than 70 s; any INVITE source outside Magrathea's ranges; any outbound attempt → retarget the DDI back and suspend the subaccount.

## 8. Sources (read 2026-10-10)

**Twilio:**
- https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc (and `.md`)
- https://www.twilio.com/docs/voice/api/sending-sip (BYOC custom headers discarded; modified 2026-10-08)
- https://www.twilio.com/docs/voice/api/sip-twiml (incoming SIP parameters, `SipHeader_`)
- https://www.twilio.com/docs/voice/twiml (request parameters, `ForwardedFrom`)
- https://www.twilio.com/docs/usage/webhooks/webhooks-security (signature)
- https://www.twilio.com/en-us/voice/pricing/gb (all prices)
- https://www.twilio.com/docs/usage/api/usage-trigger (about once a minute; notify only; modified 2026-07-31)
- https://www.twilio.com/docs/iam/api/subaccounts ("in-progress calls will not end"; one shared balance)
- support.twilio.com/hc/en-us/articles/223183248 (zero balance: live calls finish, the balance goes negative; the article has moved to help.twilio.com, so it is INDICATIVE for currency)
- https://www.twilio.com/en-us/blog/products/bring-your-own-carrier (2020)
- https://www.twilio.com/en-us/changelog/diversion-header-validation-for-termination-calls (Elastic SIP Trunking, outbound only; not relevant to inbound)

**HCG:**
- `server.js` (`/voice` at 1073–1160, guard at 951)
- `services/abuse/webhookIntegrity.js:32,70`
- `services/voiceWebhookGuards.js`
- `services/telephony/numberProviders/contract.js`
- `/Users/ad/call-ai-magrathea-trial/docs/carriers/MAGRATHEA-{LIVE-CALL-EVIDENCE,TRANSFER-READINESS,TRIAL-PLAN,SIP-TRIAL-PLAN}.md`
- Agents 1, 3 and 6 in this folder.
