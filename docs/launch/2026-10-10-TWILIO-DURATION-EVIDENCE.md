# Twilio call duration and worst-case exposure: evidence (2026-10-10)

- **Status:** verification only. No live calls, and no calls to Twilio, OpenAI or Supabase. Nothing deployed.
- **Branch:** `launch/ws1-launch-security`, based on the integrated tip `c02daa9`.
- **Claim under test:** `2026-10-10-LAUNCH-PLAN-AND-FINANCIAL-ARCHITECTURE.md` §2.2–2.3: "each call's `<Dial timeLimit>` is derived from the remaining headroom … so even if every HCG server died mid-call, Twilio ends the call within the authorisation". Also: leases renew every 300 s, the breaker terminates live calls, and estimates are at least the actuals.
- **Twilio documentation:** read 2026-10-10. URLs are in §8.
- **New tests:**
  - `tests/fortress-server-death-exposure.pglite.test.mjs` (33 checks)
  - `tests/twilio-duration-bounds.test.mjs` (36 checks)

## Summary for Andrew

1. **The code side is sound.** Every call HCG connects carries a Twilio time limit sized from that household's remaining budget. No code path can connect a call without one: the response is replaced by a refusal, which is free. A new test admits calls and then simulates every server dying. Even then, the worst case stays inside the household's budget plus reserves.
2. **What Twilio does after the time limit fires is not demonstrated.** When the limit ends the app leg, Twilio asks HCG what to do next. If HCG is dead, Twilio's documentation does not say what happens. The design assumes Twilio plays an error or fetches the fallback, then hangs up, within about 60 seconds. This is plausible but unproven.
3. **Worst case if every server dies right after admission.** A fresh £5.99 household: about £0.25 for one call, and at most £0.85 however many calls it receives (budget + trusted reserve + essential pool). Across all customers, at most £40 at today's settings: the active-call cap of 20 and a worst-case cap of £40, or £0.50 per entitled household above 80.
4. **The breaker does end live calls, but not instantly.** It refuses lease renewals. The sweeper then hangs up each call through Twilio using the master token, up to about 5 minutes later. If that fails, the time limit is the backstop.
5. **Two estimate gaps were found:**
   - Two-segment SMS messages are estimated as one segment (about 4p under per message).
   - A long monitored call on a household with extra credit (a top-up) could exceed its estimate. This needs two things at once: Twilio keeps billing a Media Stream after HCG's connection dies, and Twilio starts billing the app leg. Neither happens today.
6. **One staging call can demonstrate the Twilio side** for pennies (§7). It has not been run. Until it passes, describe the per-call cap as **"enforced by HCG code, with a Twilio time-limit backstop that is documented but not yet demonstrated"**. Do not call it "guaranteed".

---

## 1. Chargeable legs: what bounds each one, and who enforces it

| Leg | Billed | What bounds it | Enforced by |
|---|---|---|---|
| **Inbound PSTN parent leg** | £0.007558 per started minute, from Twilio's answer to hangup (`UNIT_ECONOMICS_AND_PROVIDER_REQUIREMENTS.md:18`). It covers the greeting, the ringing and the conversation | `<Dial timeLimit>` bounds only the dialled leg. The parent leg ends when there is no more TwiML to run. Every action handler returns a terminal response (§2). Extra parent time outside `timeLimit`: greeting about 3 s, plus ringing ≤ `timeout` 20 s plus Twilio's 5 s buffer, plus the action fetch, plus any fallback. Covered by `termination_grace_seconds` = 60. Outer ceiling: Twilio's account maximum of 4 h (24 h if enabled) | **Twilio** while the `<Dial>` runs. After that, **HCG** if alive, and **Twilio's undocumented behaviour** if not |
| **`<Dial><Client>` app child leg** | £0 so far; list price $0.004 ≈ £0.00316 per minute (`UNIT_ECONOMICS…:19`) | `timeLimit` (server.js:479). `timeout=20` while ringing | **Twilio** (documented, not observed on HCG's account) |
| **`<Start><Stream>` Media Stream** (unknown callers only) | £0.003329 per started minute (`UNIT_ECONOMICS…:20`) | Ends with the call. HCG closes the WebSocket at 30 min (`mediaStreamHandler.js:412-420`, `monitoringLimit.js`) | Call end: **Twilio**. 30-min cap: **HCG**, relying on assumption **A**: Twilio stops billing a stream once the WebSocket closes. A is undocumented |
| **OpenAI whisper transcription** | About £0.00474 per monitored minute (estimated) | Runs only while HCG is alive. 30-min monitoring cap. Fortress reserves the whole window up front | **HCG**. Zero cost when HCG is dead |
| **Polly greeting** | £0.0006 per use (`UNIT_ECONOMICS…:21`) | One per unknown call (server.js:1426). The red-line message (server.js:1670) and `FC_TERMINATION_MODE=announce` add one more | **HCG**. Covered by `call_fixed_fee_gbp` £0.0006 per call; the extra uses are not estimated (§5) |
| **SMS** | £0.042325 per segment. Red-line, post-call and limit messages are 2 segments | Every send needs `fc_authorize_spend` (`smsBudget.js:40-53`), fail-closed | **HCG**. Needs HCG alive. Under-estimated (§5) |
| **Number rental** | £0.86917 per month | Not metered by Fortress | Outside the per-call model |

## 2. `<Dial timeLimit>` semantics and the parent leg

**From Twilio's documentation** (`/docs/voice/twiml/dial`, read 2026-10-10):
- "The `timeLimit` attribute sets the maximum duration of the `<Dial>` in seconds." Default 14400 s. Example: "hang up on the called party automatically".
- With `action`: "Twilio will continue the initial call after the dialed party hangs up", and "your response to Twilio takes full control of the initial call". So `timeLimit` ends the **child** leg; the **parent** continues into the action request.
- `timeout`: "the limit in seconds that `<Dial>` will wait for the dialed party to answer". Also: "Twilio always adds a five-second timeout buffer".
- **Not documented:** whether the `timeLimit` clock starts at the child's answer or at the start of the `<Dial>`. This bound assumes it starts at the answer, which is the worse case.

**From Twilio's webhook documentation:**
- Webhooks: "Twilio imposes a hard upper timeout of 15 seconds on all call-related HTTP requests". Default: connect 5 s, total 15 s, one retry on TCP or TLS connect failure only (`/docs/usage/webhooks/webhooks-connection-overrides`).
- Fallback URL: "If Twilio is unable to retrieve or execute TwiML from your web server, a request is immediately made to the number's Fallback URL" (`/docs/usage/security/availability-reliability`).
- **Not documented:** whether that fallback applies to `<Dial action>` requests, and what Twilio does when there is no fallback. The provisioning code comment says Twilio "answers with 'an application error has occurred'" (`twilioProvisioning.js:61-66`). That is an observation of the *initial* request failing, not of the action URL.

**What HCG relies on.** If HCG is unreachable at the action request, Twilio either:
- fetches the number's fallback (planned: a TwiML Bin returning `<Reject/>`; not yet set on existing numbers, checklist C1); or
- plays its error message.

Either way it then has no further TwiML and the call ends. Parent overhead in the worst case is about 3 s greeting + 25 s ringing + 15 s action timeout + up to 15 s fallback or error message ≈ **58 s, within the 60 s grace**. The margin is thin and rests on provider behaviour that is **not demonstrated** (§7).

**If the Dial never connects:** ringing is bounded by `timeout=20` (+5 s). Then the same action path runs. The time before the `<Dial>` is only the Polly greeting: one `<Say>`, with no `<Pause>`, `<Gather>` or `<Redirect>` in `/voice`.

**Account maximum:** 4 h. "Call terminates automatically" (`/docs/voice/limitations-and-edge-cases`). It can be raised to 24 h by an opt-in console setting (changelog 2021-08-02). HCG's explicit `timeLimit` (≤ 14400, enforced by the egress guard) makes that setting irrelevant to the child leg. It cannot be read through the API (`verify-twilio-config-readonly.mjs:17-18`).

**`<Stream>` stop:** the docs describe `<Stop><Stream>` and the `stream-stopped`/`stream-error` callbacks only. **Not documented:** what happens to a stream when its WebSocket server disappears, and whether it is billed. That is assumption A.

**Every action handler is terminal** (tested by `twilio-duration-bounds`):

| Handler | Response |
|---|---|
| `/call-delivery-failed` (server.js:1694) | Duplicate → `<Hangup/>` (1706). Otherwise `buildDeliveryFailedResponse` → `<Hangup/>` for every `DialCallStatus` in production (`callDeliveryFallback.js:43-67`). The voicemail prototype (`<Say>` + `<Record maxLength=60>` + `<Hangup/>`) is forced off in production, and the egress guard forbids `<Record>`, so it becomes `<Reject/>` everywhere |
| `/call-status` (1832, unreachable today) | `<Hangup/>` |
| `/call-delivery-voicemail-complete` (prototype, non-production) | `<Hangup/>` |
| `/red-line-terminate` (1667, reached by REST redirect) | `<Say>` + `<Hangup/>` |
| Errors on any voice route (server.js:3136-3142) | `<Reject/>` |

## 3. Every TwiML response the RC can produce

| # | Route / site | TwiML | Bound |
|---|---|---|---|
| 1 | `/voice` SDK-originated (1084) | `<Reject/>` | terminal, unbilled |
| 2 | `/voice` abuse reject (1183) | `<Reject/>` | terminal |
| 3 | `/voice` admission refused (1219) | `<Reject reason=busy/>` | terminal |
| 4 | `/voice` no registered app (1242) | `<Reject reason=busy/>` | terminal |
| 5 | `/voice` Fortress refused (1266) | `<Reject reason=busy/>` | terminal |
| 6 | `/voice` trusted (1297 → 479) | `<Dial action=/call-delivery-failed timeout=20 timeLimit=T><Client>` | `T = min(SAFETY_MAX_CALL_MINUTES×60, fc_authorize_call.timeLimitSeconds)` (1269) |
| 7 | `/voice` unknown (1426, 1431, 1446) | [`<Say Polly>` + `<Start><Stream>`] + the same `<Dial>` | as row 6, plus the greeting |
| 8 | `dialHouseholdOrFailClosed` fallbacks (506, 526) | `<Hangup/>` / `<Reject busy/>` | terminal |
| 9 | `/process` (dormant, 1528) | `<Hangup/>` unless `PROCESS_ROUTE_ENABLED` | terminal |
| 10 | `/process` enabled (1550, 1630, 1644-1653) | `<Say>` (terminal); `<Say>` + `<Hangup/>`; or `<Say>` + `<Pause 1>` + `<Stream>` + `<Dial>` **without timeLimit** → egress guard → `<Reject/>` | terminal |
| 11 | action handlers (§2) | `<Hangup/>`, `<Say>` + `<Hangup/>` | terminal |
| 12 | `/voice-sdk-outbound-not-supported` (1498) | `<Reject/>` | terminal |
| 13 | REST: `twilioCallControl.terminate` (`twilioCallControl.js:38-51`) | `status=completed`, or inline `<Say>` + `<Hangup/>` | terminal |
| 14 | REST: red-line `callTermination.js:40,49,60` | redirect to row 11, or `status=completed` | one hop, terminal |

- **No `<Gather>`, `<Redirect>`, `<Enqueue>`, `<Connect>` or `<Conference>` is built anywhere**, so there is no TwiML loop to bound.
- Every `/voice` response passes through `sendVoiceTwiml` → `twimlEgressGuard` (server.js:1061). The guard rejects any `<Dial>` without an integer `timeLimit` of 1..14400 (`twimlEgressGuard.js:71-78`).
- `containment.authorizeCall` treats an "allowed" answer without a positive integer limit as an authority failure (`containment.js:131`). That leads to degraded mode, which rejects by default (`policy.js:22`, D3).

**Static test:** `tests/twilio-duration-bounds.test.mjs` fails if any of the following happens:
- a second `twiml.dial(` appears;
- the `<Dial>` stops taking `dialOptions.timeLimit`;
- `/voice` dials without `dialOptions`, or computes it differently;
- any redirect, gather, enqueue, connect, refer or pay verb appears;
- `<Pause>` or `<Record>` appear outside their known sites;
- a hand-written TwiML string contains a non-terminal verb;
- an action handler returns anything but `<Hangup>` / `<Say>`;
- the guard stops rejecting a missing, zero, over-4-hour, NaN or fractional `timeLimit`.

## 4. How `timeLimit` is computed, and worst-case £

**Inputs: `fc_policy` defaults** (067:46-63, confirmed by the new test):

| Setting | Value |
|---|---|
| `lease_seconds` | 300 |
| `termination_grace_seconds` | 60 |
| `max_call_seconds` | 14400 |
| `backstop_share` | 0.5 |
| Connected rate | £0.010718/min (inbound £0.007558 + app leg at list £0.00316) |
| Monitoring rate | £0.008069/min (stream + whisper) |
| `estimate_uplift` | 1.10 |
| Granularity | 60 s |
| Fixed fee per call | £0.0006 |
| `monitoring_max_seconds` | 1800 |
| `enforcement_mode` | `enforce` |

**Cost function:** `fc_call_cost(s) = ⌈s/60⌉ × 0.010718 × 1.1 [+ ⌈min(s,1800)/60⌉ × 0.008069 × 1.1 if monitored] + 0.0006` (067:300-311). The telephony block is **£0.0117898**.

**Backstop**, i.e. the returned `timeLimitSeconds` (076:335-348, the same as 067:841-855):

    avail     = base + adjustments − consumed − reserved − Σ(other live calls' worst − reserved)   (I5 contingent)
    bs_avail  = max(avail × 0.5, this call's reservation)
    timeLimit = min(max_call, max(lease, ⌊(bs_avail − monitoring window − fixed) / 0.0117898⌋ × 60 − grace))
    worst     = fc_call_cost(timeLimit + grace)

- Unattributed calls (a number with no household) are fixed at 120 s (067:734-761).
- Shadow mode sets `timeLimit = max_call`. Shadow is only possible with `FC_ALLOW_SHADOW=true`, which is off in the RC.

**Fortress invariant I5** (067:778-784): *consumed + Σ worst case of live calls ≤ budget + adjustments + reserves*. Because each call's worst case is sized from headroom that already subtracts every other live call's worst case, the provider time limits alone keep the household inside its authorisation.

**Worst case if every HCG server dies immediately after admission** (seeded `standard` profile: budget £0.50, trusted reserve £0.25 (trusted only), essential £0.10, unscreened £0). Figures are printed by `fortress-server-death-exposure.pglite.test.mjs`:

| Case | timeLimit | Fortress worst | Per-leg Twilio model, app leg billed / £0 (today) |
|---|---|---|---|
| (a) one trusted call, fresh | 1200 s (⌊(0.25−0.0006)/0.0117898⌋ = 21 blocks → 1260 − 60) | 21 × 0.0117898 + 0.0006 = **£0.2482** | £0.2219 / £0.1587 |
| (a) one monitored unknown call, fresh | 300 s (floor = lease) | 6 × 0.0117898 + 6 × 0.0088759 + 0.0006 = **£0.1246**. The reservation is £0.3376 (lease + whole 30-min window) | £0.1102 / £0.0944 |
| (b) 3 concurrent (abuse cap): 1 monitored + 2 trusted | 300 / 300 / 300 s | Σ **£0.2673** | within |
| (b) 10 simultaneous, per-household cap assumed broken | 6 admitted, 4 refused (budget) | Σ **£0.7346** ≤ £0.85 | within |
| (b) after 10 monitored minutes consumed (£0.1453), 6 more attempted | 3 admitted | £0.1453 + £0.3201 = **£0.4654** ≤ £0.85 | within |
| Per household, any number of calls | — | **≤ remaining budget + adjustments + reserves**, i.e. **£0.85** fresh for `standard`, more only with paid top-ups (revenue-capped by 077). The 24 h auto-hold at £5 also applies | — |
| (c) global, at the floors (no entitled count yet) | refused at 20 live calls (`global_active_count`) | measured Σ **£4.35**. Hard ceiling = `global_worst_case_floor_gbp` **£40**; in general `max(£40, £0.50 × N)` with active calls `≤ max(20, ⌈N/5⌉)` (067:383-404, 617-656) | — |
| Unattributed | 120 s | £0.0360 each; 20 admitted, Σ £0.72. Own cap £2/day, inside the same global caps | — |

**Per-leg model assumptions:**
- parent ≤ T + 60 s;
- app leg ≤ T, at list price;
- stream ≤ min(parent, 1800 s) (assumption A);
- whisper ≤ min(parent, 1800 s);
- Polly once.

**Does any existing test exercise "server dies after admission"?**
- `financial-containment-ledger.pglite.test.mjs:149` asserts Σ DB `worst_case_gbp` ≤ £0.20 for one burst on one household, using pinned test profiles.
- `financial-containment-e2e.pglite.test.mjs:123-143` covers the kill switch and a database outage with a *live* sweeper and a fake Twilio.
- None recomputes the worst case from the returned `timeLimit`, uses the seeded commercial profiles, or checks the global ceiling with no renewals. **The new test does all three.**
- `financial-containment-realpg` and `launch-fortress-realpg` were **SKIPPED** here (`FC_REALPG_MODULES` unset), so multi-connection races were not re-run in this session.

## 5. Estimates against Twilio actuals (delayed billing)

Enforcement uses only HCG estimates; provider actuals reconcile later. Settlement duration is either the elapsed time since admission (Dial action; that is at least the parent's billed duration) or Twilio's own parent duration (sweeper), clamped to backstop + grace + 60 (076:433-434).

| Leg | Actual | Estimate | Estimate ≥ actual? |
|---|---|---|---|
| Inbound parent | 239 s billed 4 × £0.00756 = **£0.03023** (`UNIT_ECONOMICS…:18`) | ⌈239/60⌉ = 4 × 0.0117898 + 0.0006 = **£0.04776** | yes, ×1.58 |
| App leg | £0 today; at list £0.00316/min | included at list in 0.010718 | yes. If Twilio starts billing, parent + app = £0.010718 < £0.01179 per block |
| Media Stream | £0.003329 per started minute (41 min = £0.13647). A 5-minute day = £0.01665 (`FINANCIAL_DATA_ARCHITECTURE.md:342`) | 0.008069 × 1.1 = £0.0088759/min, covering stream and whisper. 5 min = £0.0444 ≥ £0.01665 + 5 × £0.00474 = £0.0404 | yes. Whisper is *estimated* (FX 0.79); safe up to about 0.92 GBP/USD |
| Polly | £0.0006 per use | £0.0006 fixed per call (not uplifted) | yes for one greeting. **Not estimated:** a second use (red-line message, `announce` termination), £0.0006 each |
| SMS | 1 segment £0.042325; red-line, post-call and limit messages = **2 segments, £0.08465** | `units: 1` × 0.042325 × 1.1 = **£0.0466** (`smsBudget.js:42`) | **NO.** About £0.038 under per 2-segment message. Fix: authorise `units = segment count` |
| Stream after HCG dies (long monitored call, top-up household only) | Unknown (assumption A) | Monitoring is estimated only up to 1800 s | **Conditional.** Example (test, £5 extra credit): T = 12540 s. If Twilio billed the stream for the whole call *and* billed the app leg at list, the cost would be £3.09 against £2.74 estimated. With the app leg at £0 (today) it is £2.43, within. Not reachable on the base £0.50 budget (T is at most 1200 s) |
| Failed-message processing fee | £0.00152 (once in history) | not estimated | no (negligible) |
| Media Streams minimum charge | not documented | — | unconfirmed |

## 6. Global breaker and kill switch: do they end live calls?

**Triggers:**
- The spend-rate caps latch the breaker (067:617-656):
  - hourly: `max(£4, £0.03 × N)`;
  - daily: `min(£1000, max(£15, £0.20 × N))`.
- The kill switch: `fc_set_kill_switch` from admin, or latched by a verified Twilio usage-trigger webhook (server.js, `providerUsageAlert.js`).

**How calls end:**
1. `fc_renew_lease` refuses renewal (067:1081-1086) and marks the call `terminating` at `terminate_at = lease_expires_at`.
2. The sweeper runs every 15 s on every instance (`policy.js:27`). At that time it calls `client.calls(sid).update({status:'completed'})` (`twilioCallControl.js:38-51`), or inline `<Say>` + `<Hangup/>` in `announce` mode.
3. The client is `twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)`, the **master token** (`twilioClient.js:8-9`, server.js:3233-3247). Ending the parent stops the inbound leg, the app leg and the stream together.

**Latency:** up to the end of the current lease (≤ 300 s after the last renewal) plus one sweep (15 s). Not instant. The e2e test shows all 3 live calls ended within 420 s of a kill switch, using a fake Twilio (`financial-containment-e2e.pglite.test.mjs:123-131`).

**If the REST call fails:**
- The `provider_termination_failed` critical alert fires.
- The call stays `terminating` and is retried every ≥ 10 s with no limit (067:1149-1175; `financial-containment-service.test.mjs:230-240`).
- If the database is down, each instance ends its own calls at lease + grace (`leaseSweeper.js:78-91`).
- If the sweeper is not running (no Twilio client) or everything is down, **only the `<Dial timeLimit>` backstop** bounds the call, at the per-call worst case in §4.

## 7. What remains undemonstrated, and the minimal staging test

**Undemonstrated without a live call:**
1. U1: Twilio ends the `<Dial>` at `timeLimit` on HCG's account.
2. U2: whether the `timeLimit` clock starts at the child's answer or at the start of the `<Dial>`.
3. U3: parent-leg behaviour, duration and billing when the action URL is unreachable, with and without the `<Reject/>` fallback.
4. U4: the fallback URL is actually set on the existing numbers (checklist C1; the verifier has never been run).
5. U5: Media Stream billing stops when the WebSocket closes (assumption A). It is load-bearing for HCG's own 30-min cap too.
6. U6: the 24-hour setting is off (console only).
7. U7: real-Postgres races not re-run this session.
8. U8: 076 is not applied anywhere. 067 is on staging (`2026-10-04-STAGING-READINESS.md` §8).

**Minimal staging test (NOT RUN; needs approval).**

Approvals:
- S-A: `FC_TIGHTEN_MAX_CALL_SECONDS=120` on the **staging** server only. This is a tighten-only override (`policy.js:116-135`); no database policy change. Redeploy staging.
- S-B: point …1883 at staging `/voice` and record its current `VoiceFallbackUrl`.
- S-C: an attended session with the Motorola, using the staging app, plus a second phone as the caller.
- S-D: permission to stop the staging service mid-call.
- S-E: read-only Twilio reads with a restricted key (Calls, Usage, Debugger).

Note: staging uses the production Twilio account, so the pennies land on the production bill.

Run 1 (trusted caller, server dies after answer, fallback as currently set):
1. Call …1883 from a contact. Answer in the app at t0.
2. At t0 + 30 s, stop the staging service. Stay on the line on both phones; do not hang up.
3. Note the wall-clock time the app leg drops, the time the caller's call ends, and what the caller hears.
4. Restart staging. Read the parent and child `Duration`/`StartTime`/`EndTime`, the Debugger 11200 entries (action URL), and whether the fallback was fetched.

**PASS when:**
- the child duration is ≤ 120 s (+2 s);
- parent duration − child duration ≤ 60 s;
- the parent is billed ≤ 3 started minutes.

The run also settles U1, U2 and U3.

Run 2: as run 1 with the `<Reject/>` Bin fallback set on …1883 (or without it, whichever run 1 did not cover). This compares the two U3 branches.

Run 3: an unknown caller (monitored), same procedure. Next day, check that the Media Streams usage for that CallSid is ≤ the parent's minutes, and look for the `stream-error`/`stream-stopped` event (U5).

Optional run 4: let the app not answer, with the server stopped before the 20 s ring timeout ends. Measure the parent duration.

**Cost:** each run is ≤ 3 started minutes inbound (£0.023) + ≤ 3 stream minutes (£0.010). All four runs together come to **under £0.15** of Twilio usage, plus the caller's own call.

## 8. Verdict table

| Claim | Mechanism | Enforced by | Evidence | Demonstrated? | Worst-case £ |
|---|---|---|---|---|---|
| Every connected call carries a Twilio time limit | one `<Dial>` site with `timeLimit` from the Fortress; egress guard rejects a missing or invalid limit; a refusal is `<Reject>` | HCG (code) | server.js:479, 1269, 1061; `twimlEgressGuard.js:71-78`; `containment.js:131`; `twilio-duration-bounds` | **yes (code, tested)** | — |
| `timeLimit` sized so I5 holds with every server dead | backstop = share of headroom net of live worst cases | HCG (SQL) sizes it; Twilio enforces it | 067:778-790, 841-855; 076:335-348; `fortress-server-death-exposure` | **yes for the arithmetic**; Twilio enforcement **no** (U1) | £0.25 per call, £0.85 per household (fresh `standard`) |
| "Twilio ends the call within the authorisation" (parent leg) | `timeLimit` ends the child; the parent ends after the action response, fallback or error; grace 60 s covers the overhead | Twilio (partly undocumented) | Dial docs; webhook timeout docs; §2 | **no**. Code and docs only; action-failure behaviour undocumented (U3) | parent overhead ≤ 1 extra started minute (£0.0076) if within 60 s |
| No unbounded TwiML loop | no `<Gather>`/`<Redirect>`; all handlers terminal | HCG (code) | §3 table; `twilio-duration-bounds` | **yes (code, tested)** | — |
| Leases renew every 300 s, ended when unaffordable | `fc_renew_lease` + sweeper (15 s) | HCG | 067:1040-1147; `leaseSweeper.js`; `financial-containment-service`, `-e2e` | code + tests (fake Twilio) | ≤ backstop |
| Breaker or kill switch terminates live calls | renewal refused → REST `status=completed` (master token) at lease end; retried every 10 s | HCG + Twilio REST | 067:1081-1086; `twilioCallControl.js:38-51`; `twilioClient.js:8-9`; e2e:123-131 | code + tests (fake Twilio); **not live** | calls run ≤ 300 s + 15 s after the trip; if REST fails, ≤ backstop |
| Global exposure bounded if all servers die | active-call cap + worst-case cap + unattributed cap | HCG (SQL) sizes; Twilio enforces | 067:383-404, 617-656; new test (c) | arithmetic yes; Twilio no (U1) | **≤ £40** at floors; `max(£40, £0.50·N)` |
| Estimates ≥ actuals | ×1.1, app leg at list, started-minute rounding, elapsed-since-admission settlement | HCG | §5; real 239 s call £0.03023 vs £0.04776 | yes for voice/stream/whisper (within measured data); **NO for 2-segment SMS**; conditional for long monitored calls after HCG death (U5) | SMS under by about £0.038 per message |
| Account 4 h / 24 h maximum | Twilio account setting | Twilio | limitations doc; 2021-08-02 changelog | no (console only, U6) | irrelevant with explicit `timeLimit` ≤ 14400 |
| Degraded (database down) does not admit | D3 = reject; bounded mode is test/development only | HCG | `policy.js:22-26, 98-112`; e2e:134-143 | code + tests | £0 new spend; live calls ended at lease + grace |

**Sources** (all read 2026-10-10):
- https://www.twilio.com/docs/voice/twiml/dial
- https://www.twilio.com/docs/voice/twiml/stream
- https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides
- https://www.twilio.com/docs/usage/security/availability-reliability
- https://www.twilio.com/docs/api/errors/11200 (does not say what happens to the call)
- https://www.twilio.com/docs/voice/limitations-and-edge-cases.md
- https://www.twilio.com/en-us/changelog/configurable-call-limits-for-programmable-voice
- https://www.twilio.com/docs/voice/api/call-resource ("Update a Call" lists `TimeLimit`: "The maximum duration of the call in seconds")

**Option, not implemented:** setting the *parent* call's `TimeLimit` by REST at admission would make Twilio bound the whole parent leg, whatever the action URL does. That needs an extra REST request per call using the master token, and it is unverified for inbound calls. It is listed for decision only.
