# HCG unit economics & allowance model — v1

**Date:** 2026-10-04 · **Branch:** `finance/unit-economics-v1` (from `integration/launch-fortress-2026-10-03` 2011ab6)
**Status:** analysis + configuration hygiene. **No price, allowance, budget profile, database row, provider setting or deployment was changed.** £5.99 is a candidate price, not an approved one (live Apple IAP and `terms.html` still say £4.99).

**Sources of truth introduced by this work:**

| What | Where |
|---|---|
| Every input, with its status and source | `services/finance/assumptions/hcg-unit-economics.v1.json` (the **register**) |
| Loader + validator | `services/finance/economicsRegister.js` |
| The model | `services/finance/hcgUnitEconomics.js` |
| Contradiction checks (boot log + admin view) | `services/finance/economicsConsistency.js`, wired into `commercialConfigValidation.js` |
| Every number in this document | `node scripts/hcg-unit-economics.js` → `docs/finance/HCG_UNIT_ECONOMICS_V1_TABLES.md` (a test fails if that file is stale) |

---

## 1. Summary

1. **The four figures in circulation are not competing estimates of one quantity.** They measure different things, on two cost bases (§2):
   - **£0.86** is an envelope, and **£0.50** is a 58% slice of it.
   - **£2.07** is the cost of a minutes promise, priced on the Fortress's deliberately inflated basis.
   - **£1.25** has no source anywhere in the repository. It can be reconstructed to within about 1p (£1.239) by dropping the infrastructure allocation from the £0.86 formula and using a 10% reserve instead of 15%.
2. **At £5.99 with a 40% gross margin on Twilio today, the safe usage budget per customer per month is:**

   | Channel | Safe budget | Trusted-only minutes | Monitored-only minutes |
   |---|---|---|---|
   | Stripe | **£1.07** | 123 | 61 |
   | Apple SBP 15% / Google Play 15% | **£0.74** | 85 | 42 |
   | Apple 30% (SBP not confirmed) | **£0.10** | 11 | 5 |

   These are billed-cost (expected basis) figures, base case, from tables C1/E.
3. **The illustrative "typical" household misses 40% on every channel at £5.99.** It is 150 trusted plus 40 unknown minutes, and its margin is 26% on Stripe, 18% on stores and 3% on Apple 30%. **150 trusted minutes alone use up the whole safe budget on every channel** (table E). Forwarding is unconditional, so HCG pays for every inbound minute: family calls, not AI monitoring, set the cost.
4. **The Fortress charges usage on a basis 1.33–1.56× above what HCG is billed.** It prices the app leg at list price and adds a ×1.10 uplift. So a £ budget derived from billed cost buys only 64–75% of the minutes once loaded into `fc_budget_profiles`. Any profile must be converted (§6.2). This is the root of the "100 minutes cost £2.07" contradiction.
5. **The two biggest unknowns are Apple's commission and customer usage.** Apple's rate (30% vs 15%) moves the Apple budget from £0.10 to £0.74. There is no measured usage distribution (0 genuine paying customers).
6. **Telephony architecture matters more than any price step between £5.99 and £7.99** (§8). Two architectures change the shape of the problem:
   - **Network-side trusted routing (AQL/MVNO/FMC)** lifts the typical margin from 30% to 56% on Stripe (1,000 subscribers). Trusted minutes stop costing anything.
   - **Free inbound (Magrathea)** removes the per-minute cost entirely, but moves cost into HCG-run infrastructure that is not costed.

   A cheaper per-minute carrier on the same architecture, such as Telnyx, changes almost nothing (+2 points).

The commercial policy is **not** chosen here. §6 lists candidates and what each one costs.

---

## 2. Reconciling £0.50, £0.86, £1.25 and £2.07

All four are reproduced by `reconcileLegacyFigures()` and checked by `tests/economics-register.test.mjs`.

| Figure | What it actually is | Formula (source) | Why it differs from this model |
|---|---|---|---|
| **£0.86** (£0.858) | Total HCG-funded variable authorisation per customer per month: the Fortress budget, delivery reserve and essential pool combined | `economicPolicy.deriveVariableEnvelope()`: £4.99 net × 60% − Google/Apple-SBP fee £0.75 − rental £0.87 − infra £0.25, then −15% reserve, then −£0.10 overrun | It is a **15%-store-channel** figure with the reserve, the overrun allowance and an infra placeholder all stacked. It is the same quantity as this model's "safe variable budget" for 15% stores. The model gives £0.74 there because it also counts 2% revenue leakage and the churned-number overhang. The £0.86 does not survive Apple 30% (£0.10) |
| **£0.50** | The *budget* slice only (monitoring + telephony). The delivery reserve (£0.25, trusted-only) and essential pool (£0.10) come on top | 58% of the envelope = £0.4977, rounded down to £0.49; seeded as £0.50 in migration 067 | It is not a cost budget at all; it is a sub-allocation of £0.86. The seed is £0.01 above its own formula, but the £0.85 total still fits the envelope |
| **£1.25** | **No source found** in any branch | Closest reconstructions (table K): £0.858 formula without the infra allocation and with a 10% reserve = **£1.239**; without infra or reserve but with the overrun = £1.277; Stripe fee with infra and 15% reserve = £1.287 | Most likely it came from a brief using the 15%-store formula without the £0.25 infrastructure placeholder. At 1,000 subscribers the real infra share is ~£0.04, so that reading is plausible at scale. It is wrong today |
| **£2.07** | The cost of the 100-minute Standard placeholder, on the **Fortress enforcement basis** | 100 × (£0.010718 connected + £0.008069 monitoring) × 1.10 uplift = £2.0666 (`commercialConfigValidation`, fortress handover) | The connected rate includes the app leg at list price (£0.00316/min, billed £0 today), and the uplift is applied on top. At billed cost the same 100 monitored minutes cost **£1.72**, or £2.29 at Fortress rates once per-call rounding and greetings are included |

**What contradicts what:**
- `plans.js` promises **100 monitored minutes**. The Fortress seed funds **£0.50**, which buys about **22** monitored minutes at Fortress rates. Both are placeholders, but they cannot both be kept. This is now reported at boot as `plan_minutes_unfundable`.
- `economicPolicy` assumes the worst channel is 15%. `productCatalog` (top-ups) assumes Apple is 30% until SBP enrolment is confirmed. The register now records both, and `apple_commission_unconfirmed` is reported.
- The plan reserve is 15% (`economicPolicy`) but the top-up reserve is 10% (`productCatalog`). Both are now named register entries, reported as `reserve_ratios_differ`.
- FX: runtime code uses £0.79/$, while `research/carrier-routing-v2` used £0.75/$. The register holds £0.79; the research branch is unmerged.

---

## 3. Assumption register (abridged; the JSON is authoritative)

Status key:
- **KNOWN**: verified from HCG billing, law or HCG's own terms.
- **CONFIGURED**: set in HCG code or migrations.
- **ESTIMATED**: list price or assumption.
- **UNKNOWN**: no evidence.
- **PCR**: provider confirmation required.

### 3.1 Revenue, tax and channel fees

| Item | Value | Status | Source / note |
|---|---|---|---|
| Price | £5.99 incl VAT | CONFIGURED | candidate; **not approved** |
| VAT | 20%; AFMD Ltd VAT-registered GB379120684 | KNOWN | `public/terms.html`. Stores account for UK VAT on in-app sales, so commission is modelled on the ex-VAT price |
| Stripe card fee | 1.5% + 20p | PCR | public UK standard-card price. HCG's account pricing is unread (live Stripe read denied 2026-09-30); card mix is unknown |
| Stripe Billing | 0.7% | PCR | public pay-as-you-go; some sources still quote 0.5% |
| Stripe Tax | 0.5% | UNKNOWN | whether it is enabled is unknown; kept in (conservative) |
| Apple commission | 30% standard / 15% SBP | PCR | **SBP enrolment UNKNOWN**. Subscriptions fall to 15% after one paid year per subscriber |
| Google Play | 15% (subscriptions) | PCR | **not applicable today**: no Play Billing product; Android pays via Stripe. Likely required before Play Production |
| RevenueCat | £0 below $2,500 MTR, then 1% of gross | PCR | ≈ 525 Apple subscribers at £5.99 before any fee |
| Revenue leakage (refunds, chargebacks, failed renewals) | 2% of net | UNKNOWN | placeholder; a Stripe dispute costs £20 |

### 3.2 Telephony (Twilio, today)

| Item | Value | Status | Source / note |
|---|---|---|---|
| UK number | £0.86917/month | KNOWN | Pricing API + 45 billed number-months |
| Inbound (forwarded) minute | £0.007558 per started minute | KNOWN | billed 4 × £0.00756 for a 239 s call. **Applies to trusted calls too** (Twilio Support) |
| App leg `<Dial><Client>` | £0 billed; list $0.004 | KNOWN / PCR | 100 legs with no price; Twilio may start billing it |
| Media Streams | £0.003329 per started minute | KNOWN | billing |
| Polly greeting | £0.0006 per unknown call | KNOWN | billing |
| SMS | £0.042325/segment | KNOWN | warning SMS currently fail (21661) |
| Outbound | £0.023052/min | KNOWN | not used; outbound geo all disabled |
| Twilio platform fees | none | KNOWN | |
| Number purchase | first month's rental; Fortress charges £1.15 | CONFIGURED | 067 |

### 3.3 AI

| Item | Value | Status | Source / note |
|---|---|---|---|
| Transcription | whisper-1 $0.006/min × £0.79/$ = £0.00474 | ESTIMATED | OpenAI key can't read costs |
| Transcription multiplier | 1× (inbound track only, non-overlapping segments) | CONFIGURED | e56e776; in production since eb43368. Was 2× |
| Live risk scoring | £0 | KNOWN | rule-based |
| `/process` classifier | £0 (unreachable); Fortress charges £0.001 | CONFIGURED | |
| OpenAI SDK retries | up to 3× on a bad day | UNKNOWN | |

### 3.4 Infrastructure and other

| Item | Value | Status | Source / note |
|---|---|---|---|
| Fixed infrastructure | ~£40/month company-wide | ESTIMATED | Railway Hobby $5 + usage (seen); Supabase Pro likely; Resend, IONOS and developer programmes unallocated |
| Infra allocation | £0.25/customer | CONFIGURED | economicPolicy placeholder (= £40 ÷ 160 customers) |
| Churned-number overhang | rental × 5% churn × 1 month = £0.04 | ESTIMATED/UNKNOWN | quarantine/grace |
| Fraud/safety reserve | 15% of variable (plan), 10% (top-up), + £0.10 overrun | CONFIGURED | policy placeholders |
| Fortress uplift | ×1.10 on every estimate | CONFIGURED | 067 |
| Usage distribution | — | **UNKNOWN** | 0 genuine paying customers. Ofcom average *outgoing* use is 146 min/month (an anchor only) |

Retries and failures are inside the model: unanswered and failed calls still bill ringing as a started minute (0.55 extra minutes per call), and monitored ringing counts towards the allowance meter.

---

## 4. The model

```
net               = price ÷ 1.20
fee               = Stripe: gross × (1.5% + 0.7% + 0.5%) + 20p   | store: rate × net
leakage           = 2% × net
cost-of-service budget at margin m = net × (1 − m) − fee − leakage
fixed/customer    = number rental + churned-number overhang + infra share + RevenueCat share
variable budget   = cost-of-service budget − fixed/customer
safe variable     = variable × (1 − 15% reserve) − £0.10 overrun
gross margin      = (net − fee − leakage − fixed − usage) ÷ net
```

Per-minute costs (table B) include 0.55 started-minute rounding per call, stream rounding and the greeting spread over a 4-minute call:

| | Trusted minute | Monitored minute | Of which monitoring only |
|---|---|---|---|
| Expected (billed today) | £0.0086 | £0.0172 | £0.0086 |
| Fortress enforcement | £0.0134 | £0.0229 | £0.0095 |

**Monitoring is only half the cost of an unknown-caller minute.** The connected leg is paid whether or not the call is monitored. So a monitored-minute allowance bounds about £0.0086/min of avoidable cost; it does not bound the telephony.

"Gross margin" counts every per-customer cost of service. It does not count staff, marketing or other company overheads.

---

## 5. Scenarios at £5.99 (excerpt; full grid in the tables file)

### 5.1 Contribution (margin) per customer-month, all unknown minutes monitored

| Profile (trusted/unknown min) | Stripe | Apple SBP / Google 15% | Apple 30% |
|---|---|---|---|
| Light (60/15) | £2.56 (51%) | £2.17 (43%) | £1.42 (28%) |
| Typical (150/40) | £1.28 (26%) | £0.90 (18%) | £0.15 (3%) |
| Heavy family (400/80) | −£1.60 (−32%) | −£1.99 (−40%) | −£2.73 (−55%) |
| Very heavy (800/200) | −£7.15 | −£7.53 | −£8.28 |

### 5.2 Loss lines

A customer becomes loss-making when the total monthly cost of service exceeds:

| Channel | Loss line | Trusted-only minutes at that line |
|---|---|---|
| Stripe | £4.53 | 391 |
| Apple SBP / Google 15% | £4.14 | 346 |
| Apple 30% | £3.39 | 259 |

The WATCH line (margin falls below 40%) is at £2.53 / £2.15 / £1.40 total cost respectively.

### 5.3 Infrastructure scale

At 1,000 subscribers (infra £0.04/customer), with RevenueCat's 1% applied on store channels, the safe budgets become:

| Channel | Safe budget | Trusted-only minutes |
|---|---|---|
| Stripe | £1.24 | 144 |
| Apple SBP / Google 15% | £0.86 | 100 |
| Apple 30% | £0.23 | 26 |

(The £0.86 matching the legacy envelope is a coincidence of different inputs.)

---

## 6. Candidates (not decisions)

### 6.1 Safe included usage at £5.99, 40%, Twilio today

Largest monitored allowance (fully used) that keeps 40% given trusted use (table E):

| Trusted min/month | Stripe | 15% stores | Apple 30% |
|---|---|---|---|
| 0 | 61 | 42 | 5 |
| 60 | 31 | 12 | — |
| ≥ 150 | — | — | — |

**There is no "included minutes" figure at £5.99 that holds 40% for a household with average-ish trusted use.** The candidate policies are therefore choices about *which* constraint to relax:

| Candidate | What it means | Cost / risk |
|---|---|---|
| **C1 £-budget only, 40% held** | Fortress profile = the channel's safe budget (converted, §6.2); no minutes promise. When the budget runs out, the containment design applies (D3 reject / trusted-only reserve) | Typical households hit the cap mid-month. This conflicts with Andrew's hard requirement "never stop delivery while forwarding points at HCG" (research 2026-09-30) |
| **C2 40% on a portfolio, not per customer** | Light households subsidise typical ones. Fortress cap = the LOSS line (Stripe £4.53 − £1.16 fixed ≈ £3.37 of usage), not the WATCH line | Needs a real usage distribution to know the blended margin; that does not exist yet |
| **C3 Small monitored allowance, trusted uncapped but watched** | e.g. 30–40 monitored minutes promised; trusted minutes bounded only by the LOSS line + alerting | Margin per customer floats between ~51% (light) and negative (heavy) |
| **C4 Higher price** | see §6.4 | |
| **C5 Architecture change** | see §8 | trusted minutes leave HCG's bill: the only lever that fixes typical/heavy |

### 6.2 £ economic budget: converting to the Fortress basis

`fc_budget_profiles` is enforced at Fortress rates. To fund the minutes a billed-basis budget buys (50/50 trusted/monitored spend):

| Channel | Safe budget (billed basis) | Fortress profile total needed |
|---|---|---|
| Stripe | £1.07 | £1.54 |
| 15% stores | £0.74 | £1.06 |
| Apple 30% | £0.10 | £0.14 |

**Structural point:** profiles are keyed by *plan*, not *payment channel*. A single `standard` profile must either use the worst channel (Apple 30%, £0.14) or accept below-target margin on Apple. The alternatives are:
- confirm SBP enrolment;
- per-channel profiles (a schema decision);
- price Apple higher (Apple allows a different price per storefront, not per channel within the UK).

### 6.3 Warning levels (candidates)

- **Household:** notify at 50% / 75% / 90% / 100% of the £ budget. Today `plans.js` uses 75% / 90% of *minutes*. At Stripe £1.07 those are £0.53 / £0.80 / £0.96 / £1.07.
- **Operator:**
  - WATCH when a household's month-to-date cost of service passes the WATCH line (Stripe £2.53, stores £2.15, Apple 30% £1.40).
  - ALERT at the LOSS line (£4.53 / £4.14 / £3.39).

### 6.4 Top-ups (minimum price for 40% + 10% reserve)

Monitored-minute packs, priced at full cost including the connected leg (table G):

| Pack | Delivery cost | Stripe | 15% stores | Apple 30% |
|---|---|---|---|---|
| 30 min | £0.52 | £1.49 | £1.49 | £1.99 |
| 60 min | £1.03 | £2.99 | £2.99 | £3.49 |
| 120 min | £2.07 | £4.99 | £5.49 | £6.99 |

£ capacity for trusted or unmonitored delivery (100 min £0.86): £2.49 / £2.49 / £2.99.

Store prices must be mapped to Apple/Google price tiers. A top-up sold on Apple at the 15% price is under-margin if SBP is not confirmed. `productCatalog` already refuses that case, because it defaults Apple to 30%.

### 6.5 Higher tiers (safe budget ≈ minutes at a 75% trusted mix; table H)

| Price | Stripe | 15% stores | Apple 30% |
|---|---|---|---|
| £6.99 | £1.45 ≈ 135 | £1.04 ≈ 96 | £0.30 ≈ 27 |
| £7.99 | £1.84 ≈ 171 | £1.35 ≈ 125 | £0.50 ≈ 46 |
| £9.99 | £2.62 ≈ 243 | £1.95 ≈ 181 | £0.89 ≈ 83 |
| £12.99 | £3.78 ≈ 351 | £2.87 ≈ 266 | £1.49 ≈ 138 |
| £14.99 | £4.56 ≈ 423 | £3.48 ≈ 323 | £1.88 ≈ 175 |

On Twilio, the illustrative typical household (150 trusted + 40 monitored minutes, £2.08 usage) reaches a 40% margin at these prices:

| Channel | 40% margin, no reserve | 40% with the 15% reserve and overrun intact (safe budget ≥ £2.08) |
|---|---|---|
| Stripe | £7.99 (43%) | £8.99 |
| 15% stores | £8.99 (40%) | £10.99 |
| Apple 30% | above £12.99 (38% there) | above £12.99 (38% there) |

---

## 7. Sensitivity of single unknowns (typical profile; table J)

| Change | Stripe margin | Apple margin (30% base) |
|---|---|---|
| Base | 26% | 3% |
| Apple SBP confirmed | — | 18% |
| App leg billed at list | 12% | −11% |
| OpenAI retries 3× | 18% | −5% |
| Infra at 100 subs / 10,000 subs | 23% / 31% | 0% / 8% |
| Leakage 0% / 5% | 28% / 23% | 5% / 0% |
| gpt-4o-mini-transcribe | 28% | 5% |
| FX £0.85/$ | 25% | 3% |

---

## 8. Future telephony (HYPOTHETICAL; £5.99, 1,000 subscribers; table I)

| Architecture | Trusted min | Typical margin Stripe / 15% | Heavy | Very heavy |
|---|---|---|---|---|
| Twilio today | £0.0086 | 30% / 22% | −28% / −36% | −139% / −147% |
| Twilio, app leg billed | £0.0122 | 16% / 8% | −63% / −70% | — |
| Telnyx per-minute (list) | £0.0081 | 32% / 25% | −22% / −30% | −126% / −134% |
| Network-side trusted routing (AQL/MVNO/FMC) | £0 | 56% / 49% | 41% / 33% | −1% / −9% |
| Magrathea free inbound + HCG-hosted SIP/WebRTC | £0 | 73% / 65% | 68% / 60% | 55% / 47% |

**Caveats on these rows:**
- **Telnyx:** the number price is unknown, so Twilio's is used.
- **Magrathea:** includes only the £100/month minimum (and £0.50/number). HCG's own SIP edge, media/streaming servers, push and engineering are **not costed**, so the margin is an upper bound.
- **Network-side routing:** excludes any per-subscriber MNO/AQL fee (UNKNOWN).

The conclusion is robust to those gaps. **A cheaper per-minute carrier on the same architecture barely moves anything. Removing trusted minutes from HCG's bill does.**

---

## 9. Runtime: one set of assumptions

**What changed (behaviour-neutral):** these modules now read their defaults from the register instead of literals:
- `costModel.DEFAULT_RATES`
- `economicPolicy.DEFAULT_ECONOMICS` and its budget split
- `unitEconomics.CHANNELS` fees
- `carrierComparison.DEFAULT_ASSUMPTIONS`
- `pricingScenarios.ASSUMPTIONS` and the app-leg list rate
- `productCatalog.DEFAULTS` (VAT, margin, top-up reserve)
- `plans.js` placeholder minutes and warning points

Every value is identical to before, and env overrides (`SAFETY_COST_*`, `HCG_ECONOMICS_*`, `ALLOWANCE_*`, `PLAN_*`) work as before.

**What cannot import the register** is pinned by `tests/economics-register.test.mjs`:
- migration 067's `fc_policy` defaults (connected and monitoring rates, uplift, fixed fee, SMS, AI, number purchase, monitoring cap) and its `fc_budget_profiles` seed;
- `docs/finance/carrier-quotes.json`'s Twilio baseline.

The test also checks:
- that no provider-rate literal remains in `costModel` / `economicPolicy` code;
- the model identities (a customer consuming exactly the safe budget keeps ≥ 40% on every channel);
- that the generated tables are current.

**New checks at boot and in the admin view** (`economicsRegister.findings` in the commercial-config report):

| Code | Severity | Meaning |
|---|---|---|
| `enforcement_rate_below_billed_rate` | **error** | a `SAFETY_COST_*` override prices a minute below the billed rate, so every limit under-counts |
| `plan_minutes_unfundable` | warning | promised minutes cost more than the £ budget, using the DB profile if readable, else the 067 seed |
| `apple_commission_unconfirmed` | warning | |
| `safe_budget_below_average_use` | warning | |
| `enforcement_basis_premium` | info | |
| `reserve_ratios_differ` | info | |

**Still authoritative elsewhere:**
- **Database:** `fc_policy` and `fc_budget_profiles` rows in the database (067 is not applied in production) govern enforcement. Changing the register does not change them; that remains an audited `fc_set_budget_profile` / policy change.
- **Pricing:** the price itself lives in Stripe and App Store Connect.

---

## 10. Provider confirmations required (ordered by impact)

1. **Apple Small Business Program enrolment** (App Store Connect → Agreements). Moves the Apple budget £0.10 → £0.74.
2. **Real usage distribution**: total inbound minutes per household (trusted vs unknown) from the first real customers, or Twilio call logs of friends-and-family households.
3. **Twilio:** written confirmation that `<Dial><Client>` stays unbilled. If billed, typical Stripe margin falls 26% → 12%.
4. **Stripe:** account fee schedule, whether Billing is 0.7% or 0.5%, whether Stripe Tax is enabled, and card mix.
5. **OpenAI:** an org-level usage-readable key, so transcription cost can be reconciled rather than estimated.
6. **Infrastructure invoices:** Supabase plan (two projects), Resend, IONOS.
7. **Carrier quotes** (AQL, Magrathea, Telnyx). Drop them into `futureCarrierScenarios` and re-run.
8. **Accountant:** recoverability of input VAT on Twilio/OpenAI (assumed, not affecting margin on ex-VAT prices).

## 11. How to update

1. Edit the register entry: value, `status`, `source`.
2. Run `node scripts/hcg-unit-economics.js > docs/finance/HCG_UNIT_ECONOMICS_V1_TABLES.md`.
3. Run `npm test`.

If a value used by migration 067 changes, the test will demand a matching migration (or policy change). The two cannot silently diverge.
