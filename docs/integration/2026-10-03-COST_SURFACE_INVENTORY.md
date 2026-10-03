# Cost-surface inventory — integrated candidate (2026-10-03)

One row per known variable-cost surface on `integration/launch-fortress-2026-10-03`.
States: **ENFORCED** (a control refuses/ends spend in code, with an automated test of the
enforcement) · **PARTIAL** (bounded, but with a known gap) · **OBSERVED ONLY** · **NOT IMPLEMENTED**
· **PROVIDER DEPENDENT** · **NOT APPLICABLE**.

"ENFORCED" here means **code-complete and test-proven locally**. None of it is staging- or
production-proven: migrations 056/066/067/068/070 are applied nowhere and the code is deployed
nowhere. All money figures are **estimates** — no provider billing feed is connected
(`fc_record_actual` exists and is tested, but nothing calls it).

| Surface | State | Control | Bound / exposure | Evidence |
|---|---|---|---|---|
| Inbound PSTN leg (household) | ENFORCED | Fortress reservation before `<Dial>`; leases; `<Dial timeLimit>`; household £ budget + trusted-only reserve | ≤ household budget + reserve per period (placeholders £0.50 + £0.25) + ≤ 1 lease overrun | ledger/e2e/realpg/integration S1/S3 |
| Inbound PSTN leg (no household / quarantined number) | ENFORCED | `<Reject>` before any billable verb (unbilled) | £0 | attacks, integration |
| App (`<Dial><Client>`) leg | ENFORCED | same reservation (connected rate covers inbound + app leg) | as above | ledger |
| Media Streams | ENFORCED | stream token (signed /voice only) + monitoring reservation + per-household/global stream caps | within reservation | voice-surface-security, media-stream tests |
| Transcription (Whisper) | PARTIAL | only after reservation attach; per-household request caps; stops at 30 min / safety stop | bounded in minutes; **no per-request £ cost source** | callpath, transcription-efficiency |
| AI classifier (`/process`) | ENFORCED | signed + `authorizeSpend('ai')` | per-request estimate | wiring |
| Warning SMS / other SMS | ENFORCED | incident gate + UK-mobile-only + per-household caps + 056 ceiling + `authorizeSpend('sms')` (fail-closed) | per-message estimate | callpath, ledger, attacks |
| Number purchase | ENFORCED | abuse single-flight/velocity/risk + env guard + Fortress 10/day + adopt-before-buy | ≤ 10 purchases/day globally | provisioning tests, realpg S31 |
| Number rental (recurring) | PARTIAL | 047 entitlement guard + quarantine lifecycle; orphan kept (tagged) only when DB unreadable | ~£0.87/month per orphan; adopt-on-retry; **no scheduled orphan reconciliation** | provisioning-orphan |
| Polly TTS greeting/apology | PARTIAL | inside the call's fixed fee; post-Dial apology after settlement | ≤ 1 started minute per failed delivery | pipeline review |
| Recording | NOT APPLICABLE in production | voicemail prototype forced off in production (`resolveFallbackMode`); route now signature-guarded | ≤ 60 s per call in non-prod only | call-delivery-fallback |
| Storage with variable exposure | NOT APPLICABLE | no recordings stored | — | — |
| Email (alerts) | PARTIAL | per-type throttling, per-process | small | — |
| Email (Supabase Auth: sign-up, reset, resend) | PARTIAL | per-mailbox + global rate limits (process-local) | provider SMTP cost unknown | auth-rate-limit |
| Allowance warning email | PARTIAL | off by default; one per point per period | small | allowance tests |
| Carrier API actions (status reads, hang-ups) | PARTIAL | free reads; sweeper bounded per lease | ~£0 | e2e |
| Retry paths (webhook retries) | ENFORCED | replay cache + idempotent reservation per CallSid | £0 extra | integration S11/S12, realpg |
| Callbacks (duplicate/forged settle) | ENFORCED | verified + non-duplicate only; sweeper repairs | £0 | integration S16, wiring |
| Duplicated streams | ENFORCED | single-use stream token; reservation per CallSid | £0 extra | ledger |
| Abandoned calls / lost callbacks | ENFORCED | sweeper settles from provider status within one lease | ≤ 1 lease | e2e |
| Forwarding loops | ENFORCED | lineage checks + per-caller limits + concurrency + budget | ≤ budget | attacks, integration S10 |
| Floods (many callers) | PARTIAL | concurrency + household budget; delivered until budget spent (no victim lockout of trusted callers) | ≤ household budget + reserve; **victim's unknown callers refused for rest of period** | integration S3/S4 |
| Global business-wide | ENFORCED (code) | kill switch, latched hourly/daily breaker, exposure/active caps | caps are policy floors (D9 placeholders) | realpg storm, FC-7/FC-8 |
| DB outage | PARTIAL (D3) | degraded envelope per instance, then refuse | ≈ £2.61 per instance per outage (Fortress estimate) | FC-6 FAIL in bounded mode |
| Top-ups | ENFORCED | 068: £ credited = what Fortress enforces; margin cap at credit time; idempotent | top-up £ ≤ afterFees×(1−margin)÷(1+reserve) | bridge pglite, realpg S41 |
| Admin goodwill adjustments | ENFORCED | audited, ±£50, idempotent, £ moves with minutes | per adjustment | bridge |
| Sandbox/test purchases | ENFORCED | no number provisioned; sandbox entitlement unfunded profile; never supersedes in-effect entitlements | ≤ £0.10 reserve if a number already exists | entitlement-canonical |
| Support/admin actions capable of spend | PARTIAL | admin retry-provisioning (abuse override clears account-risk only); no HTTP route changes Fortress state | via purchase caps | — |
| HCG unreachable while calls arrive | PROVIDER DEPENDENT | Twilio fallback URL behaviour unverified | **unknown** | none |
| Master Twilio credential abuse | PROVIDER DEPENDENT | none in HCG code (scoped key, geo permissions, usage triggers, auto-recharge are Console settings) | **unbounded by HCG** | none |
| Client-originated calls (SDK outgoing grant) | PARTIAL | `/voice` rejects client-origin; TwiML App Voice URL unverified in Console | depends on Console | voice tests |
| OpenAI account | PROVIDER DEPENDENT | no OpenAI project budget evidence | per-request estimates only | none |
| Future carrier adapters (AQL/Magrathea/Telnyx/FMC) | NOT IMPLEMENTED | registry refuses non-Twilio providers | n/a | customer-identity tests |
