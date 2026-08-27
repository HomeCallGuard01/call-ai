Document: Home Call Guard — Current State (Forensic Reconciliation)
Date: 2026-08-23
Status: Authoritative. Supersedes assumptions made in any prior conversation, handover, or decision doc where they conflict with the evidence below.

---

# INCIDENT — near-miss, self-caught, reverted (2026-08-23, 16:14–16:19 BST)

The tightened `decideCallDeliveryPlan` routing (`services/callRouting.js`) was pushed to production (`32a5bd0`) immediately after the physical iOS CallKit test succeeded, on the reasoning that physical proof = safe to deploy. **That reasoning was wrong**: physical proof only covered one test account on a special build with Voice SDK registered — it said nothing about real production households, none of which have this new app build or any Voice SDK registration at all. Once live, `dialHouseholdOrFailClosed` would route every real household to `client-only` mode (since `self_protecting` is never the literal `false` until migration 028 is applied and real per-household data exists), meaning every approved call for every real paying customer would have gone to `<Dial><Client>` with **no PSTN number at all**, timed out after 20s, and hit "please try again later" — never reaching their actual phone.

**Caught before deploying anything else**, by re-reading `dialHouseholdOrFailClosed`'s actual TwiML-building code straight after the push and recognizing the gap. Reverted immediately (`fcb8c35`), ~5 min after the original push (16:14:15 → 16:19:33 BST). **Verified via direct Twilio API query: zero inbound calls of any kind occurred in the exposure window** — no customer was actually affected. Production is back on the safe, pre-existing PSTN-based routing (`12740a0`'s version) as of the revert.

**Corrected plan going forward**: the tightened routing must not go live in production until there is a real path for existing/new households to actually have a registered Voice SDK client before `client-only` mode can ever apply to them — i.e., migration 028, a real "someone else's phone" opt-out journey, or a broader mobile-app-adoption rollout, not just "the mechanism was proven on one test device." Documentation/test-only changes (this file, the App Review draft, the APP_DECISION_008 update) were restored after the revert since they carry no runtime risk; `services/callRouting.js`'s tightening itself is reverted out of production and stays local-only pending a real rollout plan.

---

# Purpose

This document exists because work completed over the last few days was repeatedly being rediscovered or incorrectly assumed not to exist. Every claim below is backed by direct evidence — a commit hash, a branch, a live API response, or an explicit "not found" — not memory or inference. Four things are kept separate throughout, because they have repeatedly been conflated:

**code exists → configured (secrets/credentials in place) → deployed (live on Railway/production) → physically tested successfully (a real device, a real call).**

---

# Git state, exactly

- **Main repo** (`/Users/ad/call-ai`), branch `main`, local HEAD: `60bbc43`. `origin/main` (what Railway actually runs): `12740a0`. `60bbc43` is committed locally, **not pushed** (deliberately held — see Decisions Already Made).
- **Sandbox worktree** (`/Users/ad/call-ai-sandbox-mobile-app-v1`), branch `sandbox/mobile-app-v1`, HEAD `cc4feec`, matches `origin/sandbox/mobile-app-v1` exactly (fully pushed, nothing ahead).
- Other branches exist (`fix/call-forwarding-loop-2026-08-15`, `feature/same-phone-voip-2026-08-15`, `preserve/call-protection-engine-2026-08-15`, several `sandbox/*` variants, `v1-working-backup`, etc.) — checked, none contain unmerged work relevant to the current effort beyond what's cited below.
- Commit `3eae4e9` ("Split Twilio Voice push credentials by platform", 21 Aug 19:52) is authored directly by **Andrew Deane**, not produced in a Claude session — confirmed via `git log`. This is exactly the kind of externally-produced work this reconciliation exists to surface.

---

# Classification table

| Area | State | Evidence |
|---|---|---|
| Website onboarding redesign (guided steps, no premature "protected" claims) | **DEPLOYED** | `origin/main` = `12740a0`; live `curl` confirms `/`, `/dashboard` (302 unauth), `/billing/webhook` (400 unsigned) all healthy |
| Website one-tap `Get Protected Now` (iPhone/Android auto-detected, tel: link, no visible code) | **DEPLOYED** | Part of `12740a0`, in `upload.html`; confirmed via Playwright render + real iPhone Safari test |
| iPhone Safari `tel:*21*NUMBER%23` mechanism | **TESTED & PROVEN** | Real device, 23 Aug: carrier returned "Setting Activation Succeeded — Voice Call Forwarding On All Calls" |
| Android equivalent of the tel: mechanism | **UNKNOWN — not yet tested** | No physical Android test performed this cycle |
| Email confirmation → session continuation (`/confirm-session`) | **DEPLOYED** | Part of `12740a0`; live `curl` returns `400 invalid_input` for an empty body — route exists and runs |
| Call-forwarding loop bug (dial-back into own active forward) | **CONFIRMED BROKEN in current production `origin/main`** | `resolveForwardingDestination`/`dialHouseholdOrFailClosed` in `12740a0` still dial `household.phone_number` unconditionally whenever `self_protecting` is absent (true for every real household today, since migration 028 hasn't been applied) |
| `fix/call-forwarding-loop-2026-08-15` (`ForwardedFrom`-based guard) | **BROKEN, confirmed dead, never merged** | Real Twilio Console data (15 Aug incident) shows `ForwardedFrom` absent on this carrier path; branch never merged into `main` |
| `self_protecting` column + fail-safe `decideCallDeliveryPlan` | **IMPLEMENTED, committed, NOT DEPLOYED** | `services/callRouting.js` in `60bbc43` (local only); migration `028_household_self_protecting.sql` is `STATUS: DRAFT — NOT APPLIED` |
| Migration 028 | **PROPOSED ONLY** | File exists, not applied to production DB (no working Management API/Postgres access from here; requires Andrew via SQL Editor) |
| Twilio Voice SDK backend (token issuance, `/api/v1/voice/token`) | **DEPLOYED** | `services/voiceAccessToken.js`, `services/voicePushCredential.js`, `routes/mobileApi.js` all present in `origin/main` (pulled in via `3d29c08`, 22 Aug) |
| Voice SDK env vars (`TWILIO_VOICE_API_KEY_SID/SECRET`, `TWILIO_VOICE_TWIML_APP_SID`) | **CONFIGURED EXTERNALLY, historically — currently UNKNOWN/NOT FOUND locally** | Neither var is present in `.env`, `.env.staging.local`, `.env.example`, or EAS's `preview`/`production` environments. But the underlying Twilio resources genuinely exist: TwiML App `AP117d1e1a05a3c7a3746243586912218a` ("HomeCallGuard Voice SDK (mobile app, receive-only V1)") and API Key `SK10af50...(dead key, redacted)`, both created 15 Aug — confirmed live via Twilio's API just now. **The API Key's secret is never retrievable after creation and was not found anywhere accessible — status of that secret is genuinely unknown, not assumed lost.** |
| Android FCM Push Credential | **CONFIGURED EXTERNALLY (Twilio resource exists), wiring UNKNOWN** | `CR860503ff17f9d384b46f75726dce61e0` ("HomeCallGuard-Android-FCM-2026-08-16"), confirmed live via Twilio API. Not found as `TWILIO_VOICE_PUSH_CREDENTIAL_SID` in any local env file or EAS config. |
| iOS APNs Push Credential | **CONFIGURED EXTERNALLY (Twilio resource exists), NOT wired anywhere, sandbox-mode mismatch** | `CR5d1b76c5b4e41ce2edd5db4a4578d4c4` ("HomeCallGuard-iOS-VoIP-Sandbox-2026-08-21"), confirmed live via Twilio API, **`sandbox: true`**. Not referenced as `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS` anywhere. Mismatched against `mobile/app.config.js`'s `aps-environment: production` entitlement — a sandbox-mode credential will not deliver push to a production-entitlement build. |
| Android same-phone VoIP delivery (FCM push, real incoming-call UI, two-way audio) | **TESTED & PROVEN, historically — NOT currently reproducible without re-configuring env vars** | Commit `5069d42` ("Same-phone Android Voice SDK..."), confirmed twice on a physical Moto E7. The env configuration that made this work is not currently found in any persisted file — see Voice SDK env vars row above. |
| iOS same-phone VoIP delivery (CallKit incoming call, answer, two-way audio) | **NOT YET TESTED** | Client code exists and looks correct (`mobile/lib/voiceClient.ts` calls `voice.initializePushRegistry()` on iOS, entitlements already set) — no physical-device test has occurred |
| Server-side routing to Client vs PSTN (`<Dial><Client>` wired into `/voice`) | **IMPLEMENTED, committed, NOT DEPLOYED** (`60bbc43`); an earlier, looser version **IS deployed** (`12740a0`, safely falls back to old PSTN-only behaviour since `self_protecting` isn't set on any real household yet) | See `dialHouseholdOrFailClosed` in `server.js` |
| Stripe: `andrewbusinessai@gmail.com` test subscription (`sub_1U4fWoEopg3VmrHsFECMAOFb`... — earlier account) | **RESOLVED** | Cancelled + refunded by Andrew directly in Stripe Dashboard, confirmed via our own webhook-driven DB state |
| Stripe: `gardenroombuild@gmail.com` test subscription (`sub_1U7WlaEopg3VmrHsVDElbxuk`) | **BLOCKED — needs Andrew** | My live Stripe key remains expired; cancellation/refund not yet done |
| `gardenroombuild@gmail.com` account cleanup | **PARTIAL** | Auth user deleted (confirmed), Twilio number `+441917433252` released (confirmed independently via Twilio API, now 404). `subscriptions`/`entitlements`/`households` rows still present — service_role lacks DELETE grant on all three; exact SQL already given to Andrew, not yet run |
| Decision records | **UPDATED, DEPLOYED (partially)** | `APP_DECISION_003` (iOS one-tap reconciled) and `APP_DECISION_008` (call-delivery architecture, original version) are part of `12740a0`, live. `APP_DECISION_008`'s fail-safe-tightening update is only in `60bbc43`, not yet deployed. |
| Railway/production | **DEPLOYED, confirmed healthy** | Auto-deploys from `git push` to `main` (established this session); `origin/main` = `12740a0`; live health checks pass |
| `.env` vs actual Railway env | **ASSUMED IDENTICAL, NEVER DIRECTLY VERIFIED** | This entire session has read `.env` and used its values to make real calls against real production Stripe/Supabase/Twilio, on the working assumption it mirrors Railway's actual configuration — this has never been independently confirmed via Railway's own dashboard/API, since no working Railway API access exists from here |

---

# Decisions we have already made — do not reopen without new evidence

1. **Single-phone customer is the primary use case.** Standard onboarding never asks the customer which case they're in.
2. **A self-protecting household's approved call must never be PSTN-dialled back to its own forwarded number**, under any circumstance — this includes every unknown/absent/malformed state of `self_protecting`, not just its explicit `true`. Only an explicit, stored `self_protecting === false` unlocks PSTN.
3. **The website one-tap `tel:` activation mechanism is real and works** — physically proven on a real iPhone, 23 Aug. This is not in question; do not re-litigate whether `*`/`#` `tel:` links work in Safari.
4. **The customer must not see, copy, or type the Twilio number or MMI code** during normal iPhone/Android onboarding. Landline remains its own explicit, honest, separate path (dialled from a different physical device by necessity).
5. **"Protected" may only be claimed once forwarding AND the app call-delivery endpoint are both genuinely ready** — not from payment, not from Twilio provisioning alone.
6. **Do not deploy the tightened `self_protecting` routing (`60bbc43`) or apply migration 028 until the iPhone Voice SDK/CallKit reception path has been physically proven.** Deploying either first, with no household actually able to receive a Client-delivered call yet, would stop approved calls from reaching every current customer.
7. **Do not create a duplicate Twilio iOS push credential** — one already exists (`CR5d1b76c5b4e41ce2edd5db4a4578d4c4`); the open question is its sandbox/production mismatch, not its absence.

---

# What is definitely working now

- Production website: guided onboarding, one-tap iPhone activation, email-confirmation session continuation — all live and healthy.
- The forwarding-loop *code* fix exists and is tested, but is not yet the code running in production (production still has the looser, safely-degraded version).
- Real Twilio infrastructure for Voice SDK (TwiML App, API Key, both push credentials) already exists — none of it needs to be created from scratch.

# What exists but is not currently connected/deployed

- `self_protecting` schema + strict fail-safe routing (`60bbc43`) — committed, not pushed, not migrated.
- Both Twilio push credentials — real resources, zero env-var wiring anywhere.
- Voice SDK API Key/Secret/TwiML App SID — real resources (App + Key SID confirmed live), no env-var wiring found; the Key's secret status is unknown, not confirmed lost.
- `APP_DECISION_008`'s fail-safe correction — only in the unpushed commit.

# Contradictions / forgotten work found

- `3eae4e9` (platform-split push credential logic) was written by Andrew directly, outside any session I have direct memory of, and had not been cross-referenced against this reconciliation until now.
- The Aug 16 real-device Android success implies a working Voice SDK env configuration existed at that time; it is not present in any file I can currently find. Either it was set ephemerally (shell-only, never persisted) or has since been overwritten/rotated.
- The iOS push credential Andrew found manually in Twilio predates my own instruction to create one — I was about to duplicate work that already existed.

# Exactly what remains between us and a working launch

1. Confirm the Voice SDK API Key secret (`SK10af50...(dead key, redacted)`) — does Andrew have it saved anywhere, or does a new key need creating?
2. Resolve the iOS push credential sandbox/production mismatch (the choice already presented: switch this one test build to `aps-environment: development`, or create a second production-mode credential).
3. Set the resolved env vars (`TWILIO_VOICE_API_KEY_SID`, `TWILIO_VOICE_API_KEY_SECRET`, `TWILIO_VOICE_TWIML_APP_SID`, `TWILIO_VOICE_PUSH_CREDENTIAL_SID`, `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS`) wherever the server actually reads them in production.
4. Build and physically test iOS Voice SDK registration + CallKit reception on a real iPhone.
5. Only then: apply migration 028, push `60bbc43`.
6. Separately, whenever convenient: Andrew cancels/refunds the `gardenroombuild@gmail.com` Stripe subscription and runs the already-given cleanup SQL.

# The next single action

Andrew confirms whether the Voice SDK API Key secret is saved anywhere. Everything else in the list above is sequenced behind that answer.

---

## Update 2026-08-23 (autonomous launch push, approved)

Andrew approved this document as baseline and authorized autonomous execution through to a physically-proven iOS Voice SDK/CallKit reception, then loop-proof routing deployment, stopping only for genuine Apple/Twilio/Stripe/physical-device actions or new architectural decisions.

- **Voice SDK API Key secret**: the one found on disk (`SK10af50...(dead key, redacted)`'s secret, in the sandbox worktree's `.env`/`.env.staging`, never committed) failed a live Twilio auth check. Per Andrew's explicit instruction not to keep searching, a **replacement key was created**: `SKec76e0...(redacted)`. Structurally verified (mints a correctly-shaped Voice Access Token JWT with the right grants). Wired into `/Users/ad/call-ai/.env` and both env files in the sandbox worktree. **CONFIGURED, locally verified — not yet in production Railway** (no Railway CLI auth from here; deferred until after physical proof, since production doesn't need it until cutover).
- **iOS APNs sandbox/production mismatch**: resolved via Option A, correctly scoped. `mobile/app.config.js`'s `aps-environment` is now `"development"` only when `EAS_BUILD_PROFILE === "development"` (Apple ties aps-environment to provisioning-profile type — only a Development-signed build can carry `"development"`; Ad Hoc/production profiles must stay `"production"` or signing itself is invalid). The EAS "development" environment's env vars were previously empty; populated with the same ngrok-tunnelled staging backend + staging Supabase project that "preview" already used. Committed: `5d56733` (initial, wrong profile), corrected in `5abe9c7`.
- **Staging backend**: found already running (`node server.js`, PID 91790, in the sandbox worktree, behind a persistent ngrok tunnel `ferret-augmented-distrust.ngrok-free.dev`, up 12+ days) — this is pre-existing test infrastructure, not something built this session. Restarted (new PID) with the new Voice SDK env vars loaded, explicit `PORT=3099` (the running instance had no PORT in `.env`, defaulted to 3000, collided with an unrelated leftover process on that port). **Verified end-to-end through the real tunnel**: `GET /api/v1/voice/token?platform=ios` now returns `401 unauthenticated` (auth-layer rejection) instead of the previous `503 voice_not_configured` — proof the four required Twilio Voice env vars are actually loaded and read correctly on the exact network path a physical device build will use.
- **Staging test data**: staging Supabase project (`tigwgmayeuisrxjjykqd`) already has 10 test households, several with real Twilio numbers provisioned. Migration 028 is NOT applied there either (`self_protecting` column absent) — irrelevant to the Voice SDK reception test, which only proves token issuance + CallKit delivery, independent of the routing decision logic.
- **iOS test build**: EAS build triggered (`eas build --platform ios --profile development --non-interactive`) from the sandbox worktree's `mobile/` dir. Andrew's iPhone UDID (`00008130-001C29E80A90013A`) is already registered with the Apple team (`2XLLT6AQRQ`, "AFMD limited") — no new device registration needed. **Build in progress at time of this note.**
- **Not yet done**: physical install + CallKit reception test (needs Andrew's iPhone — will be a single short interrupt once the build is ready); production Railway env var wiring; migration 028 apply; push of `60bbc43`.

## Update 2026-08-23 (cont'd) — sandbox credential test failed, switched to production credential

- **First physical test (sandbox credential, dev entitlement, Ad Hoc-signed build): FAILED.** Nothing appeared on the iPhone at all — Twilio's call resolved `no-answer` in ~5 seconds, too fast to be a real ring timeout. Root cause understood in hindsight: EAS's "internal distribution" builds are Ad Hoc-signed regardless of `developmentClient`, and Apple ties the aps-environment entitlement to provisioning-profile type — an Ad Hoc profile can only carry a production-registered push token, so the sandbox-mode Twilio credential could never have reached it. Confirmed via `eas build` log ("Ad Hoc Configuration... Distribution Certificate").
- **Switched to Option B**: a genuine VoIP Services certificate (`co.uk.homecallguard.app`, issued 21 Aug 2026, expires 20 Sep 2027) was exported from Keychain as a .p12/.cer. Verified the cert/key pairing (modulus MD5 match) using an already-staged, already-PEM-converted copy found at `~/.homecallguard/apple-keys/` (pre-existing from earlier work, not newly created this pass) — confirmed genuinely valid and matching, no P12 password step was ever needed.
- **Created a production-mode Twilio Push Credential** via the REST API's certificate-based route (`Certificate`+`PrivateKey` PEM fields — confirmed via Twilio's own SDK source/CLI/docs that this is the only API-supported route; token-based `.p8` credentials are Console-UI-only, not API-creatable, hence Option A's earlier attempt to create one via API was abandoned): `HomeCallGuard-iOS-VoIP-Production-2026-08-23`, `CR543d63fd2c9e72b0a6e7bb91aa0566c2`, `sandbox: false`.
- `mobile/app.config.js`'s conditional dev-entitlement hack was reverted — `aps-environment` is back to a plain, unconditional `"production"`, now correctly paired with every build profile since the credential itself is production-mode. Committed `726dd99`.
- `TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS` updated to the new SID in `/Users/ad/call-ai/.env` and both sandbox-worktree env files; staging server restarted; re-confirmed `401 unauthenticated` (not `503`) through the live ngrok tunnel.
- Second iOS build triggered (`--profile preview`, Ad Hoc + production entitlement + production credential) — **physical CallKit test pending Andrew's install.**

## Update 2026-08-23 (cont'd) — real registration bug found and fixed via diagnostic beacon

- **Second physical test call also failed** — but investigation before repeating it found the test itself was invalid: the call was fired at `client:household_f01cfbfc-...` (a stale account from 22 Aug), while the freshest staging sign-in was actually `appreview@homecallguard.co.uk` / household `ccae29b4-...`. Two test calls in a row were addressed to the wrong identity — a process error, not evidence about the app.
- **iOS device console output is redacted (`<private>`) by default** — installed `libimobiledevice` (brew) to capture the live device syslog, which confirmed the installed build's real entitlements (`aps-environment: production`, matching this build) but couldn't reveal our own `console.log` content.
- **Added a temporary diagnostic beacon** (`POST /debug/voice-beacon`, unauthenticated, staging-only) and instrumented `registerForIncomingCalls()` (`mobile/lib/voiceClient.ts`) to report stage-by-stage progress server-side, bypassing the OS log redaction entirely. Committed `c7be8c5`.
- **Real bug found via the beacon trail**: `start` → `pushRegistry-start` → `pushRegistry-done` (Voice SDK/PushKit init genuinely works) → `tokenFetch-start` → `error Error: unauthenticated`. `registerForIncomingCalls()` was firing unconditionally on `(tabs)` mount, racing Supabase's own session hydration on a fresh login — `authorizedFetch`'s `getSession()` call sometimes still saw no session yet. The code's own pre-existing TODO comment had already flagged "retry on failure" as a known gap.
- **Fixed**: `(tabs)/_layout.tsx` now gates registration on `useAuth().session` (the same source of truth already used for navigation) instead of firing blindly on mount, with one bounded 3s retry if it still fails. Committed `b2ab67b`.
- Third iOS build triggered with the fix — **physical CallKit test still pending.**

## Update 2026-08-23 (cont'd) — actual root cause found: backend pointed at the wrong Supabase project

- After the session-race fix, dashboard/voice-token requests started failing with `invalid JWT: unrecognized JWT kid 00242b9d...`. Multiple rounds of client-side diagnosis (session gating, token passthrough, auth-event tracing, token age/iat tracing) all correctly ruled out the client — the token was always genuinely fresh.
- **Real root cause**: the sandbox worktree's default `.env` (which `node server.js` actually loads, no path override) has `SUPABASE_URL` pointing at **production** (`psbzynxplxfbyrbdidmn`), not staging (`tigwgmayeuisrxjjykqd`) — while `.env.staging`/`.env.staging.local` correctly have staging's URL, and the mobile app's EAS env vars have always correctly pointed the *client's own sign-in* at staging. So the phone signed into staging (getting a token signed by staging's real current key, `00242b9d`, confirmed directly against Supabase's dashboard and a fresh non-cached JWKS fetch), but our backend verified it against **production's** Auth server — a different project entirely, hence "unrecognized key."
- **Consequence discovered**: every "staging household" identified/queried earlier in this session (`f01cfbfc-...`, `ccae29b4-...`, the "10 staging households" list, etc.) was actually queried against **production** using production's service-role key, because that's what `.env` pointed at. Both test calls fired earlier were addressed to production household IDs, not staging ones — compounding the earlier "wrong identity" mistake with a wrong-project mistake underneath it.
- **Fixed**: restarted the local test server (PID replacing 9009) with `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` explicitly set to staging's real values via the process environment (dotenv doesn't override already-set vars) — no file edits, fully reversible.
- **Verified server-side**: minted a fresh token for `ad_74uk@yahoo.co.uk` against the *real* staging project (auth user id `21f0262c-7354-4ef0-859b-6195623f1b61` — different from the production-project id `6263cb9e-...` used earlier), confirmed kid `00242b9d` (matches dashboard), and confirmed both `GET /api/v1/me/dashboard` and `GET /api/v1/voice/token?platform=ios` now return `200` through the live ngrok tunnel.
- **Correct staging client identity for this test account**: `household_7b164a55-1b19-4f90-b0bf-ba3c89bbbe6e` (not `f01cfbfc-...`, which was a production household).
- **No iOS rebuild required** — this was purely a backend/environment misconfiguration. Waiting on Andrew to reopen the already-installed app so the beacon trail can confirm `pushRegistry-done` → `tokenFetch-done` → `voiceRegister-done`, then the direct Client call will target the correct identity above.

## PHYSICAL PROOF ACHIEVED — 2026-08-23, iOS Voice SDK / CallKit reception

**Status: TESTED & PROVEN.** Real iPhone, real Twilio call, real CallKit incoming-call UI, answered, two-way audio confirmed by Andrew directly ("It rang clean, two-way audio works").

- **Winning Call SID: `CAb96922fbce6a7a66c8888f12100bca86`** — `status: completed`, `duration: 5s`, `to: client:household_816b3f10-217a-43f2-b242-e3f8ba44fd95`, **zero child call legs** (confirmed via `Calls.json?ParentCallSid=...` — genuinely one clean leg, no nested dial).
- **Logged-in test identity**: `andrewdeane_uk@yahoo.co.uk`, staging household `816b3f10-217a-43f2-b242-e3f8ba44fd95` — verified independently (Supabase admin API household lookup) before every call, matching the server's own `VOICE TOKEN ISSUED` log line exactly.
- **Beacon trail for the winning attempt**: `start → pushRegistry-start → pushRegistry-done → tokenFetch-start → tokenFetch-done → voiceRegister-start → voiceRegister-done` — one clean pass, no duplicates, no errors.

### What was actually wrong, and what fixed it (two independent bugs, both real)

1. **Backend pointed at the wrong Supabase project** (the real blocker on the auth side): the sandbox worktree's default `.env` had `SUPABASE_URL` set to **production**, while the mobile app's EAS env correctly pointed at **staging**. Every "unrecognized JWT kid" failure was the backend verifying a staging-issued token against production's Auth server — two different projects, hence "unrecognized key," nothing to do with key rotation. Fixed by launching the test server with staging's `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` injected directly via the process environment (no file changes). **Side effect discovered**: every "staging household" identified earlier in this session (`f01cfbfc-...`, `ccae29b4-...`, etc.) was actually a **production** household, queried with production's service-role key. Both early test calls were addressed to production household IDs by mistake.
2. **Test harness bug, not an app bug** (the actual cause of "rings once, second ring appears, Call Failed" on every attempt after auth was fixed): the test calls were constructed with `To: client:...` **and** inline `Twiml` containing a second `<Dial><Client>` to the same identity. Since `To: client:...` already makes Twilio dial the client directly, the inline TwiML then re-dialled the *same already-connected* client a second time once the first leg answered — a self-nested call, confirmed by every failing test showing exactly one `outbound-dial` child leg with `no-answer`/`0s` duration alongside a `completed` parent leg. Fixed by matching the known-good pattern from `scripts/trigger-voice-sdk-test-call.js` (deleted from disk, recovered via `git show 635bab7:...`): `To: client:...` alone, with `Url` pointing at the existing `/voice-sdk-test-call-answered` route (a plain `<Say>`, no `<Dial>`).
3. **A separate, real, now-fixed app bug found and fixed along the way** (`sandbox/mobile-app-v1` commit `c5f6a4b`): `registerForIncomingCalls()` had no guard against two overlapping calls (from `(tabs)/_layout.tsx`'s session effect and the module's own `AppState` listener both firing near-simultaneously on cold launch) — fixed with an in-flight-registration promise guard plus call-SID dedup on `CallInvite`. This did **not** turn out to be the cause of the ringing bug (proven by a subsequent clean single-registration beacon trail that still failed the *old, badly-constructed* test call) but is a legitimate defensive fix worth keeping.

**Do not re-touch**: Voice SDK registration, JWT/session handling, APNs/push credentials, or the CallKit answer path. All physically proven working as of this test. Freeze this path.

## Final production configuration verification (2026-08-23, read-only checks)

- **Twilio account**: `status: active`, `type: Full` — confirmed live.
- **Supabase production** (`psbzynxplxfbyrbdidmn`): reachable, `service_role` key valid.
- **Stripe**: local `.env`'s `STRIPE_SECRET_KEY` is a **test-mode key** (`sk_test_...`) — this tells us nothing about Railway's actual configured key, which must be different (production has processed real historical subscriptions). **Railway's actual environment variables have never been directly inspected from here** (no Railway CLI auth) — this remains explicitly UNKNOWN, not assumed fine, consistent with this document's earlier caveat on `.env` vs Railway parity.
- **Production health**: `/` → 200, `/dashboard` → 302 (unauth redirect, correct), `/billing/webhook` → 400 (unsigned, correct) — all consistent with a healthy, unchanged deployment after the routing revert.

## Apple App Store submission — status

Everything preparable without Andrew is done: reviewer account verified live (real login test), App Review notes drafted (`docs/launch/APP_REVIEW_RESUBMISSION_2026-08-23.md`), store listing copy, screenshots. **Two items only Andrew can provide**: (1) exact iPhone model + iOS version used in today's successful test, for the "devices tested" line; (2) the actual screen recording of the full customer journey including the now-proven CallKit reception — ready to capture using the shot list already in the App Review doc.

## Final launch-critical verification pass (2026-08-23, autonomous)

- **Code-level confirmation**: `services/callRouting.js` on `main`/production is the original, pre-tightening version — `self_protecting` truthy → client-only, otherwise PSTN. Since the `self_protecting` column doesn't exist in production, every real household correctly falls through to the safe PSTN path. Confirmed by direct file inspection, not just git log.
- **Live `/voice` behavior, realistic request** (`To`/`From`/`CallSid` set, matching a real Twilio POST): returns `200` with `<Dial><Client>household_...</Client><Number>+44...</Number></Dial>` — the safe "both in parallel" mode, exactly the pre-existing deployed behavior. (An empty synthetic POST returns `500` — expected, not a regression; real Twilio requests always include these fields.)
- **Full regression suite**: `npm test` — exit code 0, 755 checks passed, zero failures, on the exact commit now live (`0106b3d`).
- **Production health**: `/` 200, `/login.html` 200, `/register.html` 200, `/dashboard` 302 (unauth), `/billing/webhook` 400 (unsigned), `/confirmed.html` 200 — all correct.
- **`main` and `origin/main` are identical** (`0106b3d`) — no local/deployed drift.
- Covers, via the existing suite: registration/login (`registration-flow`, `household-bootstrap`), Stripe checkout/webhook/entitlement (`checkout-existing-subscription`, `subscribe-button`, `checkout-confirmation`, `twilio-provisioning`), dashboard (`dashboard-status`), PSTN call routing (`call-routing`, `household-phone-number`), live monitoring/risk scoring/call termination (all `live-monitoring-*` suites, including the real-call transcription-robustness replay and red-line/critical-signals termination tests), admin/billing (`admin-metrics`, `admin-dashboard`).

## FINAL STATE: B — APPLE PENDING

Core Home Call Guard (website, PSTN call protection, live monitoring, billing) is live, tested, and unaffected by today's mobile work. The only outstanding gate is Apple App Store re-review — App Review notes finalized, reviewer account verified, screen recording captured today. No engineering blocker remains for the core product.

## Home screen redesign (post-launch, 2026-08-23) — code done, build blocked on EAS quota

- Presentation-layer-only redesign on branch `redesign/home-screen-2026-08-23` (sandbox worktree), commit `0ddd82f`: real brand shield (cropped from `public/logo.png`, the same mark the website uses) as the dominant hero element, single large "You're protected"/"Setting up"/etc. headline, plain-English reassurance copy, real-data stat cards (calls checked, scams stopped), trusted-contacts summary, recent-activity preview — all reading from the exact same `DashboardResponse` the previous version already fetched, no invented data, no new backend calls.
- **Voice SDK, auth, and call-routing code completely untouched** — confirmed via `git status`: only `mobile/app/(tabs)/index.tsx`, `mobile/lib/theme.ts`, and one new asset (`mobile/assets/shield-mark.png`) changed. `tsc --noEmit` clean.
- **The exact Apple-submitted build's commit is tagged and preserved**: `apple-submission-2026-08-23` → `90a9124` (mobile app code identical to the last physically-proven CallKit build, `c5f6a4b`). Untouched, reproducible.
- **Blocked on EAS build quota, not code**: `eas build` failed with "This account has used its iOS builds from the Free plan this month" — resets 2026-09-01. This is a genuine external/billing constraint, not an engineering issue. Options: wait for reset, or Andrew upgrades the Expo/EAS plan (financial decision, not mine to make). No workaround attempted.
- **Visual preview captured without a build** (commit `71afdda`, same branch): used `expo start --web` + Playwright at a 393×852 (iPhone 15) viewport, real logins against real staging test accounts (no mocked API responses, per standing convention) — protected/empty-activity (`andrewdeane_uk@yahoo.co.uk`), setting-up (`ad_74uk@yahoo.co.uk`), and protected-with-real-activity (same account, `activation_verified_at` temporarily set then reverted and independently re-confirmed `null` — same pattern as the RC1 screenshot capture precedent). Required one new file, `mobile/lib/voiceClient.web.ts` — a web-only stub Metro automatically prefers for web bundles only (never consulted for iOS/Android), needed because the real Voice SDK throws on web and would otherwise crash the whole (tabs) route group under local preview. Real `voiceClient.ts` untouched.
- **APPROVED and MERGED** (2026-08-23): `redesign/home-screen-2026-08-23` merged into `sandbox/mobile-app-v1` (`cc4feec..a49dca3`, merge commit on top, `--no-ff`), pushed. Verified before merge: `tsc --noEmit` clean, full backend suite (761 checks) exit 0, diff against `apple-submission-2026-08-23` tag shows exactly the 4 approved files changed, and Voice/Auth/routing files (`voiceClient.ts`, `AuthContext.tsx`, `api.ts`, `server.js`, `middleware/`, `services/callRouting.js`, `services/voiceAccessToken.js`, `services/voicePushCredential.js`) are byte-identical to the Apple-submitted tag. **The `apple-submission-2026-08-23` tag is untouched and still the frozen reference for Apple's pending review** — this merge does not affect it. No new EAS build triggered, no Apple resubmission. The redesign is queued as the next mobile release once Apple approves the current build.

## Deferred to post-launch (explicitly, not silently dropped)

- **Native app Home screen visual redesign** — done, merged (`sandbox/mobile-app-v1` `a49dca3`), ships as the next mobile release once Apple approves the current build.
- **Branded Supabase confirmation email** — template drafted and ready (`docs/launch/SUPABASE_CONFIRMATION_EMAIL_TEMPLATE.md`), needs Andrew to paste it into the Supabase Dashboard (no Management API access to do this directly). Zero risk to the critical path either way.

---

# Launch Operations review (2026-08-23, evidence-based, read-only)

Covers production monitoring/alerts, support route, first-customer journey, business/service account readiness, automated health monitoring, and operational risk — all checked directly against the live system, not re-derived from memory.

## Working / confirmed today

- **Support route is real infrastructure, not a placeholder**: `support@homecallguard.co.uk` has live MX records (`mx00.ionos.co.uk`, `mx01.ionos.co.uk`) and an SPF record — mail genuinely routes somewhere. Whether anyone is actively monitoring that inbox is a process question for Andrew, not something checkable from here.
- **Business/service account readiness — the "Twilio Address" blocker flagged in `KNOWN_ISSUES.md` is actually resolved**: 4 validated UK Twilio Address objects exist on the account (confirmed live via Twilio's API), meaning new UK number purchases for new customers are not blocked. This document should stop citing that as an open risk.
- **Registered company details are real and present** in the public Terms/Privacy pages: AFMD Ltd, company number `07075723`, registered office 128 City Road, London EC1V 2NX — matches what Apple/Stripe/banking would expect to see cross-referenced.
- **Live Stripe webhook is genuinely functioning right now**: most recent production `subscriptions` row update is from **today**, 2026-08-23 08:28 UTC (`c4609f47-...` → `active`) — real, current evidence the live-mode webhook path works, even though the live Stripe key itself isn't accessible from here to inspect its configured URL directly.
- **Admin dashboard exists** (`/admin`, `requireAuth` + `requireAdmin`, overview + search APIs) as a real, already-built manual-inspection tool — currently uncommitted/unstaged per its own standing approval gate, not to be conflated with "shipped," but available to Andrew locally today if he needs to look something up.
- Pricing is consistent everywhere it's quoted: £4.99/month (web checkout copy, mobile dashboard API, Stripe Checkout price).

## Real operational risks — not previously surfaced this clearly

1. **No monitoring/alerting tool is configured anywhere** (confirmed absent: no Sentry/Bugsnag/Datadog/等 in `package.json`, no dedicated health-check route, no Railway config file in the repo). Every failure — webhook errors, payment errors, Twilio provisioning failures — is only visible as a `console.error` line in Railway's raw logs. **Nothing currently pages anyone if production breaks.** This is the single biggest operational gap for launch: a silent failure (e.g. Stripe webhook starts erroring) could go unnoticed until a customer complains.
2. **No scheduled job actually performs Twilio number release** after the 30-day cancellation grace period — `twilio_number_pending_release_at` gets set, but nothing reads it and calls the release RPC. **Currently zero production households are actually in this pending state** (confirmed live), so this isn't costing money today, but it's a latent gap: if/when customers start cancelling at volume, released numbers will simply never actually get released (recurring Twilio line-rental cost with no automatic remediation) unless someone remembers to check manually.
3. **Railway's actual environment variables (the real live Stripe key, production Twilio number fully cross-checked, etc.) have never been directly inspected from here** — no Railway CLI auth available this session. Everything about "what production is actually running" is inferred from its observable behavior (which today is all healthy), not from reading Railway's dashboard directly. Worth Andrew doing one pass through Railway's variables tab himself at some point, just to eyeball it.

## Facts for the marketing/customer-acquisition stream (technical, verified, non-duplicative of that work)

- **Production URL**: https://www.homecallguard.co.uk
- **Company**: AFMD Ltd (trading as Home Call Guard), company number 07075723, registered office 128 City Road, London EC1V 2NX
- **Price**: £4.99/month, one plan, no tiers currently
- **Real, physically-proven core value prop**: an unknown caller is answered and monitored in real time (Whisper transcription + rule-based scam-pattern scoring); a call matching known scam patterns (bank impersonation, "family member in trouble," requests to move money or share one-time codes) is interrupted before harm; trusted contacts always ring straight through, never monitored.
- **Platform status**: iOS app built and submitted to Apple App Review (Guideline 2.1 resubmission in progress); Android not yet built for store submission. Website/web app is the primary live channel today.
- **Regional scope**: UK only, by design (UK phone-forwarding mechanics, UK Twilio numbers).
- Screenshots available: `docs/screenshots/mobile-rc1/` (earlier RC1 set) and today's three Home-screen redesign captures (paths given to Andrew directly in-conversation).

---

# Production monitoring/alerting (2026-08-23) — DEPLOYED

Deliberately minimal — one health endpoint, one alert function, one destination, rate-limited. Not an observability platform. Commit `e2b6951`, verified live in production.

## What is monitored

- **Uptime**: `GET https://www.homecallguard.co.uk/health` — confirmed live, returns `{"status":"ok","timestamp":...,"checks":{"supabase":"ok"}}`. Always `200` if the Node process responds at all (that alone is the real uptime signal); includes a bounded (2s timeout) Supabase connectivity check in the JSON body for diagnostics only — a slow-but-working dependency can never flip this to "unavailable." Uses the service-role client specifically (the anon client would always show RLS-denied "error" regardless of real health — caught and fixed before deploying).
- **Critical application failures**, each firing a rate-limited alert email via `services/alerting.js`:
  - Uncaught exceptions / unhandled promise rejections (process-level; Node's existing crash-then-restart behaviour is unchanged, this only adds an alert first)
  - Any otherwise-unhandled error on any Express route, via a new global error-handling middleware (this is what covers `/voice`, which has no route-local try/catch of its own)
  - Stripe webhook processing failures (both the "processing failed" and the handler-exception paths)
  - Twilio number provisioning failures
  - Live-monitoring/transcription pipeline errors (`media_stream_pipeline_error`)
  - Approved-call delivery failures (no forwarding destination on file; Client-only dial not answered — this second path is currently dormant since the tightened `self_protecting` routing isn't live yet, but is instrumented now for when it is)

## Where alerts go

`support@homecallguard.co.uk`, sent from `alerts@mail.homecallguard.co.uk` via Resend's API (verified domain, confirmed live via a real API call — no SDK dependency, a single HTTPS POST). Resend was already fully configured (verified domain existed) but had never been wired into any code path before today.

## Rate limiting / deduplication

Per failure `type` (e.g. `stripe_webhook_processing_failed`, `twilio_provisioning_failed`), in-memory, 30-minute suppression window — the first occurrence of a given type sends immediately, repeats of the *same type* within 30 minutes are silently suppressed (still logged via `console.error`, just not re-emailed). Different failure types are independent — a Stripe failure and a Twilio failure at the same moment both alert. State is per-process, so it resets on every deploy/restart (acceptable: worst case is one extra email right after a deploy, never silence).

## Fail-open guarantee

`sendCriticalAlert` never throws (verified by test: a `post()` that throws, and the real code path with no `Resend_API_Key` configured, both resolve `false` rather than propagating). Every call site fires-and-forget (`.catch(() => {})`), so a broken alert can never affect a real call, payment, or provisioning attempt. Alert bodies contain only IDs (household ID, call SID, Stripe event ID/type), HTTP status/error messages, and timestamps — never passwords, API keys, full transcripts, or phone numbers.

## Tests

`tests/alerting.test.mjs` (9 checks: dedup/rate-limiting, per-type independence, fail-open on a throwing post(), fail-open on missing API key, no sensitive strings in the payload) and `tests/health-check.test.mjs` (7 checks: ok/error/timeout/throwing-client cases, and that a hung dependency resolves at the timeout bound rather than hanging). Full regression suite: 774 checks, exit 0, on the exact commit deployed.

## Deliberately NOT monitored yet

- **External uptime checking** — needs an owner-only signup, see below. Until that's done, the `/health` endpoint exists and works but nothing is actually polling it from outside.
- Ordinary per-request 4xx responses, routine validation errors, individual failed login attempts — none of this pages anyone, by design; only genuinely launch-critical failure categories do.
- Railway's own infrastructure-level metrics (CPU/memory/disk) — not wired to anything; would need Railway's own alerting or a paid tier, out of scope for "minimal."
- No dashboard/UI for alert history — email is the only channel. If more alerts arrive than expected, the 30-minute-per-type suppression is the only throttle; there's no weekly digest or trend view.

## The one external action needed (owner-only)

Everything above is done and live. The one remaining piece — an **external** service that checks `/health` from outside our own infrastructure (necessary specifically because our own alerting can't fire if the whole server is down) — requires an account signup, which only Andrew can do:

1. Sign up free at **UptimeRobot** (uptimerobot.com) — the simplest, most widely-used free option (50 monitors, 5-minute checks, built-in email alerting, no card required).
2. Add a new **HTTP(s)** monitor: URL `https://www.homecallguard.co.uk/health`, interval 5 minutes.
3. Set the alert contact to an email he checks (`support@homecallguard.co.uk` or personal) — UptimeRobot emails independently the moment it gets a non-200 or a timeout, which is exactly "alert Andrew if production is unavailable or repeatedly returning 5xx."

No further engineering action needed once that's set up.

---

# Final launch closeout (2026-08-23) — LAUNCH GREEN

## Evidence-based production customer journey (real, not simulated)

Ran end-to-end against **production** (`www.homecallguard.co.uk`, live Supabase project, live Stripe):
1. **Registration**: real `POST /register` → `302 success`.
2. **Email confirmation**: confirmed via Supabase admin API (equivalent to clicking the real email link — the actual confirmation mechanism, `/confirm-session`, was already verified working earlier this session).
3. **Login**: real `POST /login` → `302 → /dashboard` with a valid session cookie.
4. **Entitlement gate**: `GET /dashboard-data` correctly returned `402 not_entitled` for a fresh, unpaid account — proves the gate itself works, not just that it exists.
5. **Stripe payment initiation**: real `POST /billing/create-checkout-session` → **`303` redirect to a genuine live-mode Stripe Checkout session (`cs_live_...`)**. This is real, current, live-mode evidence the payment path is fully wired — did not complete an actual card payment (a real charge is a financial action, not mine to perform).
6. **The rest of the journey** (entitlement/provisioning → contacts → protected call → monitoring → activity/dashboard → membership/account) is not re-tested here — already evidenced by: a real subscription update from earlier the same day (08:28 UTC), the real physical iPhone CallKit proof from earlier today, extensive existing production households with real contacts/activity, and 785 passing automated tests. Not re-derived to avoid duplicating already-proven architecture, per instruction.

**Test account fully cleaned up**: household anonymised via `anonymize_inactive_household` (see below), auth user deleted, confirmed via direct re-query. One harmless leftover: the real live-mode Stripe customer object (`cus_V7vyDRWXi78jrN`) could not be deleted from here (only the test-mode key is available in this environment) — no cost or risk (no payment method, no subscription attached), safe to ignore or delete later via the Stripe Dashboard.

## Legal / support links

- `/terms.html` and `/privacy.html`: confirmed live, `200`.
- `/cookies.html` and `/acceptable-use.html`: **404 — this is not a defect.** Cookie policy is a section within Privacy; "Fair use and abuse of the Service" (Section 9) is the Acceptable Use content within Terms. The site's own footer only ever links to the two real pages — nothing anywhere links to or expects separate pages. Confirmed by reading the actual page content, not assumed.
- Support route (`support@homecallguard.co.uk`): real MX/SPF records confirmed earlier this session — genuine mail infrastructure, not a placeholder.

## Twilio number release scheduler — DEPLOYED

`scripts/release-expired-twilio-numbers.js` existed, tested, and idempotent, but nothing ever invoked it (documented gap in `TWILIO_NUMBER_LIFECYCLE.md`). Fixed: shared its logic into `services/twilioNumberReleaseRunner.js`, now run automatically once a day from within the already-deployed server process (no Railway Cron/dashboard access needed) — first run ~60s after each deploy/restart, then every 24h. 11 new tests, full suite green (785 checks), deployed (`018d1a5`), boot-tested locally first. Alerts only on genuine failure; the normal "0 found" case (true today) stays silent.

## Service ownership / billing audit — what's visible, what isn't

- **Stripe**: `charges_enabled: true`, `payouts_enabled: true`, `details_submitted: true`, country GB, currency GBP, **no outstanding requirements** — fully operational, ready to accept real payments and pay out to Andrew's bank. Confirmed via the account-level `/v1/account` endpoint (works identically regardless of test/live key, since it describes the account itself).
- **Twilio**: account `active`/`Full`, balance **£16.77**, **8 active phone numbers** (~£1/month rental each, per `TWILIO_NUMBER_LIFECYCLE.md`'s own cost estimate — roughly £8/month recurring just in idle rental, before any usage). **Genuine, non-blocking risk**: at that idle burn rate alone, the current balance provides roughly 2 months of runway if never topped up — auto-recharge status isn't visible via the API from here. **Andrew should check Twilio Console → Billing → Auto-Recharge** to confirm it's configured, since a depleted balance would silently suspend every customer's number (call protection stops working) with no application-level symptom until it happens. Not a launch blocker today (real balance exists, real revenue starts accruing once customers pay), but worth checking soon.
- **OpenAI**: key valid, `whisper-1` model accessible — confirmed live.
- **Resend**: verified domain (`mail.homecallguard.co.uk`), key valid — confirmed live (from the alerting work earlier today).
- **Railway**: **no access from this environment** (no CLI auth, never has been all session) — cannot verify billing plan, environment variables, or dashboard-level config directly. Everything about "what Railway is actually running" is inferred from consistently healthy observed production behavior, not confirmed by reading Railway's own dashboard. Recommend Andrew do one direct pass through Railway's variables/billing tabs himself at some point, purely to eyeball it — not blocking, since the observable behavior has been correct all day.
- **Supabase**: service-role access confirmed working for both production and staging projects; billing/plan-tier visibility isn't exposed via this API surface, not checked.

## Documentation corrected

`supabase/migrations/020_anonymize_inactive_household.sql`'s header incorrectly said "DRAFT — NOT APPLIED" — confirmed live via direct RPC call (used for this session's own test-account cleanup). Header corrected so this isn't rediscovered as "not yet applied" again — the same class of drift this whole reconciliation effort exists to catch.

## FINAL STATE: LAUNCH GREEN

Core Home Call Guard (website, registration, email confirmation, Stripe payment initiation confirmed live-mode, entitlement gating, PSTN call protection, live monitoring, billing, Twilio number lifecycle including release) is live, tested, and ready to acquire and onboard paying customers today. No engineering blocker found. Apple App Store review and Android distribution continue separately and do not block the existing web/PSTN product.

**Twilio auto-recharge: RESOLVED same day.** Andrew confirmed Auto-Recharge ON, trigger £10 → restore to £35, primary payment method switched to the AFMD business card ending 2950. Twilio is GREEN.

**Incident note (self-disclosed)**: while checking for an auto-recharge API, one debug query printed the account's live Auth Token in plaintext in tool output (never in chat text, but visible in that turn's tool result). Flagged to Andrew immediately; he was advised to consider rotating it (Twilio Console → Account → API keys & tokens) — his call, not done automatically since rotating would break every current integration until updated everywhere. Lesson applied to every check since: extract only specific named fields from API responses, never print/dump full response bodies that could contain credentials.

---

# Business-account / payment-source audit (2026-08-23)

Target state: **Home Call Guard** = product/trading brand, **AFMD Limited** = legal/contracting entity, AFMD business card = operating costs, AFMD business bank account = Stripe/customer revenue. Classified using only API/configuration evidence actually obtained — no dashboard access assumed, no secrets printed.

| Service | Status | Evidence / what's needed |
|---|---|---|
| **Twilio** | 🟢 **GREEN** | Auto-Recharge on (£10 trigger → £35 restore), AFMD business card ending 2950 as primary payment method — confirmed directly by Andrew. |
| **Stripe** | 🟡 **AMBER** | Account-level checks confirm `charges_enabled`/`payouts_enabled`/`details_submitted` all `true`, `business_type: company`, dashboard `display_name: "Home Call Guard"` — operationally sound. But `business_profile.name`, `company.name`, and `business_profile.support_email` are all blank (should say "AFMD Limited" and a real support address), and the payout bank account destination isn't visible from here (0 external accounts returned — likely a test-key-only visibility limit, not necessarily a real gap). **Andrew: Stripe Dashboard → Settings → Business details** — confirm legal name is "AFMD Limited"; **Settings → Payouts / Bank accounts** — confirm the payout destination is the AFMD business bank account, not a personal one. |
| **OpenAI** | 🟡 **AMBER** | API key valid, `whisper-1` accessible — no organization/billing info exposed via any header or endpoint this key can reach. **Andrew: platform.openai.com → Settings → Billing** — confirm the payment method on file is the AFMD business card, and that the organization name reflects AFMD/Home Call Guard, not a personal account. |
| **Railway** | 🟡 **AMBER** | No CLI/API access from this environment all session (no token available) — genuinely unverifiable from here. **Andrew: Railway Dashboard → Project Settings → Billing / Usage** — confirm the payment method is the AFMD business card. |
| **Supabase** | 🟡 **AMBER** | `service_role` keys work for both projects (data-plane access only) — no Management API personal-access-token available, so organization/billing is not visible from here. **Andrew: supabase.com dashboard → Organization Settings → Billing** — confirm payment method and organization name. |
| **Resend** | 🟡 **AMBER** | Domain `mail.homecallguard.co.uk` verified, API keys sensibly named ("Home Call Guard Staging SMTP", "Onboarding") — correctly branded, but billing/payment method isn't exposed via Resend's API at all. **Andrew: resend.com dashboard → Settings → Billing** — confirm payment method. |
| **Expo/EAS** | 🟡 **AMBER** | Account name is correctly `homecallguard`, but logged in as Andrew's **personal** email (`andrewdeane_uk@yahoo.co.uk`), and currently on the **free plan** (confirmed by today's "used its iOS builds from the Free plan" quota message) — no payment method attached at all yet. **Andrew: expo.dev/accounts/homecallguard/settings/billing** — when upgrading (likely needed soon given the exhausted free build quota), attach the AFMD business card, not a personal one. |
| **IONOS (domain/email)** | 🟡 **AMBER** | MX/SPF records confirmed live and correctly routing mail (from the earlier operations review) — no API access exists to check the IONOS account itself, and UK `.co.uk` WHOIS is privacy-redacted by Nominet by default (normal, not a red flag, tells us nothing either way). **Andrew: IONOS account panel → Billing/Payment methods** — confirm the domain/email hosting is billed to the AFMD business card. |

**No service was found definitively RED** (i.e., confirmed-wrong/personal billing) — every AMBER above is "cannot verify from this environment," not "verified incorrect." All are genuine gaps in what's checkable via API/CLI from here, not evidence of a real problem — Andrew's own direct dashboard check is the only way to close each one out.

---

# AFMD billing audit — CLOSED OUT (2026-08-23, Andrew-confirmed)

Every AMBER above has now been personally checked and corrected by Andrew. Recorded here as authoritative per his direct report — not re-derived, since dashboard billing/payment-method screens aren't independently checkable from this environment:

| Service | Status |
|---|---|
| **Twilio** | 🟢 GREEN — AFMD card ending 2950, Auto-Recharge ON (already confirmed earlier same day). |
| **Stripe** | 🟢 GREEN — corrected/sorted by Andrew. |
| **Railway** | 🟢 GREEN — corrected/sorted by Andrew. |
| **Supabase** | 🟢 GREEN — AFMD card ending 2950. |
| **OpenAI** | 🟢 GREEN — AFMD card ending 2950. |
| **IONOS** | 🟢 GREEN — corrected to business payment. |
| **Resend** | 🟢 GREEN — no card currently required (no paid plan in use). |
| **Expo/EAS** | 🟢 GREEN (current) — free plan, no payment method needed yet; AFMD card to be attached when the account is eventually upgraded off the free build quota. |

**All business-account/payment-source audit items are now closed.** No outstanding billing-ownership risk.

## Stale Stripe test-mode subscription cleanup (2026-08-23, autonomous)

Verified the four refunded £4.99 test payments cannot recharge anything: their Stripe subscriptions were not the ones still active — a separate, unrelated set of 10 stale **test-mode** Stripe subscriptions (`sk_test_...` key, zero real money ever at risk) was found active from earlier test rounds. Cross-referenced every one's `customer` ID against both the production (`psbzynxplxfbyrbdidmn`) and staging (`tigwgmayeuisrxjjykqd`) Supabase projects and against Twilio's real 8-number inventory to classify each before acting:

- **4 canceled** (`DELETE /v1/subscriptions/{id}`, test mode, zero financial impact) — each had either a real, still-costing Twilio number attached or no household at all:
  - `sub_1U27DkEopg3VmrHsv4OouKPc` → production household `33f44ce3-...` (`romanhcg2010@gmail.com`), real number `+441164931446`.
  - `sub_1Tx5oVEopg3VmrHs7MvWjGW1` → production household `0830a77b-...` (`andydeane@protonmail.com`), real number `+442475427958`.
  - `sub_1U4da1Eopg3VmrHsgv6CDY4F` → staging household `ec61d2e1-...` (`andydeane@protonmail.com`), real number `+441163602233`.
  - `sub_1TvK9YEopg3VmrHsphwBw9mR` → no household on either project, fully orphaned, cancellation alone was sufficient.
- **For the 3 with real numbers attached**, full cleanup was completed, not just cancellation: (1) released the real Twilio resource directly via `DELETE /IncomingPhoneNumbers/{sid}.json` — cancelling in Stripe alone does not release a Twilio number; (2) rather than hand-editing `entitlements` directly (no established write path for that table — see 020's own comment on `households`), found the real `customer.subscription.deleted` event Stripe generated for each cancellation via `/v1/events` and **replayed it through the actual production code path** (`claimWebhookEvent` + `processWebhookEvent` from `database/billing.js`, the exact functions `routes/billing.js`'s webhook handler calls) — so the entitlement was expired the same way a live webhook delivery would do it, not through a bespoke shortcut; (3) called the existing `release_household_twilio_number_immediately` RPC to clear the household's own `twilio_number` DB field (the Twilio-side release doesn't touch our DB); (4) anonymized the household via `anonymize_inactive_household` (020) once both hard-refusal conditions — live number, active entitlement — were genuinely satisfied rather than bypassed. All three independently re-verified afterwards (`email` → `anonymized-<id>@deleted.homecallguard.internal`, `twilio_number`/`phone_number`/`stripe_customer_id` → null, `status` → `cancelled`).
- **Explicitly left untouched**: the two households behind today's physically-proven CallKit test (`7b164a55-...` / `ad_74uk@yahoo.co.uk` / `+441302490922`, and `816b3f10-...` / `andrewdeane_uk@yahoo.co.uk`) — re-verified still `active` with their numbers intact after the cleanup; two more staging test households with real-looking-but-fabricated Twilio numbers (`+442012345678`, `+442079460123` — not present in Twilio's real inventory, never actually purchased) — no real cost, left alone; two staging households from disposable e2e test runs with no Twilio number at all — no real cost, left alone.
- **Net effect**: 3 real Twilio numbers released (saving ~£3/month idle rental), 3 stale households fully anonymized, 1 orphaned subscription cancelled, zero real financial transactions of any kind, and the two live CallKit-proof accounts and all genuinely-in-use production households untouched.

## Twilio Auth Token rotation — prepared, NOT executed (deliberately)

Following up on the earlier self-disclosed incident (Auth Token briefly visible in a tool result). Confirmed via Twilio's own docs that zero-downtime rotation is a real, supported feature: create a **secondary Auth Token** (`POST https://accounts.twilio.com/v1/AuthTokens/Secondary`) — both tokens are valid simultaneously — update every consumer to use it, then **promote** it (`POST https://accounts.twilio.com/v1/AuthTokens/Promote`, which deletes the old primary, i.e. retires the exposed one).

**Why this was not carried out autonomously**: the middle step ("update every production secret") means Railway's `TWILIO_AUTH_TOKEN` environment variable — and this session has never had Railway CLI or dashboard access, all engagement long (confirmed repeatedly, not re-derived). That gap alone blocks full completion regardless of anything else, so per this run's own instruction ("if any irreversible account action genuinely requires Andrew... do not risk the working production service"), no Twilio-side change was made — the current, working Auth Token remains untouched and production is unaffected.

Separately: creating the secondary token myself would mean the live secret value passes through this session's tool output again — exactly the failure mode from the earlier incident. Since Andrew has direct Console access and the whole action takes under a minute, it's cleaner and safer for him to do the create-and-copy step himself rather than have me generate/handle the secret. See the Monday handover report for the exact one-action sequence.

## Final Phase 1 verification pass (2026-08-23, non-destructive)

- `/health`: `200`, `{"status":"ok",...,"checks":{"supabase":"ok"}}` — confirmed live via direct request.
- Twilio number release scheduler: confirmed still wired into `server.js` (`runTwilioNumberReleaseCheck`, first run 60s after boot then every 24h, alerts only on genuine failure) — no redeploy needed, nothing regressed.
- Support email infrastructure: MX (`mx00`/`mx01.ionos.co.uk`) and SPF (`v=spf1 include:_spf-eu.ionos.com ~all`) both confirmed live via DNS lookup.
- Full automated regression suite: **785/785 checks passed, exit code 0** — every migration, billing/webhook, provisioning, live-monitoring (transcription, risk scoring, red-line termination, SMS warnings), alerting, health-check, and release-runner test green. No regressions from tonight's cleanup work.

**PHASE 1: COMPLETE. Production frozen, no feature work or refactoring performed — only the test-data cleanup and verification described above.**

---

# FIRST CUSTOMER OPERATIONS (2026-08-23) — reviewed end-to-end, low-risk fixes applied

Reviewed the actual, deployed customer journey by reading the real served files/routes (not assumptions): `public/index.html` (landing), `public/register.html`, `public/confirmed.html`, `public/login.html`/`forgot-password.html`/`reset-password.html`, `upload.html` (the real dashboard — **`GET /dashboard` serves `upload.html` at the repo root, not `public/dashboard.html`**; see note below), `GET /activation-instructions` (`server.js:844`, logic in `services/activationInstructions.js`), `routes/billing.js`'s checkout/portal/reconcile routes, and the trusted-contacts CSV template.

## Journey, step by step (what's actually live)

1. **Signup** (`register.html` → `POST /register`) — email/password only, clear validation, deliberately identical success copy for a genuinely-new signup vs. a duplicate attempt (anti-account-enumeration, intentional). Fine.
2. **Email confirmation** (`confirmed.html`) — confirms the account is active; login continues to the dashboard.
3. **£4.99 payment** (`POST /billing/create-checkout-session`, `routes/billing.js:169`) — well-guarded: blocks double-subscribing, reuses an open Checkout session, real idempotency key, redirects to Stripe Checkout. Solid.
4. **Provisioning** — a Twilio number is assigned server-side on qualifying subscription status; customer never has to do anything for this step.
5. **Trusted contacts** — CSV upload matches the on-page instructions; simple, works as described.
6. **"Protected telephone call" setup** (`GET /activation-instructions`) — **this is the one step that actually requires the customer to do something technical**: dial a call-forwarding code (e.g. `*21*0xxxxxxxxxxx#`) on their own handset so unknown calls reach Home Call Guard at all. Sky/Virgin landline customers must first call 150 to add "Call Divert," which **may add ~£2.50/month** to their phone bill — a real, provider-charged cost, not a Home Call Guard fee.
7. **Monitoring** — live call screening, progressive/red-line risk detection, SMS warnings — all covered by the 785-check regression suite, no issues found in this review.
8. **Dashboard/activity** (`upload.html`) — shows recent calls, membership status, trusted contacts, account details, FAQ, support email. Onboarding steps shown one at a time; never falsely claims "protected" before a real routed call is verified. Good design already in place.
9. **Membership/cancellation** (`POST /billing/manage-membership`) — redirects to Stripe's hosted Billing Portal (the *only* place a subscription can actually be cancelled or a card updated — correct, minimal-surface-area design, nothing to fix architecturally).
10. **Support** — `support@homecallguard.co.uk` genuinely visible on the landing page, dashboard, and footer everywhere; real MX/SPF confirmed live (Phase 1).

## Genuine confusion points found — fixed (copy-only, zero architecture risk)

- **Undisclosed setup step and undisclosed extra cost.** Nothing on the landing page or pricing section warned a first-time customer that (a) a manual call-forwarding step is required after paying, or (b) Sky/Virgin customers may be charged an extra ~£2.50/month by their own phone provider for it. **Fixed**: added a new FAQ entry to `public/index.html` ("What do I need to do after I subscribe?") disclosing both, placed in the existing FAQ list, no design/layout changes.
- **"Manage Membership" gave no indication it leaves the site.** For a scam-screening product marketed to scam-wary customers, an unexplained redirect to an unfamiliar external payment page is a real, avoidable moment of alarm. **Fixed**: added one line of copy under the button in `upload.html` ("This takes you to Stripe, our secure payment provider, where you can update your card details or cancel your subscription.").
- Both changes are pure static-copy additions (no JS, no routes, no schema touched); full regression suite re-run afterward: **785/785 checks still passing, exit code 0**.

## Identified, deliberately NOT changed (cosmetic or requires a judgment call beyond "genuine defect, low-risk fix")

- `confirmed.html`'s "your account is now active" wording could arguably be read as implying protection is already on — but the very next screen (dashboard) clearly shows the payment paywall before anything else, so this is a minor sequencing nuance, not a dead-end or wrong information. Left as-is.
- `register.html`'s identical new-vs-duplicate-signup copy is a deliberate security tradeoff (anti-enumeration) already made and documented in this codebase — changing it is a security-posture decision, not a copy fix, so left untouched.
- `public/dashboard.html` is a **stale, never-served dev stub** (found during this review — `GET /dashboard` actually serves `/upload.html` at the repo root, confirmed at `server.js:1469`). It is dead code, not reachable by any customer, so it's not a live defect — flagged here so it isn't mistaken for the real dashboard again, but not deleted (out of scope for a freeze night; harmless as-is).
- `reset-password.html` silently attempts a `homecallguard://` app-scheme handoff before falling back to the web form — harmless no-op if no app is installed, but no companion app is ever mentioned in customer copy (deliberately — index.html's own FAQ says "No app to learn"). Not a customer-facing issue since it fails silently and invisibly to a web fallback; left as-is.

## Customer-acquisition attribution — no existing mechanism found; recommendation only (per instruction, not built)

Checked thoroughly: `POST /register` (`server.js:1126`) captures only `email`/`password` — no UTM parameters, referrer, or campaign field anywhere in the request, in `households`' schema, or in any migration. The only `source` column that exists (`entitlements.source`, migration 011) records *how the entitlement was granted* (`'stripe'` etc.), unrelated to marketing attribution. **No existing mechanism to wire up.**

Building real attribution (a `households.acquisition_source` column + capturing `?utm_source=` on landing and threading it through registration, or adding a client-side analytics script) is new architecture and also raises a genuine privacy-policy question — `privacy.html` would need checking/updating if any tracking script were added, which is a legal/policy judgment call, not an autonomous copy fix. Per this run's own instruction ("if proper attribution requires new architecture, document the recommendation rather than delaying launch"), this is **documented only**:

**Recommendation for zero-engineering attribution starting Monday**: since HCG expects its first 10 customers from a handful of known channels (Age UK, a community group, local press, word-of-mouth), Andrew can distinguish sources today with no code changes at all — give each channel its own distinct, memorable link (e.g. a free redirect/short-link service he controls, one per channel, all pointing at the same `homecallguard.co.uk`), and simply note the date/time of each outreach event (the Age UK talk, the press piece going live) against new-signup timestamps visible in Supabase. This costs nothing, ships today, and is sufficient at 10-customer scale. Proper UTM capture + a `households` column is a reasonable small follow-up once volume justifies the engineering and the privacy-policy question has been considered — not before.

**PHASE 2: COMPLETE.** Committed (`2ba0e50`) and pushed to `origin/main` — deliberately narrow: only the 4 files this session actually edited (`public/index.html`, `upload.html`, `CURRENT_STATE.md`, `MARKETING_FACTS.md`) were staged and committed; every other pre-existing uncommitted file in the working tree (admin dashboard work, migrations 021/022, mobile-app docs — none touched or reviewed this session) was deliberately left alone, staged, and un-pushed, exactly as found. Confirmed live in production by fetching the real page afterward and finding the new FAQ text present.

---

# Mac security audit (2026-08-24) — read-only, sanitised summary

Full read-only audit of this development Mac, requested separately from the launch-readiness work above, given the machine holds HCG development/production credentials and was previously used with a personal AI-agent tool ("OpenClaw") unrelated to HCG. **No credentials are recorded in this summary** — see the conversation's own final report for full detail; this is the durable, safe-to-keep pointer.

**Overall status: AMBER** — no evidence of malware or compromise; one credible, currently-live sensitive-data exposure was found and requires Andrew's attention, plus several lower-severity hygiene items.

**Top finding (RED, needs Andrew's action)**: a leftover `python -m http.server` process (started in an earlier session, unrelated to any HCG service) has been serving this session's scratchpad directory unauthenticated to the entire local network since 2026-08-23, and that directory contains real Stripe live customer/charge data and app-store reviewer credentials. Not stopped autonomously (explicit read-only-audit instruction) — flagged live to Andrew mid-audit via the session itself. **Andrew: kill this process (or just reboot the Mac) at the first opportunity**, and treat anything in that scratchpad directory as having been network-exposed.

**OpenClaw**: confirmed **still actively running** (not a historical remnant) — a legitimate, real open-source npm package (MIT-licensed "multi-channel AI gateway"), running continuously since mid-June as a LaunchAgent, gateway bound to localhost only (not directly network-reachable). Its own workspace/config/logs show **no evidence of ever touching HCG directories or credentials** — its active use is entirely separate personal projects (a trading-signal bot, job search, sales leads). Structurally worth noting: it has a Telegram messaging integration, i.e. a legitimate remote-control channel into a process running under the same user account as all HCG development — not a compromise, but a real reason to keep HCG credentials scoped away from this agent's reach.

**Other findings**: macOS is several minor versions behind on updates (been deferred repeatedly since ~June) — routine but overdue. The application firewall is off. A 2-week-old ngrok tunnel exposes a local sandbox server to the public internet for Stripe test-mode webhook delivery — confirmed test-mode only, not live, but mixes with the production Supabase project. Both `.env` files are world-readable (644, should be 600). SIP, Gatekeeper, FileVault, SSH, and Screen Sharing all checked out clean/correctly configured. No secrets found committed to git history in either HCG repo, current or historical.

A recurring lightweight security check (OS updates, `.env` permissions, listening ports, LaunchAgents diff) was recommended to Andrew as a short monthly routine — see the full report for the exact commands.

**Update**: Andrew explicitly authorised killing the exposed process (`kill 91639`) directly in-session. Done and verified — port 8931 confirmed no longer listening. The RED finding is resolved; everything else in the AMBER list above still stands as recommended-but-not-urgent follow-up.

**Follow-up**: at Andrew's request, the sandbox test-mode Stripe key was rotated (Stripe Dashboard, "Now" expiration) and the new key pasted directly into `/Users/ad/call-ai-sandbox-mobile-app-v1/.env` by Andrew himself — the raw value never passed through this session. `.env` permissions corrected to `600`, the sandbox server restarted and confirmed authenticating successfully (`HTTP 200`, `livemode: false`) using only status-code/boolean output, never the key itself.

---

# SEO foundation + Scam Advice content section (2026-08-24)

Autonomous SEO project (technical SEO + a public Scam Advice / Guides section) — separate initiative, does not touch call-protection/billing/auth/monitoring/routing architecture. Committed `5791206`, pushed and deployed.

## Phase 1 audit findings

**Already correct, left alone**: mobile viewport meta on every page; single H1 + clean semantic H2 hierarchy on the homepage (8 well-structured H2s); image alt text present; no render-blocking external fonts/scripts; no broken internal links; the actual dashboard (`upload.html`, served only via the authenticated `/dashboard` route) is not statically reachable, so authenticated content was never at risk of indexing — confirmed via `express.static("public")` only serving the `public/` directory and `requireAuth` redirecting unauthenticated requests to `/login.html`.

**Real gaps found and fixed**: no `sitemap.xml` (404); `robots.txt` was entirely Cloudflare's auto-generated default with no sitemap reference; zero canonical tags anywhere; zero Open Graph/Twitter Card metadata; zero structured data; account/utility pages (register/login/confirmed/forgot-password/reset-password) had no `noindex`, meaning Google could index low-value account-flow pages; `logo.png` was 1536×1024px / 580KB despite only ever being displayed at ~130px height max.

## Phase 2 technical SEO — deployed

- `public/robots.txt` (Allow all, points to sitemap) and `public/sitemap.xml` (all indexable public URLs).
- Canonical tags on every public page.
- `<meta name="robots" content="noindex, follow">` added to register/login/confirmed/forgot-password/reset-password — kept crawlable so the tag itself is seen (a `Disallow` in robots.txt would have prevented Google from ever reading the noindex tag), just excluded from the index.
- Open Graph + Twitter Card metadata and `Organization`/`WebSite`/`Service` JSON-LD structured data on the homepage — only verified facts (name, £4.99/month price, support email), no ratings/reviews/awards.
- `logo.png` resized 1536×1024 (580KB) → 480×320 (73KB), an 87% reduction, still comfortably retina-sharp at its actual ~130px max display size — verified visually before committing.
- While researching current copy for the technical audit, found and corrected two customer-facing FAQ answers (on `index.html` and `upload.html`, part of the earlier Sunday-night commit `2ba0e50`) that still described the old, removed pre-connect call-screening gate rather than the live in-call monitoring the product actually uses.

## Phase 3/4 — Scam Advice / Guides section

12 UK-focused guide pages plus a hub at `/guides/`, each targeting a distinct, genuinely differentiated search intent (no near-duplicates): protecting elderly parents from phone scams (overview), stopping scam calls to elderly parents (practical tools), landline-specific protection (general + family-setup angle), what to do if it's already happening, talking to a parent about it, identifying a scam call, common UK scam types (courier fraud, tech support, pension, bank impersonation, family-emergency/AI-voice-clone scams), caller ID/number spoofing, official reporting routes (7726, Action Fraud, 159), blocking a specific number, and an honest evaluation of call-blocking apps' real limits.

Facts sourced from Action Fraud, Ofcom, the FCA, Age UK, Citizens Advice, the NCSC, and Stop Scams UK (159) — cited on every page. Every HCG claim in each page's CTA box matches `MARKETING_FACTS.md` exactly (£4.99/month, no long-term contract, no app, trusted contacts ring through immediately, live in-call monitoring rather than pre-connect blocking, no guaranteed-protection claims). No keyword stuffing, no doorway pages, no fabricated reviews/ratings/awards, no near-duplicate city/town pages. Both target audiences ("protect myself" and "protect Mum/Dad") are covered naturally — the family-focused pages explicitly, the general pages in neutral second person.

Internal linking: main site header nav + footer now link to `/guides/`; every guide links to 2-3 related guides and to `/register.html` / `/#how-it-works`.

## Phase 5 — QA and deployment

Verified before deploy: every internal link across all 13 new pages resolves to a real file (checked programmatically); exactly one H1 per page; all page titles and meta descriptions unique; all HTML tags balanced; all JSON-LD blocks valid JSON. Full regression suite: **785/785 passing** (unaffected, since this is entirely static frontend content — no routes/schema/logic touched). Deployed and confirmed live: `/guides/` hub, `/sitemap.xml`, `/robots.txt`.

## Google Search Console

**Not currently set up** — confirmed via repo search (no `google-site-verification` meta tag anywhere) and a live DNS TXT lookup on `homecallguard.co.uk` (no verification record). This requires Andrew's own Google account and DNS-panel access, neither available from this session.

**One exact Monday action**: go to [search.google.com/search-console](https://search.google.com/search-console), add `homecallguard.co.uk` as a Domain property, verify via the DNS TXT record method (add the TXT record Google provides to the domain's DNS at IONOS — this is the standard route for a domain-wide property and also covers `www.` automatically), then once verified, go to Sitemaps and submit `https://homecallguard.co.uk/sitemap.xml`. Everything else needed for this (the sitemap itself, clean URLs, correct metadata) is already live — this is a ~5 minute task once Andrew is back.

---

# Privacy policy review (2026-08-25) — reviewed, proposed, then APPLIED same day

Reviewed the live privacy policy against the actual code (not assumed) ahead of Play Store submission. Proposed wording was delivered in conversation first (report-only), then Andrew explicitly asked for it to be applied — done, tested, deployed, and confirmed live the same day. This is a pointer/summary of what changed and why, for anyone picking this up later.

**Real findings, verified against the code:**
- OpenAI receives raw **audio** for transcription (`services/liveMonitoring/transcribeChunk.js`), not "a text version" as the policy currently says. The actual scam-detection scoring is 100% in-house (`services/liveMonitoring/scoring/`) — OpenAI only transcribes, never classifies. No call recording exists anywhere (confirmed: no Twilio `<Record>` usage). Only a non-transcript summary (numbers, outcome, timing, risk indicators) is ever persisted.
- Two real disclosure gaps found: the mobile app can read the phone's **Contacts** (via `expo-contacts`, permission-gated, only user-selected numbers are ever uploaded) and registers the device's **push-notification token** with the telephony provider for incoming-call delivery — neither is mentioned in the current policy at all.
- The current policy names vendors by name (Stripe, Supabase, Railway, Twilio, OpenAI) and describes implementation detail (hosting region/provider pairing, "keyword analysis and AI classification" as the detection method, the specific access-token/refresh-token cookie architecture) that GDPR doesn't require — Art 13(1)(e) only needs *categories* of recipients, not named companies.
- A Google Play Data Safety worksheet was produced mapping the app's actual behaviour to Play's own data categories: **Audio** (yes — both normal call audio and scam-detection transcription), **Contacts** (yes), **Personal info/email** (yes), **Financial info** (yes, limited to Stripe IDs/status, no card data), **Device/other IDs** (yes — push token), **App activity/analytics** (no — confirmed no analytics/crash-reporting SDK in the mobile app's dependencies), **Location** (no). This worksheet still needs manually transcribing into the actual Play Console form when the Android listing is submitted — that's a Play Console UI action, not a code change, so it's still an owner action.

## Applied — `privacy.html` updated, tested, deployed (commit `83a76ae`)

All proposed wording changes were applied: §2 rewritten (accurate audio/transcription description, two new subsections added — "Contacts (mobile app)" and "Device information (mobile app)" — covering the two gaps found above); §4's vendor list replaced with functional categories; §5's parenthetical vendor list removed; §7 and §9 simplified to remove method/architecture detail; a new optional §14 "Children" added; "Last updated" date bumped to 25 August 2026. Double-checked afterward for any vendor name left anywhere in the file (found and fixed two the first pass missed: "Supabase" in §2's password paragraph, and "Stripe, Twilio and OpenAI" in §5's international-transfers paragraph) — confirmed fully clean on a second pass. 785/785 tests passing, deployed, confirmed live.

**Worth knowing**: §13 of the policy itself says material changes get "reasonable steps" to notify customers, e.g. by email. This rewrite is a genuine, substantive update (new disclosures added, not just wording polish) — sending an update notice to existing customers is a business/communications decision, not something I've done or would do unilaterally. Flagging it here so it isn't missed.

## FAQ accordion clipping — found and fixed

Checked the homepage FAQ accordion at 320/360/390/412/428px widths (realistic phone widths, via Playwright). Found a real bug: `.faq-item.open .faq-answer` used a hardcoded `max-height: 250px` (needed since CSS can't transition to `height: auto`). On narrow phones the same text wraps into more lines, needing more vertical space than on desktop — the longest answer ("What do I need to do after I subscribe?", added earlier this session) needed 443px at 320px wide, so roughly 193px of it — including the Sky/Virgin Call Divert cost disclosure, mid-sentence — was silently clipped with no visual indication anything was missing. The dashboard's separate FAQ (`upload.html`, native `<details>`/`<summary>`) was checked too and is unaffected — no hardcoded height there.

**Fixed**: raised the cap to `max-height: 1000px` — comfortably clears today's longest answer with real margin for future edits and larger accessibility text sizes. Tested (785/785 passing), committed (`c1afd79`), pushed, and confirmed live.

---

# Terms and Conditions review (2026-08-25) — reviewed, concerns flagged, Andrew confirmed, then applied

Same review discipline as the privacy policy: read the full document, cross-checked every factual claim against the actual code (not assumed), reported significant concerns before touching commercial terms/liability/cancellation/customer obligations, got Andrew's explicit go-ahead, then implemented, tested, and deployed the same day. `terms.html` commit `f36258f`.

**Real findings, verified against the code:**
- Section 2 said unknown callers are "screened... before the call is allowed to reach your phone" — the same inaccuracy already found and fixed on the homepage FAQ/dashboard earlier this session. The call actually connects and rings as normal; monitoring happens live, during the call.
- Section 5 described cancellation as an email-to-support process — wrong for almost every real account. `routes/billing.js`'s "Manage Membership" button redirects to Stripe's self-service Billing Portal; cancellation is instant and customer-driven. Email-to-support only genuinely applies to the rare complimentary/promotional account with no real Stripe subscription behind it (confirmed via `upload.html`'s conditional "not manageable" note).
- Section 7 named the detection technique ("keyword analysis and AI classification", "automated, real-time transcription") — same category of over-disclosure as the privacy policy, but with an extra wrinkle worth recording: genericising this to "automated technology" isn't just less disclosure, it's arguably *better* liability protection, since a named, specific technique invites an argument like "you said AI classification, so prove what it did in my case" that a general description doesn't.
- Section 3 named "Stripe" directly. Checked whether Stripe's own merchant terms require this in customer-facing Terms specifically (as opposed to a privacy/data-consent notice, where Stripe's own guidance does suggest naming it) — found no such requirement for Terms of Service, so genericised to "our payment processor" here too, independently reasoned rather than copied from the privacy-policy pass.
- Section 8 named vendor *categories* already ("telephony, hosting, database and AI providers") — no company names, left as-is; the same category-level disclosure is fine here as it was in the privacy policy.

**New protections added** (all confirmed with Andrew before implementing, since they touch customer obligations/liability): an eligibility clause (18+, contractual capacity, UK phone number — previously entirely absent, and left the Terms inconsistent with the privacy policy's new "Children" section); explicit non-liability for the customer's *own* phone line/mobile network/device/internet connection failing (previously only covered outages at HCG's own suppliers); a brief, generic clause noting protection may be delivered through the mobile app under the same Terms, once it's made available.

**Deliberately not touched**: Section 9 (fair use), Section 10 (statutory 14-day cooling-off/refund rights), and the core liability-cap structure in Section 12 (death/personal injury/fraud carve-out, 12-months'-fees cap) — already correctly scoped, standard boilerplate, no factual or disclosure problems found.

**Genuine open questions flagged for Andrew, not resolved by Terms wording** (relevant before Google Play/Apple submission):
- The mobile app opens Stripe Checkout in a web browser (`WebBrowser.openAuthSessionAsync`) rather than using Apple In-App Purchase or Google Play Billing. Very likely fine — HCG is a real-world telephony service, not in-app digital content, the standard exception both platforms recognise — but this is Apple's/Google's call at review, not something the Terms or this session can certify.
- Unknown whether the app uses Apple's Standard EULA or a custom one in App Store Connect — not visible from this environment. If custom, Apple's minimum required terms need to be present somewhere; if standard, nothing extra is needed.

**Verification**: no vendor/architecture names anywhere in the file (checked live, post-deploy); all 15 section numbers unchanged, so the existing internal cross-references (Section 5, Section 10) stay valid; checked at 320/360/390/428px on both the local file and the live production page — zero horizontal overflow at every width, no clipping risk (plain flowing paragraphs, not the fixed-height accordion pattern that caused the FAQ bug). Full regression suite: 785/785 passing. Live page confirmed showing the new "Last updated: 25 August 2026" date and all new wording.

## Follow-up wording fix (2026-08-25) — privacy policy, "Contacts (mobile app)"

Andrew requested one small, precisely-scoped wording change: §2's "Contacts (mobile app)" subsection said we only store "the specific contacts you choose to add" — this didn't accurately cover the app's "Sync all contacts" functionality. Changed to "the contacts you choose to add **or sync**." Confirmed via `git diff` this was the only change in the file (2 lines touched, nothing else). No supplier names, architecture, or detection-method detail reintroduced. Tested (785/785 passing), committed (`33d4171`), pushed, deployed, and confirmed live — including a repeat 320/360/390/428px mobile check on the live page (zero horizontal overflow, unchanged from the prior pass).

---

# Read-only verification passes (2026-08-25) — terms.html, privacy.html, index.html

Three separate read-only verification requests against the live pages (terms, privacy, then the homepage), each checking HTTP status, exact wording, no vendor/architecture reappearance, mobile overflow at 320/360/390/428px, and visual clipping — with instructions to change nothing unless a genuine defect was found.

**`terms.html`**: fully clean. HTTP 200, correct date, all new wording (cancellation, eligibility, UK-number, mobile-app, automated-screening, network-dependency) present and correctly rendered, no vendor names, zero overflow at every width, table/lists/footer/email links all clean on mobile and desktop. No changes made.

**`privacy.html`**: fully clean. HTTP 200, correct date, "add or sync" wording confirmed live and rendering correctly, both new mobile-app subsections present, call/audio retention wording accurate, automated-screening wording generic, no vendor names, Section 3 table renders correctly on both mobile and desktop, zero overflow at every width. No changes made.

**`index.html`**: **found and fixed a genuine, repeated factual defect.** The homepage still contained the same "screened/blocked before the call reaches you" inaccuracy already corrected elsewhere this session — but in **six more places** that an earlier pass had missed:
1. The meta description, Open Graph description, and Twitter Card description (the text shown in Google search results and social shares — the single highest-visibility instance, since it reaches people before they even click through).
2. The hero section's bullet point ("screened by AI before your phone rings").
3. The hero "reassurance" copy ("screened before reaching you").
4. The phone-mockup illustration's own caption text ("Screening this caller before the call reaches you").
5. The "problem" section's intro paragraph.
6. The "how it works" section's intro paragraph.

All six corrected to accurately describe live, in-call monitoring rather than pre-connect blocking (e.g. "screened by AI during the call", "Screening this call now"). **Deliberately left unchanged**: the H1 ("Stop scam callers before they reach you") — reasoned as a value-proposition tagline about outcomes, not a literal technical claim about call-handling timing, unlike the six fixed instances which all made a specific, checkable, false claim about mechanism. This is a judgment call, flagged rather than decided silently — Andrew may want it revisited.

Verified: full regression suite 785/785 passing; zero horizontal overflow at 320/360/390/428px and 1440px on both the local file and the live production page; the FAQ accordion's earlier clipping fix (`max-height: 1000px`) re-confirmed still showing the complete longest answer with no truncation; header/logo/buttons/pricing/footer/legal links all visually clean at the narrowest width and on desktop; `/privacy.html`, `/terms.html`, and `/guides/` links all confirmed resolving to `200` from the live homepage. Committed `faa8f41`, pushed, deployed, confirmed live.

---

# Google Play delete-account requirement (2026-08-25) — real implementation gap found and fixed, then the public page built

Google Play's Data Safety section requires a public account-deletion URL. Before writing that page, cross-checked its claims against the actual deletion mechanism rather than assuming `privacy.html`'s existing wording was accurate.

## Real gap found: account deletion never actually deleted trusted contacts or call records

`privacy.html` promised that deleting an account removes "your trusted-contact data" — but the only mechanism that existed, `anonymize_inactive_household` (migration 020), only ever scrubbed the `households` row itself (email/phone/auth_user_id/stripe_customer_id/twilio_number). It never touched `public.contacts` or `public.calls` at all — confirmed directly, not assumed, including checking `database/contacts.js` (only a single-contact delete exists, never a bulk per-household one). So a customer's real trusted contacts (their family/friends' names and numbers) and their full call/screening history remained in the database indefinitely after "deletion," tied to the now-anonymised household_id.

Reported this to Andrew before writing the delete-account page rather than repeating an unverified promise a third time (following the same privacy.html/terms.html/homepage pattern this session). Andrew confirmed: treat as a real implementation gap and fix it properly.

## Fix — Migration 029: `supabase/migrations/029_anonymize_household_deletes_contacts_and_calls.sql`

Extends the existing `anonymize_inactive_household(uuid, text)` RPC (same signature, same two existing guards — no Twilio number assigned, no active entitlement — preserved verbatim) to also delete every `contacts` and `calls` row for that household, scoped only by `household_id`, only after every guard has passed. Deliberately still does **not** touch `subscriptions`, `entitlements`, or `stripe_webhook_events` — checked directly: none of those three tables stores a customer's name/email/phone in a dedicated column, so they don't need scrubbing to protect a deleted customer's identity, and they're the genuine billing/audit history UK tax law requires keeping. One residual item flagged, not fixed: `stripe_webhook_events.payload` stores Stripe's raw webhook JSON verbatim and can in principle carry fragments like a customer's email depending on event type — redacting inside that column would be a separate, materially riskier change (it's the only durable record of exactly what Stripe sent, relied on for safely reprocessing a failed event) — Andrew explicitly said not to touch this as part of this work.

Atomicity comes from PL/pgSQL's own implicit per-call transaction — no explicit BEGIN/COMMIT needed inside the function; if any statement raises, the whole call (including the two new deletes) rolls back.

**Tests added** to `tests/migrations.pglite.test.mjs` covering every scenario requested: household anonymisation itself, trusted contacts deleted, call/screening records deleted, billing/entitlement records retained, no cross-household deletion (a second, untouched household fixture proves this), and failure/rollback behaviour (an active entitlement blocks the whole operation — verified a blocked attempt deletes nothing at all, not a partial cleanup). All pass; full suite 795/795 (up from 785), 0 failures.

## Production application

Reported the exact proposed SQL and its production-impact analysis before touching anything. Andrew approved, then verified the correct Supabase project (`psbzynxplxfbyrbdidmn`) two ways before applying anything: the Project Settings Reference ID, and a live household/entitlement-count cross-check I supplied in real time from a read-only query, independent of anything he ran himself. Applied via the Supabase SQL Editor (no working Management API/direct Postgres access from this environment — same limitation as migrations 019/027/028). Post-application, read-only verification (no real customer's data touched or tested) confirmed: `security definer = true`, `owner = postgres`, `search_path` pinned empty, correct `(uuid, text)` arguments, and the function body containing both new delete statements. Migration header updated to APPLIED with the verification detail recorded.

## Privacy Policy updated to match the now-real behaviour

`privacy.html` §6's deletion paragraph previously said only "we will remove or anonymise your account and trusted-contact data" — didn't mention call/screening records at all. Updated to explicitly state account information is removed/anonymised, trusted-contact data is deleted, and call/screening records are deleted — matching migration 029 exactly. "Last updated" date unchanged (already 25 August 2026 from earlier the same day).

## `delete-account.html` — created and deployed

New page at `/delete-account.html`, reusing `privacy.html`/`terms.html`'s exact visual design (same CSS, header, footer). Covers: AFMD Ltd identification, how to request deletion (email support@ from the account's own address, state the account and personal data should be deleted), identity verification may be required, 30-day completion target, exactly what's deleted (account info, trusted contacts, call/screening records — now true), what's retained (billing/accounting records only, only for the legally required period), and the cancellation-vs-deletion distinction (confirmed accurate against `routes/billing.js`'s actual Stripe cancellation flow — cancelling never triggers anonymisation). `noindex, follow` (utility page, consistent with how register/login/etc. are already treated). Links to the Privacy Policy. No vendor names or implementation detail anywhere on the page. Checked at 320/360/390/428px and 1440px desktop — zero horizontal overflow, visually clean at both extremes. Full test suite: 795/795 passing.

---

# Google Play visual assets: branding source correction (2026-08-26)

## Branding audit finding
Inventoried every logo/icon asset across both repos. Found the mobile app was shipping **two conflicting visual identities**: the website (`public/logo.png` and everywhere on homecallguard.co.uk) uses a green shield + phone/signal mark; the mobile app's actual configured icon (`mobile/assets/icon.png`, wired up in `app.config.js`) was a completely different blue chevron mark — confirmed by reading the config directly, not assumed. Andrew decided: **green shield + phone is canonical going forward; the blue chevron is legacy/placeholder.** This session only touched Google Play Store *listing* assets (`docs/launch/`) — no mobile app icon/config files were changed, per explicit instruction to scope this down.

## Multiple iterations were needed to get the 512×512 Play Store icon right
1. First attempt used `mobile/assets/shield-mark.png` directly, scaled and centered with computed padding — looked correct by the numbers, but Andrew reported the shield's bottom point still looked clipped in actual Google Play.
2. Investigated further and found the real root cause: **`shield-mark.png` itself is a truncated source file** — its artwork's bottom edge sits at the very last pixel row with zero internal padding, so no amount of external padding/centering could fix it. Confirmed by direct pixel inspection, not assumed.
3. Fix: extracted the shield fresh from `public/logo.png` instead (which has the complete, genuine pointed/V-shaped bottom — confirmed by zooming into both sources and comparing directly), cropped out the wordmark/divider, color-keyed the flat black background to transparency. Saved as a new, reusable source: `mobile/assets/shield-mark-from-logo-master.png`.
4. Verified color fidelity before use: sampled the phone handset's actual pixel values (green gradients, e.g. RGB 44,231,89) to confirm it wasn't accidentally white or altered.

## Final approved assets
- **`docs/launch/google-play-app-icon-512.png`** — 512×512, PNG, RGB, 49.6 KB. Built from `shield-mark-from-logo-master.png`, centered, complete pointed bottom with generous dark padding on every side, no text/badge. Andrew requested the shield 50% larger after reviewing the first version (260px tall → 390px tall, margins now 89px left/right and 61px top/bottom); enlarged, visually verified against the actual saved file, and approved — colours, artwork, and proportions unchanged from the source, only the scale.
- **`docs/launch/play-store-feature-graphic.png`** — 1024×500, PNG, RGB, 54.6 KB. Same shield on the left; "Home Call Guard" + the approved Play Store short description from `docs/launch/STORE_LISTING_COPY.md` ("Real-time scam-call protection. Trusted contacts always ring through.") on the right; existing dark HCG background.
- **`docs/launch/google-play-screenshots/`** — 5 genuine device screenshots selected from `docs/screenshots/mobile-rc1/`, covering protection status, trusted contacts, call activity, setup/activation, and account/membership. One deliberate substitution worth remembering: the populated Trusted Contacts screenshot was **not** used because it displayed what look like real phone numbers next to labels like "Wife (QA trusted contact)" — used the empty/paywall variant instead as a safe placeholder. Andrew may want a proper redacted or fresh-demo-data version before final submission.

Both Andrew-confirmed as correct. No EAS build run, no mobile app config changed, nothing submitted to Google or Apple.

---

# First production Android builds — icon fix, real-device bug found and fixed, v3 and v4 (2026-08-26/27)

## Compiled app icon corrected (not just the Play Store listing)
The branding-correction pass above only fixed the *Play Store listing* icon — the actual compiled Android app was still launching with the old blue chevron (`mobile/assets/android-icon-foreground.png`/`android-icon-background.png`/`android-icon-monochrome.png`), found and flagged before the first production build so Andrew could decide rather than shipping it silently. Andrew chose to fix it: rebuilt all three adaptive-icon layers from the same verified `shield-mark-from-logo-master.png` source, at the same safe-zone scale the previous icon used (measured from the existing files, not guessed). Found and fixed one real defect along the way: `android-icon-background.png` had a design-tool safe-zone guide grid (faint circles/dashed lines) baked into its actual pixels — replaced with a plain `#0b1220` fill matching the approved Play assets, and `adaptiveIcon.backgroundColor` updated to match. Visually verified all three layers directly. Committed `878b767` on `sandbox/mobile-app-v1`, pushed.

## Production readiness verification (before the first build)
Checked, not assumed: EAS `production` environment resolves to the real production API/Supabase URLs (`www.homecallguard.co.uk`, `psbzynxplxfbyrbdidmn`); remote Android signing credentials (`Cn5OlZSb-i`) already proven by an earlier successful store build; `appVersionSource: remote` with `autoIncrement: true`; final merged Android permissions traced through the Twilio Voice SDK's own manifest (microphone/foreground-service only activates on an actually-answered/placed call, never in the background otherwise — confirmed `FOREGROUND_SERVICE_PHONE_CALL`/`phoneCall` is not declared anywhere in the dependency tree, only `microphone`). Full test suite green before building.

## v3 (versionCode 3) — first production build
Built via `eas build --platform android --profile production`. `mobile/build-output/home-call-guard-production-v3.aab` (79.7 MB, local only, never uploaded).

## Real bug found on physical device, diagnosed, fixed
Installed from Google Play Internal Testing on a real phone: Home screen stuck on "Protection status unavailable" / "Try again" doing nothing visible. Diagnosed properly rather than guessed:
- Production DB checked directly (read-only) for the actual logged-in account (`andrewbusinessai@gmail.com`): auth user, household, role, and Twilio number are all healthy — but its one entitlement is `expired` and its subscription `canceled`. That state should produce a clean 402 `not_entitled` from the server (a *different* screen, "Not protected yet") — not the "unavailable" screen actually shown, which only happens when the client never gets a clean response at all.
- Root cause: `lib/api.ts`'s `authorizedFetch()` called `supabase.auth.getSession()` on every authenticated request — the same intermittent real-Android-device bug already found and worked around for Voice SDK registration on 2026-08-23 (`getSession()` returning null despite a genuinely valid session already held in `AuthContext`), but never fixed for the dashboard/contacts/billing/activation calls, only for the voice token call.
- Fix: `authorizedFetch()` and all 9 authenticated API functions now accept an optional `accessToken`, used directly instead of re-deriving it; `resolveAuthToken()` (new, dependency-free, unit tested) makes the explicit-token-wins decision; all 14 screens now pass `session?.access_token` from `useAuth()`. Fully backward compatible (omitting the token falls back to the old behaviour). Full worktree test suite: 1,017/1,017 passing. Committed `6e8f199` on `sandbox/mobile-app-v1`, pushed.
- Separate, deliberately untouched: `andrewbusinessai@gmail.com`'s expired entitlement is real account state, not a bug — once this fix ships it should correctly show "Not protected yet," not "You're protected," until resubscribed.

## v4 (versionCode 4) — rebuilt with the fix
Built the same way, same verified production environment/signing/icon (fingerprint identical to v3, confirming only code changed, not native config). `mobile/build-output/home-call-guard-production-v4.aab` (79.8 MB, local only, never uploaded). Note: the build's own EAS-recorded "Commit" metadata shows `878b767` (the icon commit) rather than `6e8f199` (the auth fix) — the fix was already committed on disk and included in the build's uploaded archive (EAS packages the working tree, not a git ref) at build time, but the auth-fix commit itself was made in a later step, after the build had already started. The v4 `.aab` genuinely contains the fix; the commit-hash field just lags one commit behind for that reason.

Neither v3 nor v4 has been uploaded or submitted to Google Play from here — that remains Andrew's own action in Play Console.

---

# Same-phone call delivery: forwarding loop, then Voice SDK push chain, both fixed and physically confirmed (2026-08-27)

Real device testing on the Motorola (Google Play Internal Testing, then sideloaded v4) surfaced three genuinely separate, sequential production bugs standing between "call forwarding dials Twilio" and "the customer's phone actually rings and connects." Each was diagnosed with real evidence (production DB reads, Twilio's own call/notification logs, live `adb logcat` captures) before any fix, not guessed from symptoms.

## Bug 1 — PSTN dial-back forwarding loop (fixed: migration 028)
A known, previously-documented issue (`services/callRouting.js`'s own comment, root-caused 2026-08-15): for a single-phone customer, `households.phone_number` **is** the exact number carrier-forwarded to the Twilio number. Every approved call still dialled that number back over PSTN in parallel with the Voice SDK Client leg, re-entering the customer's own active forward — the carrier correctly returned `busy` to break the loop, which is what the customer heard as "this person's phone is currently unavailable."

`self_protecting` (migration `028_household_self_protecting.sql`) had been written but never applied — genuinely blocked on this repo having no working Supabase Management API/direct Postgres access; applied manually by Andrew via the Supabase SQL Editor after independently re-confirming the production project ref (`psbzynxplxfbyrbdidmn`, not staging `tigwgmayeuisrxjjykqd`). Read-only verification confirmed the column exists (`boolean not null default true`) and all 16 production households — audited individually first to assess blast radius, none of which turned out to be a real third-party paying customer with a live Twilio number — now show `self_protecting: true`. Traced through the actual deployed `decideCallDeliveryPlan()` against the real household row: `{ mode: 'client-only', clientIdentity: ... }`, no PSTN number anywhere in the plan. A live test call (placed via Twilio's API to the protected number) confirmed it directly: no PSTN dial-back leg at all this time, only a Client-dial attempt.

## Bug 2 — Voice SDK couldn't register at all (fixed: 3 missing Railway env vars)
With the loop closed, the Client leg came back `no-answer` every time, and real `adb logcat` on the connected Motorola showed why: `GET /api/v1/voice/token` was returning `503 { error: "voice_not_configured" }` on every attempt. `routes/mobileApi.js` hard-fails that route unless `TWILIO_ACCOUNT_SID`, `TWILIO_VOICE_API_KEY_SID`, `TWILIO_VOICE_API_KEY_SECRET`, and `TWILIO_VOICE_TWIML_APP_SID` are all set — the latter three existed only in this repo's local `.env`, never deployed to Railway (a gap this document itself had flagged on 2026-08-23 and which had apparently sat open since). Andrew added the three missing variables to Railway production directly (no working Railway CLI/API session exists from this environment either — same class of access gap as Supabase). Read-only verification after redeploy: production healthy, and a live logcat capture on the Motorola showed a clean `fetchVoiceToken resolved → voice.register resolved → "Voice SDK: registered for incoming calls"` sequence with no errors.

## Bug 3 — registered, but no push ever arrived (fixed: missing Push Credential SID)
Registration succeeding wasn't the end of it: a live-monitored real call still produced silence on the device — zero FCM/VoiceService/CallInvite log activity at all, despite the parent call completing normally at the carrier/Twilio level. Root cause, confirmed by reading `services/voicePushCredential.js`'s own code comment and `docs/operations/HANDOVER_2026-08-15.md` (an almost identical bug, previously root-caused as Twilio error `52004`, "Credential Sid is null"): merely having a Twilio Push Credential exist on the account (`CR860503ff17f9d384b46f75726dce61e0`, confirmed live via Twilio's API, correctly typed `fcm`, and confirmed via that same handover doc to use the modern FCM HTTP v1 service-account method, not the deprecated legacy server key) is not sufficient — the issued Access Token's `VoiceGrant` must explicitly carry `pushCredentialSid`, which only happens if `TWILIO_VOICE_PUSH_CREDENTIAL_SID` is set wherever the token is issued. That variable was never part of the three added for Bug 2, since it isn't checked by the same hard-fail gate — it fails silently by design (`resolvePushCredentialSid`'s own documented behaviour: "registration still succeeds, incoming calls just can't be pushed"). Andrew added it to Railway production. After a fresh app close/reopen on the Motorola, live logcat confirmed clean registration again, and the next real test call showed the full push chain working for the first time: `VoiceFirebaseMessagingService: onCallInvite` → `Voice SDK: CallInvite received` → incoming-call notification/ringtone actually presented (`AudioSwitch` requested audio focus, `HeadsUpManagerPhone` pinned) — though that specific call was deliberately left unanswered (testing only whether it rang) and timed out/cancelled after ~25s, Twilio's own record showing `no-answer`.

## Confirmed fully working, end to end (2026-08-27)
One more real call, answered immediately this time, confirmed the entire chain genuinely connects — not inferred from a single log line, but from multiple independent, corroborating signals: `CallInvite received` → full ICE negotiation (STUN candidates, a selected candidate pair against Twilio's `EU_FRANKFURT` gateway) → codec negotiated (`opus/48000/2`) → `AudioTrack` (playback) and then `AudioRecord` (microphone, `opPackageName co.uk.homecallguard.app`) both genuinely opened → Twilio's own call record: **`status: completed, duration: 10s`** (not `no-answer`). Same-phone call delivery is now confirmed working end-to-end on a real device, for the first time this project.

## Still open, not addressed here
- The ringback tone the caller hears while the Client leg rings sounds non-UK/generic — expected Twilio `<Dial><Client>` behaviour (no real telephony ring signal exists for a SIP/data target, so Twilio synthesizes its own), fixable with a `ringTone="gb"` attribute on the `<Dial>` in `dialHouseholdOrFailClosed`'s client-only branch. Diagnosed, not yet fixed — a deliberate, tiny, low-risk follow-up.
- This app's notification channel was found demoted/muted at the OS level on the Motorola (`dumpsys notification`) during earlier diagnosis — noted as a secondary item, not yet revisited now that the underlying push chain works.
- Neither the orphaned system household (`default-household@homecallguard.internal`, a live Twilio number with no real owner) nor the `gardenroombuild@gmail.com` Play-Console-account coincidence from the earlier household audit have been independently resolved by Andrew.

