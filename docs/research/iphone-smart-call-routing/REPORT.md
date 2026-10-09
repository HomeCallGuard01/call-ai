# HCG iPhone Smart Call Routing: Research Report

**Date:** 2026-10-09
**Branch:** `research/iphone-smart-call-routing` (docs only, cut from `origin/main` eb43368)
**Status:** desk research only. No calls were placed, no settings changed, and nothing was deployed or bought.
**Scope boundary:** this work is separate from the Android CallScreeningService/CFB work (`research/telephony-trusted-bypass`) and from the Magrathea trial (`research/magrathea-trial-poc`). It does not change either of them.

---

## 0. Answer to the central question

> *Can we make trusted calls free to HCG while still getting unknown calls to our conversational AI screening service on iPhone?*

**Conditionally feasible, and not through any Apple API.**

There is exactly one candidate that keeps the customer's number, SIM and handset with no carrier deal:

**Candidate A.** Turn on Apple's built-in *Screen Unknown Callers → Silence*, turn *Live Voicemail* off, and point the carrier's conditional forwarding (busy, no-reply and unreachable) at the customer's HCG number. Unconditional forwarding must be off.

It works only if one thing Apple does not document turns out to be true: **when iOS silences an unknown cellular call, the network must divert the call** (on busy/reject or on no-reply), rather than iOS answering it on the device or holding it until the caller hangs up. Apple says only that these calls are "silenced and sent to voicemail". It does not say how they reach voicemail.

A **£0, no-HCG test with the existing iPhone and Motorola** (section 6) settles this in under an hour. If the test fails, the answer becomes **not currently supported** on iPhone short of a carrier integration (Candidate D) or a SIM change (Candidate E).

Even if it passes, Candidate A has built-in limits the business needs to accept:

- **Apple decides who is trusted.** The trusted set is Contacts plus recent outgoing calls plus Siri Suggestions, so it is always at least as wide as HCG's list.
- **Some trusted calls still cost HCG money.** A missed or declined trusted call, or any call while the phone is off, ends up at HCG.
- **Screening switches off in some situations.** It turns off while roaming and for 24 hours after an emergency call, so unknown callers then ring the phone directly (fail-open).
- **Apple can change the behaviour** in any iOS update without notice.

---

## 1. Evidence levels used in this report

| Tag | Meaning |
|---|---|
| **[DOC]** | Stated in current Apple primary documentation (developer.apple.com / support.apple.com), quoted or closely paraphrased |
| **[STD]** | Stated in a telecoms standard (3GPP / GSMA) or established by earlier HCG research, with its source noted |
| **[INF]** | Technically inferred. Plausible, but not documented by Apple or the carrier |
| **[TEST]** | Can only be settled on a physical iPhone on a named UK network |

---

## 2. Findings by investigation item

### 2.1 CallKit and the Call Directory extension

- **[DOC]** A Call Directory extension supplies **static lists** of numbers to *identify* (a label) or *block*. "The system calls this method only when it launches the app extension and not for each individual call… you can't make a request to a web service to find information about an incoming call." ([Identifying and blocking calls](https://developer.apple.com/documentation/callkit/identifying-and-blocking-calls))
- **[DOC]** What blocking does: "When a phone number is blocked, the system telephony provider will disallow incoming calls from that phone number without displaying them to the user." ([addBlockingEntry](https://developer.apple.com/documentation/callkit/cxcalldirectoryextensioncontext/addblockingentry(withnextsequentialphonenumber:))) Apple does not say what "disallow" means on the network (reject/486, or something else).
- **[DOC]** Entries are exact numbers, given in ascending order. **There are no wildcards and no "everyone except" rule.** You therefore cannot express "block all unknown numbers" (UK mobile numbers alone run to about 10⁸).
- **[DOC]** Identification is consulted only *after* the system finds no match in Contacts. The app never sees the call, cannot decide in real time and cannot redirect it.
- **[DOC]** `CXProvider`/`CXCallController` handle only **the app's own VoIP calls**. They cannot answer, reject or forward a **cellular** call.
- **[STD, earlier HCG research 2026-09-30]** iOS 26 lets EU users choose a default calling app. That entitlement is EU-only and covers placing calls. It gives no control over incoming cellular calls.

**Conclusion:** no CallKit or Call Directory route can carry out "trusted → ring, unknown → HCG". At most, a Call Directory block on *specific known scam numbers* might cause a network reject (see 2.3). That is the opposite of what HCG needs.

### 2.2 Live Caller ID Lookup (iOS 18+)

- **[DOC]** The system asks the developer's server about an incoming number, using Private Information Retrieval over Oblivious HTTP with Privacy Pass tokens, and shows identity/blocking information ([IdentityLookup](https://developer.apple.com/documentation/identitylookup), [privacy article](https://developer.apple.com/documentation/identitylookup/understanding-how-live-caller-id-lookup-preserves-privacy)). Access requires approval from Apple. Developer forums report the request/response schema is thinly documented ([thread 773374](https://developer.apple.com/forums/thread/773374), [802273](https://developer.apple.com/forums/thread/802273)).
- **[STD, earlier HCG research 2026-10-01]** The data model is one shared database with a block flag. It has no per-household allowlist, and by design the server cannot know which household's phone is asking.
- **[INF]** Like Call Directory, it can only **block or label specific numbers**, and it cannot route.

**Conclusion:** not a routing mechanism. It could identify or block known scam numbers across all customers. It cannot send unknown calls to HCG.

### 2.3 iOS 26/27 unknown-caller features: what they actually do to the call

Settings path **[DOC]**: Settings → Apps → Phone → **Screen Unknown Callers**: *Never* / *Ask Reason for Calling* / *Silence* ([Manage unknown callers on iPhone, support.apple.com/111106](https://support.apple.com/en-gb/111106)).

| Feature | What Apple documents | What it means at network level | Usable for HCG routing? |
|---|---|---|---|
| **Never** | Unsaved numbers ring normally **[DOC]** | Normal alerting | Control case only |
| **Silence** | "Silences these calls and sends them to voicemail"; calls appear in Recents/Unknown Callers **[DOC]** | **Not documented.** There are three possibilities: (a) the iPhone rejects the call, so the network applies busy forwarding (CFB) at once; (b) the iPhone suppresses the ring while the network keeps alerting, so no-reply forwarding (CFNRy) fires when its timer runs out; (c) Live Voicemail answers on the device. **[TEST]** | **Yes, if (a) or (b).** No if (c) |
| **Ask Reason for Calling** | The iPhone automatically answers, asks for the caller's name and reason, transcribes the reply, then rings while the caller holds **[DOC + reporting]** | The call is **answered on the device**. The network sees an answered call, so no forwarding condition can fire **[INF, near-certain]** | **No.** It competes with HCG instead of routing to it |
| **Live Voicemail** (UK, iOS 17+/18+; Three says it is on by default) | Transcribes as the caller leaves a message, and you can pick up mid-message | **Answered on the device** when the iPhone would otherwise send the call to voicemail, which pre-empts network no-reply forwarding **[INF; HCG 2026-09-30 validation]** | **Must be OFF** for Candidate A |
| **Call Filtering → Unknown Callers** | Moves missed calls and voicemails from unknown numbers to a separate list **[DOC]** | UI only | Neutral |
| **Carrier spam filter** | Calls the carrier flags as spam are "silenced, sent to voicemail and moved to your Spam list" **[DOC]** | Depends on the carrier | Neutral |
| **Block Caller** (user block list) | Blocked callers' voicemails go to "Blocked Messages" **[secondary sources]**; callers report 0–1 ring before voicemail | Because the voicemail lands in *network* voicemail, the network must have diverted the call. Combined with the 0–1 ring, this points to a **reject → CFB** pattern **[INF, strong]** | Indirect evidence for how iOS "disallows" a call |

Documented exceptions **[DOC]**:

- "If you're roaming, phone calls are not screened, regardless of settings."
- "If you call the emergency services, call screening turns off for 24 hours."

Both are **fail-open**: unknown callers ring the phone directly.

**Who counts as "known" [DOC]:** the iPhone article says "phone numbers that aren't saved in your contacts" are unknown. Apple's Mac Phone-app guide says calls from **Contacts, recent outgoing calls and Siri Suggestions** still notify. **[TEST]** Whether numbers labelled by a Call Directory extension count as "known" is not documented.

**iOS 27** is current (Apple's guide version selector lists it). Third-party coverage describes the same three options plus "Type to Reply". Apple's support article does not yet name iOS 27. **[TEST]** Confirm the menu on the test device.

**The rule this report follows (from the brief):** silencing ≠ forwarding. Nothing in Apple's documentation says that Silence produces a network diversion. Section 6 tests exactly that.

### 2.4 Can unknown-caller handling trigger busy or no-answer forwarding to HCG?

- **[DOC]** The iPhone's **Settings → Apps → Phone → Call Forwarding** switch configures **unconditional** forwarding only (CFU, the equivalent of `**21*`). **CFU must be OFF** for any selective design, because it diverts every call before the phone sees it.
- **[STD]** Conditional forwarding is set with carrier MMI codes typed into the dialler: `**67*` (busy, CFB), `**61*…*11*T#` (no reply, CFNRy, T = 5–30 s), `**62*` (unreachable, CFNRc), and the query codes `*#67#`, `*#61#`, `*#62#`. Support varies by UK network: earlier HCG work found Three/giffgaff MMI unreliable.
- **[STD, GSMA IR.92 §2.2.4 / TS 24.604]** A user reject (UDUB) leads the device to send SIP 486, and CFB fires on 486. **Live evidence (Magrathea Test 4, 2026-10-09):** on Lebara/Motorola, a manual *Decline* triggered CFB to an external 03 number, and the call arrived with Diversion. Lebara later de-registered that divert.
- **[INF]** If iOS Silence works as either a reject **or** a suppressed ring, then **setting both CFB and CFNRy (plus CFNRc) to the HCG number catches the call either way**. Only on-device answering (Live Voicemail, Ask Reason) or an indefinite hold would defeat it.
- **[TEST]** Which of these iOS does, and whether the diverted call reaches the target with **the original caller's number and a Diversion/History-Info header**, on each UK network and iOS version.

### 2.5 Keeping HCG's trusted list and iPhone Contacts consistent; withheld and spoofed numbers

- **Apple's trusted set is wider than HCG's, and HCG cannot narrow it.**
  - The iPhone also rings for **recent outgoing calls and Siri Suggestions** **[DOC]**. If a customer calls back a scam number, that number becomes "known" **[INF]**.
  - Any number saved in Contacts always rings. HCG cannot make a saved contact go through screening.
- **Workable sync direction: iPhone Contacts are the master and HCG mirrors them.** The HCG app can *read* Contacts (with full access; iOS 18 "limited access" exposes only the contacts the user picks) and import them as HCG's trusted list. HCG can also *write* trusted numbers into Contacts through `CNContactStore`, for example in a "Home Call Guard" group. Two-way sync is possible, but deletions and "limited access" make it fragile **[INF]**.
- **Withheld / "No Caller ID":** Apple does not document whether Silence applies **[TEST]**. Android CallScreeningService does *not* screen withheld calls (they ring), so the platforms may differ.
- **Spoofed number of a trusted contact:** the iPhone rings and HCG never sees the call. This is the same on every handset-side design, including Android. Partial mitigation exists only in the network (Ofcom CLI rules, carrier spam filters).
- **HCG's own number:** with Candidate A, HCG's number is "unknown" to the iPhone unless it is saved in Contacts. That matters for any PSTN call-back from HCG (see 4.3).

### 2.6 Supported Apple APIs, carrier entitlements and network integrations

| Route | Status |
|---|---|
| Third-party API to answer, reject or redirect a cellular call | **None exists [DOC by absence]** |
| Carrier Bundle / carrier settings | Signed by Apple and distributed by the carrier, for MNOs only. It configures IMS and VoLTE, not per-call routing **[INF]** |
| Apple UK CMA interoperability request channel (from 2026-04-01) | It exists. Asking for a call-routing hook is a long shot, measured in years **[STD, HCG 2026-10-01]** |
| Network-side selective forwarding (3GPP TS 24.604 CDIV `cp:identity`/`anonymous` conditions) | The standard supports it, but GSMA IR.92 leaves it as "operator decides". **No UK consumer offering was found** (BT, Virgin and Sky landlines likewise) **[STD]** |
| UK MNO scam-filtering products | MNOs sell pre-answer filtering. None exposes "forward unknown callers to a third party" **[STD, HCG 2026-09-30]** |
| FMC / MVNO SIM routing every inbound call through a SIP hook (iQ Mobile, Gamma Connect, Wireless Logic, AQL) | Works on any handset, including iPhone, but **needs a new SIM/eSIM and a number port** **[STD, HCG 2026-10-01]** |

### 2.7 Carrier-assisted or hybrid without replacing SIM or number

- **Carrier-native selective CDIV (Candidate D)** is the only route that keeps SIM and number, gives HCG control and works on both platforms. It needs an MNO to switch on `cp:identity` rules for HCG customers, which is a commercial and regulatory project rather than an engineering one.
- **Handset + carrier hybrid (Candidate A)** keeps SIM and number using only consumer features that exist today. It is the only route available without a partner.
- **Dual-SIM/eSIM** (a second HCG eSIM alongside the customer's SIM) does not help. Incoming calls to the customer's existing number still terminate on their own SIM.

---

## 3. Candidate architectures

### Candidate A: Apple Silence + carrier conditional forwarding (handset/carrier hybrid)

```
                         Caller dials customer's existing 07 number
                                          │
                                          ▼
                     ┌───────────────────────────────────────────┐
                     │  Customer's MNO core (EE/O2/Voda/Three/…)  │
                     │  CFU  = OFF                                │
                     │  CFB  → HCG number   (**67*)               │
                     │  CFNRy→ HCG number   (**61*… *11*T#)       │
                     │  CFNRc→ HCG number   (**62*)               │
                     └───────────────────────────────────────────┘
                                          │ (call offered to handset)
                                          ▼
                     ┌───────────────────────────────────────────┐
                     │ iPhone  Screen Unknown Callers = Silence   │
                     │         Live Voicemail = OFF               │
                     └───────────────────────────────────────────┘
                 known caller │                       │ unknown caller
       (Contacts / recent out │                       │ (iOS silences)
        / Siri Suggestions)   ▼                       ▼
                 ┌──────────────────────┐   ┌─────────────────────────────┐
                 │ Rings normally        │   │ [TEST] iOS either:          │
                 │ answered → £0 to HCG  │   │  (a) rejects → 486 → CFB    │
                 │ missed  → CFNRy → HCG │   │  (b) keeps alerting → CFNRy │
                 │ declined→ CFB  → HCG  │   │  (c) answers on device ✗    │
                 └──────────────────────┘   └─────────────────────────────┘
                                                      │ (a) or (b)
                                                      ▼
                                   ┌─────────────────────────────────────┐
                                   │ HCG number (Twilio today)            │
                                   │ AI screening + existing safe rules   │
                                   │ approved → deliver via HCG app (VoIP)│
                                   └─────────────────────────────────────┘
```

### Candidate B: Call Directory or Live Caller ID blocking

```
  Caller ──► MNO ──► iPhone ──► is number on the app's block list? ──yes──► "disallowed"
                                         │                                   (probably reject → CFB → HCG [INF])
                                         no
                                         ▼
                                     rings normally (HCG never sees it)
```

This inverts the requirement: only numbers *already listed* reach HCG, and every unknown number rings. **Not viable** for "unknown → HCG". It could serve as an add-on that sends known scam numbers to HCG instead of voicemail.

### Candidate C: Apple's own screening (Ask Reason for Calling), no HCG

```
  Caller ──► MNO ──► iPhone ── unknown ──► iPhone auto-answers, Siri voice asks name/reason
                                           ──► transcript to user ──► user answers or ignores
                         └── known ──► rings
```

It costs HCG nothing on both paths, **but HCG is not in the call at all**. This is the baseline HCG competes against, not a route.

### Candidate D: Carrier-native selective forwarding (MNO partnership)

```
  Caller ──► MNO core: CDIV rule  "if caller ∈ household allowlist → no divert"
                                   "else (incl. anonymous)        → divert to HCG"
                 │ allowlisted                    │ other
                 ▼                                ▼
          customer's handset rings        HCG number → AI screening → app delivery
          (£0 to HCG)
```

It keeps SIM and number, works on iPhone and Android, and covers withheld calls. **No UK consumer product offers it, so it needs an MNO agreement and an allowlist provisioning API.**

### Candidate E: FMC / MVNO SIM with a per-call hook

```
  Caller ──► FMC/MVNO core ──SIP route request──► HCG policy service
                                   │ trusted                 │ unknown
                                   ▼                         ▼
                      core delivers to handset        core routes to HCG AI
                      (core's tariff, not HCG's Twilio)
```

It works on any handset and gives HCG full control, but **needs a new SIM/eSIM and a number port**, which breaks the "keep existing SIM" ideal.

### Baseline F: today's iPhone model (CFU to HCG, delivery through the app)

```
  Caller ──► MNO (CFU **21* → HCG) ──► HCG number ──► trusted? ──yes──► VoIP to HCG app (HCG pays inbound for whole call)
                                                         └──no──► AI screening
```

---

## 4. Comparison

### 4.1 Matrix

| | **A. Silence + cond. fwd** | **B. Call Directory block** | **C. Apple Ask Reason** | **D. Carrier CDIV** | **E. FMC/MVNO SIM** | **F. Today (CFU)** |
|---|---|---|---|---|---|---|
| **Feasibility today** | Conditional: one [TEST] decides it | Technically works, but the logic is inverted | Works, but leaves HCG out | No product exists | Commercial onboarding needed | Live |
| **Keeps number / SIM / handset** | Yes / Yes / Yes | Yes / Yes / Yes | Yes / Yes / Yes | Yes / Yes / Yes | Port / **No** / Yes | Yes / Yes / Yes |
| **Customer setup** | 1 Apple setting, Live Voicemail off, 3 MMI codes, CFU off | Install app, enable extension | 1 setting | None (carrier does it) | New eSIM + port | 1 MMI code + app |
| **Trusted, answered: HCG cost** | **£0** | £0 | £0 | **£0** | Host-core tariff | Inbound for whole call (≈£0.00756/min + delivery) |
| **Trusted, missed/declined/phone off** | Reaches HCG, which pays (needs a rule: voicemail or app ring) | Carrier voicemail | Carrier voicemail | Carrier rule | Core rule | HCG |
| **Unknown call: HCG cost** | Same as today (inbound + AI) | n/a: unknowns ring | £0 (no screening by HCG) | Same as today | Core + AI | Same as today |
| **Unknown-call delay** | (a) about 0–2 s; (b) CFNRy timer (5–30 s of ringback) | n/a | Apple's prompt | About 0 s | About 0 s | About 0 s |
| **Who controls the trusted list** | **Apple** (Contacts + recents + Siri Suggestions) | Apple + app | Apple | HCG | HCG | HCG |
| **Withheld numbers** | [TEST] | Ring | [TEST] | HCG (anonymous rule) | HCG | HCG |
| **Failure behaviour** | **Fail-open** while roaming, for 24 h after an emergency call, and if iOS changes; fail-to-HCG when the phone is off | Fail-open | n/a | Carrier-dependent | Core outage = no calls | Fail-closed to HCG |
| **Spoofed trusted CLI** | Rings and bypasses HCG | Rings | Rings | Bypasses HCG | Bypasses HCG (unless HCG uses attestation) | HCG sees it, but trusts it |
| **Change risk** | Apple and carrier can change it silently; MMI support varies | Apple | Apple | Contract | Contract | Low |

### 4.2 Failure behaviour of A in detail

| Condition | What happens | Severity |
|---|---|---|
| Roaming | Screening off [DOC], so unknown calls ring the phone and HCG is bypassed | Medium (customer is abroad) |
| Emergency call made | Screening off for 24 h [DOC], so unknown calls ring | **High for a vulnerable user**. The customer and dashboard must be told |
| Customer turns Live Voicemail back on, or an iOS update re-enables it | Unknown calls are answered on the device, never reach HCG, and no one notices | **High**. Undetectable unless HCG measures it (see 4.4) |
| CFU switched on by mistake | All calls go to HCG, so the trusted £0 is lost but the call is safe | Low (cost only) |
| Carrier drops the conditional divert (as Lebara did in Test 4) | Unknown calls go to carrier voicemail and HCG is bypassed | **High**. Needs periodic verification calls |
| Phone off or no signal | CFNRc sends all calls to HCG, including trusted ones | Low (safe; cost) |
| Trusted caller unanswered | CFNRy sends it to HCG, which must recognise the trusted number and take a message, without screening it as a scam | Low (needs a product rule) |
| HCG outage | Diverted unknown calls fail or go to HCG's fallback; trusted calls still ring | Same as today for unknowns |

### 4.3 Security notes

- **Loop risk.** Under A, any **PSTN** call-back from HCG to the customer's mobile carries HCG's caller ID. The iPhone treats that as unknown, silences it, diverts it to HCG, and the call loops. Approved unknown calls must be delivered **only through the HCG app's VoIP/CallKit path** (today's model). Otherwise HCG's number must be saved in Contacts **and** HCG must reject inbound diverted calls whose From is an HCG number. **[TEST]** whether *Silence* affects incoming CallKit VoIP calls from the HCG app; Apple documents it only for Phone and FaceTime.
- **Trust inflation.** Recent outgoing calls and Siri Suggestions grant "known" status that HCG cannot see or revoke. A scammer who gets the customer to call back once then bypasses HCG.
- **Consent and visibility.** The customer must understand that people in their Contacts are never screened.
- **Data.** Mirroring Contacts into HCG raises the privacy scope. Today's iOS app already imports Contacts for trusted contacts, so this is not new, but the policy wording should reflect it.

### 4.4 Telemetry needed for A in production (design note, not built)

HCG cannot see Apple's settings. It can only infer that protection has stopped working. Signals:

1. Diverted calls arriving carry Diversion/History-Info. Track arrivals per household per week; a drop to zero suggests Live Voicemail is back or the divert has been removed.
2. A scheduled verification call from an unknown HCG test number should arrive back at HCG within the expected time. This needs a cost decision.
3. In-app checks: the app cannot read Apple's call-screening or Live Voicemail state **[INF]**, so the app can only ask the customer to confirm.

---

## 5. What is documented vs inferred vs needs testing

| # | Statement | Level |
|---|---|---|
| 1 | No public API lets a third-party app answer, reject or redirect a cellular call | DOC (by absence; CallKit scope) |
| 2 | Call Directory lists are static, exact-number, and set at extension launch | DOC |
| 3 | A Call Directory block means the telephony provider "will disallow" the call without showing it | DOC (network meaning unknown) |
| 4 | Screen Unknown Callers: Never / Ask Reason / Silence; Silence "sends to voicemail" | DOC |
| 5 | Not screened while roaming; off for 24 h after an emergency call | DOC |
| 6 | Known = Contacts; also recent outgoing calls and Siri Suggestions (Mac guide) | DOC (iPhone article mentions Contacts only) |
| 7 | Ask Reason answers the call on the device | DOC + reporting |
| 8 | iPhone Settings Call Forwarding = unconditional only | DOC |
| 9 | Manual decline sends 486, and CFB fires | STD + Magrathea Test 4 (Android/Lebara) |
| 10 | Live Voicemail pre-empts network no-reply forwarding | INF |
| 11 | User block = reject leading to CFB | INF (strong: voicemail in "Blocked Messages", 0–1 ring) |
| 12 | **Silence produces a network diversion (CFB or CFNRy)** | **TEST, which decides the whole question** |
| 13 | The diverted call keeps the original CLI and carries Diversion | TEST |
| 14 | Withheld callers are silenced | TEST |
| 15 | Silence affects incoming CallKit VoIP calls from third-party apps | TEST |
| 16 | Call Directory-identified numbers count as "known" | TEST |
| 17 | Behaviour is consistent across EE/O2/Vodafone/Three/MVNOs and iOS 26 vs 27 | TEST (per network) |

---

## 6. Simplest safe proof of concept: existing iPhone + Motorola, £0 to HCG

**Purpose:** establish item 12 (and 14, plus 11 for comparison) without HCG, without a new number and without touching production. The iPhone's own carrier voicemail is the forwarding target, and the **timing on the caller's side** shows which mechanism fired.

> **Not to be run without Andrew's explicit approval. Claude has not performed any step below.**
> Only Andrew (or someone he designates) operates the handsets.

### 6.1 Preconditions and safety gates

| Gate | Check | Abort if |
|---|---|---|
| G1 | The iPhone is **not** a production HCG household with CFU active. Dial `*#21#` (query only) | CFU points to an HCG number. **Abort** until Andrew decides to switch it off and restore it afterwards (test calls would otherwise land in prod HCG) |
| G2 | Record the current state: `*#21#`, `*#67#`, `*#61#` (note the timer), `*#62#`; the Screen Unknown Callers value; the Live Voicemail value; iOS version; carrier | Any query fails. Note it as an MMI limitation and continue with timing only |
| G3 | CFB and CFNRy both point at **the iPhone carrier's voicemail number** (the usual UK default) | Either points elsewhere (for example HCG or a Magrathea DDI). **Abort**; Andrew decides |
| G4 | The Motorola is the prod-HCG/Lebara device. It is used **only to place outbound calls**. Do not change its forwarding (the Magrathea trial and the prod setup stay untouched) | Anyone proposes changing the Motorola's forwarding |
| G5 | The Motorola's number must be *unknown* to the iPhone: not in Contacts, not in recent outgoing calls. Check by search | It is known. Use option (i): temporarily remove that number from the contact after exporting it, and delete the matching Recents entries. Then T0 confirms it is now unknown. If T0 still rings, the test is void for that caller; use another non-HCG phone |
| G6 | Not roaming, and no emergency call in the last 24 h | Either is true |
| G7 | Cost: only the Motorola's ordinary outbound minutes to a UK mobile. HCG cost £0 | The Motorola's plan has no inclusive minutes |

### 6.2 Settings for the test (made by Andrew on the iPhone; Claude makes none)

- Screen Unknown Callers: set per test below
- Live Voicemail: **OFF** (except T5)
- Call Forwarding (Settings toggle, CFU): **OFF**
- Do Not Disturb/Focus: **OFF** (it would also silence calls and confuse the result)
- Leave CFB and CFNRy as recorded in G2 (voicemail). Do **not** dial any `**` code.

### 6.3 Test matrix

For each call, use a stopwatch on the Motorola from the moment you press dial. Record: the number of ringback tones heard, the seconds until the voicemail greeting, whose greeting it is (carrier or Apple/Siri voice), what the iPhone showed, and the Motorola's call duration. Run each test **3 times**.

| Test | iPhone setting | Caller action | Measures | Expected if mechanism (a) reject | (b) no-reply | (c) on-device |
|---|---|---|---|---|---|---|
| **T0** | Silence ON | Motorola calls (G5 check) | Unknown status | — | — | — |
| **T1** | Never | Known caller* lets it ring out (do not answer) | **CFNRy baseline time** ≈ timer from G2 | — | ≈ T_noreply | — |
| **T2** | Never | Call from Motorola; iPhone user taps **Decline** | **CFB baseline time** | ≈ 0–3 s | — | — |
| **T3** | Never | Motorola calls, iPhone answers | Normal ring (control) | rings | rings | rings |
| **T4** ★ | **Silence**, Live Voicemail OFF | Motorola (unknown) calls | **Decisive test** | Greeting ≈ T2 time | Greeting ≈ T1 time | Apple voice / transcript on iPhone |
| **T5** | Silence, **Live Voicemail ON** | Motorola calls | Interference check | — | — | Live Voicemail transcript appears, so (c) |
| **T6** | Silence, Live Voicemail OFF | Motorola dials `#31#<iPhone number>` (withheld) | Withheld handling (item 14) | as T4 if silenced; rings if not | | |
| **T7** | Ask Reason for Calling | Motorola calls | Confirms on-device answer | — | — | Siri voice asks for name/reason, so no network divert |
| **T8** | Never; Motorola number added to **Block Caller** | Motorola calls | Block mechanism (item 11) | ≈ T2 time | ≈ T1 time | — |
| **T9** | Silence | iPhone already on a call (to a known caller); Motorola calls | Busy plus unknown | CFB timing | | |

\*T1 can use the Motorola as the caller with the iPhone set to Never: the iPhone simply isn't answered.

**Pass criterion for the mechanism (on this network and iOS version):**

- T4 sends the call to **carrier voicemail** in 3 out of 3 runs, timed like T2 (reject/CFB) or like T1 (no-reply/CFNRy);
- no Apple/Siri voice is heard;
- **and** T3 rings normally.

**Fail:** T4 gives an Apple voice or transcript, or rings out with no voicemail, while Live Voicemail is OFF. Candidate A is then **not supported** on that network/iOS.

### 6.4 Restore (Andrew)

1. Screen Unknown Callers back to the G2 value.
2. Live Voicemail back to the G2 value.
3. Remove the Motorola from Block Caller.
4. Re-add the Motorola contact from the export.
5. If G1 required switching CFU off, restore it to the exact recorded target.
6. Re-query `*#21#`, `*#67#`, `*#61#`, `*#62#` and compare with G2.

### 6.5 Phase 2 (only if Phase 1 passes; needs a separate approval and incurs small cost)

Point the iPhone's `**67*` and `**61*` at a **non-production** test number. Use an isolated Twilio subaccount or the existing staging verification number, **not** prod HCG and **not** the Magrathea DDI unless Andrew chooses that. Give it a TwiML Bin that logs and rejects. Repeat T4 and T6, and confirm from the request:

- `From` = the Motorola's number (original CLI kept)
- a `ForwardedFrom`/Diversion header = the iPhone's number
- the arrival time

That proves items 12 and 13 end to end. Afterwards, restore the forwarding to voicemail.

### 6.6 What a pass does and does not prove

- **It proves:** on *this* iPhone, iOS version and UK network, Silence produces a network divert that HCG could receive.
- **It does not prove:**
  - other networks (each MNO and MVNO needs its own run; Three/giffgaff MMI is a known risk);
  - other iOS versions;
  - long-term stability (the Lebara-style divert de-registration needs repeat checks over days);
  - customer setup success rates.

---

## 7. Recommendation

**Conditionally feasible.** Candidate A is the only iPhone route that meets "existing number, SIM and phone, trusted calls £0 to HCG, unknown calls to HCG AI" without a carrier partner. It relies entirely on undocumented Apple behaviour (item 12) and on carrier conditional forwarding. No Apple API is involved, and none exists that could do this.

1. **Next step (£0):** run Phase 1 (section 6) on the existing iPhone, alongside the Android E1 work but without touching it, as Andrew already decided (E1 and E2 together).
2. **If T4 passes:** run Phase 2 (one non-production number). Then decide product rules for missed or declined trusted calls arriving at HCG, the telemetry in 4.4, and customer-facing wording ("people in your Contacts always ring and are never screened"; "protection pauses while roaming and for 24 hours after a 999 call").
3. **If T4 fails:** record the iPhone as **not currently supported** for £0 trusted calls. Keep Baseline F (CFU + app delivery) for iPhone, and pursue Candidate D (MNO CDIV) or E (FMC SIM) as the long-term route for both platforms.
4. **Do not** build Call Directory or Live Caller ID work for routing (Candidates B and C). Live Caller ID may still be worth a separate look for *identifying* scam numbers.

---

## Sources

- Apple Developer, [Identifying and blocking calls](https://developer.apple.com/documentation/callkit/identifying-and-blocking-calls)
- Apple Developer, [addBlockingEntry(withNextSequentialPhoneNumber:)](https://developer.apple.com/documentation/callkit/cxcalldirectoryextensioncontext/addblockingentry(withnextsequentialphonenumber:)), [CXCallDirectoryExtensionContext](https://developer.apple.com/documentation/callkit/cxcalldirectoryextensioncontext)
- Apple Developer, [IdentityLookup / Live Caller ID Lookup](https://developer.apple.com/documentation/identitylookup), [Understanding how Live Caller ID Lookup preserves privacy](https://developer.apple.com/documentation/identitylookup/understanding-how-live-caller-id-lookup-preserves-privacy), [LiveCallerIDLookupExtensionContext](https://developer.apple.com/documentation/identitylookup/livecalleridlookupextensioncontext); forums [773374](https://developer.apple.com/forums/thread/773374), [802273](https://developer.apple.com/forums/thread/802273), [811182](https://developer.apple.com/forums/thread/811182)
- Apple Support, [Manage unknown callers on iPhone (111106)](https://support.apple.com/en-gb/111106); [Phone app on Mac: unknown callers](https://support.apple.com/guide/phoneapp/phn2a83dc/mac)
- Vodafone UK device guide, [Use Live Voicemail (iPhone, iOS 26)](https://deviceguides.vodafone.co.uk/apple/iphone-16-ios-26/calls-and-contacts/use-live-voicemail/); Three Community, [Introducing Live Voicemail](https://community.three.co.uk/t5/Let-s-talk/Introducing-Live-Voicemail/m-p/66560)
- Reporting on iOS 26/27 call screening: [TechRadar](https://www.techradar.com/phones/iphone/call-screening-in-ios-26-has-finally-ended-my-spam-call-nightmare-heres-how-to-set-it-up), [PIRG](https://pirg.org/edfund/?p=17486), [AP via The Star](https://www.thestar.com.my/tech/tech-news/2025/10/10/one-tech-tip-annoyed-by-junk-calls-to-your-iphone-try-the-new-ios-26-call-screen-feature), [Technobezz](https://www.technobezz.com/how-to-set-up-and-use-call-screening-on-iphone)
- Apple Community, [unknown calls go direct to voicemail](https://discussions.apple.com/thread/255905244)
- Standards and earlier HCG research: GSMA IR.92 §2.2.4/§2.3.8; 3GPP TS 24.604 §4.9.1.3; HCG "Option A Critical Validation" (2026-09-30); "Next-gen telephony architecture" (2026-10-01); Magrathea Test 4 (2026-10-09)
