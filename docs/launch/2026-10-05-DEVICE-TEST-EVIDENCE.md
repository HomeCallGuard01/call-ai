# Attended staging device test: evidence (2026-10-05, evening)

**Build:** iOS 1.0.2 **Build 16** (staging, EAS `be1f645c…`, from `e63377f`) on Andrew's iPhone (`…2700`).
**Caller:** the Motorola (`…3030`), an ordinary phone making outgoing calls only.
**Staging number:** `…1883`.

**Window:**
- LIVE 18:05:00 UTC → CLOSED 18:24:26 UTC (…1883 inert, read back).
- Reset completed 18:2x UTC.
- Private evidence folder (outside the repo): `/Users/ad/hcg-staging-window-2026-10-05/`.

Testing was stopped by Andrew after the first calls. **T7 (true background), T8 (locked) and T9–T23 were not run.**

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| S1–S9 | Window start: production baseline; …1883 inert → pointed; staging invariants; **073 applied to staging** (dry run = exactly 073; verified, 17/17 markers); window env (mode 600); config START; server + tunnel; temporary login + fixtures | PASS | `S1…S9` files, `073-*.txt` |
| T2 | Build 16 launches; staging sign-in | **PASS** | dashboard 200; registration 19:07:46 local (iOS, mic granted) |
| T3 | Account number **HCG-00010306** shown, matching the DB | **PASS** | Andrew + `S7-dashboard.json` |
| T4 | Membership / Contacts (Motorola listed) / Help & Account open; setup **4 of 5** | **PASS** | Andrew |
| T5 | Microphone permission + iOS Voice SDK registration (iOS VoIP push credential, APNs production) | **PASS** | server `device_readiness`, app log |
| T6 | Trusted call Motorola → …1883 → iPhone, answered, two-way audio | **PASS** (delivery) | `CAbbd951…` 18:13:21: known contact → no monitoring → push → app presented 1.5 s → answered → media → completed 42 s → delivered |
| (2nd call) | Second trusted call, answered (HCG in the foreground again) | **PASS** (delivery) | `CAccc2ae…` 18:17:05, completed 41 s |
| DT-1 | Ending the call on the iPhone after answering | **FAIL (usability)** | see DT-1 |
| DT-2 | Allowance shows 88% after two calls | **Diagnosed: correct maths, untrue wording** | see DT-2 |
| E1–E8 | Reset: …1883 inert first; Fortress clean; fixtures restored; login deleted; processes stopped; secrets deleted; **production identical**; Twilio = 2 inbound + 2 app legs, **0 SMS** | **PASS** | `E1…E8` files |

**Financials (staging Fortress):**
- £0.02478 committed (2 × £0.01239); 0 live reservations; invariants OK.
- Kill switch off, breaker closed, no holds.
- Fortress settled durations (50 s, 47 s) ≥ Twilio inbound durations (48 s, 44 s): the estimate errs on the safe side.

## DT-1: no obvious way to hang up after answering (usability; fixed in source)

- **Observed (Andrew, corrected record):** iOS showed its incoming-call control. After answering, the control was lost, there was no normal obvious call screen, and the call was ended from the Motorola.
- **Root cause (iPhone log):** the call was answered on the CallKit banner (`callservicesd answerRequest`, 19:13:28 / 19:17:09 local). iOS then **brought HCG to the foreground** (`App transitioned to foreground` 19:13:28.9), which is iOS's design for a CallKit app answered on an unlocked phone: the app shows its own in-call screen. **HCG had none, and `voiceClient` never kept the answered call.** HCG did not dismiss anything; CallKit worked correctly.
- **Fix:** `f01fd8d`, the in-app call screen (End call / Mute / Speaker). Needs Build ≥ 17 to prove on a device.

## DT-2: "88% left" after two short calls

Diagnosed and fixed in wording (`1db5d53`); see `2026-10-05-DT2-ALLOWANCE-AND-ECONOMICS.md`. Fortress maths correct, nothing weakened.

## Other log findings (material only)

| # | Finding | Severity | Evidence | Action |
|---|---|---|---|---|
| **LF-2** | **A customer can be shown "Protected" without call forwarding.** After the first call the staging household reached `protected` / `fullyProtected: true`, although `…2700` forwards nothing to `…1883`. Cause: `services/activationVerification.js` stamps "forwarding verified" on **any** genuine inbound call to the HCG number, including a direct dial (here a 1 Oct direct-dial stamp). One delivered call then completes "first protected call". In production, any stray call to a customer's HCG number (recycled Twilio numbers do receive them) would do the same. Known item **P-9**, now **reproduced on a real device**. | **High (customer-protection truthfulness)** | `T6-dashboard.json` stage `protected`, blockers `[]`; `activation_verified_at` 2026-10-01 | **Launch-blocking. Not changed overnight (launch-critical design); proposal below** |
| LF-3 | "App ready" was ticked **before** the iPhone had registered, from a 1 Oct registration on another device. Once the iPhone registered it was correct. A customer who changes phone keeps "app ready" until delivery health flags push failures. | Medium | `S7-dashboard.json` `deliveryReady: true` before 19:07:46 | Fold into the LF-2 design (evidence must be about *this* device) |
| LF-1 | The app logs "Value being stored in SecureStore is larger than 2048 bytes and it may not be stored successfully". This is the Supabase session. Expo warns a future SDK may throw, which would sign customers out. | Medium (reliability, latent) | iPhone log 19:06:12 | Before the next SDK upgrade: chunked SecureStore adapter, or encrypted larger storage |

Checked and found clean:
- no duplicate delivery events (each call has the full server and app chain once);
- no retries, errors or alerts on the server (one deliberate unsigned `/voice` 403);
- registration retried correctly after an early `not_entitled`, which happened before sign-in completed;
- the CallKit lifecycle was normal;
- reservations created and released correctly;
- no SMS;
- no unattributed or uncontrolled cost;
- no production change.

### LF-2 options (for approval; nothing implemented)

"Forwarding confirmed" must mean **calls to the customer's own phone are being diverted to HCG**, not "some call reached the HCG number". The obvious signal doesn't exist: Twilio's `ForwardedFrom` was checked on **184 real production calls (8 Sep)** and always held the Twilio number itself, never the diverting line (`docs/mobile-app/APP_DECISION_008…`, `services/callRouting.js`). HCG therefore **cannot tell a forwarded call from a direct dial**.

| Option | How it proves forwarding | Cost / risk |
|---|---|---|
| **A. Verification call (recommended)** | HCG places one short outbound call **to the customer's own mobile number** from a dedicated verification caller ID. If forwarding is active, it comes straight back to the HCG number with that caller ID: stamp, then hang up immediately. Re-runnable ("Check my protection"). | Needs a deliberately allow-listed outbound path (today the egress guard rejects all PSTN/SIP). Fortress-funded, about £0.01–0.02 per check. A loop guard is needed (the verification caller ID is never re-dialled). This is a design change for approval |
| B. Stop auto-stamping on arbitrary calls | Only the in-app activation flow (customer dials the code, then a call arrives within 30 min) stamps it | Still can't tell a direct dial from a forwarded call, but removes the "any stray call makes you Protected" path. Cheap, and could ship with A |
| C. Honest wording until A exists | Home says "Calls are reaching Home Call Guard", not "Your phone is protected", unless verified by A | Product decision; weaker message |

Also reset the stamp when the household's **protected phone number** changes (evidence is already scoped to the current HCG number).

Tests to add with whichever option is chosen:
- a direct dial never makes a household "Protected";
- a stray call to a recycled number never does;
- only the chosen proof stamps.

**Decision for Andrew (LF-2):** A (+B), or ship the cohort with B + C and a support-led manual check per customer. Customers' phones must not be shown "Protected" on today's evidence.
