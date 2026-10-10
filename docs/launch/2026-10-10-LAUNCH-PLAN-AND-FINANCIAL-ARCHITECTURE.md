# HCG launch plan and financial-protection architecture: 2026-10-10

Lead: the HCG LAUNCH session.

- **Status:** plan and design. Nothing has been deployed, merged, purchased or changed in production.
- **Workstream detail:** each workstream (WS1–WS4) writes `docs/launch/2026-10-10-WS*-REPORT.md`; trusted-bypass detail is in `docs/routing/2026-10-10-TRUSTED-BYPASS-ROADMAP.md` (WS3).

---

## 1. Revised launch plan (parallel workstreams)

| Workstream | Worktree / branch | Owns | Started |
|---|---|---|---|
| WS1 Launch, security, deployment | `call-ai-ws1-launch-security` / `launch/ws1-launch-security` | unauthenticated-route inventory and fixes, admin hardening, read-only production preflight tool, production env template, rollback-compatibility check, cross-review of B3 + stream hardening | 2026-10-10 |
| WS2 Financial protection, unit economics | `call-ai-ws2-financial-protection` / `launch/ws2-financial-protection` | requirement→mechanism evidence matrix, allowance-exhaustion states + API, top-up exposure proof, 100/1,000-customer simulation (10% heavy), per-customer profitability model, reconciliation calculator, degraded-mode analysis | 2026-10-10 |
| WS3 Mobile, routing, handset | `call-ai-ws3-mobile-routing` / `launch/ws3-mobile-routing` | cold-start call recovery (handset risk H5), screening-paused UX, honest "turn off forwarding" action, trusted-bypass roadmap, handset plan additions | 2026-10-10 |
| WS4 Payments, customer ops, monitoring | `call-ai-ws4-payments-ops` / `launch/ws4-payments-ops` | Play-compliant Android (Option C: no in-app buying), terms, £4.99 grandfathering proof, store-purchase eligibility endpoint, first-five runbook, ops events, Financial Control Centre v1 UI | 2026-10-10 |
| Lead (this session) | `launch/controlled-launch-2026-10-09` | integration and cross-review, production containment hotfix, this plan, approvals | — |

Ownership rules:
- File ownership does not overlap. No workstream edits `server.js`; the lead integrates all mounts.
- Migration numbers: WS2 may use 076–077 and WS4 078–079.
- Workstreams commit locally. The lead reviews each branch, merges it into the launch branch, runs the full suite and pushes.

### Timeline (critical path = your approvals → handset session → production window)

| When | Workstreams (no approval needed) | Needs you |
|---|---|---|
| **Day 0, Sat 10 Oct** | WS1–WS4 running. Containment hotfix prepared and tested | §5 containment approvals (about 60 min in the consoles) |
| **Day 1, Sun–Mon** | Lead integrates WS1–WS4, cross-reviews, runs the full suite, pushes | GO: staging migrations (075+) and the staging EAS APK (versionCode 23+) |
| **Day 2** | — | Attended Motorola session (about 3 h, handset plan H0–H17). Optional extra hour: the £0 trusted-bypass experiment E3 (§4) |
| **Day 3** | — | Production window (about 90 min): backup → migrations → Fortress limits → merge (the deploy) → checks → kill-switch drill → signed calls on `…6063` → £5.99 cutover → invite list. Then the production AAB to the Play Internal track |
| **Day 4, about Wed 14 Oct** | — | First invited customer, onboarded personally (support-verified Protected) |

This is credible only if each approval arrives within about a day. Nothing on the critical path waits on research.

---

## 2. Financial-protection architecture

### 2.1 The guarantee and its honest limit

**Guarantee (deterministic code and SQL, never AI):**

    HCG cost per customer per period  ≤  that customer's budget = subscription allocation + trusted continuity reserve + top-up credit actually paid for
    global cost per hour/day          ≤  global caps (latching breaker; terminates live calls)

This holds **including calls already in progress**, concurrency and provider billing delay (§2.3).

**The honest limit.** While customers use unconditional forwarding (`**21*`), **every** call (trusted and unknown) passes through Twilio and costs HCG for the whole conversation. Once a customer's budget and reserve are spent, only three outcomes exist:

| Option | Breaks |
|---|---|
| Keep paying | Priority 1 (uncontrolled loss) |
| Refuse the call (the caller hears busy) | "Trusted callers must not be cut off" |
| The customer turns forwarding off (calls return to normal mobile operation) | Nothing, but it needs a customer action. It **cannot be automated** on carrier forwarding today. Not proven, not claimed |

**Design choice for launch:**
- a **separate trusted continuity reserve** that unknown calls cannot drain;
- **escalating warnings** with a one-tap "turn off forwarding" (the Android dialer prefilled; the customer presses Call);
- a **last-resort hard stop** only after the reserve is gone.

So a trusted caller can be refused only after repeated warnings the customer ignored. **The trusted-caller bypass (§4) removes the conflict for good:** trusted calls never reach HCG, and exhaustion becomes automatic (the app stops silencing, so the phone behaves normally).

**Your decision:** the size of the trusted reserve.

| Reserve | Extra trusted minutes | Worst-case cost | Notes |
|---|---|---|---|
| £0.50 | about 40–60 | £0 | Recommended now |
| £1.50 | about 110–170 | Inside the £5.99 margin for most customers | — |
| £3.00 | about 220–340 | Can turn a heavy customer loss-making, about £1–2/month | — |

WS2 will report the exact figures from the simulation.

### 2.2 Layers (outermost to innermost)

| Layer | Mechanism | Type | Proven by |
|---|---|---|---|
| L0 Provider ceilings | OpenAI project and org spend limits with hard enforcement; Twilio prepaid with auto-recharge off; SMS geo UK only; outbound voice geo off; 4 h call cap | Catastrophic outer bound only. Leaky and coarse; **never relied on per customer** | Console evidence (containment checklist) |
| L1 No-cost-by-construction | **HCG never places outbound PSTN calls** (no premium-rate or international destination cost is possible; launch-gate PR-05). Signed webhooks on every Twilio route. Single-use stream tokens. Premium/international caller policy. Invite-only acquisition. `/process` off | Preventive, structural | 63 adversarial checks; PR-01…12 |
| L2 Per-call authorisation (Financial Fortress, Postgres, atomic) | Every cost-bearing action (call, monitoring, SMS, AI, number) needs a **reservation**. Invariant **I5: consumed + Σ worst case of live calls ≤ budget + adjustments + reserve**. Each call's Twilio `<Dial timeLimit>` is derived from the remaining headroom (backstop share 0.5), so **even if every HCG server died mid-call, Twilio ends the call within the authorisation**. 300 s leases; renewal needs budget; estimates ≥ actuals (×1.1, app leg at list price, started-minute rounding) | **Hard, per customer** | Fortress suites; FC-1…8; real-Postgres concurrency tests |
| L3 Global gates | £/hour and £/day caps scaled by entitled customers, with a latching breaker that **terminates live calls**; absolute daily maximum; cap on active calls and worst-case exposure; number purchases per day; **kill switch**; per-household hold; incident modes | **Hard, global** | Kill-switch and breaker suites |
| L4 Fail-closed | Fortress or database unreachable → refuse (no spend). Monitoring failure → the stream stops; the call continues within its lease. Unsafe configuration refuses to boot | Hard | `launch-config-safety`; FC-6 |
| L5 Detect and learn | Fortress ledger vs provider actuals reconciliation (>20% gap → stop procedure); anomaly signals; Financial Control Centre; AI forecasts and recommendations | **Advisory only.** AI never enforces | WS2/WS4 |

### 2.3 Active-call exposure, billing delay, provider outage

- **In progress:** a call is admitted only if its worst case (to its `timeLimit`) fits the headroom, counting the unreserved worst case of the household's other live calls. Leases renew every 300 s. A refused renewal or a tripped breaker ends the call. Twilio's own `timeLimit` is the backstop if HCG is down.
- **Concurrency:** at most 3 calls and 2 monitored streams per household; global active-call cap; real-Postgres race tests.
- **Billing delay:** enforcement never waits for provider bills. HCG prices each call from its own estimate, which is at least the actual cost. Provider actuals only reconcile afterwards.
- **Provider or database outage:** Fortress refuses all calls today, so trusted callers are refused during an HCG outage. WS2 is analysing a bounded, deterministic alternative (trusted-only, in-memory caps); **your decision**.
- **Loops and spoofing:** no PSTN dial-out, so no loop can bill outbound. A spoofed trusted caller ID bypasses screening, which is a customer-protection risk, not a cost risk.

### 2.4 Scale (100 / 1,000+, with 10% extreme users)

Each customer is capped at or below their own revenue-backed budget. So 100 extreme users out of 1,000 cost **at most 100 × their cap** (about £360/month at a £3.60 cap), and that cost is covered by their own subscriptions. Global caps scale with the entitled count and only bound anomalies. WS2's simulation (real migrations and policy) will give measured figures and recommended cap scaling.

---

## 3. Allowance exhaustion and top-up journey (today's forwarding model, honest)

| Stage | System (deterministic) | Customer sees (push + in-app; **no SMS**, because SMS costs money) |
|---|---|---|
| Normal | Screening on | Allowance meter |
| 80% of screening budget | — | "Your screening allowance is running low this month." |
| **Screening paused** (screening budget used) | **No stream, no transcription, no AI, no SMS.** Calls are still delivered: trusted calls from the trusted reserve; unknown calls **unscreened**, within a small bounded allowance | "Screening paused: calls still reach you, but unknown callers aren't being checked. Top-ups are arranged on our website. Or turn off call forwarding to use your phone normally." (Android: plain text, no link; Play policy) |
| Reserve low | — | "Calls may soon stop reaching you through Home Call Guard. Turn off call forwarding now." [Turn off forwarding] opens the dialer with the code prefilled; the customer presses Call. iPhone: the code is shown |
| Hard stop | Calls refused (busy). £0 spend | Prominent: "Turn off call forwarding to receive calls normally." |
| Top-up paid (website) | Credit applied **only after a settled live payment**, at a factor ≤ its net revenue. Refund or dispute reverses unused credit. Monthly cap. Screening resumes | "Screening is back on." |
| Renewal | New period budget | Back to normal |

Under the bypass (§4), **Hard stop becomes automatic and harmless**: the app stops silencing unknown callers, the phone rings normally, and HCG costs nothing.

---

## 4. Trusted-caller bypass roadmap (summary; detail from WS3)

| Approach | Status |
|---|---|
| Identify the trusted caller inside Twilio → free | **Disproven.** Under `**21*` HCG still pays for the inbound leg for the whole call (real call 2026-09-12) |
| Android reject → busy forwarding (CFB) | **Not proven / NO-GO.** Lebara/Motorola 2026-10-09 gave busy |
| **Android SILENCE (CallScreeningService) + no-answer forwarding (CFNRy)** | **Experimental, the quickest test.** Probe APK v0.3 is built, not installed. AOSP: silence does not reject, so the network sees no answer and CFNRy fires |
| iPhone: Silence Unknown Callers + Live Voicemail off + conditional forwarding | Experimental (T4 untested) |
| Carrier/MVNO/FMC routing | Long-term; not on the launch path |

**Quickest test: E3, about 1 h, £0, needs your approval.**
1. Motorola: forwarding off; CFNRy to the carrier's **own voicemail**.
2. Install probe v0.3 (silence mode).
3. Calls from a contact ring natively; calls from a non-contact are silenced, then go to voicemail after the timer.
4. **PASS** = silenced unknown calls divert, and trusted calls ring normally.
5. Then E3b: CFNRy to an HCG test number, which needs a number decision.

Product integration only after E3/E3b pass on the launch carriers.

---

## 5. Immediate production containment: needs your approval

Production `eb43368` today has two open spend paths:
- **forged `/media-stream`:** OpenAI cost and SMS to any number;
- **unsigned `/process`:** OpenAI cost. One unsigned request made 3 OpenAI calls in today's test.

Sales are also open.

| # | Action | Bounds | Hard or alert |
|---|---|---|---|
| C1 | **Stripe:** archive the live £4.99 Price and deactivate any Payment Links (existing subscribers unaffected) | New sign-ups, and the number purchases they trigger | Preventive |
| C2 | **App Store Connect:** remove the IAP from sale (live 1.0.1 has no sandbox guard; a TestFlight-style purchase buys a real number) | iOS sign-ups | Preventive |
| C3 | **Deploy the containment hotfix** `hotfix/prod-containment-2026-10-10` (`36db244`, 20 lines on top of `eb43368`): live monitoring and `/process` OFF by default. Calls are delivered exactly as now; screening is paused (0 genuine paying customers today). Boot test: 0 OpenAI requests (unpatched: 3). Needs a PR merged to `main` (Railway auto-deploys) and your GO | **Closes** both paths | **Hard (code)** |
| C4 | **OpenAI:** project and org spend limits with "Enforce hard limit" on (for example $20/month until launch) | All OpenAI spend | Hard (monthly; slight overshoot) |
| C5 | **Twilio:** auto-recharge OFF, keep about £20–30 balance; SMS geo UK only; voice geo all off; confirm the 4 h call cap | Total Twilio spend (leaky); SMS destinations | Hard but leaky |
| C6 | **Twilio:** `<Reject/>` voice fallback URL on every number | Calls during an outage | Preventive |
| C7 | **Twilio usage triggers** (email): daily total £5, daily SMS £2 | Detection only | **Alert** |

Recommended order: C1 + C2 + C4 + C5 now (console, about 30 min), then **C3 today**. C3 is the only one that **closes** the holes before the full deploy.

## 6. Started without waiting for you

See §1.
- WS1: route inventory and fixes, preflight tool, env template, rollback check, cross-review.
- WS2: evidence matrix, exhaustion states and API, top-up proof, scale simulation, profitability model, reconciliation, degraded-mode analysis.
- WS3: cold-start call recovery, screening-paused UX, turn-off-forwarding action, bypass roadmap.
- WS4: Android Option C, terms, grandfathering proof, eligibility endpoint, runbook, ops events, Financial Control Centre UI.
- Lead: containment hotfix (done, tested), integration.
