# Staging device test plan: iOS 1.0.2 Build 16, then Android 1.0.2 vc 22 (for 2026-10-05)

**Status: PLAN ONLY. Nothing here has been executed.** Prepared 2026-10-04 at branch `integration/soft-launch-candidate-2026-10-04` (code at `e63377f`).

**Goal:** prove the integrated 1.0.2 app end to end on the real iPhone (Build 16) against staging. Only then move to the Motorola (vc 22).

**Design rule:** Andrew touches only the phones (and sends one GO). Claude does everything on the Mac: server, tunnel, Twilio number pointing, database fixtures and checks, live iPhone logs (`idevicesyslog`), Android installation (`adb`), evidence and reset.

---

## 0. Fixed facts and limits (do not change)

| Item | Value |
|---|---|
| App under test | iOS **1.0.2 (16)**, TestFlight internal, EAS `be1f645c…`. Staging-only endpoints, verified in the binary. Startup PASS on 2026-10-04. |
| Backend | Local staging server (port 3099) behind the reserved ngrok domain `ferret-augmented-distrust.ngrok-free.dev`. Staging Supabase `tigwgmayeuisrxjjykqd` (migrations 052–072). |
| Staging number | **`…1883`** (Andrew calls it "…883"), production Twilio account. Voice URL **empty** outside the window. **Never released, never re-purposed.** |
| Staging household | `ffc4cfe1…` with active entitlement `935e230e…` |
| Phones (corrected 2026-10-05) | **Subscriber (runs HCG Build 16): Andrew's iPhone, its own number `…2700`.** **Caller: the Motorola** (its own SIM number, confirmed by Andrew 2026-10-05, ends `…3030`; the full number is used only in the staging fixture, never committed). `…2700` is **never** a trusted contact on the test household while the iPhone is the subscriber. |
| Fortress limits (unchanged) | **£0.30 per household** (£0.20 budget + £0.07 reserve + £0.03 essential), **£0.50 per hour**, **£1 per day**, **0 number purchases**, **600 s max call**, auto-hold at £0.50 per 24 h, at most 5 active calls |
| Expected spend | About £0.15–£0.40 in total. Hard ceiling £1/day from the Fortress, plus abort rule A3. |
| Never | production deploy or migrations, live Stripe/App Store/Play/RevenueCat changes, purchases, number purchase/release, any production household, call forwarding without explicit approval (§3, T12) |

---

## 1. Andrew's single GO (one message, before the window)

Reply **"GO staging window"** to approve all four:
1. **Reuse the production Twilio credentials and an OpenAI key in the staging process for the window only.** This includes the iOS push credential `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS`; without it the iPhone registers but never rings. The values live in a temporary file (mode 600) that is deleted at END. Residual risk: the master token, as documented in STAGING-READINESS §4.
2. **Claude points `…1883` at staging through the Twilio API** (and resets it at END), with a read-back each time.
3. **Claude creates a temporary staging login** linked to `ffc4cfe1`, and deletes it at END.
4. **The iPhone is connected to the Mac by cable** during the window (live logs via `idevicesyslog`).

Optional extras, each needing a separate "yes": **T12 call forwarding**, **T15b warning SMS**, **T19 admin login**.

---

## 2. START TEST WINDOW (Claude, about 10 minutes; Andrew does nothing)

| # | Action | Must hold before continuing |
|---|---|---|
| S1 | Read-only production fingerprint (row counts and newest timestamps). Production `…6063` Voice URL read-back. | Saved as the baseline |
| S2 | `…1883` Voice URL read-back | Empty |
| S3 | Staging DB: `verify-staging-schema.js`, `fc_check_invariants()`, `fc_global_status(now())`, `fc_household_status('ffc4cfe1…')`. Kill switch off, breaker closed, profile limits as in §0. | All match §0, otherwise STOP |
| S4 | Build the window env: copy `/Users/ad/hcg-staging-config/staging.env` to `window-2026-10-05.env` (mode 600). Replace the placeholders with the real `TWILIO_*` values (from the production `.env`, never printed), add `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS` and `OPENAI_API_KEY`. Keep `NUMBER_PROVISIONING_MODE=fake`, the sweep off, ops email off, Xero off, `HCG_DEPLOYMENT=staging`. | No `.env` in the worktree; the file is mode 600 |
| S5 | `STAGING_ENV_FILE=…/window-2026-10-05.env scripts/staging/start-staging-server.sh` (it refuses on non-staging Supabase, a live Stripe key or real provisioning) | `check-launch-config` → START |
| S6 | `ngrok http --url=ferret-augmented-distrust.ngrok-free.dev 3099`, plus `caffeinate -ims -w <ngrok pid>`. Record all PIDs. | `/health` 200 via the tunnel; unsigned `/voice` → 403 |
| S7 | Create the temporary login (admin `createUser`, email confirmed): `hcg-staging-iphone@example.com` with a one-time password, linked to `ffc4cfe1` (`auth_user_id`, `user_roles`). Seed one trusted contact = **the Motorola's number `…3030`** (never `…2700`). **Fixture corrections (preflight 2026-10-05), originals recorded first:** `phone_number` (`…0456`) → null so no warning SMS can be sent; `twilio_provisioning_status` `pending` → `active` so the number step can tick. | Login works via the API (bootstrap 200) |
| S8 | Point `…1883` Voice URL to `https://ferret-augmented-distrust.ngrok-free.dev/voice` (POST), then read it back | Read-back matches. **Window is now LIVE.** Time recorded |
| S9 | Start capture: `idevicesyslog` → evidence file (filtered to HomeCallGuard / CallKit / PushKit / TwilioVoice), staging server log, Fortress snapshot every 10 minutes | Capture running |

**Abort rules (any → END immediately):**
- A1: any production row or `…6063` changes versus S1.
- A2: an unexpected Twilio call or SMS that is not from the test.
- A3: Fortress global spend over £0.80 today, or the breaker trips without a test cause.
- A4: any call to `…1883` that is not answered by staging.
- A5: Andrew says stop.

---

## 3. iPhone test sequence (Build 16)

**Legend:** 📱 = Andrew touches the iPhone (HCG subscriber) · ☎️ = Andrew calls from the **Motorola** (caller only, no settings changed) · 💻 = Claude only.
Claude watches the iPhone log live and checks the server/DB after each step, so Andrew only needs to reply with what's in the "Andrew replies" column.

| # | Step | Who | Andrew replies | Claude verifies |
|---|---|---|---|---|
| T1 | Backend online: health, tunnel, number pointed | 💻 | – | S5–S8 green |
| T2 | Open HCG; sign in with the email/password Claude gives you | 📱 | "signed in" + what Home says | bootstrap + dashboard 200 for `ffc4cfe1`; no other household touched |
| T3 | Home: protection state + **HCG account number** | 📱 (look) | the account number shown + headline | Matches `households.account_number` and the canonical stage/blockers from the API |
| T4 | Tap Contacts, Membership, Help & Account (and "See setup steps") | 📱 | "all open" (or which didn't) | Contact `…3030` (the Motorola) listed; membership label matches the entitlement; no £ price shown for staging; setup steps = canonical gates |
| T5 | Allow **microphone** (and notifications if asked) when prompted | 📱 | "allowed" | Device readiness report: mic granted; Voice SDK registration with the **iOS** push credential; `voice_client_registered_at` set |
| T6 | Trusted call, **app in foreground**: call `…1883` from the Motorola; answer on the iPhone; talk 15 s; hang up | ☎️📱 | rang? answered? both hear each other? | `<Dial timeLimit>` present; 1 reservation; no stream/announcement; `delivery_verified_at` set; call row |
| T7 | Same, **app in background** (home screen) | ☎️📱 | rang (CallKit)? answered? | PushKit → CallKit in the iPhone log; reservation released |
| T8 | Same, **phone locked** | ☎️📱 | full-screen call UI? answered? | Same as T7 |
| T9 | Home after T6–T8 | 📱 (look) | headline | Expected **not "protected"** unless forwarding is verified (direct dial may count; record which). Stage and blockers recorded. |
| T10 | 💻 removes the Motorola (`…3030`) from trusted contacts (staging DB) | 💻 | – | Contact gone; app Contacts reflects it after refresh |
| T11 | **Unknown caller, monitored**: call `…1883` from the Motorola; listen to the announcement; answer; normal chat 30 s; hang up | ☎️📱 | announcement heard? rang? audio OK? | Announcement TwiML; media stream + transcription ran; Fortress monitoring reservation; spend recorded; no SMS |
| T12 | *(OPTIONAL, separate "yes")* Call forwarding from the iPhone's own number to `…1883` via the app's setup guide, then **switched off again** with the code the app shows | 📱 | done / not done | Forwarding verification for the current number. **Default: SKIP.** It routes Andrew's real incoming calls through staging while it is on. |
| T13 | **Warning path**: unknown call again; as the caller, read the warning script (Appendix A) | ☎️📱 | anything shown/heard? | Warning threshold reached in logs; recorded outcome; **SMS not sent** (household has no `phone_number`) |
| T14 | **Red-line termination**: unknown call; read the red-line script (Appendix A) | ☎️📱 | did the call end by itself? | HCG terminated the call; `terminated_by_system`; Fortress termination recorded |
| T15b | *(OPTIONAL, separate "yes")* Real warning SMS: Claude sets the staging household's `phone_number` to the iPhone's own number (`…2700`, the subscriber), then repeats T13 from the Motorola | ☎️📱 | SMS received? | Fortress + explicit-authority SMS path; one SMS; `phone_number` cleared afterwards |
| T16 | **Activity**: open Home → "See all activity" | 📱 (look) | count + latest outcome shown | `calls` rows (T6–T14) match the app list and outcomes |
| T17 | **Financial hold** (D-C5): 💻 sets a hold on `ffc4cfe1` (audited admin path) → Andrew pulls to refresh Home → ☎️ calls `…1883` | 📱☎️ | Home text; did the caller hear busy? | App shows the **approved D-C5 sentence** exactly; `/voice` → `<Reject reason="busy"/>` before any reservation; hold released afterwards (audited) |
| T18 | **Kill switch**: 💻 `fc_set_kill_switch(true)` → ☎️ calls `…1883` → 💻 kill switch off + `fc_reset_breaker` | ☎️ | busy? | Refused before spend; latch visible in `fc_global_status`; reset audited |
| T19 | *(OPTIONAL)* Andrew logs in to `/admin/business` on the Mac browser (staging URL) and opens each tab | Andrew (Mac) | "all tabs load" | MI-3 closed: real admin auth path |
| T20 | **Sign-out**: Account → Sign out; ☎️ calls `…1883` | 📱☎️ | caller heard? | Unregister reached the server; `/voice` unbilled `<Reject/>` (Finding-1, no paid apology); needs-attention/delivery health reflects it |
| T21 | **Reconnect**: sign in again (same login) → Home | 📱 | headline | Re-registration; Reconnect/needs-attention clears; trusted call (☎️) rings again |
| T22 | **Backend unavailable**: 💻 stops the tunnel only (server stays up); Andrew pulls to refresh | 📱 | headline | App shows "couldn't confirm your protection"; **never "protected"**. 💻 restarts the tunnel |
| T23 | Budget behaviour (last; only if budget remains): repeated unknown calls until the Fortress refuses | ☎️ | busy at some point? | Refusal at the £0.30 household cap; global caps unaffected; limits **not raised** |

**Andrew's physical actions (iPhone):** T2, T3, T4, T5, T6–T8 (answer), T9, T11, T13, T14, T16, T17, T20, T21, T22, plus T12/T15b only if approved. **On the Motorola (caller):** calls in T6–T8, T11, T13, T14, T17, T18, T20, T21, T23 (about 12 calls, each under 60 s).

---

## 4. END / RESET TEST WINDOW (Claude; mandatory even after an abort)

| # | Action | Verified by |
|---|---|---|
| E1 | **`…1883` Voice URL → empty** (POST, no fallback, no status callback) | Read-back empty. This happens **first**, so no call can reach a stopped server. |
| E2 | If T12 ran: confirm Andrew switched forwarding off (`*#21#` result: "not forwarded") | Andrew's reply |
| E3 | Fortress: kill switch **off**, breaker **closed**, no hold on `ffc4cfe1` (all audited, actor `claude:staging-window`); `fc_check_invariants()` ok | SQL read-back |
| E4 | Fixtures: delete the temporary login (auth user + `user_roles`); unlink `ffc4cfe1` (`auth_user_id` null, original email); restore the recorded originals: `phone_number` (`…0456`) and `twilio_provisioning_status` (`pending`); remove test contacts. **Call rows are kept as evidence.** | SQL read-back |
| E5 | Stop the server, ngrok and caffeinate (PIDs verified by command and working directory before each kill) | Port 3099 free; tunnel 404 |
| E6 | **Delete** `window-2026-10-05.env` (the real secrets) | File absent |
| E7 | Production fingerprint versus S1; `…6063` Voice URL unchanged | Identical |
| E8 | Twilio usage for the window (read-only: calls + SMS on `…1883`) versus Fortress ledger | Within 20%; total under £1 |
| E9 | Evidence committed: logs (secrets/phones masked), the PASS/FAIL table, Fortress snapshots → `docs/launch-gate/evidence/2026-10/` | Commit SHA |

The iPhone keeps Build 16 installed (harmless; it shows "couldn't confirm" while staging is offline).

---

## 5. PASS / FAIL evidence table (filled in during the window)

| # | Check | Result | Evidence |
|---|---|---|---|
| S1–S9 | Window started safely; limits as in §0 | | |
| T2 | Staging sign-in, correct household | | |
| T3 | Home state + HCG account number correct | | |
| T4 | Contacts / Membership / Help & Account / Setup steps | | |
| T5 | Microphone permission + iOS Voice registration | | |
| T6 | Trusted call: foreground | | |
| T7 | Trusted call: background (CallKit) | | |
| T8 | Trusted call: locked | | |
| T9 | Protection state truthful after calls | | |
| T11 | Unknown caller monitored (announcement + monitoring) | | |
| T12 | Forwarding (optional) | | |
| T13 | Warning detection | | |
| T14 | Red-line termination | | |
| T15b | Warning SMS (optional) | | |
| T16 | Activity records match | | |
| T17 | Hold → D-C5 wording + busy, no spend | | |
| T18 | Kill switch refuses, then reset | | |
| T19 | Admin login (optional) | | |
| T20 | Sign-out → unbilled reject | | |
| T21 | Reconnect restores delivery | | |
| T22 | Backend down → "couldn't confirm", never protected | | |
| T23 | Household budget cap refuses | | |
| E1–E9 | Staging reset; production unchanged; spend under £1 | | |

---

## 6. Motorola: Android 1.0.2 vc 22 (only after §3 is complete and E1–E9 are done or the window is still open)

**Andrew's physical actions:** connect the Motorola by USB and unlock it. One time only: Settings → About phone → tap **Build number** 7 times, then Settings → System → Developer options → **USB debugging** ON. Tap **Allow** on the "Allow USB debugging?" prompt (tick "Always allow from this computer"). Later: sign in, grant permissions, answer calls (as T2–T8).

**Roles swap for the Android section (corrected 2026-10-05):** the Motorola becomes the HCG subscriber (vc 22) and **the iPhone (`…2700`) becomes the caller**. Before M7:
- **sign out of HCG Build 16 on the iPhone** (Account → Sign out), so only the Motorola is registered for the staging household and a call can't ring both phones;
- 💻 replaces the trusted contact with `…2700` (the iPhone, now the caller) and removes `…3030`, so the Motorola is never its own trusted caller.

The Motorola's normal mobile service is never changed by being the caller in §3: outgoing calls only, no forwarding or settings touched.

**Claude (adb, no other tools needed):**

| # | Action |
|---|---|
| M1 | `adb devices -l`: one device, authorised |
| M2 | Inspect: `adb shell pm list packages \| grep homecallguard`; `dumpsys package co.uk.homecallguard.app` (versionCode, installer, signing). Expected: **not installed** (the Play app was removed). If a Play-signed build is present → STOP and ask (signature mismatch would block the install, and uninstalling removes its data). |
| M3 | APK: re-download vc 22 from EAS `d2c03b4b…` (**artifact expires 2026-10-18**); SHA-256 recorded; re-check that the bundle has staging URLs only and `AssetModule` present |
| M4 | `adb install vc22.apk`, then `dumpsys package`: versionCode **22**, versionName **1.0.2**, installer = adb |
| M5 | `adb logcat -c`, then `adb logcat` → evidence file (ReactNativeJS, AndroidRuntime, Twilio*, FCM, HCG). Launch: `adb shell monkey -p co.uk.homecallguard.app 1` |
| M6 | Startup check: no `FATAL EXCEPTION` / `ReactNativeJS` error; reaches the welcome/sign-in screen. Screenshot: `adb exec-out screencap -p > m6.png` (Claude can view it, so Andrew doesn't need to describe screens) |
| M7 | Andrew signs in (staging login). Claude checks the FCM registration with the **Android** push credential |
| M8 | Repeat T3–T8, T11, T17, T20–T22 using the Motorola (screenshots via adb instead of Andrew's descriptions) |
| M9 | Diagnostics on any failure: `adb bugreport` (only if needed), `dumpsys notification`, `dumpsys power` (battery optimisation), app-ops for full-screen intent |
| M10 | Afterwards: leave vc 22 installed or `adb uninstall` (Andrew's choice). Andrew restores the Play app if he wants production on that phone. |

The same window (§2/§4) covers both phones. If the Motorola runs on a different day, the full START/END procedure is repeated.

---

## 7. What a successful test unlocks (target: small controlled commercial launch Thu/Fri)

**Unlocks (turns RED → GREEN):**
- Staging gate **G3–G6, G8–G11, G18, G23** (and G12 partially), with real-device evidence on iOS. G7 only if T15b runs.
- MI-3 if T19 runs.
- Confidence that **1.0.2 is functionally ready**, so a **production iOS candidate (Build ≥ 17, `production` profile)** can be built from the same source.
- If the Motorola passes: the same for **Android (vc ≥ 23, `production` profile → Play Internal/Closed track)**.

**Still launch-blocking after a successful test:**
1. **Production backend and migrations not deployed**: 053, 066, 067, 070 (+ 071/072) must go before the backend; then backup/restore point, `check-launch-config` START, and the first signed production call (C1–C4).
2. **Provider containment:** Twilio has no spend cap and the master token is in the backend. At minimum a `<Reject/>` fallback on every production number, a usage trigger, and a **written acceptance** of the residual risk (C7). OpenAI project spend limit evidenced (C8).
3. **Price £5.99 not live anywhere:** live Stripe price, App Store Connect/RevenueCat product, website, terms §4, store listings (C11). Live 1.0.1 still shows £4.99.
4. **Production store builds:** iOS Build ≥ 17 through TestFlight review (or iOS sign-ups not offered for the cohort, C6); Android production build on a closed track (C5). Android Play Billing is still required before Play **Production** (P2). For a closed cohort, Stripe on a closed track is a decision.
5. **Apple cancellation/billing-issue state** not recorded (needs migration 073). Acceptable for a tiny cohort only with a written acceptance.
6. **Operations:** operations@ mailbox and alert delivery (C9), support process and refund rule (C10), Fortress production budget profiles from the £5.99 economics (C12), founder notification of each genuine customer (C13), invite-only sign-ups (C15).

---

## Appendix A: caller scripts (Andrew reads these as the caller, from the Motorola)

- **Normal (T11):** "Hi, it's just me checking in, how's your day been?"
- **Warning (T13):** "This is your bank's fraud team. There's a problem with your account and we need you to confirm your details today."
- **Red-line (T14):** "I need you to read me the full card number and the three digits on the back right now, and the code we just texted you."

These are test phrases only; nobody's real data is used.
