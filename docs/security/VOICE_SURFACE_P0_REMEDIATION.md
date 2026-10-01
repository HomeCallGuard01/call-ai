# Voice surface P0 remediation: plan for approval (NOT deployed)

| | |
|---|---|
| **Date** | 2026-10-01 |
| **Branch** | `security/voice-surface-p0` (base `origin/main` eb43368) |
| **Commits** | a6ee5cd (regression test + pre-fix evidence), a71659e (fix) |
| **Production / staging** | **Nothing deployed; no production or staging change; no migration involved** |

Testing method:
- Code review plus local black-box tests only.
- No requests were sent to production.
- No real calls, SMS, AI or email: tests use a fake Supabase and a local OpenAI stand-in, and no Twilio REST or email credentials.

## 1. P0/P1 vulnerability table

"Production affected" is based on the code in commits 871f6a4 (rollback point) and 7942e6e (last recorded deploy, 2026-09-23). The exact live commit isn't recorded in the repo. **Every finding below exists in both commits.**

| # | Pri | Endpoint / component | Attack prerequisite | Exposed data / action | Financial exposure | Prod affected | Existing fix / branch | Remediation (this branch) | Regression test |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **P0** | `/media-stream` (WebSocket) | Internet access only. A real HCG number (public: it's the sender of every warning SMS) makes the SMS look genuine. | Forged `start` → monitor created → **paid transcription** of attacker audio. **Warning SMS from HCG's own Twilio number to any attacker-chosen number**. Red-line termination attempted against an attacker-supplied CallSid. | Transcription and SMS per forged stream, **unbounded in time**. In 7942e6e there's **no concurrent-stream cap** and the malformed-frame crash bug (PR #42/43 not in that commit). Main caps at 200 streams (~£1.5k/h UK SMS + transcription, ASM). | **YES** | Partial on main (cap, crash guard, shadow signature only). Unmerged financial-safety branch blocks transcription but still reads `toNumber` from the stream. | Single-use 256-bit token issued only by a signed `/voice`, bound to the CallSid. No token → no monitor, AI or SMS; socket closed. Destination and sender from server-side record only. Per-household and global caps. Socket timeout and ceiling. | `voice-surface-security` (9, 10); `media-stream-auth-and-cost-caps` |
| 2 | **P0** | `POST /voice` | Internet; knowledge of an HCG number | **Customer's personal mobile number and household id in the TwiML**. **Trusted-contact oracle** (different response for a trusted caller). Fake calls rows in the customer's Activity. Rapid-abuse alert emails. Full `households` table read per request. | Supabase egress/CPU; alert emails; no Twilio cost (it's HCG's own endpoint) | **YES** | Signature checked only to gate the activation stamp (shadow) | Guard rejects before anything (403); mobile number removed from TwiML; `client:` requests rejected | `voice-surface-security` (1–5) |
| 3 | **P0** | `POST /process` (legacy, unreachable for real calls) | Internet; HCG number | **Paid AI call (gpt-4o-mini)** per request; fake Activity rows | OpenAI per request, unbounded | **YES** | e2895f1 (unmerged, `fix/process-endpoint-webhook-auth`) | Same guard. **e2895f1 is complete for /process but is superseded**: folding it into the shared guard avoids two divergent signature implementations. Don't cherry-pick it separately. | `voice-surface-security` (7) |
| 4 | **P1** | `POST /call-delivery-failed`, `POST /call-status` | Internet; a CallSid (to overwrite a real row) | Overwrite a call's duration/dial status; **mark a household's delivery as verified** (`completed`); "approved call delivery failed" alert emails | Alert emails; data integrity | **YES** | — | Same guard | `voice-surface-security` (6) |
| 5 | P2 | `POST /red-line-terminate` | Internet | Static TwiML only | None | YES | — | Same guard (consistency) | `voice-surface-security` (8) |
| 6 | **P1** | Voice access token `outgoingApplicationSid` (S1, 2026-09-30 review) | An entitled account, or a leaked 1-hour token | If the TwiML App's Voice URL ever points at `/voice`, a client-originated call is treated as inbound (monitoring, ringing, fake Activity) | Monitoring cost per call | UNCONF (console config) | Readiness branch 012f9f6 (unmerged) | `/voice` rejects `client:` callers first (signed or not). **Manual: check the TwiML App URL.** | `voice-surface-security` (5) |
| 7 | **P0 (financial)** | Inbound calls to HCG numbers (genuine Twilio calls) | Ability to place many real calls | — | **Twilio inbound per minute, uncapped** (no per-household concurrency or `<Dial timeLimit>` on main; Twilio default 4 h per call) | YES | Financial-safety branch (unmerged; its refusal rules need revising) | **Not fixed here** (signature can't stop genuine calls). See §7. | — |
| 8 | **P0 (containment)** | Master Twilio auth token in the backend env | Backend/env compromise | Full Twilio account | Unbounded (catastrophic review X5) | YES | — | Not in scope here; credential isolation plan in `CATASTROPHIC_RISK_REVIEW.md` | — |
| 9 | P1 | Public auth endpoints (`/register`, `/api/v1/register(+/resend)`, `/resend-confirmation`, `/forgot-password`, `/reset-password-*`, `/confirm-session`, `/verify-confirmation-token`) | Internet | Email sends, auth-quota abuse, enumeration attempts | Email cost; reputation | YES | — | Not in scope: global per-IP limiter recommended next | — |
| 10 | P2 | `/api/v1/waiting-list`, `/debug/purchase-beacon` | Internet | Unbounded DB rows / log lines | Small | YES | — | Rate limit (next) | — |

## 2. `/media-stream`: is it P0? Confirmed.

**Before the fix: yes.** An arbitrary client can open the WebSocket and reach paid transcription without proving the stream belongs to an HCG call.
- Main has only a shadow signature check that logs and never rejects; 7942e6e has none at all.
- The handler trusted `customParameters` for household, SMS destination and sender.
- **Reproduced locally:** the black-box test's forged stream produced one transcription request at the local OpenAI stand-in (`voice-surface-prefix-test-run.txt`: "a forged stream causes no transcription request (saw 1)").

**After the fix:** a forged stream is closed at `start` with zero transcription. A valid token is refused for a different CallSid and on replay. The control check (a genuine stream *does* reach transcription) proves the test can fail.

**Why a token rather than enforcing the WebSocket signature now:** which URL form Twilio signs the WebSocket handshake against is unverified (`twilioWebhookAuth.js describeMediaStreamSignatureCheck`). Enforcing it blindly risks a full monitoring outage. The shadow check stays in place. **Enforce it later** once production logs show a variant matching every genuine stream (defence in depth).

## 3. `/voice`: what an unsigned request could obtain or cause (no personal data reproduced)

Before the fix, an unsigned POST with `To` = an HCG number:
- (a) **received the household's internal id and the customer's personal mobile number** in the TwiML stream parameters, plus the HCG number;
- (b) learned **whether the `From` number is in that customer's trusted contacts** (the response differs);
- (c) caused a **fake call row** in the customer's Activity;
- (d) could trigger **rapid-abuse alert emails**;
- (e) caused a **full `households` table read**.

It could not stamp activation (already signature-gated) and caused no Twilio charges.

After the fix: **403, empty body, zero database access, no alert, no call flow, identical response regardless of `From`** (tests 1–3).

## 4. `/process` (e2895f1)

e2895f1 is **complete for `/process`**: it checks before the lookup, AI and write, and logs nothing from the request.
- It uses the APP_URL-only signature URL, which **would also refuse genuine requests arriving on other configured hosts**. That's harmless for an unreachable route, but would be wrong for `/voice`.
- **Decision:** incorporate it through the shared `twilioSignatureGuard` (same semantics plus host allowlist and throttling). **Don't cherry-pick it separately.** After this branch merges, close the `fix/process-endpoint-webhook-auth` PR/branch as superseded.

## 5. Every externally reachable webhook / WebSocket / public route

| Route | Class | Status after this branch |
|---|---|---|
| `POST /voice` | **A** | Twilio signature enforced |
| `POST /process` | **A** | Enforced |
| `POST /red-line-terminate` | **A** | Enforced |
| `POST /call-delivery-failed` | **A** | Enforced |
| `POST /call-status` | **A** | Enforced |
| `WS /media-stream` | **B** | Bound to a signed `/voice` by a single-use CallSid token. Handshake signature: shadow (enforce later). |
| `POST /billing/webhook` (Stripe) | **A** | Already verified (`constructEvent`) |
| `POST /api/v1/billing/apple/revenuecat-webhook` | **A** | Shared Authorization header (no signature/timestamp). Recommend event-id idempotency check (P2). |
| `GET /health`, `GET /api/v1/launch-flags`, `GET /`, `/privacy`, `/support`, `/go`, static | **C** | Read-only, no customer data |
| `POST /register`, `/api/v1/register`, `/api/v1/register/resend`, `/resend-confirmation`, `/forgot-password`, `/reset-password-*`, `/confirm-session`, `/verify-confirmation-token`, `/login` | Public by design; **not C**: send email / touch auth | **P1: needs a per-IP and per-account rate limit** (not in this branch) |
| `POST /api/v1/waiting-list`, `POST /debug/purchase-beacon` | Public by design; DB/log writes | P2: rate limit / remove beacon |
| All other `/api/v1/*`, `/admin/*`, `/billing/*`, dashboard routes | Authenticated (Supabase JWT; admin = role) | Out of scope (admin MFA is a separate P1) |

No other Twilio-facing route exists on main; every Twilio-facing route is covered.

## 6. Consolidated remediation (implemented)

| Control | Where | Notes |
|---|---|---|
| Strict Twilio signature rejection | `services/twilioWebhookGuard.js` on all 5 Twilio routes | 403 before body use. Hosts = APP_URL + `TWILIO_WEBHOOK_ALLOWED_HOSTS`. Never the Host header. Fails closed without `TWILIO_AUTH_TOKEN` (production already refuses to boot without it). |
| WebSocket binding / server-generated identity | `services/liveMonitoring/streamAuth.js` + handler | Token issued only inside a signed request. Household, destination and sender only from the server record. `toNumber` removed from TwiML. |
| Binding to the legitimate CallSid; replay protection | streamAuth | CallSid must match; single use; 5-minute expiry |
| Rate limiting (not authentication) | Guard: failed-signature throttling (429) only *after* verification, so it can't throttle genuine traffic | Plus socket ceiling and no-`start` timeout |
| Concurrency limits | 200 global streams (main); **2 per household** (new); socket ceiling 400 | |
| Hard cost ceilings | `services/liveMonitoring/costCaps.js` | Transcription: 2,700/household/day, 6,000/hour global. SMS: 3/household/day, 30/hour global. 30 min/call monitoring (existing). |
| Destination validation | costCaps | SMS only to UK mobiles (`+447…`), never to the sender |
| Loop prevention | `/voice` rejects `client:` callers | PSTN loop prevention already structural (no PSTN dial) |
| Paid AI/SMS only after authentication | Token gate precedes monitor creation; caps precede every transcription and SMS | |
| Safe behaviour if verification infrastructure fails | No `TWILIO_AUTH_TOKEN` → refuse (and production won't boot). No authoriser → all streams refused. Token store miss (restart, other instance) → call connects **unmonitored**. | Never "monitor anyway" |

## 7. Maximum financial exposure (independent of authentication)

Rates: inbound £0.007558/started min (invoice), Media Streams £0.003329/min (invoice), transcription ≈ £0.00474/min ($0.006 list), SMS £0.042325/segment (warning 1–2 segments), greeting £0.0006.

| Scope | Before (main / 7942e6e) | After this branch | Still uncapped? |
|---|---|---|---|
| **Forged traffic (no Twilio secret)** | Transcription + SMS per forged stream, unbounded (200-stream cap on main; **none in 7942e6e**); paid AI per `/process` POST | **£0**: 403 / closed before any paid step | No |
| **One genuine call** | Inbound up to Twilio's 4 h default (£1.81) + monitoring 30 min (£0.24) + greeting + 1 warning SMS | Same | Inbound per call bounded only by Twilio's default |
| **One household / day** | Unbounded concurrent calls and streams | Monitoring: 2 concurrent streams; ≤ 2,700 transcriptions (~£0.85/day); ≤ 3 SMS (~£0.25). **Inbound transport still uncapped.** | **P0: inbound minutes** |
| **One attacker/IP** | Unbounded forged streams and posts | Forged: £0. With real calls: as per household × households they call | Inbound (P0) |
| **All concurrent calls** | 200 streams (main) / unlimited (7942e6e) | 200 streams (env `MEDIA_STREAM_MAX_CONCURRENT_STREAMS`; recommend **30** at current scale) | — |
| **One hour (global)** | Transcription and SMS unbounded | Transcription ≤ ~£1.90; SMS ≤ ~£2.54; streams ≤ 200 × 60 × £0.003329 = £40 (≤ £6 at 30 streams) | Inbound (P0) |
| **One day (global)** | Unbounded | Transcription ≤ ~£46; SMS ≤ ~£61; streams ≤ £959 (≤ £144 at 30) | Inbound (P0) |

**Still effectively uncapped (P0, outside this fix):** Twilio inbound minutes from genuine calls (flood or long calls), and anything reachable with the master Twilio auth token. All caps above are HCG-controlled (in-process). **Provider-side backstops still needed (manual, §11):**
- OpenAI prepaid credit with auto-recharge OFF;
- Twilio SMS geo-permissions UK-only;
- Twilio prepaid balance policy;
- carrier-level channel caps (architecture work).

## 8. Migrations 060 and 061

- **This remediation involves no migration.** 060/061 stay separate.
- The two migrations are `060_revoke_unused_authenticated_grants_and_pin_trigger_search_path`, `061_global_default_revoke_function_execute_from_public` (branch `security/supabase-staging-remediation`, staging-verified, runbook `docs/engineering/SUPABASE_PRODUCTION_RUNBOOK_057-061.md`).
- **Numbering clash to resolve before production:** `readiness/android-call-delivery` / `readiness/ios-parity` also contain `060_call_delivery_events.sql` and `061_household_iphone_carrier.sql`. The financial-safety branch uses 056.
- **Prepare:** one set must be renumbered above the highest applied before either reaches production (the adopted rule). Not deployed.

## 9. Tests run and results

| Run | Files | Passed | Failed |
|---|---|---|---|
| Baseline `origin/main` (clean worktree) | 105 | 3,793 | 9 (Android manifest/notification tests need `mobile/node_modules`) |
| This branch | 107 | 3,840 | **same 9** |

- `tests/voice-surface-security.test.mjs` (black-box, real `server.js`): **21 failing checks pre-fix** (`docs/security/voice-surface-prefix-test-run.txt`), **all passing after**.
- `tests/media-stream-auth-and-cost-caps.test.mjs`: 19/19.
- Existing source-inspection tests were updated for the new route shape (`twilioSignatureGuard` middleware, `attachLiveMonitoring` signature, explicit `trustingTestAuthorizer` in handler tests), with **invariants unchanged**.

## 10. Staging verification: performed 2026-10-01 (see VOICE_SURFACE_P0_HANDOVER_2026-10-01.md); real-handset test pending

Required before production:
1. Deploy the branch to the staging service.
2. Set `TWILIO_WEBHOOK_ALLOWED_HOSTS` to every host the staging number(s) use.
3. Place a real call from a non-trusted phone to the staging test number. It must ring the app, and logs must show `media_stream_started`.
4. A trusted-contact call is delivered with no stream.
5. `curl -X POST https://<staging>/voice -d To=<staging number>` → 403, empty body, no Activity row.
6. Open a WebSocket to `wss://<staging>/media-stream` with a forged start → closed; log `media_stream_unauthorised_start`.
7. Logs show no `TWILIO WEBHOOK REFUSED` for the genuine calls.

## 11. Production plan (for approval)

### Exact files changed

| File | Change |
|---|---|
| `server.js` | Guard on 5 routes; `client:` reject; token-only stream parameters; authoriser wiring; unused import removed |
| `services/twilioWebhookGuard.js` | New |
| `services/liveMonitoring/streamAuth.js` | New |
| `services/liveMonitoring/costCaps.js` | New |
| `services/liveMonitoring/mediaStreamHandler.js` | Token gate, server-side identity, caps |
| `services/liveMonitoring/mediaStreamServer.js` | Socket ceiling, start timeout |
| `package.json` | 2 new tests in the chain |
| `tests/*` | 2 new; 10 updated |

### Migrations
None.

### Expected production behaviour change
- Unsigned or forged Twilio requests get 403 / 429.
- Forged streams are closed.
- The customer's mobile number is no longer in TwiML.
- `client:` callers are rejected.
- Monitoring is limited to 2 streams per household.
- Transcription and SMS ceilings apply.
- Warning SMS go to UK mobiles only.
- Deploying main also ships PR #42/#43/#44 (stream cap, crash hardening, log redaction) if production predates them.

### Risk to genuine calls

| Risk | Severity | Mitigation |
|---|---|---|
| **Signature URL mismatch** (a number's Voice URL uses a host or scheme not in the allowlist). Every genuine call to that number gets 403 and Twilio plays an application error: **calls fail**. | **HIGH** | Before deploying, list every number's Voice URL and the TwiML App URL in the Twilio console, and set `TWILIO_WEBHOOK_ALLOWED_HOSTS` to cover them (earlier inventory: 8 www, 1 apex, 1 old Railway domain), or repoint them to one host. Check production logs: `ACTIVATION VERIFIED AUTO-STAMP SKIPPED: Twilio signature did not validate` must **not** appear for real calls (evidence the HMAC already validates on APP_URL). |
| More than one Railway replica | MEDIUM | Streams on another instance fail closed → calls connect **unmonitored** (no outage). Confirm replicas = 1. |
| A household with > 2 simultaneous unknown calls | LOW | The third is unmonitored, still connected |
| A heavily targeted household exceeds ~3 h of transcription in a day | LOW | Monitoring degrades for the rest of the day (alerted) |
| Households whose number isn't a UK mobile | LOW | Receive no warning SMS (they couldn't before either) |

### Rollback
No database change, so rollback is code-only:
1. **Railway: redeploy the previous deployment** (one click, ~1–2 min).
2. Emergency alternative if only webhook signatures are the problem: set `TWILIO_WEBHOOK_AUTH_MODE=report`. Unsigned webhooks are then allowed, with a boot alert. **This reopens findings 2–5; use only while redeploying.** Stream tokens remain enforced in this mode.
3. `git revert a71659e` for a permanent rollback.

### Post-deployment smoke and security tests (in order, immediately)
1. Real call from a non-trusted phone to a test household: rings the app; logs show `media_stream_started`; Activity row correct.
2. Trusted-contact call: delivered, no stream.
3. Unsigned `curl -X POST https://www.homecallguard.co.uk/voice -d To=<a test HCG number>` → 403, empty body.
4. Same for `/process`, `/call-delivery-failed` → 403.
5. Forged WebSocket start (e.g. `wscat`) → closed; log `media_stream_unauthorised_start`.
6. Twilio Console → Monitor → Errors: no new 11200/HTTP 403 for genuine calls over the next hour.
7. Logs: `TWILIO WEBHOOK REFUSED` count is consistent with no genuine calls refused.

### Manual Twilio / Railway configuration needed (Andrew)
1. Inventory every phone number's **Voice URL** (host and scheme) and the **TwiML App Voice URL**. Set `TWILIO_WEBHOOK_ALLOWED_HOSTS` (Railway env) accordingly, or repoint them all to the canonical host.
2. **TwiML App Voice URL** (finding 6) must not point at `/voice` or any route that dials.
3. **Messaging geo-permissions: UK only.**
4. **Voice dialing geo-permissions:** disable international and high-risk ranges (HCG places no outbound PSTN calls).
5. Recommended: `MEDIA_STREAM_MAX_CONCURRENT_STREAMS=30` (Railway env).
6. Confirm the Railway replica count is 1.
7. **OpenAI:** prepaid credit with auto-recharge off.

## 12. Not in this change (next)
- **P0 financial:** inbound-minute containment (carrier channel caps / safe architecture). No call refusal while forwarding is active.
- **P0 containment:** Twilio credential isolation.
- **P1:** rate limits on public auth endpoints; admin MFA.
- **Later:** enforce the `/media-stream` handshake signature once logs identify the variant.
