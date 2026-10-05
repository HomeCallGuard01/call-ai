# DT-2: allowance display, truthful wording, and the production allowance decision (2026-10-05)

## 1. What happened on the real device

During the attended staging test, the iPhone (Build 16) showed **88% call checking left** after what looked like one short test call.

**Diagnosis (read-only, staging Fortress ledger):** there were **two** separate trusted calls:

| Call | Time (UTC) | Twilio call | Billed duration | Reserve | Commit | Release |
|---|---|---|---|---|---|---|
| `CAbbd951…` | 18:13:21–18:14:11 | 42 s | 50 s | £0.071339 | **£0.01239** | £0.058949 |
| `CAccc2ae…` | 18:17:05–18:17:51 | 41 s | 47 s | £0.071339 | **£0.01239** | £0.058949 |

- Exactly one reserve → commit → release per call, each under its own idempotency key. **No duplicate metering.**
- Reserved but unused capacity was released, and is neither charged nor shown. 0 live reservations.
- Ringing and setup are part of the billed inbound leg (HCG really pays for them), but both calls were inside the 60-second minimum.
- **Display:** `usedPercent = floor((consumed + reserved) / budget × 100) = floor(0.02478 / 0.20 × 100) = 12` → **88% left**. The staging household's ordinary-spend budget is deliberately tiny (£0.20, plus £0.07 trusted reserve and £0.03 essential).
- **The percentage is £-based** (Fortress), not minutes. The "100 included minutes" in the payload was only a label.

**The Fortress calculations were correct. Nothing was changed in them, in the budgets, or in the reservations.**

## 2. The real problem: the words were untrue on the £ basis

The meter said **"CALL CHECKING THIS MONTH"**, and the warnings said **"Calls from people you trust don't use it"**. That was true for the 056 *monitored-minutes* source, which is the default. On the Fortress £ source it was **false**: tonight's 12% was used entirely by *trusted* calls. The 100% email also said "calls still reach you" even when Fortress's trusted-only reserve means other forwarded calls can be refused.

**Fixed (source; ships with Build ≥ 17 and the backend deploy):**

| Surface | Change |
|---|---|
| Server payload `customerAllowance` | New `basis`: `protection_spend` (Fortress) or `monitored_minutes` (056). New `trustedCallsUseAllowance`. **`includedMinutes` is `null` on the £ basis**, so no client can show a minute promise Fortress doesn't enforce. |
| App `AllowanceMeter` | £ basis → title **"PROTECTION ALLOWANCE THIS MONTH"** with one plain line: "Every call Home Call Guard handles uses a little of this. Checking calls from unknown numbers uses the most." 75% / 90% / 100% messages no longer claim trusted calls are exempt. The minutes basis keeps its original, true wording. |
| Web dashboard | Same rules, plus the help text. A future top-up button on the £ basis reads "Add more protection allowance · £x", never "Add 30 minutes". |
| Warning emails (75 / 90 / 100%) | £ basis: "…% of this month's protection allowance left". At 100%, the email states what actually happens: calls still reach you; **or** trusted callers still get through and other forwarded calls may not, with how to turn off forwarding and contact support. |
| Guards | `tests/allowance-truthful-wording.test.mjs` fails if any £-basis copy (app, web, email) says "minutes", "call checking", or that trusted calls don't use it. `tests/customer-allowance.test.mjs` pins `basis`/`includedMinutes`. The percentage formula is pinned unchanged. |

Warning points 75% / 90% / 100% are unchanged. Customers are still warned before the allowance runs out.

## 3. Unit economics: a genuine commercial issue, not a UI issue

These are tonight's Fortress estimate figures (staging policy v2):
- connected rate £0.010718/min;
- monitoring rate +£0.008069/min;
- 60-second billing granularity;
- 1.1 estimate uplift;
- £0.0006 per call.

| Call | Fortress estimate |
|---|---|
| Trusted, any length ≤ 60 s | **£0.01239** (10 s costs the same as 60 s) |
| Each further trusted minute | £0.01179 |
| Unknown, monitored, per minute | ≈ £0.02067 + per-call fee + AI requests |

From the approved model (`docs/finance/HCG_UNIT_ECONOMICS_V1.md`, §6), at £5.99 the safe monthly variable budget (40% margin held) is **£1.07 for Stripe** and **£0.74 for 15% stores**. Converted to the Fortress basis, the profile total needed is **£1.54 / £1.06**.

| At the Fortress profile total | Stripe £1.54 | Stores £1.06 |
|---|---|---|
| One short trusted call | ≈ 0.8% of the month | ≈ 1.2% |
| Short (≤ 60 s) trusted calls per month | ≈ 124 | ≈ 86 |
| Trusted minutes (long calls) | ≈ 131 | ≈ 90 |
| Model's illustrative typical household (150 trusted + 40 unknown min) | **exceeds the budget** (model: 26% margin on Stripe, not 40%) | exceeds (18%) |

**Conclusion (unchanged from the approved model, now confirmed by real calls):**
- At £5.99, no "included minutes" figure holds a 40% margin for average-ish trusted use, because **trusted minutes are on HCG's bill** (Twilio inbound + app leg).
- Very short calls look disproportionately expensive because of the 60-second minimum and the per-call component.
- The only structural fix is C5: take trusted calls off HCG's bill (network-side routing).
- UI wording cannot fix this, and was not used to hide it.

## 4. Decision required before the first five genuine customers (Andrew)

| # | Decision | Options (from the approved model, §6.1) | Recommendation for a ≤ 5 cohort |
|---|---|---|---|
| **AL-1** | Production allowance source | `ALLOWANCE_SOURCE=fortress` (the meter shows what is actually enforced) vs the 056 minutes default (the meter shows monitored minutes while Fortress enforces £, a **mismatch**) | **`fortress`**, so the meter and enforcement agree |
| **AL-2** | Production Fortress profile (= gate C12) | C1 £-budget only (Stripe £1.54 Fortress basis, typical households hit the cap) · C2 portfolio (cap at the LOSS line, light users subsidise) · C3 small monitored allowance with trusted watched · C4 higher price · C5 architecture | **C2-style for the cohort:** `standard` profile at the Fortress basis of the Stripe safe budget (£1.54 total), with the trusted delivery reserve so trusted callers keep connecting after the budget, operator WATCH/LOSS alerts, and per-household review weekly. **Collect the real usage distribution** (the model's biggest unknown) before pricing the next stage. Needs your explicit numbers; nothing is set |
| **AL-3** | Customer wording sign-off | §2 wording (decision I-3); terms/listing must not promise minutes | Approve §2; add one sentence to terms §3 ("includes a monthly protection allowance; the app shows how much is left") before public copy |
| **AL-4** | Apple SBP enrolment | Moves the Apple budget from £0.10 to £0.74 | Confirm before iOS is offered commercially |

**Not done, deliberately:** no production profile set, no allowance activated, no budget raised, no reservation weakened.
