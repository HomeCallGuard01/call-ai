# Financial containment design and remaining launch blockers (2026-10-10)

**Status:** design plus code on branches. **Nothing deployed, merged, purchased or sent.**

**Andrew's decisions applied:**
- live AI monitoring stays;
- cohort of ≤ 10, on the existing architecture initially;
- Lebara **unverified**;
- **£7.99 provisional**, with no store price changes;
- no top-ups in the first cohort;
- **no uncapped Twilio or AI exposure, even for 10 customers.**

## 1. £7.99 provisional price: VAT, fees and costs

**Per customer per month:**

| Item | Stripe (web) | Play 15% | Apple 15% (SBP) | Apple 30% |
|---|---|---|---|---|
| Gross incl. VAT | £7.99 | £7.99 | £7.99 | £7.99 |
| VAT (20%, = gross ÷ 6) | £1.33 | £1.33 | £1.33 | £1.33 |
| Net of VAT | £6.66 | £6.66 | £6.66 | £6.66 |
| Payment fees | £0.42 (1.5% + 20p + Billing 0.7% + Tax 0.5%) | £1.00 | £1.00 | £2.00 |
| **Net revenue** | **£6.24** | **£5.66** | **£5.66** | **£4.66** |

**Cost, architecture A (Twilio), from the Agent 4/6 calculator `scripts/research/business-decision-model.mjs`:**
- Contribution margin about **41%** at every scale, on the invoiced Twilio prices: inbound £0.00756 per started minute, app (SDK) leg £0, number £0.87.
- Fully loaded per month: **−£64 at 10 customers, −£22 at 50, +£31 at 100**. That includes £75/month platform and about 4 support minutes per customer per month.
- **Sensitivities:**
  - SDK leg billed at list ($0.004/min): about **30%** contribution;
  - Twilio's current list number price ($3.50/month instead of the invoiced £0.87): lower again;
  - usage doubled: lower.
- Both Twilio billing points are in the Twilio questions (§6).
- Usage is **unmeasured**: 0 genuine paying customers.

**Conclusion:** £7.99 meets the 40% *contribution* target on today's invoiced prices. It is not yet profitable fully loaded below about 100 customers. A Twilio billing change would push it below 40%.

## 2. Containment: application controls vs provider-enforced limits

**Application controls** (HCG code; built and tested; **only active once the launch candidate is deployed**):
- signed webhooks on every Twilio route;
- single-use stream tokens;
- `/process` off;
- Fortress per-household budget, trusted reserve and essential pool, with live-call leases and `<Dial timeLimit>` from headroom;
- global £/hour and £/day caps (scaled per stage) with a latching breaker that ends live calls;
- kill switch, household holds, incident modes;
- abuse and admission limits;
- number-purchase caps;
- SMS segment-accurate charging;
- egress guard (no `<Dial>` without a valid `timeLimit`);
- no outbound PSTN.

**Weakness:** all of these are lost if the HCG server or its credentials are compromised.

**Provider-enforced limits** (work even if HCG's code is broken or compromised):

| # | Control | Enforced by | What it bounds | Status |
|---|---|---|---|---|
| P1 | **OpenAI project hard spend limit** (for example $15/month) plus an org limit | OpenAI (HTTP 429) | All AI spend, including forged requests | Console, ready (small documented overshoot) |
| P2 | **Twilio prepaid balance, auto-recharge OFF**, balance kept at B (for example £25) | Twilio | Total Twilio spend ≈ B + overrun | Console. **Leaky:** live calls finish past zero; overrun size undocumented (Twilio Q) |
| P3 | **Twilio SMS geo: UK only** | Twilio (not changeable by API) | SMS destinations | Console |
| P4 | **Twilio voice outbound geo: all off** | Twilio | Outbound calls (HCG makes none) | Console. Reversible by API with account credentials, so pair with P6 |
| P5 | **Twilio 4-hour maximum call duration** | Twilio | Length of any one call | Default; verify it's on |
| P6 | **Credential isolation:** HCG runtime in a **Twilio subaccount**; backend REST uses a **scoped API key** (`TWILIO_API_KEY_SID/SECRET`, built `352c810`); webhook signatures use the **subaccount's own token**; **master token removed from Railway** and kept offline | Twilio account model | Stops a backend compromise reaching the parent account (settings, other subaccounts, billing) | Code ready. Migration needs all numbers moved into the subaccount (the single signing token) plus new Voice SDK key, TwiML app and push credentials there |
| P7 | **Twilio-hosted usage breaker:** Usage Trigger (for example daily `totalprice` ≥ £5) → protected Twilio Function in the **parent** account → **suspends the runtime subaccount** (built `352c810`, 15 tests) | Twilio (runs inside Twilio, independent of HCG servers) | **New** calls after about 1 minute (trigger polling) | Code ready. **Live calls survive suspension** (BYOC investigation), so they are bounded only by P5/`timeLimit` |
| P8 | **Channel-capped ingress:** numbers hosted at **Magrathea** (2–10 channels **per number**, provider-enforced) → Twilio BYOC | Magrathea | **Concurrency per household number**, so £/hour has a hard ceiling: 2 ch ≈ £1.09/h, 4 ch ≈ £2.18/h, 10 ch ≈ £5.44/h if all Twilio legs bill | Not built (about 7–11 person-days, no SIP edge). An **account-wide** cap needs Magrathea's confirmation (Q5) |

**Threats against controls:**

| Threat | Application control | Provider backstop | Residual |
|---|---|---|---|
| Forged webhooks or streams | Signatures, stream tokens, `/process` off | P1 (AI), P3 (SMS) | None while the candidate is deployed |
| Long calls | Leases + `timeLimit` from headroom; breaker ends calls | P5 (4 h); P7 stops new calls | The Twilio parent leg after `timeLimit` when HCG is dead is undemonstrated (staging test designed) |
| Repeated or flooding calls | Abuse limits, Fortress daily hold, global caps | `<Reject/>` fallback is free; P7; P8 (when built) | **Without P8, inbound concurrency on Twilio numbers is uncapped by the provider** |
| Compromised HCG server or credentials | — (lost) | P1, P2, P3, P4, P6, P7 | An attacker controlling the server could **answer many concurrent inbound calls**; each runs up to 4 h (P5), survives P7 suspension, and runs past P2's zero balance. **Only P8 caps concurrency** |
| Unexpected billing (new legs billed, price changes) | Daily reconciliation, Control Centre (detect only) | P2 | Detection lag of up to 1 day |

**Honest verdict:**
- **Level 1 is achievable now** (P1–P7 plus the deployed candidate). It bounds AI hard (P1) and bounds Twilio to roughly the prepaid balance plus the tail of calls already live.
- **It is not a guaranteed cap.** Under a full server compromise, live-call concurrency on Twilio PSTN numbers has **no provider-enforced ceiling**. Twilio documents no hard spend cap, and suspension doesn't end live calls.
- **Level 2 (P8, Magrathea → Twilio BYOC)** adds the only provider-enforced concurrency cap. It is also the preferred cost reduction (§5).
- **If "no uncapped exposure, even for 10" is absolute, the cohort should wait for P8,** or for Twilio confirming in writing a bounded negative-balance and live-call behaviour (Twilio Q, §6).

## 3. Top-ups
- **Off for the first cohort.** `ALLOWANCE_TOPUPS_ENABLED` defaults off. Migration 077's database bound (credit ≤ net payment ÷ 1.2 × 0.60, at most 3 or £10 per period, refund/dispute reversal) is built and tested, but **not** the full payment-to-refund journey on staging. Not enabled.

## 4. Smallest meaningful carrier test (for approval; nothing bought)

**C-1: one non-Lebara SIM**, an O2 or Vodafone **pay-monthly or SIM-only** plan (Vodafone PAYG is blocked by policy).
1. Insert it in the Motorola.
2. Register `**21*<staging …1883>#`, then confirm with `*#21#`.
3. One iPhone → new-SIM call, which forwards to `…1883`.

**Where it lands:**
- **(a) Twilio TwiML Bin `<Reject/>`:** proves the carrier accepts the registration and that the forwarded call reaches HCG's Twilio account. **£0 on Twilio** (Reject is never answered).
- **(b) The staging server, inside the handset session H8/H9:** proves end-to-end delivery to the app and support-verified proof (pennies within staging Fortress caps).
- Then restore with `##21#`.

**Cost:** SIM £5–£10 one-off (plan minutes cover the forwarded leg; confirm on the plan); Twilio £0 for (a), under £0.15 for (b). About 30 minutes.

**C-2 (optional, later): BYOC staging test** (BYOC investigation §6): six attended calls to the Magrathea trial number on an isolated Twilio subaccount. Expected under £0.15; **approval cap £2**.

## 5. Magrathea + Twilio BYOC (preferred near-term cost reduction): status
- **Minimal variant (no SIP edge): about 7–11 person-days.**
  - Dedicated Magrathea numbers per household → Twilio BYOC trunk → existing `/voice` → `<Dial><Client>` (unchanged).
  - New code needs: UK national `07…` caller normalisation, and the one-signing-token assumption (`webhookIntegrity.js:70`) for a separate subaccount.
  - Every household needs a new number and must redial `**21*`.
- **What BYOC can't do:** custom SIP headers are discarded on BYOC calls, so `Diversion` isn't visible. **No pooling and no passive forwarding proof without an HCG SIP edge** (25–40 person-days).
- **Cost depends on Twilio's answer about which legs stack:** trusted calls £0.00302 / £0.00605 / £0.00907 per minute (BYOC only / plus SDK / plus SIP interface), against £0.00756 today.

## 6. Provider questions (drafted, NOT sent)
`research/business-decision-2026-10-10` → `docs/research/2026-10-10-business-decision/PROVIDER-QUESTIONS-DRAFT.md`:
- **Twilio:** 22 questions (leg billing, `<Reject>` £0, spend controls and zero-balance behaviour, suspension effect, number price, headers, capacity, fraud, terms).
- **Magrathea:** 22 questions (reply on ticket LKV-51353-279).
- **AQL:** 10 questions (first: re-send the September 2026 rate card).

## 7. Remaining launch blockers (prioritised) and the actions to close them

| # | Blocker | Action to close | Needs approval? |
|---|---|---|---|
| 1 | **Production is exposed now** (forged `/media-stream`, unsigned `/process`, open sales) | Merge PR #52 (ready, draft) + console C1–C7 (archive £4.99 Price, iOS IAP off sale, P1 OpenAI hard limit, P2–P5 Twilio settings, `<Reject/>` fallback) | **Yes** (merge = deploy; consoles are Andrew's) |
| 2 | **Lebara sold as `compatible` in production** | Deploy `hotfix/lebara-unverified-2026-10-10` (`1138bde`, local; production suite 105/106) with or after PR #52. Same change is on the launch branch (`3a2d3aa`) | **Yes** |
| 3 | **Twilio exposure not provider-capped** (Andrew's requirement) | Level 1: P6 subaccount migration + P7 breaker (code ready) + P2/P1. Level 2: P8 BYOC (7–11 person-days). Twilio written answers on zero-balance and live-call tail | **Yes** (console/account changes; send questions) |
| 4 | **Android 1.0.2 never run on a handset** | Staging 075–077 + staging APK + attended Motorola session (H-series + W1–W6) | **Yes** (staging change, EAS build credit, live calls) |
| 5 | **No new-customer forwarding proof on any network** (missing evidence, not failure) | C-1 test (§4) | **Yes** (SIM purchase, live call) |
| 6 | **Twilio `timeLimit` when HCG is dead: undemonstrated** | Staging S-A…S-E (under £0.15) in the same session | **Yes** |
| 7 | **Billing journey untested end to end** (Stripe test mode: subscribe, cancel, refund, grandfathering, £7.99 test price, VAT receipt) | Staging Stripe test-mode run (G19) | **Yes** (staging) |
| 8 | **Play policy:** the live Play build sells via in-app Stripe | Halt or replace it with the Option C build on the Internal track | **Yes** (Play Console) |
| 9 | **Production window** (migrations 047, 051–077, deploy, Fortress profile at £7.99, scaled caps, Stripe price) | Only after 1–8 pass (your rule 10) | **Yes** |

## 8. Can proceed without further approval (code, docs, local only)
- Recompute the Fortress allowance profile and caps for **£7.99** (calculator), as a proposal.
- Write the **subaccount migration runbook** (P6) and the **usage-breaker deployment runbook** (P7), console steps only, not executed.
- **BYOC minimal variant on a branch:** caller-number normalisation and multi-account signature support, with tests, not deployed.
- A static test that every `<Dial>` path stays bounded under the subaccount configuration.
- Prepare the **staging session runbook** (S-A…S-E + H-series + C-1), ready for one approval.
- Keep the provider questions ready to send on your approval.
