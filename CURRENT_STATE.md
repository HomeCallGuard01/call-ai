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

