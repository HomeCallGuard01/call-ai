# Agent 6: independent technical and commercial challenge (2026-10-10)

**Status:** research only. I read the five agent reports and checked their claims against the repo (`server.js`, `services/providerPolicy.js`, production `eb43368` via `git show`/`git grep`), the evidence documents (`docs/launch/*`, `docs/strategy/2026-10-10-*`, `docs/mobile-app/APP_DECISION_008…`), the Magrathea live-call evidence, the viability model (`/Users/ad/call-ai-viability/research/viability/ARCHITECTURE_MODEL_OUTPUT.md`, `CATASTROPHIC_RISK_REVIEW.md`) and Twilio's GB pricing page (fetched 2026-10-10).
- I ran Agent 4's model (`scripts/research/business-decision-model.mjs`) unchanged. I then ran variants in memory only; no file was changed.
- I made no calls, contacted no provider and touched no production system.

## 1. Verdict on how reliable the evidence is

1. **The facts are sound:**
   - Twilio unit prices are the ones on HCG's invoices.
   - Twilio `ForwardedFrom` is unusable (184/184 calls).
   - Magrathea gives free inbound, a £100/month minimum, no REFER and no PAI.
   - The 9 October `Diversion` header is real.
   - Production has an unauthenticated `/process` endpoint (`eb43368:server.js:843`).
   - There are no outbound call legs.
2. **The weak points are the commercial conclusions:**
   - **Agent 4's "short change" option is invalid.** It pools Twilio numbers, which is a demonstrated failure.
   - **Every margin depends on three unknowns:** real trusted minutes, whether Twilio bills the SDK leg on BYOC/SIP, and whether Twilio reprices numbers (list price $3.50/month against £0.87 invoiced).
   - **The model's "bounded cost" works by refusing calls, family calls included,** once a customer's allowance runs out.
3. **The self-hosting break-even depends only on assumptions.** About 200 customers if Andrew provides unpaid on-call cover; about 2,700 with £4,000/month of paid operations.
4. **The agents mostly kept missing evidence separate from failure.** Two places blur it (rows 9 and 12 in §2).
5. **No agent invented AQL prices.**

Overall: the evidence is decision-grade for "contain production, then run a small measured cohort on Twilio". It is **not** decision-grade for choosing a long-term architecture or price.

## 2. Issue table

| # | Agent | Claim | Finding | Evidence | Impact on decision | Corrected figure |
|---|---|---|---|---|---|---|
| 1 | 4 | Option 2 "short change": pooled **Twilio** numbers, households identified from `ForwardedFrom`/Diversion, 45% contribution, "days to 2 weeks" | **REFUTED** | `APP_DECISION_008` line 50: 184/184 genuine calls had `ForwardedFrom` = the Twilio number; no other Call field carries it. Agents 2 and 3 agree. The script models C as Twilio rates on ⌈N/50⌉ Twilio numbers (lines 84–86) | Remove it as an option. The only valid pooled design runs on a SIP carrier that passes `Diversion`, with an HCG SIP edge that reads it | **C′** = Magrathea → HCG edge → Twilio SIP/BYOC → app, ≤10 households per number. Contribution **58%** at £5.99 (42% if the SDK leg is billed). Fully loaded −£196 at N=100, **+£951** at N=1,000. Saves **£0 in cash below ~200 customers**, because the £100 Magrathea minimum dominates. Effort **28–47 person-days** (Agent 3: edge 20–35 + pooling 8–12) plus per-network proofs. Not a short change |
| 2 | 1 vs 4 | Self-hosted (R2/B2): "loses money below ~2,500 customers" (Agent 1) vs "breaks even ~200, £425/month fixed" (Agent 4) | **Both CONFIRMED on their own assumptions.** Agent 1's figure is inherited, not derived | The 2,500 figure comes from the viability model's `selfOpsStaff` £4,000/month + £600 per 1,000 subscribers of multi-region infrastructure + Sipflex £2/number. Agent 4 has £75 + £250 + £100 and **no on-call cost**. Agent 1's own arithmetic (£3.22 per customer at N=200, against about £4.43 net after fees) contradicts its "loses money" line | Neither is right for a solo founder. Paid cover is unaffordable; unpaid 24/7 cover is a reliability risk (a missed page means customers miss calls), not a cash cost | B2 fully-loaded break-even at £5.99: **198** (founder on-call, unpaid); **807** with £1,000/month of outsourced monitoring or on-call; **2,659** with £4,000/month. Build effort **75–130 person-days** (edge plus Option C), i.e. 4–6+ months solo, **not "weeks"** (Agent 4 R14) |
| 3 | 1 | The Magrathea test server "was due to be torn down" / "rebuild if torn down" | **CORRECTED** | Lead verified 10 Oct ~15:10 UTC: the droplet exists, services are stopped by design, and deletion waits on Magrathea's written un-routing confirmation | The per-network `Diversion` tests can reuse it. No rebuild cost or delay | VM reusable now. Restarting it needs Andrew's approval |
| 4 | 3 vs 5 | Lebara: Agent 3 says `incompatible`, Agent 5 says `unverified` | **Partly each.** `unverified` is defined as "genuinely not established either way" (`providerPolicy.js:36`), which the evidence contradicts. `incompatible` is defined as "confirmed NOT to work (official/first-party statement)" (`:34`), and the Tesco precedent is exactly a support-account statement | The network carried a diversion on 9 Oct (MLE §13). Lebara support says forwarding is unsupported. MMI registration was refused on 9 and 10 Oct. `compatible` (`:225`) rests on a code comment | Both labels block payment (`:331`); only the customer wording differs. **Recommendation (no change made):** `incompatible`, with reason text: "Lebara support states forwarding is unsupported; new registrations refused 9–10 Oct 2026; an already-registered diversion was carried 9 Oct; revisit if Lebara confirms otherwise." That matches the file's own definitions. `compatible` is wrong on any reading | — |
| 5 | 3 | Magrathea `Diversion` proven "on Lebara **busy**-divert only" | **CORRECTED** | MLE §13.4: `reason=unknown`; busy divert "unproven and currently contradicted"; earlier CFU to the same DDI may have fired | Pooling and verification designs must not assume the divert type can be read from the header | "Divert type unproven (n=1)" |
| 6 | 3 | Listed as a demonstrated failure: "Lebara external forwarding" | **CORRECTED** (wording) | As row 4 | Registration failed; diversion was proven. Keep the two apart | "Lebara new-registration: demonstrated failure; network diversion: proven n=1" |
| 7 | 1, 4 | BYOC cost = $0.004/min, plus the SDK leg at £0 or list | **UNSUPPORTED** (incomplete) | Twilio GB page: BYOC $0.0040, **SIP interface $0.0040** and Voice SDK $0.0040, each listed separately. The viability price book flags that SIP-interface stacking on BYOC calls needs a quote. Neither agent models it | If all three bill, Twilio costs **$0.012/min, more than today's $0.010** | B1 contribution **27%** (BYOC + SIP + SDK) against 50% base. Price for 40% contribution **£8.97**. Never breaks even fully loaded at £5.99 |
| 8 | 4 | A at 30% contribution; number rental £0.87 | **CONFIRMED on invoiced prices; risk not modelled** | Twilio GB list today: local **$3.50/month**. HCG invoices £0.869. Agent 1 flagged this as needing provider confirmation; Agent 4 did not test it | At list rental, A falls to **9%** contribution | A range **9–34%** (list rental / brief mix / Stripe-only cohort) |
| 9 | 4 | "Variable cost is bounded on every architecture" | **CORRECTED** | Bounded only in candidate code (production has no Fortress). It works by **pausing screening and refusing calls, trusted calls included**: allowance proposal §144–146 says "80% of typical households pause… 11% get a trusted refusal" under the current split. Model: heavy households served **45%** under A at £5.99 | Margins compare architectures at different service levels. Refusing a family call under CFU conflicts with the forwarding hard requirement | State margins **with** the served percentages. Before scale, build the trusted reserve drawn first (1-S, migration 076) |
| 10 | 4 | B2 "Delay (weeks)"; C "days to 2 weeks" | **REFUTED** | Agent 3's estimates: edge 20–35, Option C 55–95, pooling 8–12 person-days (±40%) | The timelines for options 2 and 3a are understated by 3–10× | B1/D1 6–8 weeks; C′ 7–10 weeks; B2 4–6+ months |
| 11 | 5 | "The only network ever seen forwarding to HCG is Lebara" | **UNSUPPORTED** (overstated) | 184 genuine inbound calls reached HCG Twilio numbers by 8 Sep (APP_DECISION_008:50), carriers unattributed. Earlier households (a giffgaff customer) received calls. The carriers simply weren't recorded | Missing attribution is not absence of evidence | "Forwarding has worked for real households on carriers HCG did not record. No current device proof exists for O2/VF/EE" |
| 12 | 5 | Carrier compatibility = **BLOCKER** before the first invite | **CORRECTED** (from blocker to condition) | Unproven, not failed. Agent 5's own step 8 already requires a per-customer support-verified proof (075), with forwarding off and a full refund on failure | One £5–10 SIM test is prudent and cheap, but this is a precondition, not a "cannot launch" finding | Condition: "one O2 or Vodafone pay-monthly proof, or customer 1 attended with refund-on-fail" |
| 13 | 5 | NO-GO today | **CONFIRMED** | Unauthenticated `/process` in `eb43368:server.js:843`. No allowance and no Fortress in production. Lebara `compatible` at `eb43368:providerPolicy.js:212` | These are demonstrated defects, not missing evidence. Containment is needed regardless of strategy | — |
| 14 | 2 | Pooling saves £0.45/sub (£4.50 at 10 customers) | **CORRECTED** | The £100 Magrathea minimum applies; whether rentals count towards it is unknown | No cash saving below ~200 customers if rentals count | £0 (N≤200); about £400/month (£0.40/sub) at N=1,000 |
| 15 | 2 | The per-network probe covers 8 networks, including Lebara | **CORRECTED** | Lebara refuses registration (rows 4–6). giffgaff and Three use the Settings path, not the code | Budget about £70 for 7 networks | — |
| 17 | 3 | No outbound legs exist | **CONFIRMED** | `git grep eb43368`: the only `.dial(` is `<Client>` (server.js:287); no `calls.create`. SMS via `smsWarning.js:46` | SMS is the only outbound cost path. It is capped in the candidate, but the forged `/media-stream` SMS risk remains in production | — |
| 18 | 1, 2, 3, 4 | Twilio PSTN pooling impossible | **CONFIRMED** | Row 1 | — | — |
| 19 | 1, 4 | "Free inbound" (Magrathea, Sipflex, sipgate, Gamma) | **CONFIRMED for Magrathea at trial scale only** | Volume and "capacity-based charging" terms unknown (Agent 1 Q2). sipgate charges £4.95 per concurrent call. Gamma is indicative. Channel uplift beyond 10 per number "charges may apply" | Treat £0/min as a trial fact until a written volume answer arrives | — |
| 20 | 4 | 30% (Agent 4) vs 34% (Agent 5) contribution under A | **CONFIRMED** (consistent) | The difference is the mix (brief vs WS2: script gives 33.1% on WS2) and the Stripe-only cohort | Use 30–34%, and say which mix | — |
| 21 | 4 | Support 4 min per customer per month (£1.67) | **UNSUPPORTED** | Labelled LOW confidence. Agent 5's route needs an attended forwarding set-up and proof for each customer (tens of minutes in month 1) | Fully-loaded margins at N≤100 are optimistic | Month 1: about 30–60 min per customer |
| 22 | 4 | E: 38% contribution with a £0.50 partner fee | **UNSUPPORTED** (placeholder) | No MNO publishes a partner API (Agent 1 §4). No quote. The £0.50 is generic, **not AQL** | Not a decision option, only a fee ceiling | Maximum viable fee £0.38 at £5.99 (R12) |
| 23 | 4 | D: 82% contribution | **CONFIRMED arithmetic; not comparable** | No live AI (architecture reassessment); build effort, product and willingness to pay undefined | A different product, so do not rank it against A–C | — |
| 24 | all | AQL prices | **CONFIRMED absent** | Agents 1 and 4 state that no AQL price is used. `grep` finds none in Agents 2, 3 or 5 or in the script | — | — |

## 3. Corrected comparison at £5.99

**How these figures were produced:**
- Agent 4's model, unchanged except for the corrections named here.
- Shown as monthly contribution £ (CM%) / fully-loaded £, at N = 10 / 100 / 1,000.
- Fully loaded = contribution − fixed costs (platform £75, edge or SIP infrastructure, the Magrathea £100 minimum shortfall) − support at 4 min per customer.
- Usage profiles are estimates: HCG has 0 genuine paying customers.

| Option | N=10 | N=100 | N=1,000 | Price for CM ≥ 40% (N=1,000) | FL break-even | Confidence |
|---|---|---|---|---|---|---|
| **A** Twilio today (candidate code) | £15 (30%) / −£77 | £151 (30%) / −£90 | £1,504 (30%) / −£237 | **£7.82** (SDK billed: £10.88; list number: £13.89) | never at £5.99 | Medium on unit prices; low on usage. Heavy households served 45% |
| **B1** Magrathea → edge → Twilio SIP/BYOC → SDK | £25 (50%) / −£312 | £250 (50%) / −£192 | £2,486 (50%) / **+£594** | £4.33 (SDK billed £7.16; SIP-interface stacking £8.97) | 272 (SDK billed: 4,212) | **Low**: Twilio billing on BYOC/SIP is unconfirmed |
| **C′** pooled on Magrathea → edge → Twilio (replaces Agent 4's C) | £29 (57%) / −£312 | £290 (58%) / −£196 | £2,893 (58%) / **+£951** | ≤ £3 (SDK billed £5.56) | 253 (SDK billed: 667) | **Low**: `Diversion` proven n=1; spoofing and coverage untested |
| ~~C pooled Twilio~~ | — | — | — | — | — | **Invalid** (row 1) |
| **B2** Magrathea + self-hosted delivery | £33 (66%) / −£404 | £332 (66%) / −£210 | £3,306 (66%) / +£1,314 founder on-call; +£314 at £1k/month ops; −£2,686 at £4k/month ops | ≤ £3 | 198 / 807 / 2,659 | **Low**; 4–6+ months solo build |
| **D** on-device, no live AI | £41 (82%) / −£42 | £410 (82%) / +£252 | £4,094 (82%) / +£3,186 | ≤ £3 | 23 | **Very low**: different product, willingness to pay unknown |
| **E** network partner | £19 (38%) / −£68 | £190 (38%) / −£10 | £1,892 (38%) / +£567 | £6.30 (fee £0.50, placeholder) | 115 | **Not decision-grade**: no partner, no quote, AQL missing |

**What the table means:**
- **Only A can be operated in the next 2–3 weeks.** At £5.99 it is a bounded-loss measurement cohort (−£77 to −£90/month fully loaded at 10–100 customers), not a 40% business.
- **The biggest lever is the price of a trusted minute**, which is unmeasured (M1).
- **B1 and C′ are not cheaper than A below about 250 customers**, because of the £100 minimum, the edge infrastructure and Twilio billing uncertainty.

## 4. Claims the final report must NOT make

1. "Pool Twilio numbers and identify households from forwarded-call headers" (or any Twilio-PSTN pooling margin).
2. "Self-hosting breaks even at ~200 customers" without the words *"if Andrew provides unpaid 24/7 on-call"*. Equally, "loses money below 2,500" without *"with £4,000/month paid operations"*.
3. "B2/C can be done in weeks / a short change."
4. "BYOC cuts Twilio cost by ~60%." It could be 0%, or a cost increase, until Twilio confirms which of BYOC, SIP interface and SDK legs are billed.
5. "Cost is bounded" without saying how: by pausing screening and refusing calls (including family calls on the current split), and only in the undeployed candidate. Production has no such bound, Twilio has no spend cap, and the master token remains.
6. "Pooling saves £0.45 per subscriber" at early scale (it saves £0 below ~200 customers).
7. "Magrathea `Diversion` identifies customers on UK networks". Proven once, Lebara, divert type unknown.
8. "Lebara is unverified" (contradicted by evidence), and above all "Lebara is compatible".
9. "Lebara is the only network ever seen forwarding to HCG" or "no carrier can forward". Both are missing evidence, not failure.
10. "HCG cannot launch because forwarding is unproven." The genuine blockers are demonstrated production defects. Forwarding proof is a cheap precondition.
11. Any AQL price, or E's 38% presented as an available option.
12. "Inbound is free" at volume. That is a trial fact pending Magrathea Q2.
13. "40% at £5.99 on A". The model says 30–34%, falling to 9–18% under plausible Twilio billing changes.
14. "The Magrathea server has been torn down." It exists, with services stopped.

## 5. Tests that would most change the decision (cheapest first)

| # | Test | Cost | What it decides |
|---|---|---|---|
| 1 | Written questions to Twilio: (a) is the `<Client>` SDK leg billed on PV/BYOC/SIP; (b) does the SIP interface stack on BYOC; (c) does the $3.50 number list price apply to HCG at renewal | £0 | Swings A between 9% and 34%, and B1 between 27% and 50%. **The single biggest margin unknown** |
| 2 | Written questions to Magrathea: rentals count towards £100? Free inbound at volume? Who sets `screen=yes`; is forged `Diversion` passed? Can a DDI target a Twilio BYOC/SIP URI? | £0 | Whether B1 and C′ are cheaper than A below ~250 customers; whether pooling is safe at all |
| 3 | Read-only check, if Andrew approves: households' declared carriers against the 184 historical inbound calls; Lebara Recents and log check | £0 | Retires the "only Lebara" claim; gives a historical carrier list |
| 4 | Staging `timeLimit` backstop call, plus confirmation that `<Reject>` bills £0 | pennies | Whether A's per-call bound is real when HCG is down |
| 5 | One O2 or Vodafone pay-monthly SIM: `**21*` to a staging HCG number (delivery and proof), then the same SIM to the Magrathea DDI on the existing VM (`Diversion`) | £5–10 + pennies | The first-cohort carrier gate, plus a second `Diversion` data point |
| 6 | Attended Android 1.0.2 handset session (killed, locked, warm) | ~£1, about 3 h | Delivery reliability, the real launch risk (Agent 3) |
| 7 | Isolated Twilio subaccount: Magrathea DDI → BYOC → `<Client>`, 3 calls; read the invoice lines after 48 h | < £0.10 | Confirms test 1 empirically |
| 8 | Per-network `Diversion` probe (EE, O2, VF, Three, giffgaff, Sky, iD; reject-only; CFU and handset-off variants) | about £70 | Whether C′ and passive LF-2 proof are viable |
| 9 | Forged-`Diversion` spoofing call from a second SIP provider | about £5 | Required before any pooling (membership-oracle risk) |
| 10 | Measure M1 (trusted minutes per household) over the first 5–10 customers for 30–45 days | Cohort loss of £77–£90/month | **Decides price**: 40% on A needs typical trusted ≤ ~75 min/month at £5.99, or about £7.99 |
