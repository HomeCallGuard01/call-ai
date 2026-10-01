# Real-handset staging test: Motorola conversion and restoration plan

Status: **PLAN ONLY — awaiting Andrew's supervised session (planned 2026-10-02).**
Nothing has been built, installed or changed on the Motorola. No EAS build has been started.

Related: `docs/security/VOICE_SURFACE_P0_HANDOVER_2026-10-01.md` (what is proven and what this test must prove).

## 0. Inputs still needed from Andrew (read-only, from the handset)

| # | What | Why |
|---|---|---|
| a | Account email and HCG number shown in the app | Identifies the production household; production data alone cannot (no protected number ends 0303; production has no device→household history table) |
| b | Settings → Apps → Home Call Guard: version, and install source (Play production / Play Internal Testing e.g. Build 19 / sideloaded) | Exact restoration. Play reinstalls the newest build the Google account is entitled to; a sideloaded build needs its file kept |
| c | Optional: `*#21#` result | Shows whether the Motorola's own line forwards anywhere (read-only network query) |
| d | Confirm the login method/password for that production account works | Restoration needs a fresh login |

Candidates (unconfirmed): a\*\*\*@homecallguard.co.uk (no HCG number), r\*\*\*@homecallguard.co.uk (HCG …4288), a\*\*\*@yahoo.co.uk (HCG …6063).

## 1. What production state belongs to the Motorola

- A Twilio Voice push registration for identity `household_<prodHouseholdId>` bound to the app's current FCM token.
- That household's `voice_client_registered_at` in production.
- Local app state: login session, onboarding flags, OS permissions.

## 2. What uninstalling and installing staging changes

Same package id (`co.uk.homecallguard.app`) on every EAS profile; the staging APK is signed differently from the Play build, so the production app must be uninstalled first.

**Lost on the handset:** login session, onboarding flags, permissions (notifications, microphone, phone/full-screen call, battery-optimisation exemption, contacts), FCM token.

**Not lost (server-side):** trusted contacts, call history, household settings, subscription.

## 3. Effects beyond the handset

| Item | Effect |
|---|---|
| Production household row, HCG number, Twilio number config | Unchanged; nothing writes to them |
| Subscription (Stripe/Play) | Unchanged; uninstall doesn't cancel |
| Other devices / customers | Unchanged |
| **Calls to that household's HCG number during the window** | Production still dials the dead client: callers hear "can't be connected". Only matters if a real line forwards to that HCG number |
| The Motorola's own line | Unaffected unless `*#21#` shows it forwards to an HCG number. Forwarding will not be changed |

## 4. Stale registration

- No automatic invalidation; Twilio offers no REST list/delete for Voice push bindings.
- During the window: production calls to that household fail (above).
- After reinstall + login, the app registers again under the same identity with a new FCM token, which takes over. The old binding points at a dead token; expected to be dropped by Twilio when FCM reports it unregistered. Harmless either way.
- The staging identity (`household_ffc4cfe1-…`) is never dialled by production.
- No production database cleanup needed.

## 5. Staging build isolation

- Build-time values: `EXPO_PUBLIC_API_BASE_URL=https://ferret-augmented-distrust.ngrok-free.dev`, `EXPO_PUBLIC_SUPABASE_URL`/`ANON_KEY` = staging (tigwgmayeuisrxjjykqd), **no RevenueCat key** (purchases disabled).
- Same mobile source as the version recorded in 0(b).
- Before install: unpack the APK and confirm no production Supabase URL (psbzynxplxfbyrbdidmn) or `homecallguard.co.uk` API base is embedded.
- Staging server holds only staging Supabase credentials → no production DB writes.
- Shared Twilio account: the only Twilio change is …1883's Voice URL → staging; household created directly in the staging DB (no provisioning, no number purchase/release); staging identity differs from every production identity.
- …1883 is voice-only, so warning SMS are refused by Twilio and reach no-one.

## 6. Procedure

### Phase A — preparation (Motorola untouched)

1. Andrew supplies section 0. Read-only production snapshot of that household (entitlement, `voice_client_registered_at`, HCG number + Twilio Voice URL).
2. Approval to build. Add an EAS `staging` profile (internal APK, staging env, no RevenueCat) — **local, uncommitted until approved**. `npx eas-cli` needs Andrew's Expo login; confirm the `GOOGLE_SERVICES_JSON` EAS secret exists. No local Android SDK, so cloud build only.
3. Inspect the built APK for URLs (section 5).
4. Staging prep (all temporary, recorded in a fixture):
   - create a staging auth user (admin API, `email_confirm: true`, no email sent) and link it to household `ffc4cfe1-6d93-46d8-8e88-3b93eadabf87`;
   - confirm …2700 is **not** a trusted contact (it was removed 2026-10-01);
   - set the household's `phone_number` to a number Andrew chooses for the (undeliverable) warning SMS target, or leave `…0456` (reserved test range).
5. Start the staging server (voice-security worktree, `.env.staging` from `/Users/ad/call-ai-sandbox-mobile-app-v1`, port 3099) and ngrok; point …1883 Voice URL at `https://ferret-augmented-distrust.ngrok-free.dev/voice` (pre-test config recorded: Voice URL empty, POST, no fallback, no status callback).

### Phase B — conversion (Motorola out of production from here)

6. Andrew: disable Play auto-update for HCG; uninstall Home Call Guard; install the staging APK; log in with the staging user; grant all permissions incl. battery exemption and full-screen calls.
7. Confirm staging log shows `/api/v1/voice/registered` for the staging household.

### Phase C — end-to-end test

8. From …2700 call +44 20 4652 1883 (unknown caller). Expect: protected/monitored announcement → Motorola rings → answer → conversation stays connected.
9. Normal conversation ~30 s (transcription, low risk).
10. Warning phrases (≥ 60 risk): e.g. "This is your bank's fraud team, we've seen suspicious payments on your account and need to verify you right now."
11. Red-line phrase: "Read me the six digit code we just sent you" / "Move your money to a safe account" / "Don't tell your bank about this call." Expect termination via `/red-line-terminate`.
12. Thresholds are not changed.

### Phase D — restoration

13. Point …1883 back to its recorded config (empty Voice URL).
14. Andrew: uninstall the staging app; install Home Call Guard from Play (or the recorded file); check version matches 0(b); log in to the production account; re-grant permissions; open the app once so it registers.
15. Verify: from …2700 call the production HCG number (trusted contact there → no AI cost); Motorola rings; answer; hang up. Read-only production snapshot compared to step 1.
16. Re-enable Play auto-update if it was on.

### Phase E — evidence and cleanup (Motorola already restored)

17. Reconstruct the timeline (Twilio call + child + events, staging log, staging calls row).
18. Remove the staging auth user; decide on household `ffc4cfe1` (see handover §7); stop server and ngrok.

## 7. Cost

Pennies: inbound ~£0.0076/started min, Media Streams ~£0.0033/min, transcription ~£0.0047/min; SMS refused by Twilio (voice-only sender). Production verification call: one trusted call, ~£0.01.

## 8. Duration

| Phase | Time | Motorola out of production? |
|---|---|---|
| A: build (EAS queue) + APK check + staging prep | 45–90 min | No |
| B: uninstall, install staging, login, permissions | 10–15 min | **Yes** |
| C: E2E test | 15–20 min | **Yes** |
| D: restore + production verification call | 15–20 min | **Yes** |
| E: timeline + cleanup | ~30 min | No |

About 2–3 h elapsed; Motorola away from production ~45–60 min.
