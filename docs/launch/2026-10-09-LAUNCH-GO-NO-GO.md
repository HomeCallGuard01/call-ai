# Launch GO / NO-GO: 2026-10-09

**Status: read-only audit. Nothing has been deployed, merged, purchased or changed in production or on any console.**

- **Candidate:** `integration/soft-launch-candidate-2026-10-04` @ `ad545a1`, checked in worktree `call-ai-launch-2026-10-09`.
- **Production today:** `eb43368`.
- **Supersedes:** the "where are we" parts of `LATEST-HANDOVER.md` (2026-10-06). The detailed runbooks are still current:
  - `2026-10-05-CONTROLLED-LAUNCH-RUNBOOK.md`
  - `2026-10-05-PRODUCTION-DEPLOYMENT-RUNBOOK.md`
  - `2026-10-05-PRICE-CUTOVER-CHECKLIST.md`

## Verdict

**NO-GO today** for paid customers, even a cohort of five.

**Controlled GO is achievable in about 3–5 working days.** It needs:
- 8 decisions from Andrew;
- 1 small code change (LF-2 support-led proof);
- 1 attended Android handset session;
- 1 production deploy window.

There is no architecture or carrier work on the critical path.

## Evidence gathered today

| Check | Result |
|---|---|
| Full suite at `ad545a1` (inert dummy env, no Stripe key) | **211/212 files, 9,091 checks pass.** The 1 failure is `expo prebuild` resolution through a symlinked `node_modules`. That is a property of the environment, not the code |
| Financial contract FC-1…FC-8 against the real Fortress (pglite) | **7/8 PASS.** FC-3 is a known units mismatch in the gate tooling: Fortress charges max(estimate, actual), and duplicates are still applied once (`docs/integration/2026-10-04-SOFT-LAUNCH-CANDIDATE-FINAL.md:228`) |
| Launch-gate probes PR-01…PR-12 | 12/12 PASS on the candidate. The registry's FAIL counts score `main` |
| Public production site (GET only) | Live and selling at £4.99: `/register.html` and the Play listing link. `/health` returns ok |
| Production code `eb43368` (`git show`) | See P0 below. Verified by hand: `/process` (server.js:843) has no signature check and calls `gpt-4o-mini` even with no household matched. There is no acquisition gate (`NEW_SUBSCRIPTIONS_*` absent) |
| `forwarding_proven_at` writers in the candidate | **None** outside test/preview fixtures. The protection gate reads only this column (`services/lifecycle/activationState.js:154-165`) |

## P0: production is exposed now, independent of launch

Production is open to the public. It has:
- no invite gate;
- no allowance;
- no RevenueCat sandbox guard (a TestFlight purchase buys a real Twilio number);
- no Twilio spend limit.

Production also has two **unauthenticated** spend paths:
1. **Forged `/media-stream`:** `householdId`, `toNumber` and `protectedNumber` are taken from the attacker's `start` customParameters. The result is OpenAI transcription plus an HCG-branded SMS **to any number**. The only limit is the cap of 200 concurrent streams.
2. **Forged `POST /process`:** an OpenAI chat call per request. There is no rate limit.

The candidate fixes both:
- a single-use stream token bound to a signed `/voice`;
- webhook signatures enforced on every Twilio route;
- `/process` off by default;
- Fortress admission on calls, AI, SMS and number purchase.

**None of this protects anyone until the candidate is deployed.**

**Immediate mitigations (Andrew; console only; no deploy):**
1. Pause public sales. Archive the live Stripe Price or Payment Link. Optionally, remove the iOS IAP from sale.
2. Set a hard monthly spend limit on the OpenAI project.
3. Twilio:
   - set a usage trigger on SMS and on total spend;
   - confirm SMS geo-permissions are UK-only;
   - confirm auto-recharge is off and keep the balance low (the only hard stop Twilio offers).

## Genuine launch blockers (cohort of ≤5, Android + Stripe)

| # | Blocker | Type | Owner |
|---|---|---|---|
| B1 | **Production runs pre-hardening code.** The candidate plus migrations 047, 051–074 (25 files) are not in production | Deploy window (runbook exists; staging rehearsed 052→072, 073, 074) | Andrew GO, then Claude |
| B2 | **No 1.0.2 build has ever run on an Android handset.** 5 Oct used the Motorola only as the caller, and the vc22 APK never installed. Last Android device evidence: 1.0.1 Build 19 (27–30 Sep), including an unexplained no-answer on 30 Sep | Attended device session: M-series in `2026-10-05-STAGING-DEVICE-TEST-PLAN.md` §6, plus answering from a killed app and from a locked phone | Andrew attended |
| B3 | **LF-2: no paying customer can ever be shown "Protected".** Nothing writes `forwarding_proven_at`, and 074 only allows the source `'verification_call'` | Decision, then a small code change (below) | Andrew decides |
| B4 | **Provider exposure bounded or accepted (M7/C7/C8):** a `<Reject/>` fallback URL on every production number; a Twilio usage trigger; an OpenAI project limit with evidence; a **written** acceptance of the master-token residual | Console + signature | Andrew |
| B5 | **Fortress production budget numbers (AL-2/C12)** and a kill-switch off/on/off test in production | Decision + audited DB call after B1 | Andrew decides |
| B6 | **Price is contradictory in the docs.** The cutover checklist and the gate say "£5.99 approved 2026-10-04". `docs/finance/HCG_UNIT_ECONOMICS_V1.md` says "candidate; not approved" | Decision (one line) | Andrew |
| B7 | **Live Stripe cutover:** a new tax-inclusive GBP monthly Price; `STRIPE_PRICE_ID`; Stripe Tax UK registration verified; receipts; Portal set to cancel at period end | Console, same window as B1 | Andrew |
| B8 | **Channel risk acceptance (L-1):** Android on the Play *Internal* track, paying through Stripe in-app. Play Payments policy risk; testing tracks are not shown to be exempt | Written acceptance | Andrew |

**Not blockers for five customers** (accept in writing, revisit before scaling):
- Play Billing;
- iOS 1.0.2 (keep iOS out of the cohort, because IAP can't be invite-gated);
- provider containment GREEN (subaccount, restricted key);
- accounting capture;
- operations@ mailbox (check the dashboard twice a day instead);
- lock-screen banner collapse B-11 (customers answer from the notification);
- Magrathea, smart routing, Apple review.

## B3 recommendation: support-led proof for the first five

Use support-led proof, with the first five onboarded personally:
1. Andrew watches the customer set up forwarding.
2. One real call to the customer's own mobile from a phone that is not a trusted contact arrives through HCG (Twilio `ForwardedFrom` = the customer's number).
3. Support records the proof through an audited admin action.

**Code needed, on approval only** (about half a day plus tests):
- migration 075 widens the `households_forwarding_proof_method_check` constraint (column `forwarding_proof_method`) to allow `'support_verified'`;
- an admin route that requires a typed confirmation, records the operator and the evidence call SID, and writes an audit row;
- a "Clear proof" action;
- tests.

The automatic verification-call design (`2026-10-06-LF2-VERIFICATION-CALL-DESIGN.md`) stays post-cohort.

**Alternative:** launch with nobody shown Protected. I don't recommend it: paying customers would see "not protected" indefinitely.

## Fastest safe route

| Day | Step |
|---|---|
| 0 (today) | P0 console mitigations. Decisions B3, B5, B6, B8, B-11, the L-5 refund rule, and carrier scope (recommend Lebara plus one EE/O2/Vodafone pay-monthly carrier) |
| 1 | Claude builds the B3 change on `launch/controlled-launch-2026-10-09` and runs the full suite. Approve EAS builds: production-profile Android vc≥23, plus a staging APK |
| 1–2 | Attended staging session on the Motorola (B2): install; trusted and unknown calls; warning; red line; call screen; killed and locked answer; sign-out reject; kill switch; hold; budget cap. Also one real forwarding setup on a launch carrier (needs approval) |
| 2–3 | Production window (B1, B4, B5, B7): backup and restore proof; migrations 047→075; env (`NEW_SUBSCRIPTIONS_ALLOWLIST` = invited emails, `ALLOWANCE_SOURCE=fortress`, Fortress profile); deploy; signed calls on `…6063`; kill-switch test; Stripe £5.99 cutover; uninvited checkout refused |
| 3–5 | Invite customers one at a time, using the first-five runbook. Review spend twice daily |

---

## Update, later on 2026-10-09: work completed on `launch/controlled-launch-2026-10-09`

Nothing was merged, deployed, purchased or changed in production or on any console.

Full suite: **215/216 files, 9,243 checks.** The only failure is the same symlink-only `expo prebuild` case as the baseline.

| Blocker | Status now | Evidence |
|---|---|---|
| B1 deploy | **Procedure ready.** Railway auto-deploys `main`, so the merge is the deploy and migrations come first. **The deploy publishes £5.99 on the website, terms and guides**, so deploy GO = price-cutover GO | `2026-10-09-PRODUCTION-DEPLOY-PROCEDURE.md` |
| B2 Android handset | **Plan ready.** It adds the killed-app answer (no `getCalls()` cold-start recovery exists), the locked screen, real forwarding and proof end to end | `2026-10-09-ANDROID-HANDSET-VERIFICATION-PLAN.md` |
| B3 Protected | **BUILT** (`c0420d7`). Migration 075 DRAFT plus an audited admin action. The database enforces the evidence rules (answered in app, designated support caller, fresh, current number, attested digits, single use). Tests: 36 database checks, 26 end-to-end checks | `2026-10-09-SUPPORT-VERIFIED-PROTECTION.md` |
| B4 provider exposure | **Checklist ready.** The true HARD limits are separated from alerts. Only 6 controls are real hard limits; Stripe has none | `2026-10-09-PROVIDER-CONTAINMENT-CHECKLIST.md` |
| B5 cost limits | **Values recommended, with exact SQL. The SQL was verified to apply on the real migrations (invariants ok).** £3.60 per household per period; £2/day auto-hold; global £10/day (5 customers) and £15/day (25); £25 absolute | `2026-10-09-COST-LIMITS-RECOMMENDATION.md` |
| B6 price | Andrew: **£5.99 target**; the cutover waits for approval | — |
| B7 Stripe cutover | Unchanged (in the deploy window, D10) | — |
| B8 Play policy | **Compliant route found; no risk acceptance needed.** Cohort: Option C, no buying in the Android app (pay on the website, sign in on the app). Before public Android: Option A, Play Billing via RevenueCat | `2026-10-09-ANDROID-COMPLIANT-PAYMENTS.md` |
| Unauthorised cost | **Verified closed in the candidate.** 63 adversarial checks: every forged case makes 0 OpenAI calls and 0 SMS. Production `eb43368` was demonstrated vulnerable. Two non-spend gaps were fixed (`14bd3aa`) | `2026-10-09-UNAUTHORISED-COST-VERIFICATION.md` |

New findings:
- **Android in-app buying must go for compliance.** That means Stripe Checkout in `subscribe.tsx` and the Billing Portal button in `membership.tsx` (the portal can take a card). The in-app Terms/Privacy links lead to web checkout. The candidate's terms say "in our Android app: through Stripe" and would need one sentence changed.
- **Whatever is live on Play today sells through in-app Stripe**, which is non-compliant now. Check Play Console.
- **The allowlist cannot gate store purchases** (Play or Apple). Keep iOS off sale for the cohort.
- **Margins at £5.99 (Stripe):** typical customer about 26%, light about 51%. Capped worst case about break-even. **£5.99 does not reach the 40% target for a typical customer.** Revisit with real cohort usage.
