# WS5 Test B: silence → no-reply forwarding → an external HCG number (attended runbook)

> **2026-10-10: superseded for sequencing, limits and gates by `TEST-B-PLAN-v2-2026-10-10.md`.** Do not use the `**61*` code below without Lebara's written confirmation (Test A: Lebara refused MMI registration).


**Status: READY, NOT RUN. Run only after Test A PASSES.** Needs approvals B-1..B-4 (§B.8). Prepared 2026-10-10 by WS5.
**Question:** does Lebara accept CFNRy to a **non-Lebara UK geographic number** on HCG's Twilio account, and does a silenced unknown call arrive there after the timer, with which caller ID and `ForwardedFrom`, while answered trusted calls produce **zero** requests?

## B.1 Choosing the landing number

| Option | Number | Type | Lebara acceptance (evidence) | Cost | Verdict |
|---|---|---|---|---|---|
| **B-i (recommended)** | staging `+44 20 4652 1883` (HCG Twilio account; staging shares the production Twilio account) | **London 020 geographic**, Twilio GB Local, voice-only | Unproven for `**61*`. Same number *type* as the production numbers that `**21*` reached on Lebara (founder test 2026-09-16, `services/providerPolicy.js` lebara). Lebara's "external **03** unsupported" statement does not name geographic numbers | Reject = **£0** | Use. No purchase; one config change on the production Twilio account, reversed in the same session |
| B-ii | Same number, but on the research `divert-landing-probe` Twilio Function (`PROBE_MODE=reject`, `PROBE_NUMBER=+442046521883`) instead of a TwiML Bin | as B-i | as B-i | £0 (Functions free tier; reject) | Use if B-i's Request Inspector does not show `ForwardedFrom`. The Function logs `From`/`To`/`ForwardedFrom`/`StirVerstat` as one JSON line (unmasked, in Twilio's Function logs: delete afterwards) |
| B-iii | A newly bought GB Local number in an isolated subaccount | geographic | as B-i | ≈ £0.87–£2.63 first month + bundle work (E1 runbook Part A) | Only if Andrew wants zero production-account change. Slower (regulatory bundle) |
| B-iv | Magrathea DDI `0330 088 4327` | **03 non-geographic** | **Likely refused:** Lebara says external 03 forwarding is unsupported; `**67*` to it registered once, then showed inactive and re-registration gave "invalid MMI" (Magrathea evidence §13) | free inbound on Magrathea; the E-SIP VM's deadline was Sat 10 Oct 13:00 BST, teardown prepared: availability must be checked | **Do not use for Test B.** At most a later, separately approved probe of 03 acceptance |

**Recorded pre-test state of …1883 (LATEST-HANDOVER, 2026-10-06):** Voice URL, fallback, status callback, voice application and SMS all **empty**. Re-read it at B.2 step 1 before changing anything: if it differs, **STOP**.

## B.2 Set-up (Andrew in the Twilio Console; Claude makes no change)
1. Twilio Console › Phone Numbers › Active numbers › `+44 20 4652 1883`: screenshot the Voice configuration (expected: all empty). Confirm it is **not** a production customer's number (staging household `ffc4cfe1…` only).
2. TwiML Bins › Create `ws5-reject`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>
   ```
   `<Reject>` as the first verb: Twilio never answers, so nothing is billed (Twilio docs; confirmed per call in B.5).
3. On …1883 › Voice › "A call comes in" → TwiML Bin `ws5-reject`. Leave fallback, status callback and SMS empty. Save, re-open, screenshot.
4. **Landing self-test:** the iPhone dials `+44 20 4652 1883` directly → busy tone. Monitor › Logs › Calls shows 1 call, status **busy**, price **£0.00**. A price shown → **STOP**, restore B.7 step 2.

## B.3 Handset (Test A gates repeated)
1. Repeat Test A §A.1 gates G1–G10 and §A.2 (CFU off, with approval). Record G2 (Lebara voicemail + timer) again: it is the restore target.
2. Reinstall probe v0.3 exactly as Test A §A.3 (sha256 check, role, S3 gate). Mode SILENCE, allow-list empty, iPhone **not** a contact.
3. **Register CFNRy to …1883** (approval B-1): dial `**61*+442046521883**15#` (timer 15 s; decision TB-4). Then `*#61#` must show `…1883` and 15 s.
   - "Invalid MMI", "not allowed", "network error", or `*#61#` not showing …1883 → **result X2 = FAIL on Lebara for CFNRy to geographic**. Do **not** retry with other formats beyond one attempt of `**61*+442046521883*11*15#`; restore G2 (B.7 step 1); stop. Do not try 03 numbers.
4. Wait 60 s, dial `*#61#` again (Magrathea Test 4 showed a registration that later went inactive). Must still show …1883.

## B.4 Calls (≤ 12 in total; Twilio Calls log refreshed after each)

| # | Set-up | Action | PASS |
|---|---|---|---|
| C1 ★ | SILENCE, iPhone unknown | iPhone calls; don't touch. **×3** | Motorola silent; iPhone hears ringback ≈ 15 s then **busy** (the Bin's reject); Twilio shows **one** call per attempt to …1883, status busy, **£0.00**; probe log `decision=SILENCE` |
| C2 | Save iPhone as a **contact** | iPhone calls; **answer** on the Motorola; hang up | Rings audibly; **zero** new Twilio calls |
| C3 (sizing) | contact | iPhone calls; **don't answer** | Rings ≈ 15 s, then **one** Twilio call (leakage path: expected) |
| C4 | Delete contact; add iPhone to the probe's **allow-list** (simulates HCG trusted list) | call, answer | Rings audibly; `decision=ALLOW`; **zero** Twilio calls |
| C5 | Probe force-stopped or role set to None | unknown call, don't answer | Rings audibly (fail-open) or silenced; either way one Twilio call after ≈ 15 s; never busy before the timer |
| C6 (info) | `141` withheld from iPhone | don't answer | Rings audibly; one Twilio call after ≈ 15 s; From = anonymous |

**Per Twilio call, record (Call details › Request Inspector, or the B-ii Function log):** `From` (is it the iPhone's real CLI? HCG's trust check depends on it), `To` (…1883), `ForwardedFrom` (expected: the Motorola's number, if Lebara passes the Diversion header; Twilio documents it as carrier-dependent; **TO CONFIRM** whether the Bin's Request Inspector shows it), `CallerName`, `StirVerstat` if present, status, duration, price. Mask numbers to last 3 digits in the results sheet.

## B.5 Pass criteria
**Test B PASS** = B.3 step 3–4 accepted and stable, **C1 3/3** (one £0 Twilio call each, after ≈ the timer), **C2 = 0** and **C4 = 0** Twilio calls, and `From` = the real caller CLI. C3 is recorded (leakage confirmed), C5 must not be busy, C6 recorded.
**What a PASS proves:** on Lebara + this Motorola, CFNRy to a non-Lebara UK geographic number on HCG's Twilio account is accepted and fires for silenced calls; the caller identity (and whether `ForwardedFrom` identifies the customer) as recorded. It proves nothing for other networks, handsets, or 03/Magrathea numbers.
**Cost bound:** `<Reject>` = £0. If the Bin were misconfigured and answered, ≤ 12 calls × 1 started minute × £0.007558 ≈ **£0.09**. The forwarded leg (Motorola → …1883) is a Lebara-plan charge to the SIM (TO CONFIRM; UK geographic, normally inclusive).

## B.6 Stop rules
- `*#61#` ever shows a number other than …1883 or G2.
- Any Twilio call shows a non-zero price, or a call reaches any number other than …1883.
- Any call hits a production HCG number or the HCG app rings.
- A contact/allow-listed answered call produces a Twilio request (FAIL-SAFETY).
- Network refusal (B.3 step 3) → X2 FAIL, restore, stop.

## B.7 Mandatory restoration (in order)
1. **CFNRy back to voicemail:** `**61*<G2 Lebara voicemail number>**<G2 seconds>#` (Claude generates the exact string from the recorded G2 values; logic in `tests/ws5-forwarding-codes.test.mjs`). `*#61#` must equal G2 exactly. **Never `##61#`** (it erases voicemail-on-no-answer). Do this **before** step 2, so no divert ever points at a reconfigured number.
2. Twilio: …1883 Voice "A call comes in" → **empty** again (fallback, status callback, SMS empty); re-open and screenshot; delete TwiML Bin `ws5-reject` (or the B-ii Function and its logs).
3. Probe: OBSERVE → uninstall (`adb uninstall co.uk.homecallguard.divertprobe`), Caller ID app = G7, contacts = G10, USB debugging off.
4. Always-forward: if G1 was active, `**21*<G1 number>#` (approval A-1 restore half).
5. Read-back `*#21#`, `*#61#`, `*#62#`, `*#67#`, `*#43#` = gates. Twilio: every WS5 call shows status busy/no-answer and £0.00.

## B.8 Approvals (Andrew)

| # | Approval |
|---|---|
| B-1 | Register CFNRy on the Motorola to `+44 20 4652 1883` with a 15 s timer, then restore it to the recorded Lebara voicemail number and timer |
| B-2 | Production-Twilio-account change: create TwiML Bin `ws5-reject` and point …1883's Voice URL at it for the session only (or B-ii: deploy the research Function in the same account), then empty it and delete the Bin/Function |
| B-3 | ≤ 12 test calls (≤ 60 s each) plus the landing self-test |
| B-4 | Test A approvals A-1, A-2, A-4 again for this session |

**Duration:** about 45–60 minutes including restore. **Cost to HCG: £0** (bounded at ≈ £0.09).

## B.9 Results sheet
```
Date/time ____   Test A outcome ____   …1883 pre-state empty __ (screenshot)
Bin self-test: busy __ price £__
G2 Lebara VM timer __ s     **61* to …1883 accepted __ ; *#61# shows …1883 15 s __ ; still after 60 s __
C1 #1 silent __ heard ____ at __ s  Twilio calls __ status __ price __  From real CLI __  ForwardedFrom ____(masked)
C1 #2 ...   C1 #3 ...
C2 contact answered: Twilio calls __ (must be 0)
C3 contact unanswered: Twilio calls __ at __ s
C4 allow-listed answered: Twilio calls __ (must be 0)
C5 probe stopped: rang/silenced __  Twilio calls __  busy before timer __
C6 withheld: rang __ Twilio From ____
Restore: CFNRy = G2 __  …1883 empty __  Bin deleted __  probe removed __  CFU = G1 __  read-back __
OUTCOME: PASS / PARTIAL / FAIL-X2 (network refused) / FAIL-SAFETY
```
