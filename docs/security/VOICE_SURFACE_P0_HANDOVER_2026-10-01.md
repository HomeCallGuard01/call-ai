# Voice surface P0: production-readiness and security handover (2026-10-01)

**Status: NOT deployed to production. NOT merged. Staging-verified with real Twilio traffic except the handset-dependent path.**
Production remains subject to Andrew's explicit approval.

## 1. Where the work is

| Item | Value |
|---|---|
| Repo | HomeCallGuard01/call-ai |
| Worktree | `/Users/ad/call-ai-voice-security` |
| Branch | `security/voice-surface-p0` (pushed to origin) |
| Code commit staged-tested | `29d5825` (fix `a71659e`, tests `a6ee5cd`) |
| Base | `origin/main` `eb43368` (production code line) |
| This handover commit | see `git log -1` on the branch |
| Remediation design | `docs/security/VOICE_SURFACE_P0_REMEDIATION.md` |
| Evidence | `docs/security/evidence/2026-10-01-staging/` |
| Remote verifier | `scripts/verify-voice-surface.mjs` |
| Handset test plan | `docs/security/STAGING_HANDSET_TEST_PLAN_MOTOROLA.md` |

"Staging" in this report = `server.js` at `29d5825` running locally with the staging env (Supabase `tigwgmayeuisrxjjykqd`), exposed via the ngrok reserved domain `ferret-augmented-distrust.ngrok-free.dev`, with the real Twilio number +44 20 4652 1883 pointed at it. Twilio account is shared with production.

## 2. Findings fixed

| Finding | Fix |
|---|---|
| Unsigned/forged Twilio webhooks (`/voice`, `/process`, `/call-delivery-failed`, `/call-status`, `/red-line-terminate`) | `services/twilioWebhookGuard.js`: HMAC validated against APP_URL host + `TWILIO_WEBHOOK_ALLOWED_HOSTS`; 403, 429 after 20 failures/min/key; body never logged |
| Forged `/media-stream` → SMS to arbitrary numbers + paid AI | `services/liveMonitoring/streamAuth.js`: 256-bit single-use token, CallSid-bound, 5-min TTL, issued only by signed `/voice`; household/destination/sender taken from the server-side record; no authoriser = refuse all |
| Customer mobile number in TwiML stream parameters | Only `streamToken` is sent |
| `client:`-originated `/voice` | Rejected before any work |
| Unbounded monitoring cost | `services/liveMonitoring/costCaps.js` + socket ceiling 400 + 10 s no-start timeout |

## 3. PROVEN WITH REAL TWILIO TRAFFIC

Two real PSTN calls from Andrew's …2700 phone to +44 20 4652 1883 (evidence: `evidence-export.json`, `staging-server-real-calls.log`).

| Claim | Evidence |
|---|---|
| **Legitimate `/voice` signature validation** | Both calls: Twilio events `/voice` → HTTP 200 (a failed signature returns 403). No `TWILIO WEBHOOK REFUSED` in the log |
| **Unknown-call monitoring path** | Call 1 `CA3e3fe55e…` 18:09:50Z: calls row `status: Unknown`, `risk_score 0` |
| **Authenticated media-stream establishment** | `media_stream_started` 18:09:55.132Z for `CA3e3fe55e…` with household `ffc4cfe1…` taken from the token record. Twilio's handshake signature matched the `wss` URL variant |
| **Real transcription** | `transcript_chunk` chunk 1: 27 chars / 4 words, `riskScore 0` (text not logged) |
| **Trusted-contact classification** | Call 2 `CAefb431ad…` 18:36:19Z: log `Known contact → bypass AI`; calls row `status: Known` |
| **Trusted bypass of media streaming/OpenAI** | Call 2: no `media_stream_*`, no `transcript_chunk`; 0 SMS on the Twilio account since 00:00Z |
| **Signed callbacks** | Both calls: `/call-delivery-failed` → HTTP 200, `dial_call_status: no-answer` recorded |

Both calls ended "can't be connected" solely because the synthetic household had no registered device (child legs `client:household_ffc4cfe1…` no-answer, 0 s). Andrew reported that Call 2 played no protected/monitored announcement, which is correct for a trusted caller. For Call 1, the announcement was not separately confirmed by ear.

## 4. PROVEN BY STAGING / AUTOMATED TESTS

**Remote verifier against staging** (`remote-verifier-staging-run.txt`): **31/31 passed**.
- Unsigned `/voice`, `/process`, `/call-delivery-failed`, `/call-status`, `/red-line-terminate` → 403, empty body. The `/voice` response is identical for trusted and unknown callers, and no DB row is created.
- Invalid signature → 403; a signature for a non-allowlisted host → 403.
- Forged `/media-stream` start (no token) → closed, never started.
- Signed synthetic `/voice` → Dial/Client plus a token-only stream. The TwiML carries no mobile number or household id.
- Signed `client:` → Reject.
- Forged `/call-delivery-failed` leaves the call row unchanged.
- Signed `/red-line-terminate` → termination TwiML.
- Token rules: wrong CallSid refused, replay refused, invalid token refused. Server-side household identity is used and attacker `customParameters` are ignored.
- Third simultaneous stream for one household refused (cap 2). Socket with no `start` closed at ~10 s.
- No phone numbers and no exceptions in the staging log.

**Caps on the running staging service** (`staging-server-caps.log`, restarted with tight env limits for the test):
- global concurrency cap 2: `media_stream_concurrent_limit_reached`;
- global transcription cap: `media_stream_cost_cap_reached rule=global_transcription_limit`, with subsequent chunks empty (no paid call).

**Automated suite (local, no real SMS/calls/AI):**

| Run | Files | Passed | Failed |
|---|---|---|---|
| Baseline `origin/main` | 105 | 3,793 | 9 (Android tests needing `mobile/node_modules`) |
| This branch | 107 | 3,840 | the same 9 |

- `tests/voice-surface-security.test.mjs`: 28 checks; 21 failed on pre-fix code (`voice-surface-prefix-test-run.txt`); all pass after the fix.
- `tests/media-stream-auth-and-cost-caps.test.mjs`: 19/19. Covers fail-closed with no authoriser, forged parameters ignored, token rules, per-household concurrency, transcription/SMS caps (per household and global), UK-mobile-only SMS, and the handler stopping transcription at the cap.

## 5. STILL REQUIRES REAL-HANDSET TEST

Planned for 2026-10-02 on the Motorola 0303 under Andrew's supervision (`STAGING_HANDSET_TEST_PLAN_MOTOROLA.md`):
1. Actual staging Android delivery and answer.
2. Live conversation while monitoring (stream + Dial coexisting with the device connected).
3. Warning threshold behaviour (≥ 60).
4. Red-line detection.
5. Intentional call termination (`/red-line-terminate` via REST redirect on a real call).
6. Restoration and verification of the Motorola after staging use.

Also not yet heard on a real call: the protected/monitored announcement on an unknown call.

## 6. Tonight's restoration and cleanup (2026-10-01 ~18:54–19:00Z)

| Action | Result |
|---|---|
| …1883 Twilio config | Restored to the recorded pre-test state: Voice URL empty, POST, no fallback, no status callback (verified by fetch) |
| Temporary trusted contact (…2700, `1a6c7024…`) | Deleted |
| Synthetic trusted contact (…0555, `4335b60d…`) | Deleted |
| 9 synthetic calls rows from the remote verifier | Deleted, after a full export to `evidence-export.json` |
| Staging server (PID 42252, port 3099) and ngrok (PID 41916) | Stopped; port 3099 free; tunnel offline |
| Motorola 0303 | Not touched |
| EAS | Nothing built or installed |

## 7. Retained in staging (deliberately)

| Record | Why |
|---|---|
| Household `ffc4cfe1-6d93-46d8-8e88-3b93eadabf87` (`voice-p0-staging-test@example.invalid`, `twilio_number` …1883, `phone_number` …0456 reserved test range, `auth_user_id` null) | Needed for tomorrow's handset test. It owns the two real-call evidence rows |
| Entitlement `935e230e-…` (complimentary, active) | Needed for tomorrow. Harmless while …1883 has no Voice URL |
| Calls rows `CA3e3fe55e…` (Unknown) and `CAefb431ad…` (Known) | Real-call evidence |

After the handset test, delete the household, entitlement and calls rows in one step, once the evidence has been exported again.

## 8. Production was not modified

- All production DB access in this workstream was SELECT-only.
- Twilio (read-only, 2026-10-01 ~18:55Z): 9 production numbers (8 on `www.homecallguard.co.uk/voice`, …4288 on the apex `homecallguard.co.uk/voice`), all last updated on or before 2026-09-28. The only number updated today is …1883 (staging). TwiML App unchanged since 2026-08-15 (`/voice-sdk-outbound-not-supported`).
- `origin/main` is still `eb43368` (2026-09-27). The security branch is not contained in main.
- `www.homecallguard.co.uk/health` → ok.
- Not checked: Railway deployment history (CLI not installed here). Nothing in this session deployed.

## 9. Remaining risks and uncapped exposure

**Provider-enforced or manual** (none of these exist yet unless configured in the console):
- OpenAI prepaid credit with auto-recharge OFF.
- Twilio SMS geo-permissions UK-only (pending in the Console per the zero-idle-spend audit). Outbound voice geo is already all off.
- Twilio balance/auto-recharge policy.

**App-enforced (HCG, in-process):**
- caps on streams, transcriptions, SMS and sockets.
- These are defence in depth, per instance, and reset on restart. **They are not a guaranteed financial cap** across multiple instances or restarts.

**Still uncapped (P0, outside this change):**
- Twilio inbound minutes from genuine or flood calls (per call bounded only by Twilio's 4 h default, ~£1.81).
- Anything reachable with the master Twilio auth token in the backend.
- Fixing this needs the inbound-containment architecture, which must not refuse calls while forwarding points at HCG.

**Financial review per service:**

| Service | Per call | Per household/day | Global/hour | Global/day | Enforced by |
|---|---|---|---|---|---|
| Twilio Voice inbound | ≤ ~£1.81 (4 h default) | **uncapped** | **uncapped** | **uncapped** | Twilio default only |
| Media Streams | 30-min monitoring limit (~£0.10) | 2 concurrent streams | ≤ £40 at 200 streams (≤ £6 at 30) | ≤ £959 (≤ £144 at 30) | HCG |
| OpenAI transcription | ~£0.14 (30 min) | ≤ 2,700 req (~£0.85) | ≤ 6,000 req (~£1.90) | ≤ ~£46 | HCG; plus OpenAI prepaid (manual) |
| SMS warnings | 1–2 segments (£0.04–0.08) | ≤ 3 (~£0.25) | ≤ 30 (~£2.54) | ≤ ~£61 | HCG (UK mobile only); plus geo UK-only (manual) |

Forged traffic without the Twilio secret costs **£0** after the fix.

**Operational risks:**
- **HIGH:** a number's Voice URL host not in the allowlist → every call to it gets 403 and fails. Production needs `TWILIO_WEBHOOK_ALLOWED_HOSTS` to include `homecallguard.co.uk` (apex, used by …4288) as well as `www.homecallguard.co.uk`.
- **MEDIUM:** more than one Railway replica → streams can land on the instance without the token → calls connect unmonitored (no outage). Confirm replicas = 1.
- **LOW:** a third simultaneous unknown call per household goes unmonitored; heavy daily use degrades monitoring for the rest of the day.

## 10. Environment/config for production

| Setting | Value |
|---|---|
| `TWILIO_WEBHOOK_ALLOWED_HOSTS` | `www.homecallguard.co.uk,homecallguard.co.uk` (verify against the live inventory on the day) |
| `TWILIO_WEBHOOK_AUTH_MODE` | unset (enforce). `report` only as an emergency during rollback |
| `MEDIA_STREAM_MAX_CONCURRENT_STREAMS` | 30 (recommended) |
| Other `MEDIA_STREAM_MAX_*` | defaults |
| Railway replicas | 1 |
| Console | Twilio SMS geo UK-only; OpenAI prepaid with auto-recharge off |

No migrations.

## 11. Deployment steps (when approved)

1. Complete the real-handset test (§5).
2. Re-inventory production Voice URLs and set the env (§10).
3. Merge `security/voice-surface-p0` to main via PR (Andrew's approval).
4. Railway deploys main. Note that main already contains PR #42/#43/#44.
5. Post-deploy verification, immediately:
   - `MODE=production TARGET_URL=https://www.homecallguard.co.uk TEST_NUMBER=<test HCG number> node scripts/verify-voice-surface.mjs` (sends unsigned/forged traffic only; costs nothing);
   - repeat with `TARGET_URL=https://homecallguard.co.uk`;
   - one real unknown call and one trusted call to a test household;
   - Twilio Monitor → Errors: no new 11200/403 for an hour;
   - check the `TWILIO WEBHOOK REFUSED` count.

## 12. Rollback

Code-only, since there's no DB change:
- Railway: redeploy the previous deployment (~1–2 min).
- Emergency only: `TWILIO_WEBHOOK_AUTH_MODE=report`. This reopens unsigned webhooks, while stream tokens stay enforced.
- Permanent: `git revert a71659e`.

## 13. Migrations 060/061 conflict (not part of this deployment)

- This branch has no migrations.
- Supabase security branch: 060 revoke grants, 061 global default revoke; both applied on staging.
- Readiness branches: 060 `call_delivery_events`, 061 `household_iphone_carrier` (plus one duplicate 055).
- Recommendation: keep security 057–061, renumber the readiness migrations above the highest applied, and repair the staging migration history.
- Note: on 2026-10-01 staging PostgREST reported `call_delivery_events` absent from its schema cache. Re-check before relying on staging history.
- Nothing has been renamed or applied.

## 14. Recommendation

- **Do not deploy yet.**
- The security controls are proven against real Twilio traffic and the automated/staging suite.
- The answered-call monitoring path (warning, red line, termination) has not yet been exercised with a real device. These are the core customer-facing behaviours that the stream-token change sits in front of.
- Run the Motorola test (§5).
- If it passes, deploy with the §10 config and the §11 verification, in a quiet window with Andrew available to roll back.

## 15. Follow-ups found during staging

- The `/media-stream` handshake signature matched the `wss` URL variant on a real call. Enforcing the handshake signature (currently shadow-only) can now be designed as a second layer.
- Staging and production share one Twilio account (containment P0, separate work).
