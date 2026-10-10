# Test B plan v2: silence → no-answer forwarding → external HCG test number (2026-10-10)

**Status: PLANNING ONLY. Nothing executed.**
- Supersedes `TEST-B-PLAN-REVISED-2026-10-10.md`.
- `TEST-B-RUNBOOK.md` stays as the detailed reference, but where it differs, **this plan wins**. Two examples:
  - the runbook's `**61*…**15#` code is **not** to be used without carrier confirmation;
  - the runbook allows up to 12 calls; this plan allows at most 8.

## 0. Starting point (from Test A)

| Fact | Evidence |
|---|---|
| A silenced unknown call reached Lebara voicemail on no-answer (15–17 s; no busy, no early drop) | Telecom `CSCR.sC`, no ringer, MISSED → voicemail; calls at 15:45 and 15:46 |
| Android 10 sends **saved contacts** to the screening app, so trust must come from the **probe allow-list** | Call at 15:49: contact recognised, still screened, silenced |
| Allow-listed caller rings in SILENCE mode | Andrew reports a pass. Telecom shows the 15:57 call **allowed and rang**, but cannot show the mode. **Confirm the probe's on-screen log line** (`mode=SILENCE_UNTRUSTED … decision=ALLOW`) before relying on it |
| Lebara **refused** no-answer forwarding **registered by code** (`**61*…` → "invalid MMI"). Its own 1211 service set voicemail forwarding | Test A timeline |
| Current Motorola state | Always-forward off, no-answer → voicemail 121 after 15 s, unreachable → voicemail, busy off, call waiting on; probe installed in OBSERVE holding the role |

## 1. Gate B0: carrier confirmation (Andrew; £0) **MUST be YES before anything else**

Ask Lebara in writing (app or web chat), quoting the "invalid MMI" result:
1. "Can a Lebara UK customer set **call forwarding on no answer** to a **UK geographic 020 number** (not voicemail)? Lebara previously said external **03** numbers are unsupported."
2. "What is the **supported method**: a code (please give the exact format), the Lebara app, or set by your team?"
3. "How are forwarded calls **charged**: from plan minutes, per minute, or free? Is there any set-up fee?"
4. "Can you **restore** forwarding on no answer to voicemail afterwards, and how?"

| Lebara's answer | Next step |
|---|---|
| **Yes**, with a method and the charges | Continue on Lebara, using **only** that method |
| **No / unknown / unsupported** | Test B on Lebara is **NO-GO**. Options: (a) re-run Test A then Test B on an EE, O2, Vodafone or Three SIM (about £1–£10 to buy; separate approval); or (b) record "Lebara customers can't use the bypass", which is a product finding in its own right |

## 2. The external test destination (safe by construction)

- **Number:** staging `+44 20 4652 1883`. It is a London 020 number on HCG's Twilio account (shared with production) and is **not a customer number**. Today its Voice URL, fallback, status callback, voice app and SMS are **all empty**.
- **Configuration during the test:** Voice "A call comes in" = **TwiML Bin** `ws5-reject` containing exactly:
  `<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`
- Fallback, status callback, SMS and voice application stay **empty**.
- **No HCG server, `/voice`, monitoring, AI, transcription, SMS or `<Dial>` is reachable**, so there is no onward routing and no loop. The staging server stays **off**.

### Every possible charge

| Party | What could cost | Expected | Worst case |
|---|---|---|---|
| **Twilio** | Inbound call to `…1883` | **£0**: `<Reject>` as the first verb is never answered and not billed, but is logged | If the Bin were misconfigured and Twilio **answered** (any other first verb, or an application error): about £0.0076 per started minute, ≤ 30 s per call. 8 calls × 1 min ≈ **£0.06** |
| Twilio | Number rental | Already paid (about £0.87/month); unchanged | — |
| Twilio | TwiML Bin | Free | — |
| **Lebara** (charged to the Motorola's plan) | The forwarded leg to a UK 020 number | **Unknown; B0 Q3.** Likely plan minutes (other UK networks charge forwarding to another number as a normal UK call) | ≤ 8 calls × ≤ 1 min = ≤ 8 plan minutes |
| Lebara | iPhone → Motorola calls | Plan minutes on the iPhone | ≤ 8 minutes |
| HCG / OpenAI / SMS | — | **£0**: nothing is routed to HCG services | £0 |

**Total test expenditure cap: £0.50 (Twilio).** Lebara is limited to plan minutes.

## 3. Limits and manual stop

| Limit | Value |
|---|---|
| Total calls | **≤ 8**: 2 trusted baseline, 3 unknown, 2 failure tests, 1 final check |
| Duration | iPhone hangs up at **30 s** at the latest (stopwatch), or at the busy tone |
| Concurrency | **1 call at a time.** The next call only after the Twilio log has refreshed |
| Window | ≤ 60 minutes |
| Priced Twilio call | **STOP at the first call showing a price > £0.00** |

**Manual stop (in this order):**
1. iPhone hangs up.
2. In the probe app, tap **OBSERVE**. This stops silencing; unanswered calls would still forward, but the Twilio reject is free.
3. Restore no-answer forwarding to voicemail by Lebara's confirmed method.
4. Twilio: set `…1883` Voice back to **empty**. That blocks free and doesn't log. Delete the Bin.

**Do not** empty `…1883` while forwarding still points at it and you need evidence. The blank state is free but unlogged.

## 4. Sequence (each block needs its own GO)

**B1 Trusted baseline, before any forwarding change (2 calls, £0):**
- Probe **SILENCE** with the iPhone **on the allow-list**. The iPhone calls; the Motorola **must ring**.
- Answer once, and let it go to voicemail once.
- Confirm the probe log shows `decision=ALLOW` and Telecom shows `CSCR.aC` with the ringer started.

**B2 Destination (Andrew in the Twilio Console; £0):**
- Screenshot `…1883`'s current configuration (expected: all empty). Create the Bin and assign it.
- **Self-test** is call #3 of 8: the iPhone dials `…1883` directly. It must hear **busy**, and Twilio must show 1 call, status **busy**, **£0.00**.

**B3 Register** no-answer forwarding to `…1883` by **the B0 method only**:
- Read `*#61#`, which must show `…1883`.
- Re-read after 60 s.

**B4 Unknown calls (3 calls):**
- The iPhone is **removed from the allow-list**; probe SILENCE.
- Expected for each: the Motorola is silent; after about 15 s the iPhone hears **busy**; Twilio shows **one** call to `…1883`, **busy, £0.00**.
- Record From / ForwardedFrom / caller ID.

**B5 Trusted proof after the change (1 of the 8):**
- The iPhone is back on the allow-list. The Motorola **rings**; answer it.
- **Twilio shows NO new call to `…1883`.**

**B6 Failure tests (2 calls):**
- **Rejected destination:** already covered by B4 (busy reject). Optionally, one call with the Bin changed to `<Reject reason="rejected"/>` (not-in-service tone) to see what the caller hears.
- **Unreachable destination:** set `…1883` Voice to **empty** (Twilio blocks free and doesn't log). One unknown call; record what the iPhone hears.
- **Forwarding loop:** **not tested live**. It is structurally impossible here, because the destination never dials out (no `<Dial>`, no server) and Twilio shows no outbound leg. Proven from the configuration screenshot and from 0 outbound calls in Twilio logs for the window.

**B7 Rollback** (§6), then the final check (call 8): an unknown call goes to **Lebara voicemail** again.

## 5. Proof that trusted calls never reach Twilio/HCG

| Evidence | How | Who |
|---|---|---|
| Device side | Telecom `CSCR.aC` + `START_RINGER` for each allow-listed call; probe log `decision=ALLOW` | Claude (adb, read-only) + probe screenshot |
| Twilio call records | Monitor › Logs › Calls, filter **To = …1883**, test window: **exactly one row per unknown call** (B4 + B6), **zero** for B1/B5 timestamps. Export as CSV | Andrew (console). My production read access is blocked |
| Twilio billing | Usage (today), Voice inbound: **£0.00**, minutes 0, for the window | Andrew |
| Carrier | Lebara usage after the session: forwarded minutes only for the unknown calls (if itemised) | Andrew |
| HCG | Production and staging logs show no `/voice` for `…1883` (the staging server is off, and nothing points at production) | Claude, read-only, if access is granted; otherwise covered by the Twilio log |

## 6. Rollback checks (all must pass; screenshots)

1. **Forwarding:** `*#61#` = **voicemail 121, 15 s** (today's state), restored by Lebara's method. `*#21#` off, `*#62#` voicemail, `*#67#` off. One unanswered call reaches Lebara voicemail.
2. **Probe:** tap OBSERVE. Then `adb uninstall co.uk.homecallguard.divertprobe`; `pm list packages | grep divertprobe` must be empty; `dumpsys role` CALL_SCREENING has **no holder**. Google Phone stays the dialler. Contacts and allow-list as before.
3. **Twilio `…1883`:** Voice, fallback, status callback, voice app and SMS **all empty** (screenshot). TwiML Bin `ws5-reject` **deleted**. No other number changed. Today's usage £0.00 for the window.
4. **No residue:** no staging server, tunnel or log capture running on the Mac.

## 7. Automatic vs needs Andrew

| Claude can do (read-only / local) | Needs Andrew's approval or action |
|---|---|
| adb Telecom/role/package checks; probe install state | **B0** Lebara contact |
| Timeline, results sheet, evidence sealing | Each of **B1–B7** GO |
| Checking for leftover processes; reading Twilio data **only if** you grant read-only access | **Twilio console** changes on `…1883` (production account) and the call-log/billing exports |
| Uninstalling the probe (once approved at rollback) | Any forwarding change (Lebara method) |
| | Placing every call; a different-network SIM purchase if B0 = no |

## 8. GO / NO-GO checklist

- [ ] **B0:** Lebara confirms, **in writing**, forwarding on no answer to a UK 020 number is supported, gives the exact method, and states the charges.
- [ ] **Allow-list pass confirmed** by the probe log line (`mode=SILENCE_UNTRUSTED decision=ALLOW`).
- [ ] `…1883` confirmed empty before the change (screenshot), and not referenced by any customer.
- [ ] Staging server off; no tunnel; Twilio balance and auto-recharge reviewed.
- [ ] You present with both phones; at most 60 minutes; at most 8 calls; £0.50 cap; stop rule understood.

**Any box unticked → NO-GO.**
