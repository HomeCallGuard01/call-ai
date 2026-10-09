# iPhone Phase 1 Test Checklist: Silence Unknown Callers vs carrier voicemail

**Status: NOT APPROVED. Nothing below has been run.** Andrew operates both phones. Claude changes nothing.
**Equipment:** the existing iPhone (the phone under test) and the existing Motorola (used only as the caller; its settings are not touched).
**Forwarding target:** the iPhone's **existing carrier voicemail only**. No HCG, Twilio, Magrathea or other external number. **No `**` or `##` codes are dialled.**
**Cost:** only the Motorola's normal outbound minutes to a UK mobile (about 15 short calls). HCG cost is £0.

---

### A. Record the current settings before anything else (read-only)

On the iPhone, dial each query code and press call. Each one only *shows* a setting; none changes anything. Write down exactly what the screen says, or take a screenshot.

| # | Item | How to read it | Recorded value |
|---|---|---|---|
| A1 | Forward all calls (CFU) | Dial `*#21#`, and also check Settings → Apps → Phone → Call Forwarding | |
| A2 | Forward when busy/declined (CFB) | `*#67#` | |
| A3 | Forward when not answered (CFNRy) and its timer | `*#61#` (note the number **and** the seconds) | |
| A4 | Forward when unreachable (CFNRc) | `*#62#` | |
| A5 | Screen Unknown Callers | Settings → Apps → Phone | Never / Ask Reason / Silence |
| A6 | Live Voicemail | Settings → Apps → Phone → Live Voicemail | On / Off |
| A7 | Focus / Do Not Disturb, Wi-Fi Calling | Control Centre; Settings → Apps → Phone | |
| A8 | iOS version, carrier, SIM/eSIM | Settings → General → About | |
| A9 | Is the Motorola's number in Contacts or Recents on the iPhone? | Search Contacts and Phone → Recents | |

If a query code returns an error, write "MMI not supported" and carry on. A1 can still be read in Settings.

### B. Stop conditions: do not continue if any of these is true

- [ ] **B1.** A1 shows forwarding to **any** number (HCG, Twilio, Magrathea or other). Stop and ask Claude/Andrew. Switching it off would change a live setting.
- [ ] **B2.** A2 or A3 points to anything other than the carrier's own voicemail number. Stop.
- [ ] **B3.** The iPhone is roaming, or someone dialled 999/112 from it in the last 24 h. Stop (Apple turns screening off in both cases).

### C. Temporary test settings (iPhone only; all reversed in section E)

- [ ] **C1.** Focus/Do Not Disturb **off**.
- [ ] **C2.** Live Voicemail **off**.
- [ ] **C3.** If A9 = yes: export that contact first (Share Contact), then remove the Motorola's number from it and delete that number's Recents entries.

### D. Calls (from the Motorola, with a stopwatch started at "dial")

For each call, note: rings heard, seconds until a greeting, **whose** greeting it is (carrier voicemail or an Apple/Siri voice), and what the iPhone shows. **Hang up as soon as the greeting starts. Leave no messages.**

| Test | iPhone Screen Unknown Callers | What to do | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|---|
| D1 Ring-out baseline | Never | Motorola calls; nobody answers. Time to voicemail ≈ A3 timer? | | | |
| D2 Decline baseline | Never | Motorola calls; tap **Decline** on the iPhone | | | |
| D3 Control | Never | Motorola calls; iPhone rings and is answered | rang? | | |
| **D4 Decisive** | **Silence** | Motorola calls (now unknown). Does the iPhone ring? Time to voicemail? | | | |
| D5 Withheld | Silence | Motorola dials `#31#` followed by the iPhone number | | | |
| D6 Live Voicemail interference | Silence, **Live Voicemail on** | Motorola calls. Transcript on the iPhone? | | | |

**Reading D4:**

| Result | Meaning |
|---|---|
| Carrier greeting at about the **D2** time | iOS *rejects* the call and the network's busy forwarding fires |
| Carrier greeting at about the **D1** time | iOS rings silently and the network's no-answer forwarding fires |
| An Apple/Siri voice, or a transcript appears | Answered **on the phone**, so the network never diverted the call. **FAIL** |
| Rings until the caller gives up | **FAIL** |

**PASS** = 3 out of 3 runs reach carrier voicemail, no Apple voice is heard, **and** D3 rang normally.

### E. Restore everything (tick each one)

- [ ] **E1.** Screen Unknown Callers back to A5.
- [ ] **E2.** Live Voicemail back to A6.
- [ ] **E3.** Focus/DND back to A7.
- [ ] **E4.** Re-add the Motorola's contact from the C3 export, if C3 was done.
- [ ] **E5.** Re-dial `*#21#`, `*#67#`, `*#61#`, `*#62#`. Every value must match A1–A4. This test never changes forwarding, so a mismatch means something else changed. Stop and report it; don't fix it by guessing. If a recorded value must be put back, Claude prepares the exact restore code from the A2–A4 values (format `**67*<number>#`, `**61*<number>*11*<seconds>#`, `**62*<number>#`) for Andrew to approve first.

### F. What this test can and cannot establish

| It CAN establish (this iPhone, this iOS version, this carrier only) | It CANNOT establish |
|---|---|
| Whether "Silence" leaves the call to the **network** (reaches carrier voicemail) or keeps it **on the phone** (Apple voice/transcript) | That conditional forwarding to an **external** HCG number will work. Carriers often handle diversion to their own voicemail differently from diversion to outside numbers: it may be always allowed, use different timers or be billed differently, and external divert may be barred or de-registered (as Lebara did in Magrathea Test 4) |
| Which trigger fires, reject/busy or no-answer, judged by timing | That the diverted call keeps the **original caller's number** and a **Diversion** header. Voicemail doesn't show the routing data HCG needs |
| Whether trusted (known) callers still ring normally | That HCG's real number or an external DDI would be accepted in `**67*` / `**61*` on this carrier |
| Whether withheld callers are silenced | Behaviour on other UK networks, other iOS versions, or over days and weeks |
| Whether Live Voicemail interferes | That HCG would receive the call, the AI screening would answer it, or app delivery afterwards would work without a loop |

**Next step after a PASS** (a separate approval, small cost): Phase 2 points the busy and no-answer forwarding at one **non-production** number and confirms the caller's number and Diversion arrive. See REPORT.md §6.5.
