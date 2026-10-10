# Test A, short form: does a SILENCED call forward on no-answer? (Motorola + Lebara, carrier voicemail only)

**Status: PREPARED, NOT RUN.**
- Nothing is installed, no forwarding has changed, no call has been made.
- Every 🔴 step needs Andrew's GO at execution time.
- Full runbook with every edge case: `TEST-A-RUNBOOK.md`.

| | |
|---|---|
| **Question** | Will a call the app *silences* (not rejects) still go to Lebara voicemail after the no-answer timer? If yes, trusted callers can ring the phone directly at £0 to HCG |
| **Cost** | £0. Calls are iPhone → Motorola (normal mobile calls) and end at the voicemail greeting, with no message left. No HCG number is involved and no Twilio activity |
| **Time** | About 45 minutes |
| **Phones** | Motorola (Lebara SIM `…3030`) = the test phone. iPhone `…2700` = the caller |
| **Probe** | **v0.3.1**, `~/hcg-android-probe/v0.3.1/hcg-divert-probe-v0.3.1.apk`. SHA-256 `1d3423ec1068eabaeca58322080de6104bfa8b78d84db7bf4974458e26035970`. Built 2026-10-10 from the v0.3 source plus the one-line Android 10 guard. 37/37 unit tests pass. No permissions. Android 10+. Replaces v0.3, which would crash on Android 10 |

## 1. Read-only checks on the Motorola (no change; screenshot each)

1. `*#21#`: always-forward. **If active, it points at the Motorola's production HCG number. Write it down exactly.**
2. `*#61#`: no-answer forwarding. **Must be a Lebara voicemail number plus a timer. Record both.** If not active: **STOP** (nothing to divert to).
3. `*#43#`: call waiting (record only).
4. Settings › Default apps › **Caller ID & spam app**: record the current holder.
5. Is the iPhone saved in Contacts? Record.

## 2. 🔴 Set-up

1. **Only if step 1.1 was active:** dial `#21#` (deactivate; not `##21#`).
   - Re-check: `*#21#` = inactive, and `*#61#` = unchanged.
   - *This pauses production HCG on this test phone only, until step 5.*
2. USB debugging on. On the Mac:
   ```
   shasum -a 256 -c ~/hcg-android-probe/v0.3.1/SHA256SUMS
   adb devices
   adb shell getprop ro.build.version.sdk
   adb install ~/hcg-android-probe/v0.3.1/hcg-divert-probe-v0.3.1.apk
   ```
   The checksum must print OK. `adb devices` must show exactly one device. Record the SDK level.
3. Open **HCG Divert Probe** → **Make this the call-screening app** → accept. It must show **Screening role held: YES**.
4. On the Mac, start the log: `adb logcat -c; adb logcat -v threadtime > ~/hcg-ws5-evidence/testA-short.log`.

## 3. 🔴 Calls (≤ 10; each ends at the voicemail greeting; never leave a message)

The iPhone must **not** be a Motorola contact unless stated. Record for each: seconds from dial to greeting; what the iPhone heard; what the Motorola did.

| # | Probe mode | Call | PASS |
|---|---|---|---|
| 1 Baseline | OBSERVE | iPhone → Motorola, don't answer | Motorola rings; greeting after **N** s (about the `*#61#` timer) |
| **2 Unknown ★ ×3** | **SILENCE** | iPhone → Motorola, don't touch | **No ringtone**; the iPhone hears ringback all the way, then the **greeting at N ± 3 s**. Probe log `decision=SILENCE`. The Motorola log shows a *missed* call |
| 3 Trusted | SILENCE, with the iPhone **saved as a contact** | iPhone → Motorola; answer, then hang up | **Rings normally** and can be answered |
| 4 Fail-safe | SILENCE; `adb shell am force-stop co.uk.homecallguard.divertprobe` | iPhone (not a contact) → Motorola | Either silenced → greeting, or rings normally → greeting. **Never busy or cut off** |

**★ Call 2 decides the experiment.**
- **PASS** = all three calls reach the greeting at N ± 3 s.
- **FAIL** = busy, "not available" or a disconnect before N. That means the network treated the silence as a reject.

## 4. Stop immediately (then go to step 5) if

- anything rings the **HCG app**;
- `*#21#` shows forwarding active after step 2.1;
- any network message about charges, barring or "invalid MMI";
- a contact's call is silenced;
- more than 10 calls, or 60 minutes.

## 5. 🔴 Restore (mandatory, in order)

1. `adb uninstall co.uk.homecallguard.divertprobe`. Then `adb shell pm list packages | grep divertprobe` must be empty. Uninstalling also drops the screening role.
2. Caller ID & spam app = the value from step 1.4. Contacts as in step 1.5. USB debugging off.
3. **Only if step 1.1 was active:** `**21*<number from step 1.1 exactly>#`. Then `*#21#` must show that number. This reconnects production HCG on the phone.
4. Read back `*#21#` and `*#61#`: they must equal step 1. Screenshot.
5. One iPhone → Motorola call behaves as before the test.

## Approvals for this session (one GO covers all)

| # | Approval |
|---|---|
| A-1 | Only if step 1.1 shows always-forward active: switch it off for the session (pauses production HCG on this test phone) and restore it exactly at the end |
| A-2 | Install **v0.3.1** over adb, and grant it the call-screening role. Removed at the end |
| A-3 | Up to 10 iPhone → Motorola calls, each ending at the voicemail greeting |
| A-4 | Temporarily save, then remove, the iPhone contact on the Motorola; force-stop the probe |

**If PASS:** Test B (`TEST-B-RUNBOOK.md`) is the next session. It forwards no-answer calls to the staging number `…1883` set to reject every call, to prove routing to an external HCG number on Lebara; cost about £0.

**If FAIL:** bypass silence + no-answer forwarding is NO-GO on Lebara/Motorola. Record it, and re-test only on another carrier.
