# Launch sprint handover (overnight 2026-10-05)

Branch `integration/soft-launch-candidate-2026-10-04`, pushed. Started at `e225151`.

**Nothing was deployed, applied, built, submitted, purchased or sent.** No provider was contacted or changed: Stripe, App Store, Play, RevenueCat, Twilio and OpenAI are untouched, and so are call forwarding and …1883. The staging handset window was not opened.

## Commits tonight

| SHA | What |
|---|---|
| `4b40316` | Apple/RevenueCat cancellation + billing-issue lifecycle, **migration 073 (DRAFT, not applied)** |
| `2b66c36` | £5.99 in source (website, guides, terms, docs), live price-cutover checklist, production deployment runbook |
| `df0933f` | Genuine-customer notifications: milestones #1–5/10/25/50/100, Resend sender with idempotency, 15-min schedule (all OFF) |
| `2e3463d` | iOS / Android release prep, accounting + ops launch minimum, screenshot capture pipeline (`--final`) |
| `f7a9ecf` | Stop-acquisition switch + invite-only cohort gate; controlled-launch go/no-go runbook |

**Verification at `f7a9ecf`:**
- full suite **208/208 files, 9,049 checks, 0 failures**, including the real-PostgreSQL suites;
- mobile `tsc` **0 errors**;
- migration numbering clean (69 files, 30 rollbacks);
- the launch gate still reports **CLOSED** for an unrestricted launch (correct; no gate weakened).

## Documents to read (in order)

1. `docs/launch/2026-10-05-CONTROLLED-LAUNCH-RUNBOOK.md`: **the master go/no-go** (L-1 cohort decision, M1–M14).
2. `docs/launch/2026-10-05-STAGING-DEVICE-TEST-PLAN.md`: tomorrow's test (unchanged).
3. `docs/launch/2026-10-05-PRODUCTION-DEPLOYMENT-RUNBOOK.md`: 047 → 073, 24 files, no `--include-all`.
4. `docs/launch/2026-10-05-PRICE-CUTOVER-CHECKLIST.md`
5. `docs/launch/2026-10-05-ACCOUNTING-OPS-LAUNCH-MINIMUM.md`
6. `docs/releases/2026-10-05-IOS-102-RELEASE-PREP.md`, `docs/releases/2026-10-05-ANDROID-RELEASE-PREP.md`
7. `docs/operations/2026-10-05-APPLE-STORE-LIFECYCLE-073.md`

---

## MORNING REPORT

### DONE

- **£5.99 audit + source cutover.** Every customer-facing £4.99 is now £5.99: homepage (including the JSON-LD offer), 12 guides (CTAs now price-free), terms (+ Apple payment, cancellation and refund wording, a forwarding warning on cancel), `MARKETING_FACTS`, launch docs, Play description. Silent £4.99 fallbacks in admin/finance now use the economics register. **A test now fails if any homepage, terms or guide page mentions 4.99.** The apps already read the price from StoreKit or Stripe. **Not deployed; no provider changed.**
- **Exact live-cutover order** written, so £4.99 can't be left behind:
  1. backend first;
  2. a new **tax-inclusive** live Stripe Price and the `STRIPE_PRICE_ID` switch;
  3. Stripe Tax, receipts and Portal;
  4. App Store price change **only after 1.0.2 is live**.
- **Apple lifecycle (073):**
  - Apple cancellation shows "Cancelled — protection continues until [date]". Access is never cut early; only EXPIRATION ends it.
  - A billing problem shows "Payment needs attention".
  - Sandbox events can never touch production rows.
  - Refunds are recorded and alerted.
  - One shared membership derivation for web and app (the Stripe logic is byte-for-byte unchanged).
  - 073 was verified free on every branch and worktree; idempotent; the rollback refuses while billing history exists.
- **Genuine-customer notifications:**
  - Each genuine customer is numbered; **#1–5, 10, 25, 50, 100 say "MILESTONE"**.
  - Reviewer, internal, sandbox, unverified, Stripe-test and complimentary accounts never notify.
  - A retry can't double-send (idempotency key).
  - 5 failed attempts → visible as failed.
  - Not on any customer path.
  - Startup refuses email ON without Resend + an operations recipient.
  - Everything is OFF until you switch it on.
- **Production deployment runbook:**
  - The collision analysis is resolved: the candidate's sequence is clean; the cross-branch "collisions" are all superseded side branches.
  - Production is at 046, so 047 → 073 applies monotonically.
  - **070 keeps the exact function signature, so the currently running backend stays compatible during the gap.**
  - The runbook covers backup + restore rehearsal, verification queries, and stop/rollback rules.
- **Controlled-launch runbook:**
  - MUST-before-first-customer, acceptable temporary limitations, MUST-before-scaling;
  - stop-acquisition and incident procedure, with what each lever does to customers' calls;
  - provider-spend, first-customer and weekend monitoring.
- **New controls (built, tested, OFF by default):**
  - `NEW_SUBSCRIPTIONS_PAUSED=true` stops new paid sign-ups;
  - `NEW_SUBSCRIPTIONS_ALLOWLIST` makes checkout invite-only.
  - Existing customers, renewals and calls are unaffected.
- **iOS prep:**
  - corrected, price-free store copy;
  - claims audit (removed "no delays", "ends the call", the trusted-number spoofing implication);
  - Build ≥ 17 checklist;
  - **screenshot pipeline:** frames 03/05/06/07 take real captures, and `--final` exports 6.9" + 6.5". It refuses (DRAFT) while any capture is missing. The approved 8-frame design is unchanged except frame 04's banned "no delays" line.
- **Android prep:** Play payments options assessed, vc ≥ 23 checklist, listing and permission audit, Play Billing gaps identified (the RevenueCat webhook would label a Play purchase as Apple).
- **Accounting/ops:** capture can stay OFF for the first five (Stripe + ASC are the records); separation rules; support/refund gaps listed.

### NEEDS ANDREW (batched: 4 replies)

**Reply 1: decisions (one line each)**
1. **L-1 cohort channel:** (A) Android via Play *Internal* + Stripe, with written risk acceptance [recommended if tomorrow's Motorola test passes] / (B) iOS when Build ≥ 17 is approved / (D) slip.
2. **D-P2:** existing £4.99 subscribers keep £4.99 (recommended).
3. **D-P3:** approve the terms changes as written (`public/terms.html`; the price-change clause is unchanged).
4. **L-5 cohort refund rule:** full refund on request within 14 days, refund + cancel together (recommended).
5. **D-A1:** Apple refund keeps access until support acts (recommended).
6. **B-11:** accept the Android lock-screen banner collapse for the cohort (recommended, recorded).
7. **I-2 / I-3 / I-4 / I-10:** frame 05 captured later on Build 17; show the allowance meter; replace frame 02's "Your bank" card; fix the one Home string "Blocked a suspected scam call". All recommended.

**Reply 2: "GO staging window"** (tomorrow's device test; as in the plan) **plus GO to apply 073 to staging** in the same window.

**Reply 3: provider and console checks (you only; about 15 min)**
- Play Console: what is live on **Production** (B-13)? Was the foreground-service declaration filed?
- ASC: the current live subtitle and keywords.
- Stripe: is Stripe Tax registration active in live mode?
- OpenAI: set a project spend limit.

**Reply 4: the accountant email** (AD-1…4, text in the accounting doc). Send whenever convenient.

### NEEDS DEVICE TEST

- iPhone Build 16 end-to-end (T-series), Motorola vc 22 (M-series).
- Screenshot captures 03/06/07 (and 05, per I-2).
- iPhone `**21*` auto-dial behaviour (decides the forwarding wording).
- Production smoke test on Build 17 / vc 23 after deploy.

### NEEDS PROVIDER

- Stripe: new live £5.99 tax-inclusive Price, Stripe Tax live, receipts on, Billing Portal at period end.
- Twilio: `<Reject/>` fallback on production numbers, a usage trigger.
- OpenAI: project spend limit.
- ASC: £5.99 IAP price, only after 1.0.2 is live.
- Play Console / RevenueCat: Play Billing product + RevenueCat Android app (if A-2).
- Resend / mailbox: operations@ mailbox.

### BLOCKS FIRST 5 CUSTOMERS

Runbook M1–M14, all RED:
- device test passed (M1);
- 073 on staging (M2);
- production backup (M3), migrations (M4), backend + first signed call (M5);
- Fortress production budgets (M6);
- provider exposure bounded/accepted (M7);
- live £5.99 + VAT evidence (M8);
- invite list set (M9) and stop switch tested (M10);
- notifications on (M11);
- support + refund rule (M12);
- a store build for the chosen channel (M13);
- admin login on production (M14).

### BLOCKS SCALING

- Twilio subaccount and a restricted runtime key (master token offline).
- Play Billing.
- iOS 1.0.2 live, with real screenshots and the £5.99 IAP.
- Accounting capture in shadow mode + accountant answers.
- operations@ + notification email.
- Allowance and price-change wording in the terms.
- Staging G-items GREEN.
- A week of clean cohort evidence.

---

## Safety notes from tonight

- An accidental `node -e "require('./server.js')"` was started in the candidate worktree while checking module loading. It had no `.env` or credentials, exited by itself, and nothing was listening. I verified no stray process remained, and an unrelated pre-existing node process (PID 946) was left alone.
- All four research reviews were read-only. Their findings are folded into the documents above.

---

# MORNING REPORT 2 (after the attended device test, night of 5→6 Oct)

Commits (pushed): `f01fd8d` DT-1 call screen · `1db5d53` DT-2 wording · `015bd01` evidence · plus the mobile-app test locator fix.
Details:
- `docs/launch/2026-10-05-DEVICE-TEST-EVIDENCE.md`
- `docs/launch/2026-10-05-DT2-ALLOWANCE-AND-ECONOMICS.md`

## RESET CONFIRMED

- …1883 made inert **first**: Voice URL, fallback, status callback and SMS URL all empty (read back 18:24:26 UTC).
- Staging fixtures restored from the recorded originals: phone `…0456`, status `pending`, device and network empty, original email, unlinked.
- Motorola contact removed; temporary login and its role deleted; window secrets file deleted.
- Server, tunnel, keep-awake and iPhone log capture stopped (PIDs verified).
- Fortress: kill switch off, breaker closed, 0 holds, 0 live calls, £0 reserved, invariants OK.
- Twilio for the window: exactly 2 inbound + 2 app legs, **0 SMS**.
- **Production identical** to the start-of-window snapshot.
- Andrew's mobile service and call forwarding were never touched.
- **Andrew was told SAFE TO UNPLUG IPHONE.**
- Kept as evidence: call rows, `voice_client_registered_at` / `delivery_verified_at` on the staging household, and migration **073 applied to staging**.

## TONIGHT'S DEVICE TEST RESULT

- **PASS:**
  - Build 16 launch and staging sign-in;
  - account number HCG-00010306;
  - Membership / Contacts (Motorola listed) / Help & Account;
  - setup 4 of 5;
  - iOS VoIP registration (mic granted);
  - **Motorola → …1883 → HCG → iPhone rang, answered, two-way audio**, on two separate trusted calls (42 s, 41 s).
  - Each call followed known contact → no monitoring → push → presented within about 1.5 s → answered → delivered.
- **FAIL (usability):** DT-1.
- **Diagnosed:** DT-2.
- **Not run:** T7 (true background), T8 (locked), T9–T23; Motorola.

## DT-1 ROOT CAUSE

- The calls were answered on the CallKit banner of an unlocked iPhone. iOS then brought HCG to the foreground (log: 19:13:28.9), which is iOS's design: the app is expected to show its own in-call screen.
- **HCG had none, and `voiceClient` never kept the answered call.** Andrew lost the obvious way to hang up and ended from the Motorola.
- CallKit itself worked correctly.

## DT-1 FIX

- **Change (`f01fd8d`):**
  - `voiceClient` now tracks the accepted call (listener-only; ringing and answering unchanged);
  - a full-screen **"Call in progress"** screen at the app root shows the caller, a timer, a **big red labelled "End call"**, **Mute** and **Speaker**, plus plain guidance if a control fails.
- **How it works:** End uses `Call.disconnect()`, which on iOS is the SDK's **CallKit end-call transaction**, so iOS and the app stay in step. Speaker uses the SDK's audio-device API.
- **Verified:** `tests/mobile-active-call.test.mjs` (28 checks); `tsc` 0; iOS bundle export OK.
- **Build 17 must prove it on a device** (see below).

## DT-2 ROOT CAUSE

- The 88% was correct arithmetic: two calls × £0.01239 = £0.02478 of a **£0.20** staging budget.
- There was no duplicate metering; reserves were released; 0 live reservations.
- The meter is **£-based** (Fortress), but the wording said "call checking" and "**calls from people you trust don't use it**". That is **false on the £ basis**: the 12% came entirely from trusted calls. The 100% email also said "calls still reach you" even when the trusted-only reserve means other calls can be refused.

## DT-2 CUSTOMER-UI FIX/RECOMMENDATION

- **Change (`1db5d53`):**
  - the server sends `basis` (`protection_spend` / `monitored_minutes`) and `trustedCallsUseAllowance`, and **no minute figure on the £ basis**;
  - the app meter, web dashboard and 75/90/100% emails say **"protection allowance"** and explain plainly that every handled call uses some of it;
  - they never promise minutes or exempt trusted calls;
  - the 100% email states the real refusal behaviour and how to get calls back.
- **Unchanged:** warning points and Fortress maths, budgets and reservations.
- **Guards:** `tests/allowance-truthful-wording.test.mjs` plus a startup warning if the production meter wouldn't match enforcement.

## UNIT-ECONOMICS / ALLOWANCE DECISION

**A genuine commercial issue, now confirmed by real calls:**
- a trusted call of 60 s or less costs **£0.01239** at the Fortress estimate (10 s costs the same as 60 s);
- the safe budget at £5.99 is **£1.07** (Stripe) / **£0.74** (stores); at Fortress basis £1.54 / £1.06 that's about 124 / 86 short calls, or 131 / 90 trusted minutes;
- the model's typical household (150 trusted + 40 unknown min) **exceeds** this;
- trusted minutes on HCG's bill are the root cause; only network-side routing (C5) fixes it.

**Decisions before the first five:**
- **AL-1** `ALLOWANCE_SOURCE=fortress` in production;
- **AL-2** production profile values (= C12; recommended C2-style £1.54 Stripe-basis profile with trusted reserve, watched weekly);
- **AL-3** wording sign-off and one terms sentence;
- **AL-4** Apple SBP.

Nothing has been set or activated.

## OTHER LOG FINDINGS

- **LF-2 (High, launch-blocking): a customer can be shown "Protected" without call forwarding.**
  - Reproduced on the device: after the first call the household was `protected` although …2700 forwards nothing.
  - **Any** inbound call to the HCG number stamps "forwarding verified" (direct dials and stray calls included).
  - Twilio's `ForwardedFrom` can't distinguish a forwarded call (184 production calls checked on 8 Sep).
  - **Options:** **A** a verification call to the customer's own mobile (needs an allow-listed outbound path; design change); **B** stop auto-stamping on arbitrary calls; **C** honest Home wording until A.
  - Not implemented: needs Andrew's decision.
- **LF-3 (Medium):** "App ready" was ticked from another device's old registration before the iPhone registered. Fold into the LF-2 design.
- **LF-1 (Medium, latent):** the Supabase session exceeds Expo SecureStore's 2048-byte guidance (warning in the log); a future SDK could sign customers out. Fix before the next SDK upgrade.
- **Clean:**
  - no duplicate events, no server errors or retries;
  - registration recovered correctly;
  - CallKit normal;
  - reservations correct;
  - Fortress estimates ≥ Twilio actual durations;
  - no SMS, no uncontrolled cost.

## AUTOMATED TEST RESULTS

- Full suite **210/210 files, 9,092 checks, 0 failures**, including the real-PostgreSQL suites (15 / 10 / 9).
- Mobile `tsc` 0 errors.
- Migration numbering clean (69 files).
- New: `mobile-active-call` (28), `allowance-truthful-wording` (13).
- One existing test (`mobile-app`) had its source locator made precise after DT-1; the property it guards is unchanged.

## NEEDS DEVICE RETEST (Build 17 must prove)

1. **DT-1, iPhone unlocked, HCG in the foreground:**
   - answer on the banner → the "Call in progress" screen appears;
   - **End call** hangs up (the Motorola hears the call end);
   - Mute (the Motorola can't hear) and unmute;
   - Speaker on and off.
2. DT-1, HCG in the background (true T7) → the same screen when HCG is opened; End works.
3. DT-1, **locked** (T8) → iOS's own full-screen call UI with End. After unlocking, the HCG screen is consistent and ends correctly.
4. The remote party hangs up → the screen disappears by itself; a second call starts clean (not muted).
5. DT-2: the meter reads "Protection allowance this month" with the explanation; no "minutes" or "trusted don't use it" anywhere.
6. The rest of the plan (T9–T23): monitored unknown call, warning, red line, hold (D-C5 wording), kill switch, sign-out / reconnect, backend down.
7. LF-2: once decided, prove the chosen forwarding proof (T12 with forwarding approved).
8. Then the Motorola (Android vc 22/23) section.

**Build 17 is NOT created.** Build numbers 17+ are free. *(Superseded: see Morning report 3. Build 17 was created and uploaded on 2026-10-06.)*

## BLOCKS FIRST 5 CUSTOMERS

Everything in runbook M1–M14, **plus**:
- **LF-2 decision and fix** (no customer may be shown Protected on today's evidence);
- **DT-1 proven on Build ≥ 17**;
- **AL-1/AL-2 allowance decisions** (production profile = C12).

## BLOCKS SCALING

As before, plus:
- the trusted-minute economics: C5 network-side routing, or a pricing change, after real usage data;
- LF-1 session-storage fix before the next Expo SDK upgrade.

## RECOMMENDED NEXT ACTION TOMORROW

1. Decide **LF-2** (A + B recommended) and **AL-1 / AL-2**.
2. Approve the **Build 17 (staging)** build from the current branch so DT-1 can be proven.
3. Book a short attended window for items 1–6 above (and T12 forwarding, if LF-2 option A is chosen).

---

# MORNING REPORT 3 (2026-10-06): LF-2 B+C, Build 17

## DECISIONS APPLIED (Andrew, 2026-10-06)

- **LF-2 B+C: implemented** (`ee3fab1`).
  - An inbound/direct call no longer counts as forwarding proof. `activation_verified_at` is now evidence only.
  - New column `forwarding_proven_at` (migration 074) is the only forwarding-gate input; nothing writes it yet.
  - New stage `forwarding_unconfirmed` with truthful wording in the app, web and legacy step list. Admin/ops get `FORWARDING_NOT_PROVEN` / `forwarding_not_proven`.
  - **Consequence: nobody is shown Protected until forwarding proof exists.**
- **LF-2 option A: design only.** See `docs/launch/2026-10-06-LF2-VERIFICATION-CALL-DESIGN.md`. Nothing implemented, enabled or purchased.
- **AL-1 approved and preserved:** the meter shows the real enforced protection allowance, with no minutes promise.
- **AL-2 NOT approved:** no £1.54 or other production budget, pending the AQL carrier discussion.
- DT-1 and DT-2 fixes preserved.

## MIGRATION 074

DRAFT. **Not applied anywhere** (staging has 052–073; production untouched). Additive, nullable, idempotent; the rollback refuses while proof is recorded. Pglite test: 8 checks.

## BUILD 17

- iOS 1.0.2 (17), STAGING only, from `ee3fab1`.
- EAS build `eeccee2e…` FINISHED.
- EAS Submit `920f523d…` FINISHED 07:36 UTC with no error: internal TestFlight upload only.

Details are in `docs/releases/2026-10-04-STAGING-TEST-BUILDS-1.0.2.md`.

## BUILD 17 MUST PROVE (next attended window, not started)

1. DT-1 foreground, background (T7) and locked (T8): End, Mute, Speaker. The screen auto-dismisses on a remote hang-up, and the next call starts unmuted.
2. DT-2: "Protection allowance this month" wording.
3. LF-2: the staging household shows "can't yet confirm your phone's call forwarding" and **never Protected**.
4. T9–T23, then the Motorola section.

## AQL INPUTS (discussion today)

- Can trusted calls bypass HCG's Twilio legs network-side? That decides £5.99 trusted-minute economics and AL-2.
- Per-minute rates.
- CLI preservation on diversion.
- Can the carrier expose diversion state? That would give genuine forwarding proof, an alternative to option A.
