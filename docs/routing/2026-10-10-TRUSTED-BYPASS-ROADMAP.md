# Trusted-caller bypass: roadmap (2026-10-10)

> **Execution superseded by WS5 (2026-10-10):** `docs/routing/2026-10-10-WS5-TRUSTED-BYPASS-EXPERIMENT.md` and the runbooks in `docs/routing/ws5/` replace §3 (experiment steps), §5 (integration) and §6 (cost) of this roadmap. WS5 also found that probe v0.3 crashes after each screened call on Android 10 (an API-30 call in its log line), which adds a gate to Test A. §2, §4, §7, §8 and decisions TB-1..TB-5 still stand.

**Status: synthesis and plan only.** Nothing was built, installed, dialled or changed. No APK built, no adb, no carrier contact. Every 🔴 step needs Andrew's approval.
**Owner:** WS3 (mobile, routing and handset validation), launch `launch/controlled-launch-2026-10-09`.
**Does not block the launch.** The first Android cohort ships on today's unconditional forwarding (`**21*`) with the honest allowance UX added by WS3 on 2026-10-10 (screening-paused banners plus a customer-pressed "Turn off call forwarding" action).

**Sources (read only, not modified):**
- `/Users/ad/call-ai-telephony-architecture`, branch `research/telephony-trusted-bypass` @ `b5fdced`: `research/telephony/TRUSTED_CALL_BYPASS_ARCHITECTURE.md`, `E3_SILENCE_NO_ANSWER.md`, `EXPERIMENT_E1_ANDROID_BUSY_DIVERT.md`, `E1_RUNBOOK_MOTOROLA.md`, `android-divert-probe/` (probe source), `divert-landing-probe/`, `economics/`.
- `/Users/ad/call-ai-iphone-call-routing` @ `acc545c`: `docs/research/iphone-smart-call-routing/REPORT.md`, `TEST_CHECKLIST_PHASE1.md`.
- `/Users/ad/call-ai-magrathea-trial` @ `f664aaf`: `docs/carriers/MAGRATHEA-LIVE-CALL-EVIDENCE.md` §13 (Test 4) and the §13.4 correction; `MAGRATHEA-TRANSFER-READINESS.md`.

---

## 0. Summary

1. **While customers use `**21*` (forward every call), HCG pays for every trusted call, and no provider can change that.** The network sends every call to HCG before anyone knows who is calling. The only non-looping way back to the same handset is the VoIP app leg, so HCG's provider bridges the whole conversation. Twilio, Telnyx, Plivo, Magrathea, SIP REFER and BYOC change only the rate.
2. **The only £0 route is to decide on the handset, before the network diverts.** The first candidate, Android reject plus busy-forwarding (CFB, `**67*`), is **NO-GO on the only phone and network tested** (Lebara, Motorola, 2026-10-09: Decline gave the caller busy or disconnect, not the busy divert).
3. **Lead candidate: Android SILENCE plus no-reply forwarding (CFNRy, `**61*<number>**<seconds>#`).** HCG's call-screening service *silences* unknown callers without rejecting them. The phone stays "ringing" on the network, so the carrier's no-reply timer diverts them to HCG. Trusted callers ring natively, and HCG never sees them. The AOSP source supports this strongly, but it is **untested**. Probe APK v0.3 is built (`~/hcg-android-probe/v0.3`, SHA-256 `2ac081ee…18a4`) and has never been installed.
4. **Quickest experiment (§3): about 30 minutes, £0, two phones.**
   - Phase 1 sends no-reply forwarding to the **carrier's voicemail** and changes no forwarding.
   - Phase 2 (a separate 🔴 approval, about £0) points no-reply forwarding at an **HCG staging test number** whose answer is a `<Reject>` (Twilio does not bill rejected calls).
5. **Under this architecture, allowance exhaustion becomes automatic and server-enforced.** When screening is paused, the app stops silencing, so the phone behaves normally. HCG incurs cost only when it *answers*, and a diverted call can be refused at £0. Today, under `**21*`, it is **not** automatic: the customer has to dial the cancel code (which is why WS3 built the guided "Turn off call forwarding" action).
6. **iPhone:** there is no API for this. The only candidate uses Apple's *Silence Unknown Callers*, with Live Voicemail off, plus conditional forwarding. It is untested, and the T4 Phase 1 checklist is ready.

---

## 1. Evidence: PROVEN vs EXPERIMENTAL vs DISPROVEN

"PROVEN" means established by a physical HCG test or by authoritative documentation/source for the stated scope only. "DOC/SOURCE" means documented or read in source but not seen on an HCG device.

### 1.1 PROVEN

| # | Fact | Scope / evidence |
|---|---|---|
| P1 | `**21*` (unconditional) to an HCG Twilio geographic number works, and HCG delivers the call into the app | Lebara founder test 2026-09-16 (`services/providerPolicy.js` lebara note); production since August |
| P2 | Under `**21*`, no provider can drop the trusted leg from HCG's bill | Twilio/Telnyx/Plivo docs (2026-09-30); REFER is SIP-only; Magrathea, Ben LKV-51353-279: "REFER unsupported"; `TRUSTED_CALL_BYPASS_ARCHITECTURE.md` §2–3 |
| P3 | Trusted calls under `**21*` cost about £0.00756 per started inbound minute for the whole conversation | Verified on the Twilio Call resource (memory: trusted call cost path) |
| P4 | A call diverted by a UK mobile reaches an external endpoint with the original caller in `From`/RPID and the **diverting mobile in `Diversion`** | Magrathea Test 4, Lebara, 2026-10-09 (§13.2–13.3). **The divert type is unknown (`reason=unknown`)** |
| P5 | Android platform rules for `CallScreeningService` (DOC/SOURCE): contacts are not passed unless the app holds `READ_CONTACTS`; withheld, restricted or payphone calls are not passed; 5 s response limit; `setSilenceCall(true)` does not reject, and the call goes down the normal "add call" path with ringing suppressed | AOSP `CallScreeningService` javadoc; Telecomm `CallsManager.onCallFilteringComplete`, `Ringer.java`, Android 10 and main (`E3_SILENCE_NO_ANSWER.md` §2 D1–D4) |
| P6 | A call refused with `<Reject>` is never connected by Twilio, so no inbound minutes accrue (DOC; the probe says to confirm £0 on the Call resource) | Twilio docs, as used by `divert-landing-probe` |
| P7 | Probe v0.3 is built as specified: no permissions, SILENCE mode, 2 h auto-off, 37/37 unit tests | Build record `E3_SILENCE_NO_ANSWER.md` §5. Artefact only, never run on a phone |

### 1.2 EXPERIMENTAL (plausible; untested by HCG)

| # | Hypothesis | Why plausible | What would settle it |
|---|---|---|---|
| X1 | **A silenced call stays eligible for CFNRy.** The network sees an unanswered, alerting call, so the no-reply divert fires | P5: Telecom treats a silenced call as a normal ringing call; no reject is sent (inference A1, strong) | §3 Phase 1 (B2) |
| X2 | The carrier accepts **CFNRy to an HCG number** | `**21*` to the same geographic number type worked on Lebara (P1). But Lebara says forwarding to **03** numbers is unsupported, and `**67*` to the Magrathea 03 number de-registered itself | §3 Phase 2 |
| X3 | Motorola/OEM Phone apps don't override silence (no OEM auto-reject or spam reject) | AOSP behaviour; OEM changes unknown (A2) | §3 Phase 1 |
| X4 | CFNRy applies on VoLTE and Wi-Fi Calling as it does on 2G/3G | 3GPP TS 24.604 IMS CDIV includes no-reply (A4) | Phase 1 with Wi-Fi Calling noted |
| X5 | iPhone *Silence Unknown Callers* leaves the call to the network (reject→CFB or silent ring→CFNRy), not answered on the device | Apple says only "silenced and sent to voicemail"; Block Caller's 0–1 ring hints at reject→CFB (iPhone REPORT §2.3) | T4 Phase 1 checklist (D4) |
| X6 | Other UK networks (EE, O2, Vodafone, Three, giffgaff, Sky, Tesco, iD, SMARTY, VOXI) behave like Lebara for CFNRy | Standard GSM/IMS service | Carrier matrix stage (§7, Stage 3) |
| X7 | Samsung One UI binds the screening service reliably (system binding, not app standby) | Telecom binds the role holder | Stage 3 |

### 1.3 DISPROVEN or NO-GO

| # | Idea | Result |
|---|---|---|
| D1 | **Android Decline/reject → busy-forwarding (CFB)** | **NO-GO / contradicted on Lebara + Motorola (2026-10-09).** With CFU off and CFB accepted to Lebara voicemail, a manual Decline gave the caller busy or disconnect, not voicemail (call waiting on). Test 4's divert type is unproven (§13.4). A screening-service reject sends the same signal as Decline (`Call.reject` → UDUB / `CODE_USER_DECLINE`), so E1 is superseded by E3. *Untested on other networks; do not rely on it anywhere.* |
| D2 | A provider swap (Telnyx, Plivo, Simwood, Magrathea) removes the trusted leg under `**21*` | Disproven by topology and documentation (P2). It only changes the rate |
| D3 | SIP REFER hands the call back to the carrier | Magrathea does not support REFER (LKV-51353-279), and the only PSTN target would loop anyway |
| D4 | iPhone Call Directory or Live Caller ID as a router | Not viable. These are exact-number block/label lists with no "everyone except" rule (Apple docs) |
| D5 | iPhone "Ask Reason for Calling" or Live Voicemail alongside conditional forwarding | Incompatible. The call is answered on the device, so no divert condition can fire (near-certain inference). Both must be **off** |
| D6 | Consumer selective call forwarding on UK networks | None found (only the four GSM divert types are offered to consumers) |
| D7 | Lebara `**67*` to a Magrathea **03** number as a stable registration | Worked once. The setting then showed *inactive*, and re-registration gave "Connection problem or invalid MMI code" (§13). The Motorola's busy destination still needs restoring via Lebara support |

---

## 2. The lead architecture: Android SILENCE + CFNRy

```
Customer's forwarding:  CFU (**21*) OFF.  CFNRy (**61*<HCG number>**<15–20>#) ON.
                        CFB and CFNRc stay at carrier voicemail (unchanged).

TRUSTED (phone contact, or on the HCG trusted list synced to the app)
  Caller ─PSTN─▶ carrier ─▶ handset: HCG CallScreeningService → ALLOW (or not consulted) → RINGS natively
  HCG legs: NONE. Cost to HCG: £0. The customer answers on the normal Phone app.

UNKNOWN (screening ACTIVE)
  Caller ─PSTN─▶ carrier ─▶ handset: HCG service → SILENCE (no ringtone; NOT rejected)
                     └─ no answer for N s ─▶ carrier CFNRy ─▶ HCG number ─▶ existing announce + monitor
                                                                  + <Dial><Client> back to the same handset
                                                                  (VoIP leg, no loop)

TRUSTED BUT UNANSWERED ("leakage")
  Rings natively for N s, nobody answers ─▶ CFNRy ─▶ HCG. /voice sees From ∈ trusted list:
  never monitor, never ring the app again → <Reject> (£0) or a short message (≈1 billed min).

WITHHELD / UNKNOWN PRESENTATION
  Never passed to the screening service → rings natively (unscreened).

APP DEAD, ROLE LOST, 5 s TIMEOUT, PHONE ON ANOTHER APP
  Telecom rings the call normally → FAIL-OPEN (reachable, unscreened).
```

**Behaviour customers will notice:**
- Unknown callers hear ringing for the no-reply timer (typically 15–30 s, sometimes as low as 5 s) before HCG answers. The customer's phone shows the silenced call; then the HCG app rings for it after screening.
- A trusted call the customer misses goes to HCG, not to their carrier voicemail, unless HCG's leakage treatment is "take a message".
- The phone never goes dead because of HCG. Every HCG failure leaves the phone working normally.

**What the app can and cannot do:** an app cannot register or erase network forwarding by itself. That needs the privileged `MODIFY_PHONE_STATE`, or `CALL_PHONE` plus USSD, which is a dangerous permission with no reliable result. The customer still sets CFNRy once by pressing Call, using the same guided dialer pattern as today's activation and turn-off screens.

---

## 3. Quickest £0 experiment (E3), exact steps

**Equipment:** iPhone `…2700` as the caller (its HCG app **signed out**) and the spare Motorola (Lebara `…3030`) as the phone under test.
**Never** in the same window as the launch handset session (B2). That session sets `**21*` on the Motorola, and CFU overrides CFNRy. Run E3 on a different day, after B2's mandatory reset (forwarding confirmed off).

### 3.1 Approvals needed (Andrew)

| # | Approval | Phase |
|---|---|---|
| E3-A1 | Run Phase 1: install the archived probe v0.3 APK (`~/hcg-android-probe/v0.3/hcg-divert-probe.apk`, verify `.sha256` first) on the Motorola via USB debugging, grant the call-screening role, about five iPhone→Motorola calls of under 30 s each | 1 |
| E3-A2 | 🔴 Change the Motorola's no-reply forwarding to the staging HCG number, then restore it to the recorded voicemail value | 2 |
| E3-A3 | 🔴 Landing target for the diverted calls. `divert-landing-probe` is a Twilio Function written for a **new, non-production test number**. It answers with `<Reject reason="busy">` (Twilio does not connect the call; confirm £0 on the Call resource) and logs `From`/`To`/`ForwardedFrom` **unmasked** into Twilio's Function logs. Choose one: **(a)** buy one test number (≈£1/month; a purchase, so it needs approval; release it afterwards), or **(b)** temporarily point the staging number `…1883` at the Function for the window only, then empty its voice URL. Staging sits on the production Twilio account, so (b) is a production-account config change. Recommendation: (b), because it is the same number type that already worked for CFU on Lebara and buys nothing | 2 |
| E3-A4 | If Lebara refuses `**61*` to a geographic number: stop. Do not try 03 or other number types without a new approval | 2 |

### 3.2 Phase 1: silence → CFNRy → carrier voicemail (changes no forwarding)

Follow `E3_SILENCE_NO_ANSWER.md` §3 and §6 exactly. Summary:

**Gates (read-only codes on the Motorola):**
1. `*#21#` must show **not forwarded**.
2. `*#61#` must show **Lebara voicemail** (record the number and seconds).
3. `*#67#`: record it (known wedged state from Test 4).
4. The iPhone number is not in the Motorola's contacts.
5. Record the Android version, Wi-Fi Calling state and the current Caller ID & spam app.

| Step | Action | PASS | FAIL |
|---|---|---|---|
| A1 | No app installed. iPhone calls; don't touch the Motorola; time it | Rings audibly; Lebara greeting after *N* s | Rings out, or busy → **stop** (nothing for SILENCE to divert to) |
| B0 | Install probe, grant role | "Screening role held: YES" | Role unavailable → stop, record |
| B1 | OBSERVE mode, call | Rings; `decision=ALLOW` | — |
| B2 | **SILENCE mode, call, don't touch** | **No ringtone; iPhone hears ringing, then the Lebara greeting after ≈ *N* s (±3 s); `decision=SILENCE`; Motorola call log shows a missed call (not "blocked")** | Busy or disconnect (= rejected somewhere), or rings out with no voicemail |
| B3 | Allow-list the iPhone, call | Rings audibly | — |
| B4 | (optional) SILENCE, answer on the Motorola | Connects normally | — |

**Phase 1 PASS** = A1, B1, B2 and B3 all pass, with B2 repeated 3 times (3/3).
**Restore:** OBSERVE → clear the allow-list and log → restore the Caller ID & spam app → uninstall the probe → USB debugging off → `*#21#`, `*#61#` and `*#67#` match the gates.

### 3.3 Phase 2: silence → CFNRy → HCG staging number (only after Phase 1 PASS)

1. 🔴 Attach `divert-landing-probe` (`PROBE_MODE=reject`) to the chosen number (E3-A3). Read back the voice URL. The number below assumes option (b), staging `…1883`.
2. 🔴 On the Motorola: `**61*+442046521883**15#` → Call. Then `*#61#` must show the staging number and 15 s. If you get "invalid MMI" or "not allowed", **stop** (that is result X2 = FAIL on Lebara).
3. Reinstall the probe (Phase 1 procedure), SILENCE mode.

| Step | Action | PASS |
|---|---|---|
| C1 | Unknown iPhone call, don't touch | Motorola silent; after ≈15 s the iPhone hears busy or rejection (the probe's `<Reject>`); the landing probe logs **one** request with `From` = the iPhone CLI (masked) |
| C2 | Allow-list the iPhone, call, **answer** on the Motorola | Rings natively; **zero** requests at the landing probe |
| C3 | Allow-listed, **don't answer** | Rings natively for ≈15 s, then **one** request at the landing probe (the leakage path, expected) |
| C4 | Contact (add the iPhone as a contact, clear the allow-list), answer | Rings natively; zero requests (platform contact path) |

**Phase 2 PASS** = C1 3/3, C2 0 requests, C4 0 requests. C3 is recorded (it sizes leakage).

**Restore, in order:**
1. `**61*<recorded voicemail number>**<recorded seconds>#`. Claude prepares the exact string from the Phase 1 gate values for Andrew to approve. **Never `##61#`**, which would erase voicemail-on-no-answer.
2. `*#61#` matches the gate.
3. Staging voice URL emptied and read back.
4. Uninstall the probe.
5. Twilio: the calls show as rejected or unbilled.

**Cost:** Phase 1 £0 to HCG. Phase 2 about £0 (`<Reject>` is unbilled; at most a few pence if the landing probe ever answered). Lebara usage on both SIMs is within plan.
**What a pass proves:** on Lebara and this Motorola, silence leaves calls eligible for CFNRy, and CFNRy to an HCG geographic number works. It says nothing about other networks or OEMs (Stage 3).

### 3.4 iPhone counterpart (T4, parallel, £0)

Run `TEST_CHECKLIST_PHASE1.md` from the iPhone report unchanged. It uses Silence plus carrier voicemail only, dials no `**`/`##` codes, and the Motorola is the caller. It needs its own approval and can run in the same session as §3.2 with the roles swapped. Its Phase 2 (external number) needs separate approval.

---

## 4. Allowance exhaustion becomes automatic

| | Today (`**21*`) | SILENCE + CFNRy |
|---|---|---|
| Who receives every call | HCG first | The phone first; HCG only gets silenced or unanswered calls |
| Screening paused (allowance used) | HCG must keep bridging every call (cost) or refuse it (the caller hears busy). Returning to normal needs the **customer to dial the cancel code** (WS3's guided "Turn off call forwarding", not automatic) | The backend's allowance state reaches the app (`allowanceState.screeningActive=false`). The app **stops silencing**, so every call rings natively. **Nothing for the customer to do.** |
| A call still diverted while paused (unanswered, or the app hasn't refreshed yet) | — | `/voice` refuses it with `<Reject>` (**£0**), or plays a short "not available" message. Server-enforced even if the phone is offline |
| Hard ceiling | Forwarded calls may fail; trusted delivery depends on the reserve | Trusted calls never touch HCG, so they are **never cut off by HCG**. Only unanswered calls are affected |
| App dead or uninstalled | Callers hear "can't connect" (fails **closed**) | Phone rings normally (fails **open**) |

The financial guarantee no longer depends on the app: HCG only spends money when it *answers*, and the server decides that per call. The app's silence switch only makes the customer experience good (normal ringing instead of a rejected call).

**Honest limit:** with CFNRy pointing at HCG, an unanswered call while paused goes to HCG, not to the customer's carrier voicemail. For a fully normal phone (voicemail included), the customer still has to restore CFNRy to voicemail. The app can offer that with the same guided dialer (`**61*<voicemail>**<s>#`), and it needs no urgency.

---

## 5. Product integration design (not built; for planning)

### 5.1 Android app
- **Native module:** an Expo config plugin plus a Kotlin `CallScreeningService` (`android.permission.BIND_SCREENING_SERVICE` on the service), and role request UI via `RoleManager.createRequestRoleIntent(ROLE_CALL_SCREENING)`. API 29+ (Android 10+). This needs a new EAS build and `app.config.js` changes (owned outside WS3; listed in the WS3 report as needed changes).
- **Allow-list on the device:** the trusted contacts the app already uploads (`/(setup)/contacts`) are mirrored to app-private storage (normalised E.164). The service only reads local data; there is **no network call inside the 5 s budget**.
- **Phone contacts:** HCG already holds `READ_CONTACTS`, so the platform *will* pass contacts to the service. The service must allow them explicitly (`ContactsContract.PhoneLookup`) or trust only the HCG list. **Decision TB-2** (recommend: allow phone contacts, matching the customer's intuition and Apple's model).
- **Modes:** `OFF` (allow all) / `SILENCE_UNTRUSTED`. Driven by the server's allowance state (`screeningActive`) plus a local kill switch. There is never a reject mode (D1).
- **Health:** report `roleHeld`, mode and last decision time with the existing device-readiness report (`/api/v1/voice/device-readiness`, authenticated). If the role is lost or another app holds it (Truecaller, Hiya), Home shows "Smart routing is off — calls ring normally, unknown callers aren't checked", never "Protected".
- **Fail-open everywhere:** exception, timeout, missing list, unknown mode → ALLOW.

### 5.2 Backend (outline; owned by WS1/WS2)
- A `forwarding_mode` per household (`unconditional` | `no_reply`).
- In `/voice`, when the mode is `no_reply` and the caller is trusted, treat the call as leakage: no monitoring, no app ring, then `<Reject>` or a short message (**decision TB-3**).
- When screening is paused, diverted unknown calls get `<Reject>` (£0).
- Activation and verification copy for `**61*…**15#` per carrier. Forwarding proof (LF-2) needs a CFNRy-aware design: a support call that goes unanswered on purpose.

### 5.3 Google Play policy (to re-verify against live policy pages before any build; no network access in this session)
- `ROLE_CALL_SCREENING` is a role, not a restricted permission. The research found no Permissions Declaration Form requirement, and HCG needs **no** `READ_CALL_LOG`/`PROCESS_OUTGOING_CALLS` (the restricted call-log group is avoided). *Verify on the day.*
- `READ_CONTACTS` is already declared. It needs prominent in-app disclosure and a Data safety entry (contacts are processed on the device for routing; the trusted list is already sent to the server). Update the store listing and privacy policy wording.
- No new purchase surface. This does not change Option C.

### 5.4 Carrier matrix (what is known)

| Network | CFU `**21*` (today) | CFNRy MMI | CFNRy to HCG geographic | Notes |
|---|---|---|---|---|
| Lebara | ✅ founder test (activation only) | Gate reading only | ❓ Phase 2 | Says forwarding to 03 is unsupported; `**67*` to 03 de-registered (D7) |
| EE | MMI (activation) | ❓ | ❓ | No confirmed cancel code (providerPolicy) |
| O2 / Vodafone / SMARTY / iD / VOXI / Tesco / Sky / Talkmobile / Lyca / ASDA / 1pMobile | Varies (providerPolicy) | ❓ | ❓ | Sky uses the `#61#` family for cancellation (native settings) |
| Three | Native Settings only (MMI reportedly broken) | ❌ via MMI | Android Phone-app Settings "When unanswered" may work ❓ | iPhone on Three cannot set CFNRy (no Settings UI) |
| giffgaff | Native Settings | ❓ (MMI undocumented) | ❓ | As Three for iPhone |

### 5.5 iPhone limits
- No API can reject, silence or route a cellular call. The only route is Apple's **Silence Unknown Callers** plus Live Voicemail **off** plus CFNRy/CFB (and optionally CFNRc) by MMI. iOS Settings only offers unconditional forwarding.
- Apple decides who is trusted (Contacts, recent outgoing calls, Siri Suggestions). To honour HCG's list, the app would write trusted numbers into Contacts.
- Screening turns off when roaming and for 24 h after an emergency call (fail-open). Apple can change the behaviour in any iOS release.
- Three and giffgaff iPhones probably can't use it (no MMI), so they stay on `**21*`.
- Allowance exhaustion **cannot** become automatic on iPhone: the app can't switch Silence off. The server-side `<Reject>` still caps cost, and the customer turns Silence off themselves.

---

## 6. Cost model impact

From `economics/` in the research branch (typical profile: 180 trusted + 20 unknown min/month, unchanged Twilio rates):

| | Cost/sub/month | Trusted part | Break-even trusted min |
|---|---:|---:|---:|
| Today (`**21*`, Twilio) | £2.81 | £1.51 | ≈276 |
| SILENCE + CFNRy, leakage `<Reject>`ed | ≈£1.30 | **≈£0.00** | unbounded |
| SILENCE + CFNRy, leakage gets a ~1 min message (assume 15% of trusted calls unanswered) | ≈£1.33 | ≈£0.03 | unbounded |

Assumptions: the number rental (£0.87) becomes the largest fixed line, and monitored minutes are unchanged (≈£0.0187 post-fix). Unknown calls cost the same as today once HCG answers; the extra CFNRy ring time is not billed to HCG. The research model's "D" figure (£1.31) used a CFB leakage share of 5%. CFNRy leakage is the unanswered-trusted-call share, measured in Phase 2 C3 and later in production telemetry. **Trusted-call cost becomes independent of how long people talk.** That removes the uncapped trusted-minute exposure flagged in the cost-safety work, for Android customers on proven carriers only.

---

## 7. Staged plan (never blocks the launch)

| Stage | What | Cost | Gate to continue |
|---|---|---|---|
| **0 (now)** | Launch on `**21*`. WS3 allowance banners plus the guided "Turn off call forwarding" action. No bypass claims anywhere (website, store, app) | — | Launch GO as planned |
| **1** | E3 Phase 1 (§3.2) + iPhone T4 Phase 1 (§3.4), one attended session **after** the B2 handset session | £0 | E3-A1 / T4 approval; PASS 3/3 |
| **2** | E3 Phase 2 (§3.3): CFNRy to the staging HCG number with `<Reject>` landing | ≈£0 | E3-A2/A3; PASS C1/C2/C4 |
| **3** | Carrier matrix: PAYG SIMs on EE, O2, Vodafone and Three (≈£10 each), plus one Samsung, repeating Phase 1/2 per network | ≈£40–60 | Approval to buy SIMs; ≥3 major networks PASS |
| **4** | Build behind a flag: Kotlin service + plugin, allow-list sync, role/health reporting, backend `forwarding_mode` + leakage branch + paused `<Reject>`, CFNRy activation copy. Play **Internal** track only; opt-in for one or two cohort members on proven carriers | 2–4 weeks eng | Decisions TB-1..TB-5; Play policy re-check; handset plan rows for role loss / fail-open |
| **5** | Default for new Android signups on proven carriers; `**21*` stays for unproven ones and for iPhone until T4 passes | — | 30 days of Stage 4 telemetry: leakage share, zero unexpected busy, zero "phone went dead" reports |

### Decisions for Andrew
- **TB-1:** approve Stage 1 (E3 Phase 1 + T4 Phase 1) for a date after the B2 handset session.
- **TB-2:** under SILENCE, trust phone contacts as well as the HCG list (recommended), or the HCG list only.
- **TB-3:** leakage treatment for an unanswered trusted call: `<Reject>` (£0, the caller hears busy) or a short "not available, try later" message (≈£0.008, kinder).
- **TB-4:** CFNRy timer (15 s recommended: shorter wait for unknown callers, still enough time to answer trusted ones).
- **TB-5:** when screening is paused, should a diverted unknown call get `<Reject>` (£0) or a brief message? Under §4 the app stops silencing, so few calls should arrive.

---

## 8. Risks

- **Silence might be treated as reject on some OEMs or networks** (as Decline was on Lebara). Phase 1 B2 detects this, and Stage 3 repeats it per network.
- **Carriers may refuse CFNRy to non-carrier numbers** (Lebara's 03 refusal, `**67*` de-registration). Phase 2 tests the geographic HCG number type, which already worked for CFU.
- **Fail-open is a change of promise:** an HCG failure means unscreened calls ring, not that calls stop. Customer copy must say this, and it must never show "Protected" when the role is not held.
- **Withheld callers ring unscreened** (platform rule). The dialer's "block private numbers" is a reject → busy (D1), so it does not help here.
- **Role conflict** with Truecaller/Hiya: only one app can hold the role.
- **The Motorola's wedged `**67*` state** from Test 4 is still unrestored (Lebara support). Record it at the gates; don't try to fix it during E3.
