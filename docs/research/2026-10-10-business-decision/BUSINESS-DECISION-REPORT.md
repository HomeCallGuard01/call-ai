# Home Call Guard: business decision report (2026-10-10)

**Lead engineer synthesis** of six independent workstreams. All are research only: no production changes, calls, purchases or provider contact.

| Agent | Report |
|---|---|
| 1 Providers | `AGENT-1-TELECOM-PROVIDERS.md` |
| 2 Number pooling | `AGENT-2-NUMBER-POOLING.md` |
| 3 Telephony engineering | `AGENT-3-TELEPHONY-ENGINEERING.md` |
| 4 Financial model | `AGENT-4-FINANCIAL-MODEL.md` (+ `scripts/research/business-decision-model.mjs`) |
| 5 Launch readiness | `AGENT-5-LAUNCH-READINESS.md` |
| 6 Independent challenge | `AGENT-6-INDEPENDENT-CHALLENGE.md` (its corrections are applied throughout) |

**Data gaps that limit confidence:**
- **The AQL September 2026 rate card is missing** (searched every worktree and the home folder). The AQL comparison is **incomplete**, and no AQL price is used anywhere.
- **Usage is unmeasured:** there are 0 genuine paying customers.
- **Two Twilio billing points are unconfirmed:** whether BYOC, SIP-interface and SDK legs are each billed, and whether number rental is £0.87 (as invoiced) or $3.50 (current list).

## 1. Recommendation

**Launch after a short engineering change (about 2–3 weeks), on today's architecture (A), as a 10-customer measurement cohort. Not "launch now", and not "delay".**

**Not "launch now".** Production `eb43368` has *demonstrated* defects, not just missing evidence:
- two unauthenticated paid endpoints (forged `/media-stream`, unsigned `/process`);
- open public sales with no invite gate;
- Lebara marked `compatible`;
- a live Play build that takes Stripe in-app (against Play policy);
- no Twilio `timeLimit` and no signature check on `/voice`;
- no Fortress.

**Not "delay".** Every cheaper architecture is either:
- weeks to months of build (B2 self-hosted delivery: 75–130 person-days; pooled C′: 28–47 person-days);
- dependent on unconfirmed Twilio billing (B1 BYOC could even cost more than today);
- a 12–24-month partnership track (E).

None can be operated within a month.

**The "short engineering change" is mostly already built.** It is the integrated launch candidate:
- containment hotfix;
- signed webhooks;
- single-use stream tokens;
- Fortress hard limits;
- support-verified Protected;
- Play-compliant Android.

What remains is **evidence and deployment**, not invention:
- the Android handset session;
- one non-Lebara carrier forwarding test;
- the production window.

**Forwarding.** Missing evidence for new-customer forwarding is **not** a demonstrated failure.
- *Proven:* the Lebara network diverted to an external number on 9 Oct (SIP `Diversion` header), and 184 real calls have reached HCG numbers (carriers unrecorded).
- *Demonstrated failure:* registering forwarding **by code** on Lebara (9 and 10 Oct), plus Lebara support's statement.
- *Missing evidence:* EE, O2, Vodafone, Three and others.
- **So forwarding proof is a cheap precondition per carrier, not a launch blocker.**

## 2. Monthly cost and margin by option, at £5.99

Figures are contribution £ (CM%) / fully loaded £ per month (Agent 6 corrected).

| Option | 10 customers | 100 customers | 1,000 customers | Price for 40% CM | Can run within a month? | Confidence |
|---|---|---|---|---|---|---|
| **A** Twilio, candidate code | £15 (30%) / −£77 | £151 (30%) / −£90 | £1,504 (30%) / −£237 | **£7.82** (£10.88 if Twilio bills the SDK leg; £13.89 at the $3.50 list number) | **Yes** | Medium on unit prices; low on usage |
| **B1** Magrathea → HCG SIP edge → Twilio SIP/BYOC → SDK | £25 (50%) / −£312 | £250 (50%) / −£192 | £2,486 (50%) / +£594 | £4.33 (£7.16 SDK billed; £8.97 if every Twilio leg stacks) | No (edge build + questions) | **Low**: Twilio billing unconfirmed |
| **C′** pooled Magrathea numbers (≤10 households each) via edge → Twilio | £29 (57%) / −£312 | £290 (58%) / −£196 | £2,893 (58%) / +£951 | ≤ £3 (£5.56 SDK billed) | No (28–47 person-days + per-network tests) | **Low**: `Diversion` proven on n = 1 |
| ~~C pooled Twilio numbers~~ | — | — | — | — | — | **Invalid**: Twilio exposes no diverting line (184/184 calls) |
| **B2** Magrathea + self-hosted app delivery | £33 (66%) / −£404 | £332 (66%) / −£210 | £3,306 (66%) / +£1,314 with unpaid founder on-call; +£314 with £1k/month ops; −£2,686 with £4k/month ops | ≤ £3 | No (75–130 person-days solo) | Low |
| **D** direct-to-app as a full Twilio replacement | Same economics as B2; it *is* B2's delivery half | | | | No | Low |
| **E** network/MNO partner | £19 (38%) / −£68 | £190 (38%) / −£10 | £1,892 (38%) / +£567 | £6.30 (placeholder partner fee) | No (12–24 months) | **Not decision-grade** (no partner, no quote, AQL missing) |

**How "cost is bounded":** per-customer Fortress budgets **pause screening and then refuse calls** when exhausted. Under A, heavy households get only about 45% of their demand at £5.99, and that applies only in the undeployed candidate. Production has no such bound, Twilio has no spend cap, and the master token remains.

## 3. Can £5.99 be kept?

**Not at a 40% margin on today's architecture.**
- A gives about 30% contribution at £5.99 and never breaks even fully loaded. 40% needs about **£7.82 (in practice £7.99)**, assuming Twilio keeps billing as invoiced today.
- £5.99 becomes realistic only by moving inbound to a free-inbound carrier (B1/C′) at **about 250+ customers**, *if Twilio confirms favourable BYOC/SIP billing*, or by B2 at a scale where operations are funded.

**Decision for Andrew:**
- **(i)** £7.99 for the cohort, which meets 40% on current costs; or
- **(ii)** £5.99 as an explicit **bounded-loss measurement cohort** (about −£80–£90/month fully loaded at 10–100 customers), with a price checkpoint at day 45 or 25 household-months.

## 4. Strongest number-pooling opportunity and its limits

- **Opportunity:**
  - A small pool of **Magrathea-hosted numbers (≤10 households each)**, identifying the household from the SIP `Diversion` header at an HCG SIP edge.
  - It saves about **£0.45 per customer per month** against dedicated Twilio numbers, **but £0 below about 200 customers** because of Magrathea's £100/month minimum.
  - A dedicated SIP number per customer gives most of the same saving with less risk.
- **What is proven:** a single call (Lebara via the Vodafone network → Magrathea, 9 Oct) carried the diverting mobile in `Diversion` (`screen=yes;reason=unknown`; no PAI or History-Info).
- **Demonstrated failure:** pooling on **Twilio PSTN numbers** (`ForwardedFrom` = the Twilio number on 184/184 calls).
- **Needs carrier testing:** EE, O2, Vodafone retail, Three and MVNOs, each divert type, and repeatability.
- **Limits:**
  - **No added capacity.** Channels are per trunk or account (about 26–43 channels at 1,000 subscribers; 10 households on a 10-channel number is safe).
  - **Spoofable.** `Diversion` has no integrity protection, so use it as a **check, not a routing key**.
  - **A missing header under unconditional forwarding means the customer gets no calls at all.**
  - **Re-homing a household needs the customer to redial `**21*`.**
  - **Each household loses its own per-number cost limit.**
- **Smallest safe test:** one call per network to the existing Magrathea trial number, with the endpoint logging headers and **rejecting without answering**. About £0 per call plus about £10 per SIM (about £80 for 8 networks).
  - The Magrathea server still exists (services stopped), so it can be reused.
  - Every test needs approval.

## 5. Built and working vs unproven

| Status | Items |
|---|---|
| **Working in production** | Forwarded calls reach HCG numbers (184 calls); trusted calls ring the app; unknown calls monitored by AI; Stripe £4.99 billing; iOS 1.0.1 live |
| **Built, tested, not deployed** (launch branch) | Containment hotfix (draft PR #52); signed webhooks; stream tokens; Fortress per-customer and global hard limits with live-call bounding (≤ about £0.85/household worst case after server death); support-verified Protected (075); allowance states (076); top-up revenue bound (077, off); Android cold-start recovery; Play-compliant Android (Option C); invite allowlist; Financial Control Centre; 237/238 test suite |
| **Proven by test, not in product** | Silence → no-answer forwarding on Lebara/Android 10 (Test A); Magrathea free inbound with a `Diversion` header (9 Oct) |
| **Unproven** | 1.0.2 on an Android handset; new-customer forwarding on any non-Lebara network; Twilio's own `timeLimit` enforcement when HCG is dead (staging test designed); Twilio BYOC/SIP/SDK billing; Magrathea at volume; pooling identity beyond n = 1; all usage profiles |
| **Not built** | HCG SIP edge; self-hosted app delivery; Play Billing; web top-ups |

## 6. Critical launch blockers (demonstrated, not speculative)

1. **Production containment:** merge the hotfix (PR #52), plus console steps C1–C7 (archive the £4.99 price, iOS IAP off sale, OpenAI hard limit, Twilio low balance with auto-recharge off, UK-only SMS, `<Reject/>` fallback).
2. **Carrier label:** Lebara must not stay `compatible`. Agent 6 recommends `incompatible`, with reason text recording the 9 Oct diversion; both labels block payment. **Your decision.**
3. **Android 1.0.2 must pass the handset plan** (never run on a device).
4. **Production window:** migrations 047, 051–077, deploy, Fortress profile and **scaled** global caps, then the £5.99/£7.99 Stripe cutover.
5. **The live Play build with in-app Stripe** must be halted or replaced by the Option C build.
6. **Written acceptance** that Twilio has no provider-side cap and the master token stays, for this cohort only.

Missing evidence (a precondition, not a blocker): **one non-Lebara carrier proven end to end**, using an O2 or Vodafone pay-monthly SIM.

## 7. Fastest safe path to 10 paying customers (about 2–3 weeks, each step with your GO)

1. **Day 0–1:**
   - merge the containment hotfix (PR #52) and run the post-deploy checks;
   - console steps C1–C7;
   - decide the Lebara label;
   - send the written questions to **Twilio** (BYOC, SIP and SDK billing; number price) and **Magrathea** (volume terms, `Diversion` per network).
2. **Day 2–4:** staging migrations 075–077 and the staging APK, then one attended **Motorola session**: delivery, killed/locked app, call screen, allowance banners, kill switch, support-verified proof. Swap in an **O2 or Vodafone pay-monthly SIM (about £5–10)** for the real-forwarding step, because Lebara can't register forwarding.
3. **Day 5–6:** production window (backup, migrations, Fortress profile and caps, merge, smoke checks, kill-switch drill, signed calls on `…6063`), the price cutover, and the production AAB to Play Internal.
4. **Day 7–14:** invite **5 customers one at a time**, only on networks with device proof. Each gets a support-verified proof. Spend reviewed twice daily.
5. **Day 15–21:** if there are 14 clean days and no stop rule has fired, go to **10**. Measure real trusted and monitored minutes per household.

**Stop rules:** a priced anomaly, a breaker trip, a delivery failure, a Fortress invariant failure, or spend near caps → pause sales, then use the kill switch if needed.

## 8. 30-day plan, in priority order

| Week | Engineering | Business |
|---|---|---|
| **1** | Containment; Lebara label; Android staging session; one non-Lebara carrier test; the **Twilio "dead server" `timeLimit` staging test** (under £0.15) | Twilio and Magrathea written questions; AQL rate card into the repo; price decision (i or ii) |
| **2** | Production window; Play Internal build; Financial Control Centre live; daily reconciliation | First 5 invites; support macros; refund rule |
| **3** | Measure usage; fix what the cohort reveals; **decide R1 vs R2** from the Twilio and Magrathea answers | Cohort to 10; collect willingness-to-pay signals |
| **4** | If Twilio billing is favourable: **prototype B1** (SIP edge on Magrathea → Twilio SIP, about 20–35 person-days, starting with one number). Otherwise plan B2 scope. Per-network `Diversion` probe (about £80 in SIMs) if pooling is still of interest | Day-45 price checkpoint prepared with real data; MNO partnership outreach (long track, optional) |

## 9. Decisions and approvals needed from Andrew

1. **GO to merge the containment hotfix (PR #52)**, plus console steps C1–C7.
2. **Lebara label:** `incompatible` (recommended, with the evidence noted) or `unverified`.
3. **Cohort price:** £7.99 (meets 40%) or £5.99 as a bounded-loss measurement cohort, with day-45 review. Existing £4.99 subscribers stay grandfathered.
4. **Allowance profile** (Option 1: £4.20 budget, as amended for a trusted reserve drawn first) and **scaled global caps**.
5. **Written risk acceptance:** no Twilio hard cap and the master token stays, for ≤10 customers.
6. **Purchase approval: one O2 or Vodafone pay-monthly SIM** (about £5–10) for the carrier test.
7. **Staging session GO** (migrations 075–077, staging APK, attended Motorola session, Twilio `timeLimit` test).
8. **Production window GO** (migrations, deploy, price cutover, Play Internal).
9. **Send the Twilio and Magrathea questions**, and supply the **AQL rate card**.
10. **Magrathea server:** keep it for the per-network tests, or delete it after Magrathea confirms un-routing.
