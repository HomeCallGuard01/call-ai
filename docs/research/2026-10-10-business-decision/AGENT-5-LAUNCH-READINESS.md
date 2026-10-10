# Agent 5: launch readiness for ≤10 paying customers (2026-10-10)

**Status:** research only. I read the documents, code and git history and ran nothing against production, Twilio, Supabase, Stripe or any device. Worktree: `research/business-decision-2026-10-10` @ `e2e1347`, which contains the integrated candidate `launch/controlled-launch-2026-10-09` (WS1–WS4 merged at `3c9d397`/`c02daa9`). Production is `eb43368`.

## 1. Verdict

1. **We cannot launch NOW. It is NO-GO today.** Production `eb43368` is selling £4.99 to the public. It has two unauthenticated spend paths (forged `/media-stream` and unsigned `/process`, at `server.js:843`), no invite gate and no allowance. Lebara is still marked `compatible` (`eb43368:services/providerPolicy.js:212`).
2. **The software is close.** The candidate passes 221/222 test files and closes every known spend path (63 adversarial checks). It adds hard per-customer limits, kill switches, invite-only checkout and support-verified Protected status.
3. **What it lacks is evidence.** No 1.0.2 build has run on an Android handset. No customer-type carrier has device proof today that it forwards to an HCG number. 28 migrations are unapplied in production.
4. **Carrier finding:** the only network ever seen forwarding to HCG is Lebara, and Lebara now refuses new forwarding registrations. In practice, **zero carriers today have proof that forwarding can be set up now**. At least one carrier (O2 or Vodafone pay-monthly) has to be proven on a device before the first invite.
5. **Minimum safe route:** contain now, then one attended handset session using a non-Lebara SIM, then the 90-minute production window, then invite customers one at a time. Android only, website Stripe at £5.99 (Option C), with an invite allowlist. That is about **5–7 working days if each approval arrives the same day**. Start with 5 customers and go to 10 only after 14 clean days.
6. **Financial exposure is bounded in code.** Each customer's usage costs at most about £4.44 a month on the Fortress cost estimate (about £3.36 actually billed), and total cost is capped at about £25 a day. **Two risks stay outside code:** Twilio has no spend cap, and the master token sits in the backend. Today these can only be accepted in writing and narrowed with a low prepaid balance.

## 2. Readiness matrix

| Area | Rating | Evidence | Owner / effort |
|---|---|---|---|
| **Code (candidate)** | READY WITH CONDITIONS | Suite 221/222; the one failure is a symlink-only `expo prebuild` check (`2026-10-10-WS4-REPORT.md` §11). Unauthorised-cost suite: 0 OpenAI/SMS on every forged case (`2026-10-09-UNAUTHORISED-COST-VERIFICATION.md`). Open items: WS1 F-1 (`mediaStreamServer.js:47,54` should use `ws.terminate()`; monitoring availability only, no spend risk); Twilio `timeLimit` backstop documented but not demonstrated (`2026-10-10-TWILIO-DURATION-EVIDENCE.md` summary item 6); `fc_record_actual` is never called, so reconciliation is offline only (WS2 G-1) | Claude: F-1 about 1 h; one staging duration call, about 30 min and pennies |
| **Production containment** | **BLOCKER** | No-auth `/process` and forged stream are live on `eb43368`. Hotfix PR #52 (`ea58231`, +27 lines, both switches default OFF) is not merged. Provider items C1–C7 not done (`2026-10-10-LAUNCH-PLAN…` §5) | Andrew: consoles about 60 min, plus GO to merge #52 (about 20 min including checks S1–S6) |
| **Migrations / deploy** | READY WITH CONDITIONS | 28 files (047, 051–077) are pending. Staging has up to 074, and 075–077 are not on staging yet. Procedure written: backup, restore proof, migrations, then merge = deploy (`2026-10-09-PRODUCTION-DEPLOY-PROCEDURE.md` §0–§6). Rollback compatibility: `eb43368` runs on the 075 schema (static and PGlite checks pass; HTTP layer not proven) (`WS1-REPORT` §5). **Deploy GO = £5.99 price GO** (website, terms and 14 guides) | Claude executes, Andrew GO; about 90 min |
| **Carrier compatibility** | **BLOCKER** | See §2a. Lebara is `compatible` in code (`services/providerPolicy.js:225-236`) on the strength of a 16 Sep test that exists only as a code comment. Registrations were refused 9–10 Oct (`TEST-A-RESULTS` finding 3), and Lebara support says forwarding is unsupported. No EE/O2/Vodafone/Three/giffgaff device proof was found in the repo (`LEBARA-FORWARDING-EVIDENCE.md` §4: "not tested live") | Andrew: Lebara → `unverified` decision (Claude, 15 min + test); one test SIM (£5–10) |
| **Call delivery: Android** | **BLOCKER** | No 1.0.2 build has ever run on a handset (`2026-10-09-ANDROID-HANDSET-VERIFICATION-PLAN.md` "Why"). Cold-start `getCalls()` recovery has been built (WS3 `536d645`) but not proven on a device (W1/H5). Locked-screen banner collapses after about 5–6 s (B-11, accept with guidance). There was an unexplained no-answer on 30 Sep | Andrew attended, about 3 h; EAS staging APK vc≥23 |
| **Call delivery: iOS** | Out of scope (BLOCKER if included) | Live iOS is 1.0.1, built from Build 12 code, with no sandbox guard. In-app purchases can't be invite-gated (`GO-NO-GO` Update, new findings) | Keep iOS off sale (C2) |
| **Billing: Stripe £5.99** | READY WITH CONDITIONS | Checkout reads the price from the Stripe Price and fails safe if it isn't a GBP, monthly, tax-inclusive Price (deploy procedure §0). Grandfathering proven: no code compares Price ids (`WS4-REPORT` §4). Needs: a new tax-inclusive Price, `STRIPE_PRICE_ID`, Stripe Tax registration, Portal plan-switching off, and webhook events subscribed (`WS4` §8) | Andrew, console, inside the window (D10) |
| **Billing: Play policy** | READY WITH CONDITIONS | Option C (no buying in the app) is built (`mobile/app/(setup)/subscribe.tsx:87`, `WS4` `079596d`) and compliant according to the Play FAQ (`ANDROID-COMPLIANT-PAYMENTS.md` §1). **What is live on Play today ships in-app Stripe (B-13), which is non-compliant now.** Remaining copy fixes: `delete-account.tsx`, `device-picker.tsx` (`WS4` §5) | Andrew: Play Console check, then halt or replace that build; Claude: copy, about 30 min |
| **Onboarding / forwarding set-up** | READY WITH CONDITIONS | Instructions per carrier exist (`providerPolicy.js`). The giffgaff/Three forwarding-number fix (`829135c`) is in the candidate but **not in production** (verified with `git merge-base`). Handset plan H8b assumes the Motorola can register forwarding, but **its SIM is Lebara, which refuses registration** | Swap the test SIM before the session |
| **Support-verified Protected (075)** | READY WITH CONDITIONS | Built, with 10 rules enforced in the database (36 + 26 checks) (`SUPPORT-VERIFIED-PROTECTION.md`). Not applied on staging or production. Gaps F-2 and F-3: it can't prove a diversion rather than a direct dial, and caller ID can be spoofed. Both are procedural controls (`WS1` §6). Unknown per carrier: whether the caller ID is preserved through the divert (`LF2-VERIFICATION-CALL-DESIGN.md:64`) | Proven at H9 on the test SIM |
| **Customer communication** | READY WITH CONDITIONS | "Protected" is shown only after proof (074/075 gate). Allowance banners never say Protected while screening is paused (WS3 `636ff31`). Hotfix turns off the "monitored and protected" announcement (`c9e9ab7`). Draft terms §2/§3/§5 await approval and the `TERMS_VERSION` bump (`WS4` §6). Turn-off-forwarding action built; `##21#` fallback unconfirmed per network (WS3-D2) | Andrew approves wording, about 30 min |
| **Financial containment** | READY WITH CONDITIONS | Hard limits in code: per-call `timeLimit`, leases, `£2/24 h` hold, global caps, latching breaker, kill switch (`LAUNCH-PLAN` §2.2). Profile not yet approved: CA-1 Option 1 B £4.20 / T £0 / E £0.10 (`COMMERCIAL-ALLOWANCE-PROPOSAL.md` §7.1). The £25 absolute daily cap is safe only up to about 25 households (WS2 §4). Provider level: only 6 real hard limits exist, and Twilio's is a "leaky" prepaid balance (`PROVIDER-CONTAINMENT-CHECKLIST.md` §1). Master token risk G-6 remains | Andrew: SQL approval plus written acceptance of the master-token risk |
| **Support / ops / monitoring** | READY WITH CONDITIONS | Ops events and alerts exist (new genuine customer, never registered, payment failed, refund, dispute) (`WS4` §8). Financial Control Centre v1 is read-only. Gaps: no operations mailbox (check the dashboard twice a day), alert dedupe is in-memory, reconciliation is a manual offline run, no sweeper watchdog (G-2), admin MFA (WS1 M1+M3) | Andrew: MFA 10 min, daily 15-min review |

### 2a. Carrier reconciliation (evidence, not universal claims)

| Network | Device evidence of forwarding to an HCG/external number | Can a new customer register forwarding today? | Cohort status |
|---|---|---|---|
| **Lebara** | 16 Sep: claimed physical test (code comment only, no artefact). 26–27 Sep: calls reached `…6063` and were delivered; the number dialled was never recorded, so **likely but unproven**. 9 Oct: **external diversion PROVEN** (SIP `Diversion` header, Magrathea CDR `6AC8BAC7JF4CE809`; divert type `reason=unknown`) | **No evidence it can.** Codes were refused on 9 Oct (busy) and 10 Oct (`**61*`). Support says forwarding is unsupported network-wide. Only Lebara's 1211 line could set a forward, and only to Lebara voicemail | **Exclude.** Lebara has carried diversions, so it is unreliable rather than impossible. But a customer can't complete set-up by code, and support won't do it. Mark `unverified` (this blocks payment, `providerPolicy.js:285-289`) until Lebara answers the §2 question in the evidence doc |
| O2, Vodafone pay-monthly | None in repo (first-party documentation only) | Expected yes | **First candidates:** the strongest first-party documentation. Device-prove one before inviting |
| EE | None in repo; `provider_specific`, code `**21*`, no confirmed cancel code | Expected yes | Second wave, after a proof |
| giffgaff, Three | Old "physical-device confirmation" (giffgaff, per a code comment); a giffgaff customer failure on 24 Sep. Both now set up through phone Settings | Settings path only; needs the fix that is not in production | Second wave |
| Sky, Smarty, iD, Talkmobile | None | Unknown | Not in the first 10 |
| Tesco, 1pMobile, Vodafone PAYG, Lyca, VOXI, ASDA | Policy blocks them | — | Excluded (already) |

Each customer's support-verified proof (075) is itself a device proof for that customer and carrier (n=1). The cohort carrier allowlist grows only through those proofs.

## 3. Critical blockers (genuine)

1. **P0 containment on production.** Merge hotfix #52. Archive the £4.99 Price (C1). Take the iOS in-app purchase off sale (C2). Set the OpenAI hard limits (C4). Twilio: auto-recharge off with a £20–30 balance, SMS UK only, voice geo off (C5). Add the `<Reject/>` fallback (C6) and the usage triggers (C7). This is needed whatever the launch decision.
2. **Lebara marked `compatible`.** It must become `unverified`, both in the candidate and as a stop for public sales (C1 covers production until the deploy).
3. **No carrier has proof that forwarding to HCG can be set up today.** We need one attended proof on an O2 or Vodafone pay-monthly SIM (H8b, then H9, then H11).
4. **The 1.0.2 Android build has never run on a handset.** All MUST rows H0–H17 and W1–W5 must pass, especially killed-app answer (H5/W1) and locked phone (H6).
5. **Production runs pre-hardening code.** The window must apply 047, 051–077 and then merge the candidate (B1).
6. **A Play build with in-app Stripe is live.** Halt it, or replace it with an Option C build (vc≥23). Invitees install only from the Internal track.
7. **Financial profile and the residual-risk acceptance.** Approve CA-1, the global caps for N≤25, and a written acceptance of Twilio's lack of a hard cap and the master-token risk (B4/B5).

Not blockers for 10 customers (accept in writing): Play Billing (Option A), iOS 1.0.2, a Twilio subaccount with a restricted key, accounting capture, the operations mailbox, B-11 banner collapse, the trusted-caller bypass, Magrathea, the 40% margin target.

## 4. Minimum safe route to 10 paying customers

**Assumptions.**
- **Price and allowance:** £5.99 including VAT, Stripe on the website only.
- **Fortress profile Option 1:** B £4.20, T £0, U £0, E £0.10, monitoring 1,800 s. That gives a worst case of about £4.44 on the Fortress estimate, about £3.36 billed, against £4.53 net revenue. Expected blended margin is about 34%, not 40%; this is a measurement cohort.
- **Caps:** £2/24 h household hold, 7,200 s maximum call length, global £15/day and £25 absolute (valid while N ≤ 25).
- **Existing customers:** £4.99 subscribers keep their price (CA-4a, exposure ≤ £0.78 each per month).
- **Heavy households:** with 10 customers, the chance that at least one is heavy is about **80%** (1 − 0.85¹⁰). Ask about family call volume at invite and decide the response in advance (CA-3).

**Steps (in order).**

| # | Step | Who | Gate to proceed |
|---|---|---|---|
| 0 | Console containment C1, C2, C4, C5, C6, C7. Read the genuine-customer count. Answer B-13 (what is on each Play track) | Andrew, about 60 min | Evidence screenshots saved |
| 1 | Merge hotfix PR #52, then checks S1–S6 and D1–D5 | Andrew GO, Claude | `/process` returns 404, stream refused, calls still delivered |
| 2 | Send Lebara the question from the evidence doc §2. Check iPhone Recents for 26–27 Sep (£0, 10 min) | Andrew | Recorded; does not block the steps below |
| 3 | On the candidate: Lebara → `unverified`; F-1 `terminate()`; WS4 copy fixes; terms wording; `TERMS_VERSION` bump; suite green | Claude, about half a day | 0 new failures |
| 4 | Staging: apply 075–077 (S0–S1). EAS staging APK vc≥23 from the pinned SHA. One staging call to demonstrate `timeLimit` | Andrew GO, Claude | Grants verified; Twilio ends the leg at `timeLimit` |
| 5 | **Attended handset session:** Motorola with a new **O2 or Vodafone pay-monthly SIM** (Lebara SIM out). H0–H17 + W1–W5, including real forwarding H8b → H9 support proof → H11 forwarding off → H12 | Andrew attended, about 3 h; about £1 in calls | Every MUST passes. Any unexplained missed ring on a warm app = NO-GO |
| 6 | Production window: backup and restore proof, migrations, then D5 profile SQL (Option 1 values), then merge, D7–D12. `NEW_SUBSCRIPTIONS_ALLOWLIST` = the first 5 emails; `PAUSED` stays true until D10 | Andrew GO on each row, Claude | All D rows pass; an uninvited checkout is refused |
| 7 | Production AAB vc = staging + 1 → **Play Internal track only**. Halt or replace any build that has in-app Stripe. On Andrew's household, production check P2 | Andrew | Trusted call and unknown call both pass on production |
| 8 | Invite customers 1–5, **one at a time**, only on the proven carrier(s). Each pays on the website, installs from Internal, gets an attended forwarding set-up, then a support-verified proof. If proof fails within 48 h: forwarding off first, then a full refund | Andrew | Customer N proven before N+1 is invited |
| 9 | 14 days: dashboard twice a day; daily offline reconciliation (Twilio and OpenAI exports); measurements M1–M7 | Andrew + Claude | No stop rule hit |
| 10 | Invite 6–10. Add a carrier only after a customer on it is proven (EE next, then giffgaff via Settings). Raise caps only per WS2 D-4 | Andrew | — |

**Cohort controls.**
- Invite-only: `NEW_SUBSCRIPTIONS_ALLOWLIST`, plus the Play Internal tester list as the second allowlist.
- iOS in-app purchase off sale. The `IOS_COMING_SOON` server gate blocks iPhone checkout on the website.
- Android Option C: no price, link or button in the app.
- A single Railway instance.
- Top-ups off (`ALLOWANCE_TOPUPS_ENABLED`).
- Degraded mode = reject.
- Wording: "Not Protected until verified"; "Screening paused" when the allowance runs out.
- No public promotion, and no "Protect a landline".

**Stop rules (any one → kill switch or pause invites, then investigate).**
1. Reconciliation flags `undercount` or `unmatched_provider`, or provider spend is more than 20% above the ledger.
2. A Twilio trigger fires (£10/day or SMS £2/day), or there is OpenAI spend with no matching calls.
3. A warm app misses a ring with no explanation, or a customer reports missed calls. Clear the proof and pause invites.
4. Any customer is shown "Protected" without a 075 proof row.
5. A trusted caller is refused while the household is in the `normal` state.
6. The breaker trips, or two or more automatic holds fire in a day (cost-limits §stop rule 6).
7. SDK-leg billing appears (`model_gap`): switch to the Option 2 profile the same day.
8. Any Google Play or App Store policy notice.
9. A customer cannot turn forwarding off. Support stays on the line until a native ring is confirmed.

## 5. What must be proven on devices and carriers first, and the cheapest way

| Proof | Why | Cheapest way |
|---|---|---|
| 1.0.2 build answers on Android: foreground, background, killed and locked | No handset evidence for 1.0.2 | One session (step 5) on the Motorola Andrew already owns, on staging (£0.20–0.60) |
| Forwarding to an HCG number registers and carries calls on O2 or Vodafone | No non-Lebara device proof | A £5–10 pay-monthly 1-month SIM (not Vodafone PAYG), used in the same session. First check whether Andrew's old giffgaff SIM (from the 28 Sep incident notes) is still active; it can prove the Settings path for £0 |
| The carrier keeps the caller ID through the divert | 075 requires From = the support phone | Same call, at H9 |
| Forwarding can be turned off by code or Settings, and the phone rings natively again | Honest turn-off promise | H11/W5/W6 |
| Twilio ends the call at `timeLimit` and the fallback is `<Reject/>` | The backstop is undemonstrated | One short staging call (pennies) |
| Lebara: barred SIM or network-wide change? | Decides whether Lebara can ever be included | Recents and Twilio log check (£0) plus a written question to Lebara |

## 6. Approvals needed from Andrew

1. **Now:** console containment C1, C2 and C4–C7. GO to merge hotfix #52 (live screening paused for everyone).
2. Lebara → `unverified` (blocks Lebara payments) and the cohort carrier scope (O2/Vodafone pay-monthly first).
3. Buying a test SIM, and the attended handset session including the forwarding change (H8b/H11).
4. Applying 075–077 to staging; EAS staging APK vc≥23; the staging `timeLimit` call.
5. Price £5.99 (deploy = price cutover), grandfathering £4.99 (CA-4a), and accepting a 34% margin for the cohort (CA-2).
6. Fortress Option 1 profile SQL (CA-1), global caps for N ≤ 25, top-ups off, degraded mode = reject (D-7).
7. Written acceptance of the residual risks: Twilio has no hard cap, the master token is in the backend, and the backstop is unproven until step 4.
8. Android Option C, plus halting or replacing the Play build that has in-app Stripe (B-13).
9. Draft terms §2/§3/§5, customer copy and macros, and the 14-day refund rule.
10. The production window (each 🔴 row) and the invite list (5, then 10).
11. Admin MFA (M1 + M3).
12. Strategic caveat: the architecture reassessment (`docs/strategy/2026-10-10-ARCHITECTURE-REASSESSMENT.md` §4) recommends pausing the live-screening launch until positioning is decided. This route assumes you choose to run a ≤10 measurement cohort of the forwarding product anyway. Containment (approval 1) applies whichever way you decide.
