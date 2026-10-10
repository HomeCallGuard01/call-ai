# Test B plan, revised after Test A (2026-10-10): NOT approved, NOT run

> **Superseded by `TEST-B-PLAN-v2-2026-10-10.md`.**


**Goal:** prove that a silenced unknown call, forwarded on no-answer, reaches an **external number on HCG's Twilio account**, and record how it arrives. This is the routing a real product needs. Test A proved the same thing only to the carrier's own voicemail.

Detailed steps stay in `TEST-B-RUNBOOK.md`. This revision changes the order and adds the gates Test A showed are needed.

## What Test A changed

1. **Lebara refused no-answer forwarding registered by code** ("invalid MMI"), even to its own voicemail. Busy-forwarding re-registration was also refused on 9 Oct. So Test B's step "register `**61*` to `…1883`" is **likely to fail on Lebara**, and **we must not try code variants** (Andrew's instruction).
2. **Contacts reach the screening app on Android 10**, so the trusted path must use the probe's **allow-list**. That is a probe setting, not a code change.

## Order of work (each gate needs Andrew's GO)

| Gate | What | Cost | Who |
|---|---|---|---|
| **B0 Carrier confirmation** | Ask Lebara support, in writing (app or web chat): *"Can a Lebara UK customer set call forwarding **on no answer** to a **UK 020 landline number**, and what is the supported method: a code (exact format), the Lebara app, or set by support?"* Lebara has already said external **03** numbers are unsupported. **020 is unknown** | £0 | Andrew |
| B0 outcome | **Yes, with a method:** continue to B1 on Lebara using exactly that method. **No / unknown:** Test B on Lebara is **NO-GO**. Repeat Test A then Test B on another network's SIM (EE, O2, Vodafone or Three). That needs a SIM purchase (about £1–£10) and a separate approval | — | — |
| B1 Allow-list check (completes Test A) | Probe in SILENCE with the iPhone on the **probe allow-list**: 1 call. Expected: probe replies Allow, the phone **rings**. Optional: 1 fail-safe call with the probe force-stopped (must ring or reach voicemail, never busy) | £0 | Andrew + Claude (adb read-only) |
| B2 Landing | Twilio Console: TwiML Bin `<Response><Reject reason="busy"/></Response>` on **staging `…1883` only**. Self-test: dial `…1883` directly → busy; Twilio shows **£0.00**. Any price shown → **STOP** | £0 (a Twilio reject before answer is not billed; verified per call) | Andrew (console), production Twilio account, temporary |
| B3 Register | Set no-answer forwarding to `…1883` **using only the B0-confirmed method**. Verify with `*#61#`, then wait 60 s and read it again | £0 | Andrew |
| B4 Calls (≤ 6) | iPhone (not allow-listed) → Motorola in SILENCE, ×3. Expected: Motorola silent; after about 15 s the iPhone hears **busy** (the Twilio reject); Twilio shows **one call to `…1883` per attempt, £0.00**, and the caller ID / `ForwardedFrom` recorded. Plus 1 allow-listed call (must ring, with **no** Twilio call) | £0 (worst case about £0.09 if Twilio answered unexpectedly; stop rule) | Andrew |
| B5 Restore | Forwarding back to **voicemail 121, 15 s** (the current state, via Lebara's supported method). `…1883` Voice URL **emptied** and the Bin deleted. Probe uninstalled (role released). Every setting read back | £0 | Andrew + Claude |

**Pass:** in B4, silenced calls reach `…1883` (visible in Twilio) at £0, and allow-listed calls never touch Twilio.

**Fail:** the forwarding can't be registered (B3), or calls don't reach `…1883`.

## Safety and cost

- No HCG production customer number is used.
- `…1883` is the staging number: inert today and restored to inert at the end.
- Every Twilio call is refused before answer, so £0. B4 stops at the first priced call.
- Forwarding a call to a UK landline may use the **Motorola's plan minutes** (a Lebara charge to the subscriber, not HCG). Confirm in B0.
- The probe's SILENCE switches off by itself after 2 hours (evaluated per call). Uninstalling at B5 removes it completely.

## Approvals needed (separately)

- **B0:** Andrew contacts Lebara.
- **B1:** 1–2 calls with the allow-list.
- **B2:** temporary production Twilio change on `…1883`.
- **B3 / B4:** forwarding registration and up to 6 calls.
- Or, if B0 is negative: buying a different-network SIM for a re-run.
