# Test A results: SILENCE + no-answer forwarding on Motorola / Lebara (2026-10-10)

- **Attended by Andrew.** Evidence (phone numbers, logcat, Telecom dumps) is kept privately in `~/hcg-ws5-evidence/testA-20261010/` and is not in the repo.
- **Cost:** £0 to HCG. Only ordinary Lebara-to-Lebara calls ending at Lebara voicemail. No HCG or Twilio number, purchase or AI was used.

## Set-up as found and as changed

| Item | Before | During and after |
|---|---|---|
| Handset | Moto E7, **Android 10 (SDK 29)**, Lebara SIM | Unchanged |
| Always forward (`*#21#`) | Not forwarded | Unchanged |
| No-answer forwarding (`*#61#`) | **Not forwarded** (baseline call rang out, with no voicemail) | `**61*+447836121121*20#` was **refused**: "Connection problem or invalid MMI code". Andrew then called Lebara's **1211** (voicemail reactivation). Lebara set it to **voicemail 121 after 15 s** |
| Unreachable (`*#62#`) | Lebara voicemail | Unchanged |
| Busy (`*#67#`) | Not forwarded | Unchanged |
| Call waiting | On | Unchanged |
| Call-screening role | No holder | **HCG Divert Probe v0.3.1** (SHA-256 `1d3423ec…5970`) installed by adb; role granted by Andrew. The first "role held" report was not confirmed on the device. Verified by `dumpsys role` before any call |

## Calls (Telecom record; `CSCR.aC` = probe allowed, `CSCR.sC` = probe silenced)

| Time (BST) | Probe mode | Caller | Probe reply | Ringer | Outcome |
|---|---|---|---|---|---|
| 15:34:38 | OBSERVE | iPhone, not a contact | Allow | Rang | Missed after about 14 s → Lebara voicemail |
| **15:45:14** | **SILENCE** | iPhone, not a contact | **Silence** | **No** | **Missed after about 15 s → Lebara voicemail** ✅ |
| **15:46:49** | **SILENCE** | iPhone, not a contact | **Silence** | **No** | **Missed after about 17 s → Lebara voicemail** ✅ |
| 15:49:17 | SILENCE | iPhone, **saved contact** (Telecom: contact found) | **Silence** | No | Missed → voicemail ❌ (see finding 2) |
| 15:53:32 | OBSERVE | iPhone, saved contact | Allow | Rang | Missed → voicemail |
| 15:57:03 | OBSERVE | iPhone | Allow | Rang | Missed → voicemail |

The probe responded every time (20–50 ms). There were no crashes, so the v0.3.1 Android 10 fix works.

## Findings

1. **PROVEN (Lebara, Android 10, one handset):** a call silenced by a call-screening app is **not rejected**. The caller hears ringing, and the network's **no-answer forwarding fires on its normal timer**, reaching voicemail after 15–17 s. There was no busy and no early disconnect. This is the mechanism the trusted-caller bypass depends on.
2. **DISPROVEN assumption:** "Android never passes calls from saved contacts to a screening app without contacts permission." On this Android 10 build, Telecom recognised the contact and **still sent the call to the probe**. The probe silences everything not on its own allow-list, so the contact was silenced.
   - **Consequence:** the product must decide "trusted" inside the app, using HCG's own trusted-contacts list synced to the device, and must never rely on Android to skip contacts.
   - Behaviour on Android 11+ is not tested.
3. **Carrier set-up risk (Lebara):** registering no-answer forwarding **by MMI code was refused** ("invalid MMI"), even when the target was Lebara's own voicemail. Lebara's own 1211 service set it instead.
   - On 9 Oct, a busy-forwarding re-registration by code was also refused.
   - **Customer set-up on Lebara cannot be assumed to work by code.** Test B (forwarding to an external number) may be impossible on Lebara for the same reason.

## Not yet tested

- The allow-list path: an allow-listed number while in SILENCE should ring.
- Fail-safe when the probe is force-stopped.
- Locked screen, call waiting and Do Not Disturb.
- Android 11+.
- Other carriers.
- Forwarding to an external (HCG) number: Test B.

## Probe timer (from source, `ScreeningPolicy.java`)

- SILENCE and REJECT last **2 hours** (`REJECT_WINDOW_MS`) from the moment the mode is tapped.
- Expiry is **evaluated at each call**. There is no background timer or job.
- After expiry, every call is **allowed** (rings normally). Uninstalling removes the role and the stored state.
- Nothing in the probe can restart or re-enable itself.
