# One authoritative inbound-call safety pipeline (integrated, 2026-10-03)

This is the order the integrated `POST /voice` actually runs (server.js +
services/abuse/inboundCallGuard.js + services/usage/callAdmission.js +
services/containment/containment.js). **Security and financial controls run
before the trusted-contact decision takes effect. Trust only decides whether
monitoring is skipped and whether the trusted-only delivery reserve may fund
the call — it bypasses nothing else.** Verified end to end by
`tests/launch-fortress-integration.test.mjs` (real server.js × real SQL).

| # | Step | Where | On failure |
|---|---|---|---|
| 1 | Provider authenticity: Twilio signature (enforce mode; allowlisted alternate hosts) | `twilioSignatureGuard` (services/twilioWebhookGuard.js) | 403, nothing recorded or reserved |
| 2 | Request integrity: AccountSid match, parameter pollution, size bounds, CallSid format; replay/duplicate within 30 min → identical cached TwiML | `twilioWebhookIntegrity` (services/abuse/webhookIntegrity.js) | 400/403/413; duplicate gets the same response, no second token/count/reservation |
| 3 | Client-origin (Voice SDK outgoing) | `isVoiceSdkClientOriginated` (From **or** Caller) + abuse step 1 | `<Reject>` (unbilled) |
| 4 | Household resolution (dialled number belongs to HCG) | `getHouseholdByTwilioNumber` (indexed; ambiguous ⇒ none) | abuse step 3 `<Reject>` |
| 5 | Global incident state (env, auto-trip, **Fortress kill switch/breaker → full_stop**, unreadable > 60 s → contain) | abuse step 2 (services/abuse/incidentMode.js) | full_stop ⇒ `<Reject>`; suspend_paid ⇒ no new monitoring |
| 6 | Account hold | abuse step 4 | `<Reject>` |
| 7 | Loop / lineage (From==To, HCG caller, ForwardedFrom HCG, ParentCallSid) | abuse step 5 | `<Reject>` |
| 8 | Caller velocity (pair burst + cooldown, fan-out) — per caller only | abuse step 6 | `<Reject>` for that caller only |
| 9 | Household volume — **flag only** (never refuses: no victim lockout) | abuse step 7 | trusted *bypass* suspended; monitored |
| 10 | Concurrency (household 3, caller 2; claim is atomic in-process; provider-verified before refusing) | abuse step 8 | `<Reject>` (engaged-line). Provider unreachable ⇒ admitted (fail-open) — **056 DB limit below is the backstop** |
| 11 | Destination/number class for trust: withheld/malformed/premium/070/076/087/09/STIR-fail ⇒ never trusted | abuse step 10 (identity defects) | monitored, never bypassed |
| 12 | DB-serialised admission (056): kill switch, loop, household concurrency 3, per-caller flood 9/5 min (cross-instance backstop), £ ceilings; household burst opt-in (off) | `callAdmission.admit` | `<Reject>` (busy) |
| 13 | **Financial Fortress global + household authorisation / reservation** — kill switch, latched breaker, rolling hour/day spend, exposure/active caps, household budget (+ trusted-only reserve, essential pool); reserve-before-spend, atomic | `containment.authorizeCall` → `fc_authorize_call` | `<Reject>` (busy). DB unreachable ⇒ **D3 bounded degraded envelope** (≤2 concurrent, ≤20/h, ≤10 min, unmonitored, per instance; reject after 15 min) |
| 14 | Trusted-contact decision takes effect: `trusted` ⇒ skip monitoring; `deliveryTrusted` ⇒ eligible for the trusted-only reserve | server.js (`isKnown` / `deliveryTrusted`) | — |
| 15 | Monitoring decision: Fortress reservation covers monitoring **and** 056 allowance/ceilings **and** abuse decision **and** not a duplicate | server.js | call connects unmonitored; no "protected" announcement |
| 16 | TwiML egress guard (no PSTN/SIP/conference legs, own-host callbacks, own household Client only) | `sendVoiceTwiml` → `guardTwiml` | `<Reject>` |
| 17 | Provider setup with hard `<Dial timeLimit>` = min(056 max, Fortress backstop) | `dialHouseholdOrFailClosed` | — |
| 18 | Live lease renewal every lease (5 min) by the sweeper; unaffordable ⇒ parent call ended at lease end; DB down ⇒ instance ends its own calls after lease + grace | services/containment/leaseSweeper.js | provider timeLimit is the last backstop |
| 19 | Settlement: verified, non-duplicate Dial callbacks only (abuse leases released, 056 session ended, Fortress settled); unverified ⇒ sweeper settles from provider status | `/call-delivery-failed`, `/call-status` | — |
| 20 | Actual-cost reconciliation (`fc_record_actual`, charge max(estimate, actual)) | 067 | **NOT WIRED — no provider billing feed**; every figure is an estimate |

## Other paid paths

- **SMS:** incident gate + UK-mobile-only destination + per-household caps → 056 SMS ceiling → Fortress `authorizeSpend('sms')` (fail-closed) → Twilio.
- **AI (`/process`):** signed request + Fortress `authorizeSpend('ai')`. Live transcription only after the stream is attached to a reservation, plus per-household transcription caps.
- **Number purchase:** abuse single-flight / incident / global velocity / account-risk (ensureTwilioNumberProvisioned; production refuses if the guard is absent) → environment guard (non-production never buys on the production account) → Fortress `authorizeNumberPurchase` (10/day global; an adoption also consumes one — conservative) → adopt-before-buy → buy → response check → assign (verify-then-release on failure).
