# Agent 3: Telephony engineering (2026-10-10)

**Status:** research only. I read code and documents only. I made no calls, no provider API requests and no code changes.

**Code:** RC = this worktree. Production = `git show eb43368:server.js`.

**Evidence (short names):** TDE = `docs/launch/2026-10-10-TWILIO-DURATION-EVIDENCE.md`; ACA = `ANDROID_CALL_CHAIN_AUDIT_2026-09-30.md`; DTE = `2026-10-05-DEVICE-TEST-EVIDENCE.md`; MLE/MTR = `/Users/ad/call-ai-magrathea-trial/docs/carriers/MAGRATHEA-{LIVE-CALL-EVIDENCE,TRANSFER-READINESS}.md`.

**Labels:** **[P]** proven · **[B]** built, unproven · **[NP]** needs a prototype · **[PC]** needs provider cooperation · **[S]** speculative.

---

## 0. Summary

1. **One Twilio leg bills for every call's whole length:** the inbound parent leg, at £0.00756 per started minute. That includes trusted calls, and it covers greeting, ringing and talk.
   - The app leg has been £0 on HCG's invoices (list $0.004).
   - Unknown callers add a Stream, Whisper, Polly and sometimes SMS.
   - **No outbound leg can be produced. There are no recordings.**
2. **Removing Twilio:** the carrier half is **[P]** (Magrathea free inbound, live calls, `Diversion`). Replacing the Voice SDK and push is **[NP]**, about **55–95 person-days**.
3. **BYOC** (~5–8 person-days) cuts inbound to ~$0.004/min but keeps Twilio's lack of any spend cap. It is a margin tweak.
4. **Recommended order, D (staged):**
   - **D1:** an HCG SIP edge on Magrathea → Twilio SIP → `<Client>`, with a local media fork.
   - **D2:** native delivery.
   - New numbers or ports **[PC]** are needed. That is cheapest now (~0 paying customers).
5. **Delivery reliability, not the provider, is the launch risk.** Android 1.0.2 is untested on a device. The lock-screen ring collapses (FSI blocked). The 20 s Dial timeout includes push latency.
6. **Pooling** (one or a few shared numbers, with the customer identified from `Diversion`) is **impossible on Twilio PSTN** and **plausible on Magrathea** (§7).
7. **Best ≤2-week change:** Android delivery verification and fixes, plus a Lebara carrier gate. In parallel, run a ~£80 per-network `Diversion`/CFU probe (§9).

---

## 1. Chargeable legs and events, per call type (RC; production differences noted)

**Inbound flow, RC:** `/voice` (server.js:1075). Checks run SDK-origin → abuse → `callAdmission.admit` → registered-app check → `containment.authorizeCall` (1084–1270). Trusted calls go to `dialHouseholdOrFailClosed` (1297 → 479). Unknown calls get `<Say Polly>` (1426) + `<Start><Stream>` (588) + the same `<Dial timeout=20 timeLimit=min(admission, Fortress)>` (1269, 479). All of it passes through the egress guard (`twimlEgressGuard.js:8–19`).

**Unit prices** (HCG invoices, via TDE §1; Twilio GB list page read 2026-10-10):

| Item | Price |
|---|---|
| Inbound | £0.007558 per started minute (list $0.0100) |
| App leg | £0 measured (list $0.0040) |
| Media Stream | £0.003329 per started minute (list $0.0044) |
| Polly | £0.0006 per use |
| Whisper (`whisper-1`, `transcribeChunk.js:59`, 4 s windows `audioWindow.js:18`) | ≈ £0.00474/min, **estimated** |
| SMS | £0.042325 per segment; warnings are 2 segments |
| Number rental | £0.86917/month |

| Call type | Chargeable legs/events | Evidence | Typical £ |
|---|---|---|---|
| **Trusted, answered** | Parent leg ⌈(ring + talk)/60⌉ × £0.00756. App leg £0 (measured), list £0.00316/min. No Polly, Stream, Whisper or SMS | server.js:1281–1300; TDE §5: **239 s → 4 × £0.00756 = £0.03023**; DTE E1–E8 | ~£0.0076/min of conversation, **for the whole call** |
| **Unknown, monitored, answered** | Polly ×1. Parent (greeting ~3 s + ring + talk). Stream per started minute, until call end or the 30-min HCG close (`monitoringLimit.js:14`; `mediaStreamHandler.js:412–420`). Whisper per monitored minute. Red-line SMS 2 segments if triggered (≤3 per household per day, `costCaps.js`; fail-closed authorisation `smsBudget.js:40–53`). Red-line terminate = REST redirect + a second Polly (server.js:1670; `callTermination.js:40–60`). App leg £0 | server.js:1424–1432; TDE §1, §5 | 5-min call ≈ £0.0378 parent + **£0.01663 stream** + ~£0.024 Whisper + £0.0006 ≈ **£0.079**; plus £0.085 per warning SMS |
| **Unknown, after allowance (budget + reserves exhausted)** | Fortress refuses → `<Reject reason=busy>` → **£0** (unscreened reserve defaults to 0). Unknown caller to an *unentitled* household: connects **unmonitored**, parent only, no Polly | server.js:1262–1266; `fortressAdapter.js:44–54`; `readModel.js:41`; server.js:1436–1446 | £0, or parent only |
| **Refused** (SDK-originated, abuse, admission, Fortress, no household) | `<Reject>` → no Twilio answer → £0 per Twilio docs. *Confirming £0 on the Call resource is a pending Test B item* | server.js:1084, 1183, 1219, 1266, 526 | £0 **[B]** |
| **App unreachable: never registered** | `<Reject busy>` before any paid step | server.js:1228–1243 | £0 |
| **App unreachable: registered, no answer** | Parent answered: greeting + ring ≤ 20 + 5 s buffer, then `/call-delivery-failed` → `<Hangup/>` (`callDeliveryFallback.js:43–67`). Unknown: plus Polly and ≥1 stream minute, because the stream starts before the Dial. Push itself costs nothing | server.js:1694ff; TDE §2 | ~£0.0076 (trusted), ~£0.012 (unknown) per lost call |
| **Outbound legs** | **None.** No `calls.create` anywhere in RC or production. The only `twiml.dial(` is server.js:479 with `<Client>`. The egress guard rewrites `<Number>/<Sip>/<Conference>/<Refer>/<Record>/…` to `<Reject/>` | grep over the repo; `twimlEgressGuard.js:12–15`; static test `tests/twilio-duration-bounds.test.mjs` | £0 **[P]** by construction |
| **Recordings** | None in production. The voicemail `<Record maxLength=60>` prototype is forced off and forbidden by the guard | `callDeliveryFallback.js:28–51`; TDE §2 | £0 |
| **Number purchase** | `incomingPhoneNumbers.create` at provisioning (`twilioProvisioning.js:290`; `numberProviders/twilio.js:46`). Rental is not metered by Fortress | — | £0.869/month per household |
| **REST control** | `calls(sid).update` for the breaker or red-line. Not a new leg | `twilioCallControl.js:38–51` | £0 |

**Production `eb43368` differences:** no signature guard on `/voice` (641); no `timeLimit` on the Dial (287); no Fortress. Failure paths answer with a billed Polly apology (311, 331, 1024): ≥1 parent minute + Polly per lost call.

**Structural fact:** with `**21*` (CFU), **every call the customer receives, including family calls, passes through Twilio's per-minute meter for its whole length**. Twilio's leg cannot be released (`TRUSTED_CALL_COST_PATH` evidence; Magrathea and Twilio have no REFER, MTR P1).

---

## 2. Options for removing Twilio

### What HCG already has that transfers

| Asset | Status | Cite |
|---|---|---|
| Magrathea inbound to an HCG UAS (answer, hold, BYE with retransmit, ACK timer, re-INVITE, SIGTERM drain, masked logs) | **[P]**, 4 live calls; 26 + 16 + 14 loopback tests | MLE §1–3, §13; MTR §1 |
| A mobile divert arrives with `Diversion: <forwarding mobile>` | **[P]** on Lebara busy-divert only. EE, VF, O2 and Three are unknown | MLE §13.2; MTR P10 |
| Inbound free; £100/month contract minimum; Network Mode CLI (PAI?) under a separate agreement | **[PC]**, confirmed in writing (LKV-51353-279) | MTR P2, P6, P7 |
| Caller identity is `presentation_only` (From/RPID, **no PAI**) | **[P]** finding | MLE §4 |
| Number-provider abstraction (`contract.js`, `registry.js`, `twilio.js`) | **[B]**, Twilio only | `services/telephony/numberProviders/` |
| Monitoring pipeline independent of transport (window, segmenter, Whisper, scorer, SMS) | **[P]** on Twilio Media Streams frames (μ-law 8 kHz base64 JSON) | `services/liveMonitoring/*` |
| Fortress (per-call reservation, leases, breaker, egress guard) | **[B]**; the Twilio-side backstop is undemonstrated | TDE summary 2, 6 |

### Option A: wholesale SIP inbound → HCG SIP edge → AI fork → app

**Topology:**
- The customer's mobile forwards (`**21*`) to a Magrathea DDI. Magrathea sends SIP to an HCG B2BUA.
- **Engine choice:** FreeSWITCH (`mod_audio_fork` / `mod_audio_stream`, or ESL) or drachtio + rtpengine.
- The edge does three things:
  - classifies callers using the existing admission and containment logic, over HTTP;
  - forks unknown callers' RTP into `mediaStreamHandler` (§5);
  - bridges to the app, via Twilio SIP into `<Dial><Client>` (**A1**) or by its own delivery (**A2** = Option C).

**Status:** inbound and teardown are **[P]**. The B2BUA, the fork, the greeting WAV (£0 per call) and A1 are **[NP]**.

**Cost:**
- Carrier inbound is £0. A1 adds Twilio SIP at $0.004/min, plus the app leg (£0 so far **[S]**). Media Streams go away.
- Fixed costs: the Magrathea £100/month minimum **[PC]**, plus 2 VMs at about £30–80/month.

**Effort:**
- Edge, fork adapter, local hard timers, provisioning provider for Magrathea numbers (`DEAC`/REST access currently 401 **[PC]**), monitoring, runbooks: **20–35 person-days**.
- A1 bridge: **+3–5 person-days**.

**Operations:**
- **HA:** 2 nodes. Whether Magrathea offers a failover target per DDI is unknown **[PC]**; without one, a node outage is a total outage.
- **Security:** allowlist Magrathea signalling plus the media /26 (MLE §3); no internet REGISTER; TLS/SRTP to the app; rate limits.
- **Toll fraud:** **no outbound route** in the dialplan; trunk `112168` stays disabled. Magrathea limits don't end live calls, and outbound is £0.0069/min (MTR P3–P5). Keep E-SIP's BYE-only output guard.
- **CDR reconciliation:** needs CDR access **[PC]**.

**Hard limits:**
- With carrier inbound free, the **only variable spend is OpenAI, SMS and (A1) Twilio SIP minutes**.
- The edge enforces locally:
  - `sched_hangup` / `max_call_s` from Fortress `timeLimit`, already proven in E-SIP (`max_call_s` backstop);
  - stopping the fork stops Whisper spend.
- **If HCG's edge dies, carrier cost is £0.** The caller's leg drops at the latest at the session refresh (`Session-Expires 1900; refresher=uac`, so ~950 s). In A1, Twilio's `timeLimit` still applies.
- **This is strictly better containment than today.** Today the dangerous leg sits with a provider that has no spend cap and an undemonstrated backstop.

### Option B: BYOC into Twilio (keep Voice SDK, change origination)

**Topology:**
- Magrathea DDIs route by SIP to a Twilio BYOC trunk. Twilio runs the same `/voice` TwiML.
- Only Twilio's inbound pricing line changes: list $0.0100 → $0.0040/min (Twilio GB pricing page, read 2026-10-10). Media Streams $0.0044 stays.

**Status:** the app and Fortress are unchanged **[P]**. Magrathea → BYOC interop is **[NP]/[PC]**.

**Effort:**
- **5–8 person-days**: trunk, origination URI, provisioning provider, tests.
- Twilio-hosted numbers cannot be BYOC'd. Each household needs a **new Magrathea number**, so the customer re-enters `**21*`, or a port **[PC]**.

**Cost and containment:**
- Saves ~£0.0045/min on all calls, including trusted ones.
- **Twilio still has no spend limit.** The master token, the undemonstrated `timeLimit` backstop and assumption A (stream billing after the WebSocket dies) all remain.
- Adds the £100/month Magrathea minimum. Break-even ≈ 22,000 forwarded minutes/month **[S]** (£100 / £0.0045).

**Verdict:** a margin optimisation, not a structural fix.

### Option C: direct-to-app SIP/WebRTC delivery (no Twilio on the call path)

**The parts to build:**
- an HCG push sender: APNs VoIP (HTTP/2, token auth) and FCM HTTP v1;
- registration and token lifecycle (an HCG-owned replacement for Twilio's ~1-year push binding);
- a SIP/WebRTC user agent in the app;
- TURN (coturn) for NAT;
- native call UI: CallKit on iOS, a self-managed `ConnectionService` and CallStyle notification on Android.

**Stack choices:**

| Stack | Notes | Status |
|---|---|---|
| `react-native-webrtc` + `react-native-callkeep` + own SIP-over-WSS (JsSIP/SIP.js) to FreeSWITCH (`mod_verto`/WSS) | Community libraries; Expo config plugins; ICE/DTLS cold-start time | **[NP]** |
| **Linphone SDK** (liblinphone + Flexisip push gateway) | Mature SIP + push; GPLv3 or commercial | **[NP]**, licence cost unknown **[PC]** |
| **Telnyx RN SDK** (`@telnyx/react-voice-commons-sdk`) | PushKit → CallKit and FCM → `ConnectionService` built in ([docs](https://developers.telnyx.com/development/webrtc/react-native-sdk/push-notifications)) | Swaps one per-minute meter for another; TeXML lacks `<Client>` (provider-migration playbook) **[NP]** |

**Platform rules that bind C:**
- **iOS:** apps built on the iOS 13+ SDK are **terminated if a VoIP push is not reported to CallKit**. Repeated failures can stop VoIP push delivery to the install ([Apple PushKit `voip`](https://developer.apple.com/tutorials/data/documentation/pushkit/pkpushtype/voip.md); [forum](https://developer.apple.com/forums/thread/801446)). So VoIP push can never carry control messages, and a call cancelled early must still be reported, then ended.
- **Android:** high-priority FCM that does not produce a visible notification is **deprioritised**, assessed per instance over 7 days. Doze buckets cap the quota ([Firebase message priority](https://firebase.google.com/docs/cloud-messaging/android/message-priority)). This is the same rule as today; HCG would own the risk.
- **Android lock screen:** the right fix is a self-managed `ConnectionService` plus a CallStyle notification with FSI. Play's FSI declaration must succeed (HCG's v10 was rejected as "not core") **[PC]**.

**Effort:** **55–95 person-days** for both platforms: native modules, call UI, push sender, TURN/WSS, telemetry parity, device matrix, store review.

**Main gain:** Twilio is out of the call path, and trusted minutes cost £0 at the margin.

**Main risk:** HCG has to re-solve the edge cases the Twilio SDK already handles (token rotation, CallKit races, audio session).

### Option D: hybrid staged migration (recommended order)

| Stage | Change | Exit criterion |
|---|---|---|
| D0 | RC on Twilio; fix delivery (§3); demonstrate the backstop (TDE §7) | P1–P11 pass; backstop call passes |
| D1 | Magrathea live account + 2-node edge (A1); new households on Magrathea DDIs | 2 weeks of delivery parity; CDRs reconcile |
| D2 | Option C behind a per-household flag, with A1 fallback | Matrix parity; push P95 within budget |
| D3 | Retire Twilio voice; SMS only, prepaid, UK geo | — |

**The migration cost is numbers.** Existing Twilio numbers must be ported **[PC]**, or customers re-enter their forwarding code. With ~0 genuine paying customers, a re-setup is cheapest **now**.

---

## 3. Delivery reliability today, and how each option changes it

| Platform / item | State | Label |
|---|---|---|
| iOS 1.0.1 (Build 14) live | Production; Twilio SDK PushKit + CallKit | [P] in the field |
| iOS 1.0.2 B16 staging | Trusted delivery PASS ×2: push → presented **1.5 s** → answered → media (DTE T6). DT-1 (no hang-up control after answer) fixed in source, untested | [P] / [B] |
| Android 1.0.1 (Build 19) | 30 Sep: Dial issued, app never answered; cause **not determinable** from production data (ACA §1) | Open |
| Android 1.0.2 | **No device test.** H5 cold-start recovery (`mobile/lib/voiceClient.ts:169–280`, `activeCallModel.ts:107`) added 10 Oct, untested | [B] |
| FSI blocked (`app.config.js:72–100`) | Locked phone: heads-up collapses after ~5–6 s, Answer only from the shade, for the rest of the ring | [P] regression |
| FCM token rotation in background | SDK `onNewToken` only logs; fixed on foreground only | partly [B] |
| Force-stop / OEM battery killers / DND / reboot | Unverified per OEM (ACA rows 12, 13, 20, 22) | Open |
| Mic or notification permission off | Silent no-ring (SDK 31401); now reported and bannered | [B] |

**How each option changes this:**
- **B:** no change.
- **A1/D1:** no device change. Server-side setup is ~0.5–1 s faster for unknown callers, because the edge can send the push *in parallel* with the greeting. In TwiML today, `<Say>` blocks before `<Dial>`.
- **C/D2:** can fix FSI properly and owns token rotation. It adds new risks: HCG's own push sender, PushKit termination rules, an ICE cold start of ~1–3 s **[S]**, and TURN. **Expect a reliability dip until the device matrix passes.**

---

## 4. Call setup time budget (CFU forward, today on Twilio)

| Segment | Estimate | Basis |
|---|---|---|
| Caller's network → customer's mobile network; CFU divert decision (no ringing on the handset) | 1–3 s | **[S]**, typical UK mobile routing |
| Divert across interconnect to Twilio/Magrathea DDI | 0.5–2 s | Magrathea: INVITE → 100/180 in 1–4 ms at HCG (MLE §2); upstream not measured |
| Twilio → `/voice` webhook, HCG decision (≈6–10 DB/RPC calls: household, abuse, entitlement, admission, Fortress) | 0.3–1.5 s; hard Twilio ceiling 15 s | **[S]**; not measured; TDE §2 |
| Unknown only: Polly greeting before Dial | ~3 s | TDE §2 |
| Twilio → APNs/FCM → device wake → notification/CallKit | iOS 1.5 s measured (DTE T6). Android warm ~1–2 s, cold/killed 2–6 s **[S]**; Doze/deprioritised: tens of seconds or never | ACA row 24 (`push_requested` → `app_invite_received` recorded, never analysed) |
| Human notices and answers | 5–15 s **[S]**; locked Android with collapsed banner: longer | — |
| **Dial timeout** | 20 s (+5 s Twilio buffer), **from Dial start, including push latency** | server.js:479 |

**Totals:**
- Caller-perceived silence or ringback before the phone rings: **~3–7 s trusted, ~6–10 s unknown**. The caller hears Twilio's UK ringback once Twilio answers.
- The customer then gets roughly **12–17 s of effective ring**. Then the call ends with no voicemail.

**Abandonment risk:**
- Under CFU, carrier no-answer timers don't apply, because Twilio or HCG has already answered.
- The binding constraint is **HCG's 20 s timeout minus push latency**. Callers' patience (~20–30 s) is secondary **[S]**.
- Raising `timeout` to 30–40 s costs ~1 parent minute per unanswered call on Twilio, and £0 on Option A.
- **The CFNRy/silence roadmap** adds the carrier no-reply timer first (Lebara 15 s, `TEST-A-RESULTS` line 12). That means **~25–45 s before the app rings**: a high abandonment risk **[S]**.

---

## 5. Monitoring continuity

- On A/C, the edge forks the caller's RTP (PCMA → μ-law) through a ~200-line adapter emitting Twilio-style `start`/`media`/`stop` frames into the unchanged `mediaStreamHandler` **[NP]**.
- All HCG caps stay as they are (`costCaps.js:13–19`, the 30-min cap, the Fortress window reservation).
- The fork dies with HCG, so spend cannot outlive HCG. That eliminates assumption A.

---

## 6. Hard-limit enforcement points by option

| Option | Per-call bound | When HCG is dead | Provider spend cap |
|---|---|---|---|
| Today (RC) | Fortress → `<Dial timeLimit>` (Twilio) + lease sweeper (master token) | `timeLimit` documented, **undemonstrated**; parent overhead ~58 s against 60 s grace | **None** (Twilio) |
| B (BYOC) | Same as RC | Same | None (Twilio); Magrathea prepaid doesn't end live calls |
| A1 | Edge `sched_hangup` + Twilio `timeLimit` on the SIP leg | Carrier £0; Twilio SIP leg bounded by `timeLimit` | Twilio still none, but only on delivered minutes |
| A2/C | Edge only (local timer; no remote API) | **£0 telephony exposure** (inbound free, no outbound route) | Not needed for telephony; OpenAI cap; SMS prepaid |

---

## 7. Number pooling (shared number or small pool)

**Design:** all customers forward `**21*` to one of N HCG DDIs. The edge keys the household on the **diverting line** (`Diversion`, or `History-Info`), normalised from national `07…` (MLE §2) to E.164 and matched against the account mobile. That number would be verified at activation by a test call from the app.

**Feasibility:**

| Platform | Finding | Status |
|---|---|---|
| Twilio PSTN | `ForwardedFrom` carried **no usable information on 184 real inbound calls** (server.js:439–441; `callRouting.js:68`) | **Demonstrated failure**; per-household numbers required |
| Magrathea SIP | `Diversion` = the diverting mobile, `screen=yes` (MLE §13.2) | **[P] n=1**, Lebara **busy**-divert only. CFU, EE/VF/O2/Three/MVNOs and `History-Info`: **no evidence** |

**Concurrency:**
- Each INVITE is an independent dialog (own Call-ID), so a shared DDI needs no per-number serialisation.
- Per-household limits (2 streams, abuse concurrency, Fortress I5) apply unchanged.
- The trunk channel cap is a Magrathea parameter **[PC]**.

**Risks:**
- **No `Diversion`** (a stripping network, or an unforwarded direct dial): reject. That is free on the carrier, but those customers need a dedicated-number fallback (a hybrid pool).
- **Forged `Diversion`** from a VoIP-originated direct dial **[S]**: at worst it creates a monitored unknown call charged against the victim household's capped allowance. It can never grant trust, because trust already relies only on presentation `From` (MLE §4). Reject when `Diversion` is absent or unregistered.
- **Customer changes mobile number:** re-verify.

**Effort:** **8–12 person-days on top of Option A**:
- the lookup;
- an activation-verification call;
- `routing_assignments` (customer-identity branch, migration 062 provisional);
- fallback allocation.

It removes most of the per-household number rental (Twilio £0.87/month; Magrathea's per-number terms are unknown).

---

## 8. Demonstrated failure vs missing evidence; smallest safe tests

**Demonstrated failures:**
- Lebara external forwarding: Lebara's written statement; `**61*` refused; `**67*` re-registration failed (MLE §13).
- Magrathea REFER is unsupported (MTR P1).
- Twilio `ForwardedFrom` is unusable (184 calls).
- The Play FSI permission was rejected (v10), and the lock-screen collapse was observed on Android 10 (`app.config.js:72–100`).
- A Lebara decline gave busy, not divert (trusted-bypass NO-GO).

**Missing evidence (not failures):**
- Twilio `timeLimit` backstop behaviour.
- `<Reject>` billed £0.
- App-leg billing.
- Android 1.0.2 delivery.
- `Diversion` under CFU and on other networks.
- Magrathea CDR debits.
- Push-latency distribution.
- A1 and BYOC interop.
- HCG-owned push delivery.

**Smallest safe test per option.** All tests are inbound-only, with no outbound route and Andrew attending.

| Option | Test | Bound |
|---|---|---|
| RC/today | TDE §7 staging backstop call; Android 1.0.2 ACA P1–P11 on the Motorola against a staging number | ~12 calls, < £0.30 |
| A (edge + fork) | E-SIP `max_call_s` 120: fork caller RTP to a file, then transcribe ≤30 s offline | £0 carrier, ≤ £0.01 Whisper |
| Pooling | 1 CFU (`**21*`) call per network (EE, VF, O2, Three, giffgaff, Sky, iD) to the Magrathea DDI; record `Diversion`/`History-Info` | £0 inbound; ~£60–80 in PAYG SIMs |
| A1 | DDI → edge → Twilio SIP domain (IP ACL = edge only) → staging `<Client>`; 3 calls ≤ 2 min | < £0.10 |
| B (BYOC) | One DDI → Twilio BYOC trunk on staging; 3 calls; confirm the BYOC rate in usage records | < £0.05 |
| C (own delivery) | Internal build: HCG push sender → PushKit/CallKit and FCM/`ConnectionService` → dev SIP endpoint; 50 pushes per platform, killed/locked/Doze; push → ring P95 | **No PSTN, £0 telephony** |

---

## 9. Highest commercial value in ≤ 2 weeks

1. **Android delivery verification and fixes** (~8–10 person-days):
   - run P1–P11 on 1.0.2;
   - analyse `push_requested` → `app_invite_received` deltas, and set `timeout` from them;
   - file the Play FSI declaration (calling is the core function);
   - add an unanswered-call notice to the customer.

   **Why first:** a call that doesn't ring is an immediate refund or churn event, and Android is the larger share of the store market. No cost saving is worth anything if delivery fails.
2. **Carrier gate (≤1 day):** `providerPolicy.js:181` still marks Lebara `compatible`. Selling to customers who can't forward is a guaranteed refund.
3. **In parallel, the per-network `Diversion` probe** (~2 person-days, ~£80). It is decision-grade evidence for both Option A and pooling, before committing 30–50 person-days.

Option A/D1 itself (20–35 person-days) does **not** fit in 2 weeks.

---

## 10. Classification summary

- **WORKS TODAY:** Twilio → `<Client>` delivery (iOS production and B16; earlier Android builds); the measured costs; no outbound legs; Magrathea inbound and `Diversion` (n=1).
- **BUILT BUT UNPROVEN:** the Fortress backstop; Android 1.0.2; DT-1; `<Reject>` billed £0.
- **DEMONSTRATED FAILURE:** see §8.
- **NEEDS PROTOTYPE:** the edge and fork; A1; pooling lookup; Option C; push P95.
- **NEEDS PROVIDER COOPERATION:** Magrathea terms, failover, CDRs, PAI and porting; BYOC; Play FSI.
- **SPECULATIVE:** app-leg £0 continuing; abandonment; latencies; efforts (±40%).

## 11. Confidence and unknowns

- **High** confidence: the leg enumeration (grep-complete), the Magrathea facts and the push rules.
- **Medium** confidence: efforts and setup timings. No end-to-end timing has been measured.

**Key unknowns:** app-leg billing; Magrathea failover; customers re-entering forwarding codes; Android 1.0.2 push reliability in the field.

**Sources (web, read 2026-10-10):**
- Twilio GB voice pricing: https://www.twilio.com/en-us/voice/pricing/gb
- Apple PushKit VoIP: https://developer.apple.com/tutorials/data/documentation/pushkit/pkpushtype/voip.md and https://developer.apple.com/forums/thread/801446
- Firebase message priority: https://firebase.google.com/docs/cloud-messaging/android/message-priority
- Telnyx RN SDK push: https://developers.telnyx.com/development/webrtc/react-native-sdk/push-notifications
