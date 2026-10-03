# POC 1 specification — handset decides, network forwards (DESIGN ONLY)

**Status: NOT AUTHORISED. Nothing in this file has been run.** No number bought, no forwarding changed, no probe installed, no call placed.

This deepens "What exactly does POC 1 prove?" in the decision report. It reuses, and does not replace, the existing runbook `research/telephony/E1_RUNBOOK_MOTOROLA.md` and probe APK v0.2 (branch `research/telephony-trusted-bypass`, worktree `/Users/ad/call-ai-telephony-architecture`, uncommitted edits on 07a0a38).

## 1. The question POC 1 answers

> When the handset declines (Android) or silences (iPhone) an unknown caller, does the customer's UK network forward that call to HCG, quickly, with the original caller's number intact — while trusted callers ring natively and never reach HCG?

## 2. Does screening happen before carrier diversion?

**It depends on which forwarding is set, and this is the core of the design.**

| Forwarding type | Where it acts | Does the handset (and its screening) see the call first? | Usable for POC 1? |
|---|---|---|---|
| CFU **21* (today) | In the network, before paging the handset | **No.** The handset never sees the call; screening can't act | No: must be **off** |
| CFB **67* (busy) | Network, after the handset answers "busy" (UDUB / SIP 486, possibly 603) | Yes: the handset is paged, screening decides, decline → busy | **Yes: the mechanism under test** |
| CFNRy **61* (no reply) | Network, after the no-reply timer (typically 5–30 s) | Yes: handset is alerted (or silently alerted) | Fallback: works for iPhone "silent ring"; slower |
| CFNRc **62* (not reachable) | Network, when the handset is off/out of coverage | No (handset unreachable) | Optional: decides what happens when the phone is off (unknown **and** trusted calls would go to HCG) |

So the customer's onboarding must change from "**21* to HCG" to "##21# then **67* (and optionally **61*/**62*) to HCG". POC 1 must prove that change works on each network.

## 3. Android mechanism (exact)

| Step | API / mechanism | Evidence |
|---|---|---|
| Role | `RoleManager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)`; user grants once | AOSP / developer docs |
| Binding | System binds the app's `CallScreeningService` (`android.permission.BIND_SCREENING_SERVICE`) per incoming call; must call `respondToCall` within 5 s or the call is allowed (fail-open) | AOSP traced 2026-09-30 |
| Trusted | `respondToCall(details, CallResponse.Builder().build())` (allow) → native ringing; HCG never sees the call | By design |
| Unknown | `setDisallowCall(true).setRejectCall(true)` → `Call.reject(false, null)` → `REJECT_REASON_DECLINED` (same as manual Decline). `setDisallowCall` **without** `setRejectCall` does **not** reject: the network keeps ringing → CFNRy only | AOSP traced |
| Signalling | IMS: `ImsReasonInfo.CODE_USER_DECLINE` → vendor IMS stack picks SIP code (GSMA IR.92 §2.2.4: user-determined busy → 486). CS/2G: CHLD=0 (UDUB). Vendor code (486 vs 603) not in AOSP | IR.92 v15; vendor UNKNOWN |
| Network | 486/UDUB → CFB (3GPP TS 24.604) → HCG number with original CLI | **UNTESTED on any UK MNO** |
| Contacts | Not passed to the screener unless the app holds `READ_CONTACTS`; the production app holds it, so production logic must allow contacts explicitly | AOSP |
| Withheld | Android 11+ never passes restricted/unknown presentation → withheld calls ring natively, unmonitored | AOSP |

**Re-verified 2026-10-03 (`sources/android_ios_platform.md`):**
- Telecom honours reject from a user-chosen screening app (PUBLISHED). Rejected calls always appear in the call log as "blocked"; `setSkipCallLog` works only for carrier/system apps. The missed-call notification can be suppressed.
- When the user picks a third-party screening app, the default dialler's own screening service is not run (PUBLISHED). Whether Google Phone's spam filter / automatic Call Screen still acts on calls HCG allows: UNKNOWN. Samsung: nothing official found → test row required.
- Withheld/unavailable numbers never reach the screener, so they ring natively and cannot be diverted to HCG. A scammer who withholds their number bypasses R1 entirely (product gap, not a POC gate).
- If a network turns a decline into 603 rather than busy, an untested fallback is "disallow without reject" (call keeps ringing silently) + **61* no-reply forwarding (INFERRED).
- Setting **67* from the app: proper APIs are system-only (PUBLISHED). AOSP suggests `sendUssdRequest` might run it silently with only `CALL_PHONE`: unverified and a Play-policy risk → **off-limits**. Use a pre-filled dialler intent the customer confirms.

**Permissions:** the screening role itself; no `CALL_PHONE`, `READ_CALL_LOG` or `MODIFY_PHONE_STATE`. Setting forwarding programmatically requires privileged permissions (not available to a Play app), so the **customer** dials the MMI code or uses the dialler's call-forwarding settings; the app can only open the dialler pre-filled and verify by test call. Re-verification of these API facts: `sources/android_ios_platform.md`.

**Play policy concerns:** call screening is an accepted use of the role; no restricted permission (call log/SMS) is needed for the mechanism. Separate, existing issue: Play Payments policy for in-app Stripe on Android (memory: Android Play Billing compliance).

**Handset/OEM dependencies:** the SIP code chosen by the vendor IMS stack (Samsung, Pixel/Google, Motorola/Qualcomm) on decline; whether the OEM dialler honours a third-party screening role while its own spam filter is on; VoLTE/VoWiFi provisioning per handset/network.

## 4. iPhone mechanism (exact)

Re-verified 2026-10-03 against iOS 27 (now current): still no API lets a third-party iOS app reject, divert or route a cellular call (CallKit Call Directory = label/block list; Live Caller ID Lookup = PIR, one-byte block flag, cannot be per-household; EU default dialler = outgoing only). The only candidate is Apple's own **Settings › Apps › Phone › Screen Unknown Callers › Silence**, with **Live Voicemail off** and **Ask Reason for Calling off** (both answer on-device, so the network never forwards).

| Limitation | Consequence | Verified |
|---|---|---|
| Apple decides who is "known": Contacts, recent outgoing calls, Siri suggestions | HCG's trusted list matters only if written into Contacts; a scammer the customer once called back rings through | Apple support page (decision report) |
| HCG can't read whether Silence is on, or Live Voicemail/Ask Reason off | Setup can only be verified indirectly (unknown calls arriving at HCG or not) | Apple docs (no API) |
| Roaming: "calls are not screened" | Everything rings natively abroad (unprotected, £0 to HCG) | Apple support |
| Silence = decline (CFB) or silent ring (CFNRy)? | Decides speed (≤5 s vs 15–30 s) and which code must be set | **UNTESTED** |
| Apple may change behaviour in any iOS release | Re-test each major iOS | — |
| Apple UK CMA interoperability channel | Open to UK-registered developer accounts; eligibility answer "endeavoured" within 4 weeks; no commitment to build | PUBLISHED; filing is Andrew's decision |

## 5. Four-network validation matrix (to fill when authorised)

One row per network × handset family × radio path. MVNOs inherit host behaviour for routing but not always MMI support.

| # | Network (host) | Handset | Radio path | Baseline manual decline → CFB? | Screened unknown → test number? | Seconds to arrive | From = original CLI? | Contact rang natively, 0 at test number? | Result |
|---|---|---|---|---|---|---|---|---|---|
| 1 | EE | Android (Moto, Qualcomm IMS) | VoLTE | | | | | | |
| 2 | EE | Android | VoWiFi | | | | | | |
| 3 | EE | Android | 2G fallback (VoLTE off) | | | | | | |
| 4 | EE | Samsung | VoLTE | | | | | | |
| 5 | EE | Pixel | VoLTE | | | | | | |
| 6 | EE | iPhone, current iOS (27) (Silence) | VoLTE | | | | | | |
| 7 | EE | iPhone | VoWiFi | | | | | | |
| 8–14 | O2 (and giffgaff, Tesco) | as 1–7 | | | | | | | |
| 15–21 | Vodafone (and Lebara, VOXI, Asda) | as 1–7 (**PAYG can only divert to voicemail**) | | | | | | | |
| 22–28 | Three (and Smarty, iD) | as 1–7 (**MMI unsupported: Settings only; Three charges per diverted call**) | | | | | | | |

Order: start on whichever SIM the Motorola already has (recorded at runbook Step 0), then the other three hosts, then Samsung and Pixel on the network that passed.

## 6. Exact PASS / FAIL evidence

Evidence is recorded per row; screenshots + test-number call log are mandatory.

| Evidence item | Source | Required for PASS |
|---|---|---|
| Forwarding state before/after (all four rows) | Handset call-forwarding screen screenshots | CFU **Off**; CFB = test number; restored afterwards |
| Baseline: manual decline reaches test number | Test-number call log (subaccount Monitor › Calls, or SIP INVITE log) | 1 entry, From = caller, Price £0 (`<Reject>`) |
| Screened unknown call | Probe log `decision=REJECT respondedIn=…ms` + test-number log + handset did not ring | 3/3 calls arrive; ≤ 5 s from dial (CFB) |
| Contact / allow-listed call | Handset rang + test-number log | **0** entries at test number |
| CLI | Test-number log `From` | Equals the caller's real number (not the customer's, not withheld) |
| Radio paths | Repeat with VoWiFi toggled and VoLTE off | Same result, or recorded as PARTIAL |
| Withheld (informational) | Handset rang; probe line | Recorded; product decision, not PASS gate |
| Rollback | Forwarding screen + test calls after restore | Every call rings normally; test number receives nothing |
| Cost | Subaccount usage | £0 per call (rejected) |

Outcomes: **PASS** (all above), **PARTIAL** (CFNRy only, some radio paths, slower than 5 s, CLI altered), **FAIL-NO-DIVERT** (baseline decline doesn't reach test number), **FAIL-PLATFORM** (role/binding), **FAIL-SAFETY** (any trusted call reaches the test number, or contacts reach the screener unexpectedly).

iPhone rows: PASS = unknown call reaches test number with original CLI, phone did not ring audibly, contact rang; record ≤ 5 s (decline/CFB) vs 15–30 s (silent ring/CFNRy). FAIL = voicemail, busy tone, on-device answer, or no forward.

## 7. Safety preconditions (unchanged from runbook)

- The Moto E7 is the production HCG device: its **21* must be confirmed **off** before testing or test calls enter production.
- Test number only in an isolated Twilio subaccount (`<Reject reason="busy"/>`, unbilled) or a free-inbound SIP DID that logs the INVITE. The Twilio account is shared staging/prod: pre-flight in Console. Needs Andrew's approval to buy.
- Release the number only after rollback is verified.

## 8. Triggers that make POC 1 unnecessary

POC 1 becomes unnecessary **only** if a provider confirms caller-based routing for customers who **keep their SIM**. Encoded in `response-pack/rules.mjs` and checked by `classify.mjs`:

| Trigger | Response-pack question | Effect |
|---|---|---|
| aql: routing applies to numbers staying on EE/O2/Vodafone/Three | AQL-1 = YES | POC 1 not needed (confirm with a provider-run trial) |
| Twilio names an arrangement acting before the customer's MNO | TWI-1 = YES | POC 1 not needed |
| All three UK network groups offer caller-based CDIV / IMS hook | MNO-1 = YES ×3 | POC 1 not needed (per network if only some) |
| A SIM route fully confirmed (aql SIM, FMC SIM, or Telnyx Mobile Voice) | AQL-2…6 / FMC-1…4 / TEL-3…5 all YES | POC 1 **optional**: still needed for customers who won't switch SIM |
| A network states in writing how it treats 486/603 with CFB | MNO-2, AQL-7 | **Narrows** only (network half); handset and Apple halves still need testing |

Nothing else (cheaper per-minute rates, channel billing, BYOC, REFER, own number range) affects whether POC 1 is needed.

## 9. What POC 1 does not prove

Behaviour on untested networks/handsets; consumer set-up success at scale; monitored-call quality; anything about SIM routes; that Apple won't change Silence behaviour.
