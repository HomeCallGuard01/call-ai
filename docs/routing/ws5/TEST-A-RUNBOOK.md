# WS5 Test A: silence → no-reply forwarding → Lebara's own voicemail (attended runbook)

**Status: READY, NOT RUN.** Needs approvals A-1..A-5 (§A.9). Prepared 2026-10-10 by WS5. Cost to HCG **£0**. No HCG, Twilio, Magrathea or staging system is touched.
**Question:** on the Motorola + Lebara, does a call that the call-screening app *silences* (not rejects) stay on the network as an unanswered call, so Lebara's no-reply forwarding (CFNRy) sends it to voicemail after the timer, while contacts ring natively?

| Role | Device |
|---|---|
| Phone under test | Motorola Moto E7, Lebara SIM `…3030` (the production-HCG test device) |
| Caller | iPhone `…2700` (its HCG app signed out, so no HCG push can confuse the result) |
| Mac | adb (`~/Library/Android/sdk/platform-tools/adb`), probe APK `~/hcg-android-probe/v0.3/hcg-divert-probe.apk` |

**Run it on its own.** Never in the same window as a launch handset session that sets `**21*` on the Motorola. Allow **75–90 minutes** including restore.

---

## A.0 Evidence folder (Mac, before starting)
```
mkdir -m 700 -p ~/hcg-ws5-evidence/testA-$(date +%Y%m%d)
cd ~/hcg-ws5-evidence/testA-$(date +%Y%m%d)
```
Everything with phone numbers (logcat, dumpsys, screenshots, recordings) stays here, outside git. Only the results sheet (no numbers) goes into the repo.

## A.1 Gates: read-only, on the Motorola dialler (record every answer verbatim, screenshot each)

| # | Dial | Record | Rule |
|---|---|---|---|
| G1 | `*#21#` (always forward) | active? number? | **If active: this is the Motorola's production HCG number.** Write it down in full (needed for restore). Continue to A.2 only with approval A-1 |
| G2 | `*#61#` (no reply) | number + seconds | **Expected: Lebara voicemail number + a timer.** This number IS the Lebara voicemail number for this runbook (**TO CONFIRM**: no HCG document records Lebara's voicemail number; read it here). If "not active" or not a Lebara number: **STOP** (nothing for SILENCE to divert to; changing it is a new decision) |
| G3 | `*#62#` (unreachable) | number | record only |
| G4 | `*#67#` (busy) | state | record only. Known wedged state after Magrathea Test 4 (inactive, re-registration gave "invalid MMI"). **Do not try to fix it in this session** |
| G5 | `*#43#` (call waiting) | active? | record; step 4 depends on it |
| G6 | Settings › About phone | Android version; **`adb shell getprop ro.build.version.sdk`** after A.3 | **If SDK = 29 (Android 10): see §A.3 gate S3** |
| G7 | Settings › Apps › Default apps › **Caller ID & spam app** | current holder (often Phone by Google, or None) | needed to restore |
| G8 | Wi-Fi Calling | on/off | record; keep it unchanged all session |
| G9 | Do Not Disturb | off; record its "People › Calls" exceptions | must be OFF except in step 7 |
| G10 | Contacts | is the iPhone `…2700` saved? | record; steps change it |

The Phone app's **Settings › Calls › Call forwarding** screen shows the same four rows; screenshot it too.

## A.2 Turn always-forward off (only if G1 was active; approval A-1)
1. Dial `#21#` (deactivate; keeps the registration). Do **not** use `##21#` or `##002#` (`##002#` erases voicemail-on-no-answer too).
2. Dial `*#21#` → must show **not forwarded / inactive**. If it still shows forwarding: **STOP**, restore (A.8).
3. Re-dial `*#61#` → must still equal G2 (the deactivation must not have touched CFNRy).

Effect: HCG protection on this test phone is paused until A.8 restores it. No customer is affected. Admin delivery-health views may flag the household; expected.

## A.3 Install the probe (approval A-2)
1. Motorola: Settings › About phone › tap Build number 7× → Developer options › **USB debugging on**. Connect USB, accept the Mac's key.
2. Mac:
```
cd ~/hcg-ws5-evidence/testA-$(date +%Y%m%d)
shasum -a 256 -c ~/hcg-android-probe/v0.3/hcg-divert-probe.apk.sha256      # must print: OK
#   expected 2ac081eeb852fee2f79fc31a329272e3345be3a9fe2d16053ab5cc62f82918a4
adb devices                                     # exactly ONE device, state "device"
adb shell getprop ro.product.model              # the Moto E7
adb shell getprop ro.build.version.sdk          # S3: see below
adb shell pm list packages | grep divertprobe   # must be EMPTY (no v0.2 left over)
adb install ~/hcg-android-probe/v0.3/hcg-divert-probe.apk
adb shell dumpsys package co.uk.homecallguard.divertprobe | grep -E "versionName|versionCode"   # 0.3-research, 3
```
3. **Gate S3 (found by WS5 on 2026-10-10):** the probe's log line calls `Call.Details.getCallerNumberVerificationStatus()`, which exists only from **API 30** (Android SDK `api-versions.xml`: `since="30"`). It is called *after* the probe has already responded to Telecom, so the decision still applies, but on **Android 10 (SDK 29)** the probe would crash after every screened call and write no log line.
   - **SDK ≥ 30:** continue.
   - **SDK = 29:** **STOP** before any call and ask Andrew to approve a rebuild as v0.3.1 with the one-line guard in `docs/routing/ws5/probe-v0.3.1-api29-guard.patch` (re-run 37 unit tests, record the new SHA-256, uninstall v0.3 first: a rebuild has a new key). Do not run with v0.3 on SDK 29.
4. Open **HCG Divert Probe** → **"1. Make this the call-screening app"** → accept. Status must show **"Screening role held: YES"**, mode **OBSERVE**, and the SDK/device line.
   - Cross-check: `adb shell dumpsys role | grep -A2 CALL_SCREENING` (should list `co.uk.homecallguard.divertprobe`).
   - Role unavailable or refused: **STOP**, record, go to A.8.
5. Battery: Settings › Apps › HCG Divert Probe › Battery › **Unrestricted** (removes one variable; restore not needed after uninstall).

## A.4 Capture set-up (Mac, keep running)
Terminal 1 (whole session):
```
adb logcat -c
adb logcat -v threadtime -b main,system,radio,events > logcat-session.txt
```
After **each** call:
```
adb shell dumpsys telecom > dumpsys-telecom-<step>.txt
```
Per call, optional screen recording of the Motorola (≤ 90 s): `adb shell screenrecord --time-limit 90 /sdcard/ws5-<step>.mp4` started just before dialling; afterwards `adb pull /sdcard/ws5-<step>.mp4 . && adb shell rm /sdcard/ws5-<step>.mp4`.
iPhone: start Screen Recording (Control Centre) before dialling, so the call timer is captured (call audio is not recorded; note what was heard).
Afterwards, filter (Mac, no device needed):
```
grep -nE "Telecom|CallScreening|Ringer|FILTERING|SCREENING|[Ss]ilen|[Rr]eject|DISCONNECT|ALERTING|CallFailCause" logcat-session.txt > logcat-filtered.txt
grep -nE "FILTERING|SCREENING|[Ss]ilen|[Rr]eject|DISCONNECT" dumpsys-telecom-*.txt > dumpsys-filtered.txt
```
(The exact Telecom event names vary by build. The decisive evidence is the timing and what the caller hears; the logs explain it.)

**Timings to record for every call:** T0 = dial pressed on iPhone; T1 = first ringback heard on iPhone; T2 = Motorola shows the call (screen/recording); T3 = Lebara voicemail greeting heard (or busy/disconnect); probe `respondedIn` (probe UI log). Hang up **before** the beep; never leave a message.

## A.5 The calls (allow-list in the probe stays EMPTY throughout; contacts decide "trusted")

Before 1: iPhone **not** in Motorola contacts (delete it if G10 showed it saved; note it for restore).

| # | Set-up | Action | PASS | FAIL / STOP |
|---|---|---|---|---|
| **1 Baseline** | Probe **OBSERVE** (no silencing) | iPhone calls; don't touch the Motorola. ×2 | Motorola **rings audibly**; iPhone hears ringback, then the **Lebara greeting** at T3−T0 = **N** s (≈ G2 timer + a few s). Probe log `decision=ALLOW`. Both runs within ±3 s | Rings out with no voicemail, or busy → **STOP** (no CFNRy to observe; record) |
| **2 Trusted** | Save the iPhone as a **contact** on the Motorola. Mode **SILENCE** | iPhone calls; **answer** on the Motorola after ~5 s; hang up. Then call again, don't answer | Rings **audibly**; **no probe log line** (Android doesn't pass contacts to an app without READ_CONTACTS). Unanswered run: greeting at ≈ N s (this is the "leakage" path) | A log line for the contact → **STOP SILENCE tests** (contacts reach the app; record) |
| **3 Unknown** ★ | Delete the iPhone contact. Mode **SILENCE** | iPhone calls; don't touch. **×3** | **No ringtone** (call may be visible on screen); iPhone hears **ringback the whole time**, then the **Lebara greeting at N ± 3 s**; log `decision=SILENCE respondedIn=<5000ms`; Motorola call log shows a **missed** call (not "blocked") | Busy, "not available", or disconnect before N → the call was **rejected** somewhere = **FAIL** (record, stop step 3–7, restore). Rings out with no voicemail = **FAIL** |
| 3w (info) | as 3 | iPhone dials `141` + Motorola number (withheld). ×1 | Rings **audibly** (withheld calls are not screened on Android 11+; on Android 10 the probe sees an empty number and fails open) | — |
| **4 Call waiting** | Mode SILENCE; iPhone **not** a contact. Motorola dials its **own voicemail** (G2 number; Lebara voicemail access cost TO CONFIRM, normally free) and stays on it | iPhone calls the Motorola while it is on that call. Then repeat with the iPhone saved as a contact | Unknown: **no call-waiting tone**; iPhone hears ringback, then greeting at ≈ N s (CW on, G5) or the greeting at once (CW off → network busy → CFB to voicemail; G4 permitting). Contact: **call-waiting tone**, can be answered | Unknown hears busy/disconnect while G5 = CW on → **FAIL** (record) |
| **5 Locked** | Motorola screen locked. SILENCE; iPhone not a contact, then a contact | iPhone calls; don't touch | Unknown: no ring, greeting at ≈ N s. Contact: rings audibly, lock-screen answer UI | as step 3 |
| **6 Probe killed** | SILENCE. `adb shell am force-stop co.uk.homecallguard.divertprobe` | iPhone (unknown) calls; don't touch. Then 6b: Default apps › Caller ID & spam → **None**, call again; then re-grant the role (A.3 step 4) | **Either** still silenced → greeting at ≈ N s (Telecom re-binds the service), **or** rings audibly → greeting at ≈ N s (fail-open). 6b: rings audibly (fail-open) | Busy/disconnect, or call never shown → **FAIL-SAFETY** |
| **7 Do Not Disturb** | DND **on** with G9's exceptions. SILENCE | iPhone unknown, then contact | Record what each did: expected unknown → greeting at ≈ N s; contact rings only if DND allows contacts, else greeting at ≈ N s (a trusted call diverted = leakage) | Busy/disconnect → FAIL |

★ Step 3 is the decisive result.

**SILENCE switches itself off 2 hours after it is tapped.** If the session runs long, tap SILENCE again (status shows the new auto-off time).

### Optional A-opt: shorter timer (approval A-5; default **skip**)
Only if G2's timer is above 20 s and Andrew wants the faster CFNRy measured: `**61*<G2 voicemail number>**15#`, check `*#61#` shows 15 s, repeat step 3 ×1. Restore in A.8 step 1 with G2's own seconds. Use `node tests/ws5-forwarding-codes.test.mjs`'s `cfnryRegister`/`restorePlan` logic (or have Claude generate the exact strings from the recorded gate values). **Never `##61#`** (erases voicemail-on-no-answer).

## A.6 Pass criteria
**Test A PASS** = step 1 PASS (both), step 2 PASS (rings, no log line), **step 3 PASS 3/3**, step 4 unknown not busy when CW on, step 5 PASS, step 6 no FAIL-SAFETY, step 7 no busy, **and** restore verified (A.8).
**PARTIAL** = step 3 passes 1–2 of 3, or step-3 timing differs from N by more than 3 s consistently (record; may indicate an OEM change), or vibration on silenced calls (cosmetic).
**FAIL** = step 3 busy/disconnect or rings out. Result: SILENCE+CFNRy is NO-GO on Lebara/Motorola (like D1); do not run Test B; record and test another network/handset before giving up the architecture.

## A.7 Stop rules (any one → stop calls, go to A.8)
- Anything rings the **HCG app** or appears in HCG admin (it means forwarding still points at HCG): stop immediately.
- `*#21#` shows forwarding active after A.2.
- Any network message about charges, barring, or "invalid MMI" on an interrogation code.
- A trusted (contact) call is silenced or busy.
- The probe shows "Screening role held: NO" unexpectedly, or crashes (S3).
- More than 25 calls made, or 90 minutes elapsed.
- Andrew wants to stop.

## A.8 Mandatory restoration (in order; tick each)
1. Probe: tap **OBSERVE**, **Clear allow-list**, **Clear log**.
2. If A-opt was run: `**61*<G2 number>**<G2 seconds>#` → `*#61#` must equal G2 exactly.
3. `adb uninstall co.uk.homecallguard.divertprobe` → `adb shell pm list packages | grep divertprobe` is empty (uninstall also drops the role and its stored numbers).
4. Settings › Default apps › **Caller ID & spam app** = G7.
5. Contacts: iPhone saved / not saved exactly as G10. DND off (G9). Wi-Fi Calling = G8.
6. Delete `/sdcard/ws5-*.mp4` if any remain: `adb shell ls /sdcard/ | grep ws5` → empty.
7. USB debugging **off**; Developer options off.
8. **Always-forward:** only if G1 was active, and only with approval A-1's restore half: `**21*<G1 number exactly>#` → `*#21#` shows that number. (Restoring it sends the Motorola's calls to production HCG again, as before the test.)
9. Final read-back: `*#21#`, `*#61#`, `*#62#`, `*#67#`, `*#43#` all equal G1–G5. Screenshot.
10. One iPhone → Motorola call: behaves as before the test (to HCG if G1 was active; rings natively otherwise). Hang up.

## A.9 Approvals (Andrew)

| # | Approval | Reversal |
|---|---|---|
| A-1 | Deactivate always-forward (`#21#`) on the Motorola for the session (pauses production HCG on this test phone), and re-register it to the exact G1 number at the end | A.8 step 8 |
| A-2 | USB debugging on; `adb install` of the archived probe v0.3 (SHA-256 `2ac081ee…18a4`); grant it the call-screening role (displaces G7's holder) | A.8 steps 3, 4, 7 |
| A-3 | About 15–25 iPhone → Motorola calls, each ≤ 60 s, no messages left, plus calls from the Motorola to its own voicemail (step 4) | — |
| A-4 | Edit the Motorola's contacts (iPhone saved/removed), toggle DND, force-stop the probe, set Caller ID app to None (6b) | A.8 step 5 |
| A-5 | *(optional, default skip)* re-register CFNRy to the same Lebara voicemail number with a 15 s timer, restored to G2 | A.8 step 2 |
| — | If S3 finds SDK 29: separate approval to rebuild the probe as v0.3.1 | — |

**Cost:** £0 to HCG. Lebara/iPhone plan usage only (UK calls ≤ 60 s each; forwarding to the network's own voicemail).

## A.10 Results sheet (no phone numbers)
```
Date/time ____  Android ____ (SDK __)  Wi-Fi Calling __  CW (*#43#) __  Caller-ID app before ____
G1 CFU active __ (number recorded privately)  G2 CFNRy → Lebara VM __, timer __ s  G4 CFB state ____
A.2 CFU off verified __     A.3 sha OK __  role held __  S3 SDK ≥30 __
Step 1 baseline   #1 rang __ T3−T0 __ s   #2 rang __ T3−T0 __ s     N = __ s
Step 2 trusted    rang __  log line (must be none) __  unanswered → VM at __ s
Step 3 unknown    #1 rang(audible) __  heard ____  T3−T0 __ s  respondedIn __ ms  calllog missed/blocked __
                  #2 ...                          #3 ...
Step 3w withheld  rang __  probe line __
Step 4 CW         unknown: tone __ heard ____ at __ s   contact: tone __ answered __
Step 5 locked     unknown ____ __ s   contact ____
Step 6 killed     6a: silenced/rang __ heard ____ __ s   6b (no role): rang __ __ s
Step 7 DND        unknown ____ __ s   contact ____ __ s
Vibrated on silenced calls __
Restore 1–10 ticked __   final read-back equals gates __
OUTCOME: PASS / PARTIAL / FAIL     Evidence folder: ~/hcg-ws5-evidence/testA-YYYYMMDD
```
