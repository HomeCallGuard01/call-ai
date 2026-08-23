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

- **Native app Home screen visual redesign** (task tracked) — requires rebuilding/reinstalling the mobile app, which risks disturbing the just-proven-working Voice/CallKit build. Not touched. Real, known issue — schedule immediately after launch.
- **Branded Supabase confirmation email** — template drafted and ready (`docs/launch/SUPABASE_CONFIRMATION_EMAIL_TEMPLATE.md`), needs Andrew to paste it into the Supabase Dashboard (no Management API access to do this directly). Zero risk to the critical path either way.

